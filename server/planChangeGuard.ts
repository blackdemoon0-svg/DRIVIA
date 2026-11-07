/**
 * In-process protections for the plan-change route: rate limiting, one PATCH at
 * a time, and single-use quotes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THESE ARE, AND WHAT THEY ARE NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * Every structure here lives in the memory of **one serverless instance**:
 *
 *   • best-effort, NOT durable — a cold start, a redeploy or a second instance
 *     starts again from nothing, so two requests handled by two instances do not
 *     see each other's lock;
 *   • NOT a substitute for a durable store. A shared counter needs a table (a
 *     migration) or Redis; neither is available here, and inventing the illusion
 *     of a durable lock would be worse than saying what this is.
 *
 * What they *do* stop, reliably, is what actually goes wrong in practice:
 *
 *   1. a double click, a double-submitted form or a replayed request on the same
 *      instance → the second one gets 409 instead of a second PATCH;
 *   2. a burst of requests from one account (or one address) → 429 with a
 *      `Retry-After` the browser can honour;
 *   3. the same signed quote used twice → refused, so a captured token cannot
 *      buy the same change twice.
 *
 * And the layer that does not depend on memory at all: Paddle itself refuses to
 * modify a subscription while a change is processing (`subscription_locked_*`),
 * which this route maps to a 409 rather than retrying. The three protections are
 * complementary, not redundant: ours is cheap and immediate, Paddle's is
 * authoritative and remote.
 *
 * Note on idempotency keys: Paddle's documentation states plainly that the API
 * does not support client-supplied idempotency keys ("Paddle doesn't support
 * idempotency keys, so verify before retrying"). There is therefore no header to
 * send on `PATCH /subscriptions/{id}` — which is precisely why the lock and the
 * single-use nonce exist on this side.
 *
 * Why not the chat quota
 * ----------------------
 * The chat's counters were the obvious thing to reuse, and they are the wrong
 * thing: they are keyed on the chat's plan limits, and consuming one there would
 * spend a *message* allowance on a plan change. A customer who re-quotes three times
 * would lose three messages. The mechanism (a per-key sliding window in memory)
 * is the same; the budget is not. Hence a separate module with its own keys and
 * its own limits, rather than a shared counter that would quietly charge the
 * wrong thing.
 *
 * Server-only module: never import it from `src/`.
 */

/** A window rule: at most `limit` hits per `windowMs` for one key. */
export type RateLimitRule = { limit: number; windowMs: number };

/**
 * The budgets applied to the plan-change route.
 *
 * They are sized for a human confirming a purchase, not for a machine:
 * a customer may re-quote a few times while deciding, and the apply budget is
 * deliberately small because a successful apply is a one-off event.
 */
export const PLAN_CHANGE_RATE_LIMITS: Record<"preview" | "apply" | "ip", RateLimitRule> = {
  /** Quoting is read-only on Paddle's side, so it can be a little more generous. */
  preview: { limit: 12, windowMs: 60_000 },
  /** Applying takes money: six attempts per hour per account is already a lot. */
  apply: { limit: 6, windowMs: 60 * 60_000 },
  /** One address, all accounts: catches a script rotating tokens. */
  ip: { limit: 40, windowMs: 60_000 },
};

/** A PATCH may take up to two Paddle calls; the request timeout is 15s each. */
const LOCK_TTL_MS = 90_000;

/** Memory bounds, so a hostile caller cannot grow these maps without limit. */
const MAX_TRACKED_KEYS = 5_000;
const MAX_TRACKED_NONCES = 10_000;

const rateHits = new Map<string, number[]>();
/** Window of each tracked key, kept next to its hits so pruning stays correct. */
const rateWindows = new Map<string, number>();
const locks = new Map<string, number>();
const usedNonces = new Map<string, number>();

/** Drop keys whose window has fully elapsed. */
function pruneRateHits(nowMs: number) {
  for (const [key, stamps] of rateHits) {
    const windowMs = rateWindows.get(key) ?? 0;
    const alive = stamps.filter((stamp) => nowMs - stamp < windowMs);
    if (alive.length === 0) {
      rateHits.delete(key);
      rateWindows.delete(key);
    } else {
      rateHits.set(key, alive);
    }
  }
}

function trimToBound<K, V>(map: Map<K, V>, bound: number) {
  if (map.size <= bound) return;
  for (const key of [...map.keys()].slice(0, map.size - bound)) map.delete(key);
}

export type RateLimitVerdict =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; limit: number };

/**
 * Count one request against `rule` for `key`.
 *
 * Nothing is consumed when the call is refused, so a burst that hits the limit
 * does not extend its own window by its own failures.
 */
export function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  nowMs: number = Date.now(),
): RateLimitVerdict {
  const stampedKey = `${key}|${rule.windowMs}|${rule.limit}`;

  if (rateHits.size > MAX_TRACKED_KEYS) pruneRateHits(nowMs);

  const stamps = (rateHits.get(stampedKey) ?? []).filter((stamp) => nowMs - stamp < rule.windowMs);

  if (stamps.length >= rule.limit) {
    const oldest = stamps[0] ?? nowMs;
    const waitMs = Math.max(1_000, oldest + rule.windowMs - nowMs);
    rateHits.set(stampedKey, stamps);
    rateWindows.set(stampedKey, rule.windowMs);
    return { ok: false, retryAfterSeconds: Math.ceil(waitMs / 1_000), limit: rule.limit };
  }

  stamps.push(nowMs);
  rateHits.set(stampedKey, stamps);
  rateWindows.set(stampedKey, rule.windowMs);
  trimToBound(rateHits, MAX_TRACKED_KEYS);
  return { ok: true };
}

export type LockVerdict =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSeconds: number };

/**
 * Take the single-change lock for one Paddle subscription.
 *
 * Held from just before the re-preview until the PATCH has returned, so two
 * requests handled by the same instance can never both reach Paddle. Released
 * in a `finally`; the TTL is the safety net for a process that dies mid-flight.
 */
export function acquireSubscriptionLock(
  subscriptionId: string,
  nowMs: number = Date.now(),
): LockVerdict {
  const key = (subscriptionId ?? "").trim();
  if (!key) return { ok: false, retryAfterSeconds: 5 };

  for (const [id, expiresAt] of locks) {
    if (expiresAt <= nowMs) locks.delete(id);
  }
  trimToBound(locks, MAX_TRACKED_KEYS);

  const heldUntil = locks.get(key);
  if (heldUntil !== undefined && heldUntil > nowMs) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((heldUntil - nowMs) / 1_000)) };
  }

  locks.set(key, nowMs + LOCK_TTL_MS);

  let released = false;
  return {
    ok: true,
    release: () => {
      // Idempotent: a double `finally` must not steal a lock taken later.
      if (released) return;
      released = true;
      if (locks.get(key) === nowMs + LOCK_TTL_MS) locks.delete(key);
    },
  };
}

export type NonceVerdict = { ok: true } | { ok: false };

/**
 * Mark a quote's nonce as spent.
 *
 * The first call succeeds; every later call with the same nonce — a replayed
 * request, a back button, a second tab — is refused. The entry is dropped once
 * the quote would have expired anyway, so memory follows traffic, not history.
 */
export function consumeQuoteNonce(
  nonce: string,
  expiresAtMs: number,
  nowMs: number = Date.now(),
): NonceVerdict {
  const key = (nonce ?? "").trim();
  if (!key) return { ok: false };

  for (const [spent, expiresAt] of usedNonces) {
    if (expiresAt <= nowMs) usedNonces.delete(spent);
  }
  trimToBound(usedNonces, MAX_TRACKED_NONCES);

  if (usedNonces.has(key)) return { ok: false };

  usedNonces.set(key, Math.max(expiresAtMs, nowMs + 1_000));
  return { ok: true };
}

/**
 * Forget every counter, lock and spent nonce.
 *
 * Exists for the tests, which must not influence each other, and for nothing
 * else: it is not reachable from any route.
 */
export function resetPlanChangeGuard(): void {
  rateHits.clear();
  rateWindows.clear();
  locks.clear();
  usedNonces.clear();
}
