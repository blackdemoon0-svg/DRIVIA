/**
 * Instance-level spend guard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THIS IS (AND IS NOT)
 * ─────────────────────────────────────────────────────────────────────────────
 * A multi-model architecture multiplies the cost of a single conversation: a
 * collaborative turn can call three or four models. Without a guard, one bug in
 * the router — or one enthusiastic account — can produce a surprising invoice.
 *
 * This module keeps a best-effort daily total *in the memory of one instance*.
 * Like the request quotas, that means it resets on a cold start and does not
 * aggregate across instances. It is therefore an early-warning brake on
 * expensive *modes*, not a billing meter: it never blocks a user's message, it
 * only disables the costly collaboration path and lets the request continue on a
 * single model. The real ceiling remains the OpenAI account's own hard limit.
 */

/** Default soft cap, in USD per UTC day, for one instance. Env-overridable. */
export const DEFAULT_DAILY_BUDGET_USD = 20;

type SpendState = {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  usd: number;
};

let state: SpendState = { day: utcDay(Date.now()), usd: 0 };

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function rollIfNeeded(nowMs: number) {
  const day = utcDay(nowMs);
  if (state.day !== day) state = { day, usd: 0 };
}

/** USD spent by this instance today (UTC). */
export function spentTodayUsd(nowMs = Date.now()): number {
  rollIfNeeded(nowMs);
  return state.usd;
}

/** Record the measured cost of a finished request. */
export function recordSpend(usd: number, nowMs = Date.now()): number {
  rollIfNeeded(nowMs);
  if (Number.isFinite(usd) && usd > 0) state.usd += usd;
  return state.usd;
}

/**
 * Whether a costly mode may run, given what it is expected to cost.
 *
 * Returning false never refuses the request: the caller degrades the route to a
 * single model, which is the whole point.
 */
export function canAffordExpensiveMode(
  estimatedUsd: number,
  options: { dailyBudgetUsd?: number; nowMs?: number } = {},
): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const budget = options.dailyBudgetUsd ?? DEFAULT_DAILY_BUDGET_USD;
  if (!Number.isFinite(budget) || budget <= 0) return true;
  rollIfNeeded(nowMs);
  return state.usd + Math.max(0, estimatedUsd) <= budget;
}

/** Test hook. */
export function resetSpend(): void {
  state = { day: utcDay(Date.now()), usd: 0 };
}
