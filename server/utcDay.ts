/**
 * The UTC day boundary — one definition, used by everything that has to agree
 * on when a daily allowance resets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY THIS IS ITS OWN MODULE
 * ─────────────────────────────────────────────────────────────────────────────
 * Both sides of the durable quota must compute the same day: PostgreSQL derives
 * it from `now()` inside `ai_usage_consume`, and the route needs it to say "it
 * resets at midnight UTC" and to build the `Retry-After` of a 429. Two
 * independent implementations of "today" would drift at the boundary and
 * produce a wrong reset time for a message sent at 23:59:59.
 *
 * Until P8/S4 these two functions lived in `server/quotas.ts`, next to an
 * in-memory counter that was the quota itself. That counter is gone (P7/S3 made
 * the daily allowance durable in PostgreSQL); keeping a module named "quotas"
 * around a pair of date helpers would keep inviting the wrong idea back. Hence
 * this file: the arithmetic, nothing else.
 *
 * No environment read, no clock read: the caller passes `nowMs`. That is what
 * makes both functions testable at the exact millisecond, including at midnight.
 */

/** One day, in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * The UTC calendar day of an instant, as `YYYY-MM-DD`.
 *
 * UTC, not local time: the published rule is "resets at midnight UTC", and a
 * serverless function may run in any region. Using the server's local zone would
 * make the same account see a different reset hour depending on where the
 * instance happened to be scheduled.
 */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Milliseconds until the next UTC midnight — i.e. until a daily allowance
 * resets. Never zero: a `Retry-After` of 0 means "retry now", which would be a
 * lie at 23:59:59.999.
 *
 * Computed with `Date.UTC` rather than by adding `DAY_MS` to `nowMs`, because
 * the day after the clock moves is not always 86 400 000 ms long.
 */
export function msUntilNextUtcDay(nowMs: number): number {
  const now = new Date(nowMs);
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1_000, nextMidnight - nowMs);
}

/** Exported for tests that need the length of a day without duplicating it. */
export { DAY_MS };
