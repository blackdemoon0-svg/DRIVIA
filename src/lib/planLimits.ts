/**
 * Plan quotas — the single source of truth shared by the server and the
 * interface.
 *
 * This module is deliberately free of Node built-ins and of any import from
 * `server/`: the pricing page renders these numbers in the browser, and the chat
 * handler enforces them on the server. Keeping one table is what stops the page
 * from promising something the server refuses.
 *
 * The figures mirror the public catalogue in `src/lib/paddleCore.ts`:
 * - Découverte: "Analyse d'un devis" (one), no photo or PDF capability;
 * - Plus: "Devis et factures de garage illimités" and "Analyse de photos et de PDF";
 * - Pro: everything in Plus, with a larger allowance.
 *
 * `scripts/plan-limits.test.mjs` asserts the two sides against each other, so a
 * change on either side fails the build instead of shipping a contradiction.
 */

export type PlanId = "decouverte" | "plus" | "pro";

export type PlanLimits = {
  /** Messages per UTC day. `null` means unlimited. */
  messagesPerDay: number | null;
  /** Garage-quote analyses per UTC day. `null` means unlimited. */
  quoteAnalysesPerDay: number | null;
  /** Whether photos and PDFs may be attached. */
  attachments: boolean;
  /** Requests allowed in a rolling minute, per account. */
  requestsPerMinute: number;
};

/**
 * Validated quotas. Changing a number here changes both the enforcement and the
 * wording shown on the pricing page.
 */
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  decouverte: {
    messagesPerDay: 15,
    quoteAnalysesPerDay: 1,
    attachments: false,
    requestsPerMinute: 10,
  },
  plus: {
    messagesPerDay: 200,
    quoteAnalysesPerDay: null,
    attachments: true,
    requestsPerMinute: 20,
  },
  pro: {
    messagesPerDay: 600,
    quoteAnalysesPerDay: null,
    attachments: true,
    requestsPerMinute: 30,
  },
};

/** Unknown plans get the most restrictive row, never a paid one. */
export function limitsFor(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as PlanId] ?? PLAN_LIMITS.decouverte;
}

/**
 * Short factual sentence describing a plan's allowance, for the pricing page.
 *
 * Wording is generated from the table above so the page cannot drift from what
 * the server enforces. `null` values are rendered as "illimitées".
 */
export function describeLimits(plan: PlanId): string {
  const limits = limitsFor(plan);
  const parts: string[] = [];

  if (limits.messagesPerDay === null) {
    parts.push("Messages illimités");
  } else {
    parts.push(`${limits.messagesPerDay} messages par jour`);
  }

  if (limits.quoteAnalysesPerDay === null) {
    parts.push("analyses de devis illimitées");
  } else {
    parts.push(
      limits.quoteAnalysesPerDay === 1
        ? "1 analyse de devis par jour"
        : `${limits.quoteAnalysesPerDay} analyses de devis par jour`,
    );
  }

  if (limits.attachments) parts.push("photos et PDF acceptés");
  else parts.push("sans pièce jointe");

  return `${parts.join(", ")}.`;
}
