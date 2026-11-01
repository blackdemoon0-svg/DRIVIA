/**
 * The one rule that turns a stored subscription row into a right.
 *
 * Why this module exists
 * ----------------------
 * Two places need to know what a row means: the server, to authorise a chat
 * request, and the pricing page, to decide whether a plan's button may be
 * pressed. If each kept its own copy, the page could offer a purchase the
 * database would refuse, or hide a purchase the customer needs. The rule
 * therefore lives here once and is imported by both.
 *
 * What it is NOT
 * --------------
 * Importing this module grants nothing. `server/access.ts` is the authority;
 * the pricing page uses the same functions with the rows it is allowed to read
 * through row level security, purely for display. A browser-side answer is
 * never used to authorise anything.
 *
 * Two distinct sets of statuses, deliberately
 * -------------------------------------------
 * - `ENTITLED_STATUSES` — the statuses that can still give access while the
 *   paid period runs. This is what the chat obeys.
 * - `BLOCKING_STATUSES` — the statuses named in the partial unique index on
 *   `paddle_customer_id` (0001_subscriptions.sql). A stored row in one of
 *   these statuses makes a second subscription for the same Paddle customer
 *   fail with a 409.
 *
 * The two differ, and the difference is exactly where a naive "is the plan
 * active?" check goes wrong: a `paused` or an expired `past_due` row grants
 * nothing, yet it still occupies the customer and would refuse a new
 * subscription. Offering a purchase there takes the customer's money and then
 * leaves the webhook with an unresolvable conflict. The pricing page must
 * therefore reason on `BLOCKING_STATUSES`, not on `ENTITLED_STATUSES`.
 */

/** Plan identifiers, matching the public catalogue in `src/lib/paddleCore.ts`. */
export type AccessPlan = "decouverte" | "plus" | "pro";

/** Paid plans only: the ones a subscription can grant. */
export type PaidAccessPlan = Exclude<AccessPlan, "decouverte">;

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "canceled";

/**
 * Raw row as PostgREST returns it. Every field is untrusted until checked, and
 * every field is optional: a hand-written row may omit anything.
 */
export type StoredSubscriptionRow = {
  user_id?: unknown;
  plan?: unknown;
  status?: unknown;
  current_period_ends_at?: unknown;
  scheduled_change_effective_at?: unknown;
  canceled_at?: unknown;
  source_updated_at?: unknown;
};

/**
 * Statuses that can still grant access, provided the paid period has not
 * ended.
 *
 * `past_due` is included on purpose: Paddle reports a failed renewal while the
 * customer keeps access until the period ends or the subscription is
 * canceled — that window is what the "update your payment method" notice
 * refers to. `paused` and any unknown status grant nothing.
 */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due", "canceled"] as const;

/**
 * Statuses named by the partial unique index on `paddle_customer_id`
 * (`0001_subscriptions.sql`). A stored row in one of them refuses a second
 * subscription for the same Paddle customer.
 *
 * Keep this in step with the migration: the database is the authority, and a
 * test in `scripts/schema-alignment.test.mjs` compares the two lists.
 */
export const BLOCKING_STATUSES = ["trialing", "active", "past_due", "paused"] as const;

const KNOWN_PAID_PLANS: readonly PaidAccessPlan[] = ["plus", "pro"];

export function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asPaidPlan(value: unknown): PaidAccessPlan | null {
  const raw = asTrimmedString(value);
  return raw && (KNOWN_PAID_PLANS as readonly string[]).includes(raw)
    ? (raw as PaidAccessPlan)
    : null;
}

export function asSubscriptionStatus(value: unknown): SubscriptionStatus | null {
  const raw = asTrimmedString(value);
  const known: readonly string[] = ["trialing", "active", "past_due", "paused", "canceled"];
  return raw && known.includes(raw) ? (raw as SubscriptionStatus) : null;
}

/**
 * Convert one stored row into a grant, for one specific account.
 *
 * Returns `null` unless every condition holds: the row belongs to this user, the
 * plan is one we sell, the status is entitled, and the paid period ends in the
 * future. A row we cannot fully understand grants nothing.
 */
export function toGrant(
  row: StoredSubscriptionRow | null | undefined,
  expectedUserId: string,
  nowMs: number = Date.now(),
): PaidAccessPlan | null {
  if (!row || typeof row !== "object") return null;

  const expected = (expectedUserId ?? "").trim();
  if (!expected) return null;

  const rowUserId = asTrimmedString(row.user_id);
  if (!rowUserId || rowUserId !== expected) return null;

  const plan = asPaidPlan(row.plan);
  if (!plan) return null;

  const status = asTrimmedString(row.status);
  if (!status || !(ENTITLED_STATUSES as readonly string[]).includes(status)) return null;

  // The period end is the only proof the subscription is currently paid for.
  // A missing or unparseable date is not "probably still valid": it grants
  // nothing.
  const periodEnd = asTrimmedString(row.current_period_ends_at);
  if (!periodEnd) return null;
  const periodEndMs = Date.parse(periodEnd);
  if (!Number.isFinite(periodEndMs)) return null;
  if (periodEndMs <= nowMs) return null;

  return plan;
}

/**
 * Decide the plan for an account from its stored rows.
 *
 * The most capable valid grant wins, so a customer who upgraded is never held
 * back by a stale `plus` row still present in the table.
 */
export function resolveAccessPlan(
  rows: readonly (StoredSubscriptionRow | null | undefined)[],
  expectedUserId: string,
  nowMs: number = Date.now(),
): AccessPlan {
  const grants = rows
    .map((row) => toGrant(row, expectedUserId, nowMs))
    .filter((plan): plan is PaidAccessPlan => plan !== null);

  if (grants.includes("pro")) return "pro";
  if (grants.includes("plus")) return "plus";
  return "decouverte";
}

export type BlockingSubscription = {
  plan: PaidAccessPlan;
  status: SubscriptionStatus;
};

/** Display order for a stored status: the most "current" first. */
const BLOCKING_STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  paused: 3,
};

/**
 * The subscription that already occupies this account, if any.
 *
 * Unlike `resolveAccessPlan`, this ignores the period end: the question is not
 * "does this row still grant access?" but "would the database accept another
 * subscription for this customer?". A `paused` row, or a `past_due` row whose
 * period has ended, grants nothing and still blocks — see `BLOCKING_STATUSES`.
 *
 * Returns the most capable plan, so an account holding both a `plus` and a
 * `pro` row is reported as `pro` and is never offered a Pro checkout.
 */
export function findBlockingSubscription(
  rows: readonly (StoredSubscriptionRow | null | undefined)[],
  expectedUserId: string,
): BlockingSubscription | null {
  const expected = (expectedUserId ?? "").trim();
  if (!expected) return null;

  const candidates: BlockingSubscription[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (asTrimmedString(row.user_id) !== expected) continue;

    const plan = asPaidPlan(row.plan);
    const status = asSubscriptionStatus(row.status);
    if (!plan || !status) continue;
    if (!(BLOCKING_STATUSES as readonly string[]).includes(status)) continue;

    candidates.push({ plan, status });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.plan !== b.plan) return a.plan === "pro" ? -1 : 1;
    return (BLOCKING_STATUS_PRIORITY[a.status] ?? 9) - (BLOCKING_STATUS_PRIORITY[b.status] ?? 9);
  });

  return candidates[0] ?? null;
}
