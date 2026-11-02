/**
 * Purchase guard — decides whether a plan's button may be pressed.
 *
 * What this module protects against
 * ---------------------------------
 * 1. paying twice for the plan already in force;
 * 2. pressing twice while a checkout is being created or while Paddle's overlay
 *    is still open, which would open a second checkout and take a second
 *    payment;
 * 3. paying for a formula the database would refuse to record: a stored row in
 *    a status named by the partial unique index (`paused`, `past_due` with an
 *    ended period, ...) already occupies the customer, so a new subscription
 *    arrives as an unresolvable 409 at the webhook. The customer would be
 *    charged and the conflict would wait for a human;
 * 4. mistaking "the checkout window opened" for "the payment is confirmed".
 *
 * What this module is NOT
 * -----------------------
 * It is a courtesy, not an authorisation. The plan shown here comes from the
 * customer's own rows, read through row level security; nothing in this file
 * grants access, and `server/access.ts` remains the only authority. Hiding a
 * button is a service to the customer; it is never a security boundary.
 *
 * The decision is a pure function of three inputs — which plan the button is
 * for, what the database says, and whether a checkout is in flight — so every
 * case can be tested without a browser and without Paddle.
 */

import {
  findBlockingSubscription,
  type PaidAccessPlan,
  type StoredSubscriptionRow,
  type SubscriptionStatus,
} from "./subscriptionAccess";

export type { SubscriptionStatus };

/**
 * What the database currently says about this account.
 *
 * `unknown` is not "probably free": an unreadable subscription is a reason to
 * refuse a payment, never a reason to assume there is none.
 */
export type PlanSnapshot =
  /** The rows are being read: nothing is claimed, nothing may be bought. */
  | { kind: "checking" }
  /** The read failed: the guard cannot vouch for the absence of a plan. */
  | { kind: "unknown"; message: string }
  /** No row occupies this account: a purchase is safe to open. */
  | { kind: "free" }
  /** A stored subscription already occupies this account. */
  | { kind: "subscribed"; plan: PaidAccessPlan; status: SubscriptionStatus };

/**
 * A checkout in flight.
 *
 * `creating` covers the moment between the click and Paddle answering;
 * `open` covers the window being displayed. Neither means the payment was
 * confirmed — only a row written by the webhook does.
 */
export type CheckoutActivity =
  | { kind: "idle" }
  | { kind: "creating"; plan: PaidAccessPlan }
  | { kind: "open"; plan: PaidAccessPlan };

export const IDLE_ACTIVITY: CheckoutActivity = { kind: "idle" };

export type CtaReason =
  /** This exact plan is already in force. */
  | "current"
  /** The active plan already covers this one. */
  | "included"
  /** The plan is still being read from the database. */
  | "checking"
  /** The database could not tell which plan applies. */
  | "unreadable"
  /** A checkout is being created or is open. */
  | "busy"
  /** Plus → Pro: allowed. */
  | "upgrade"
  /** A payment in arrears must be settled before changing formula. */
  | "arrears"
  /** The stored subscription is paused and must be resumed first. */
  | "paused"
  /** Ordinary purchase. */
  | "checkout";

/** Reasons that disable the button. Everything else allows it. */
const BLOCKING_REASONS: readonly CtaReason[] = [
  "current",
  "included",
  "checking",
  "unreadable",
  "busy",
  "arrears",
  "paused",
];

export function isBlocked(reason: CtaReason): boolean {
  return BLOCKING_REASONS.includes(reason);
}

/** Public names of the two paid plans. */
const PLAN_LABELS: Record<PaidAccessPlan, string> = {
  plus: "VEYVRO Plus",
  pro: "VEYVRO Pro",
};

export type CtaDecision = {
  /** The button must not react to a click. */
  disabled: boolean;
  /** Visible button text — never claims a state the database does not hold. */
  label: string;
  reason: CtaReason;
  /** One line under the button, or null when nothing needs saying. */
  hint: string | null;
};

/**
 * Turn the account's own rows into a snapshot.
 *
 * Uses `findBlockingSubscription`, not the access rule: the question is "would
 * the database accept another subscription for this customer?", so a `paused`
 * row counts even though it grants no access.
 */
export function snapshotFromRows(
  rows: readonly (StoredSubscriptionRow | null | undefined)[],
  userId: string,
): PlanSnapshot {
  const blocking = findBlockingSubscription(rows, userId);
  return blocking
    ? { kind: "subscribed", plan: blocking.plan, status: blocking.status }
    : { kind: "free" };
}

/**
 * Decide what the button for `plan` must do.
 *
 * Order matters and is the whole point of this function:
 * 1. an unknown state refuses everything, because it cannot prove the absence
 *    of a plan;
 * 2. a plan already held is refused, and so is a formula the customer already
 *    covers;
 * 3. anything that requires a change of formula is refused while the stored
 *    subscription is not in good standing — paying again would not fix arrears,
 *    it would add a second subscription;
 * 4. one checkout at a time: while one is being created or is open, every other
 *    paid button is refused too;
 * 5. only then may a click open a checkout.
 *
 * `baseLabel` is the catalogue's own wording (the caller passes `plan.cta`), so
 * this module never has to own marketing copy.
 */
export function decideCta(
  plan: PaidAccessPlan,
  baseLabel: string,
  snapshot: PlanSnapshot,
  activity: CheckoutActivity,
): CtaDecision {
  // 1. Nothing is known yet, or what is known is unusable.
  if (snapshot.kind === "checking") {
    return {
      disabled: true,
      label: baseLabel,
      reason: "checking",
      hint: "Vérification de votre formule en cours…",
    };
  }

  if (snapshot.kind === "unknown") {
    return {
      disabled: true,
      label: baseLabel,
      reason: "unreadable",
      hint: "Votre formule actuelle n'a pas pu être vérifiée : aucun paiement ne peut être ouvert. Réessayez la vérification.",
    };
  }

  // 2. What the stored subscription already gives.
  if (snapshot.kind === "subscribed") {
    if (snapshot.plan === plan) {
      return {
        disabled: true,
        label: "Formule actuelle",
        reason: "current",
        hint:
          snapshot.status === "past_due"
            ? "Paiement en retard : régularisez-le depuis Paddle, votre accès court jusqu'à la fin de la période."
            : snapshot.status === "paused"
              ? "Abonnement en pause : reprenez-le depuis Paddle."
              : "Cette formule est déjà active sur votre compte.",
      };
    }

    // The target is below what the customer already holds.
    if (plan === "plus") {
      return {
        disabled: true,
        label: `Inclus dans ${PLAN_LABELS[snapshot.plan]}`,
        reason: "included",
        hint: "Un changement de formule à la baisse se fait auprès de Paddle, pas par un nouveau paiement.",
      };
    }

    // 3. Plus → Pro is allowed, but only from a subscription in good standing.
    if (snapshot.status === "past_due") {
      return {
        disabled: true,
        label: baseLabel,
        reason: "arrears",
        hint: "Régularisez d'abord le paiement en retard de votre abonnement en cours.",
      };
    }
    if (snapshot.status === "paused") {
      return {
        disabled: true,
        label: baseLabel,
        reason: "paused",
        hint: "Votre abonnement est en pause : reprenez-le avant de passer à VEYVRO Pro.",
      };
    }
  }

  // 4. One checkout at a time — including while the window is merely open.
  if (activity.kind !== "idle") {
    const isThisPlan = activity.plan === plan;
    return {
      disabled: true,
      label: isThisPlan && activity.kind === "creating" ? "Ouverture du paiement…" : baseLabel,
      reason: "busy",
      hint: isThisPlan
        ? "Un paiement est déjà en cours pour cette formule."
        : "Un paiement est déjà en cours. Terminez-le ou fermez la fenêtre avant d'en ouvrir un autre.",
    };
  }

  // 5. Allowed.
  if (snapshot.kind === "subscribed") {
    return {
      disabled: false,
      label: `Passer à ${PLAN_LABELS[plan]}`,
      reason: "upgrade",
      // An upgrade no longer opens a checkout: it modifies the existing Paddle
      // subscription through the server. The wording therefore promises a
      // prorated amount shown *before* confirmation, and never a plan that has
      // already changed — the webhook still has to record it.
      hint: `Votre formule actuelle est ${PLAN_LABELS[snapshot.plan]}. Le montant au prorata vous sera montré avant de confirmer ; le changement n'est enregistré qu'une fois l'abonnement mis à jour par Paddle.`,
    };
  }

  return { disabled: false, label: baseLabel, reason: "checkout", hint: null };
}
