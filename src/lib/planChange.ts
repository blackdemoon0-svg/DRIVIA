/**
 * Which plan changes are allowed — decided once, before any money moves.
 *
 * This module is pure: it never calls Paddle, never reads the database and
 * never touches the network. It answers one question, from the stored
 * subscription and the requested target:
 *
 *   "may this account move to that plan, in place, right now?"
 *
 * The server route is the authority and uses it to refuse; the interface may
 * use it to explain. Splitting it out means every refusal can be tested without
 * Paddle, which matters because each one exists to prevent a specific way of
 * taking the wrong amount of money:
 *
 * - `past_due` — Paddle refuses to update such a subscription at all. Charging
 *   again would not fix the arrears; it would only add noise on top of a
 *   payment problem.
 * - `paused` / `canceled` — there is nothing live to modify in place. The right
 *   answer is a new subscription through the checkout, not a PATCH.
 * - `trialing` — Paddle only allows `do_not_bill` on a trialing subscription.
 *   Our catalogue has no trial, so this state is not one we claim to handle.
 * - a lower plan — a downgrade is a scheduled change at the end of the period,
 *   a different product decision with a different wording. Out of scope here,
 *   and never a "change now, refund later".
 * - a different billing interval — every recurring item on a subscription must
 *   share one interval, so switching month → year replaces the billing cycle
 *   and moves the renewal date. Out of scope for this step.
 */

import type { BillingInterval } from "./paddleCore";
import {
  BLOCKING_STATUSES,
  asPaidPlan,
  asSubscriptionStatus,
  asTrimmedString,
  type PaidAccessPlan,
  type StoredSubscriptionRow,
  type SubscriptionStatus,
} from "./subscriptionAccess";

/** Ordering of the paid plans. Higher is more capable. */
const PLAN_RANK: Record<PaidAccessPlan, number> = { plus: 1, pro: 2 };

/** The subscription as the change route sees it, already validated. */
export type SubscriptionForChange = {
  /**
   * The exact Paddle subscription id of the selected row.
   *
   * Carried with the selection on purpose: re-finding the row afterwards by
   * `(plan, status)` would be ambiguous the day an account holds two rows that
   * look alike, and the PATCH must name the row the rules actually looked at.
   */
  subscriptionId: string;
  plan: PaidAccessPlan;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
};

export type PlanChangeRefusalCode =
  /** No subscription of ours to modify: the checkout is the right path. */
  | "no_subscription"
  /** Already on that plan: nothing to buy. */
  | "same_plan"
  /** Moving down is a scheduled change, not an in-place PATCH. */
  | "downgrade_not_supported"
  /** Replacing the billing cycle is out of scope for this step. */
  | "interval_change_not_supported"
  /** `past_due`, `paused` or `canceled`: not updatable in place. */
  | "not_in_good_standing"
  /** Paddle only allows `do_not_bill` on a trialing subscription. */
  | "trialing_not_supported";

export type PlanChangeDecision =
  | { ok: true }
  | { ok: false; code: PlanChangeRefusalCode; status: SubscriptionStatus | null };

/**
 * Decide whether an in-place change to `target` is allowed.
 *
 * `current` is `null` when the account has no subscription this application can
 * name: that is not an error, it simply means the customer must subscribe first.
 */
export function evaluatePlanChange(
  current: SubscriptionForChange | null,
  target: { plan: PaidAccessPlan; interval: BillingInterval },
): PlanChangeDecision {
  if (!current) return { ok: false, code: "no_subscription", status: null };

  if (current.status === "trialing") {
    return { ok: false, code: "trialing_not_supported", status: current.status };
  }

  // `past_due`, `paused`, `canceled`: nothing to modify in place. Checked before
  // anything else so no later branch can accidentally allow a payment on a
  // subscription Paddle itself would refuse to update.
  if (current.status !== "active") {
    return { ok: false, code: "not_in_good_standing", status: current.status };
  }

  if (current.plan === target.plan) {
    return { ok: false, code: "same_plan", status: current.status };
  }

  if (PLAN_RANK[target.plan] < PLAN_RANK[current.plan]) {
    return { ok: false, code: "downgrade_not_supported", status: current.status };
  }

  // An unknown stored interval cannot be "assumed the same": it would silently
  // replace the billing cycle and move the renewal date.
  if (current.interval !== target.interval) {
    return { ok: false, code: "interval_change_not_supported", status: current.status };
  }

  return { ok: true };
}

const STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  paused: 3,
  canceled: 4,
};

/**
 * Pick the subscription a change would apply to.
 *
 * Deterministic and conservative: only rows owned by this account, with a
 * usable Paddle subscription id, a known plan, a known status and one of the
 * statuses the partial unique index treats as occupying the customer. An
 * `active` subscription wins, then the more capable plan, then the latest
 * period end — so an account holding a stale `plus` row next to its `pro` row
 * can never be upgraded twice.
 *
 * The tie-break ends on the Paddle subscription id, which makes the choice a
 * pure function of the rows: the same set in a different order returns the same
 * row. Without it, two rows sharing plan, status and period end would resolve in
 * whatever order PostgREST happened to return.
 */
export function pickSubscriptionForChange(
  rows: readonly (StoredSubscriptionRow | null | undefined)[],
  expectedUserId: string,
): SubscriptionForChange | null {
  const expected = (expectedUserId ?? "").trim();
  if (!expected) return null;

  const candidates: (SubscriptionForChange & { periodEnd: number })[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (asTrimmedString(row.user_id) !== expected) continue;

    const paddleSubscriptionId = asTrimmedString(
      (row as { paddle_subscription_id?: unknown }).paddle_subscription_id,
    );
    if (!paddleSubscriptionId) continue;

    const plan = asPaidPlan(row.plan);
    const status = asSubscriptionStatus(row.status);
    if (!plan || !status) continue;
    if (!(BLOCKING_STATUSES as readonly string[]).includes(status)) continue;

    const interval = asTrimmedString((row as { billing_interval?: unknown }).billing_interval);
    const periodEnd = Date.parse(asTrimmedString(row.current_period_ends_at) ?? "");

    candidates.push({
      subscriptionId: paddleSubscriptionId,
      plan,
      status,
      interval: interval === "month" || interval === "year" ? interval : null,
      periodEnd: Number.isFinite(periodEnd) ? periodEnd : 0,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const byStatus = (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    const byPlan = PLAN_RANK[b.plan] - PLAN_RANK[a.plan];
    if (byPlan !== 0) return byPlan;
    if (b.periodEnd !== a.periodEnd) return b.periodEnd - a.periodEnd;
    // Total order: no two candidates can compare equal, so the answer never
    // depends on the order the rows arrived in.
    return a.subscriptionId < b.subscriptionId ? -1 : a.subscriptionId > b.subscriptionId ? 1 : 0;
  });

  const best = candidates[0];
  return best
    ? {
        subscriptionId: best.subscriptionId,
        plan: best.plan,
        status: best.status,
        interval: best.interval,
      }
    : null;
}
