/**
 * VEYVRO — anti-abuse layers, and the invariant that keeps them from
 * overriding the contractual plan limits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE BUG THIS MODULE IS WRITTEN TO PREVENT
 * ─────────────────────────────────────────────────────────────────────────────
 * `api/chat.ts` currently applies **10 requests/minute and 60/hour per IP to
 * every caller**, before the plan is even consulted. The published plans are
 * 10 / 20 / 30 requests/minute (`src/lib/planLimits.ts`), so:
 *
 *   • a PLUS or PRO customer is silently capped at 10/minute — 20 and 30 are
 *     unreachable, i.e. the product promise is not what the server applies;
 *   • 60/hour makes PRO's 600 messages/day impossible in a burst.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE SIX LAYERS
 * ─────────────────────────────────────────────────────────────────────────────
 *  A. daily quota          per account  15 / 200 / 600 messages   DURABLE (SQL)
 *  B. contract burst       per account  10 / 20 / 30 per minute   memory, per instance
 *  C. failed-auth guard    per IP       20 failures per minute    memory, per instance
 *  D. authenticated net    per IP       120/min, 1200/hour        memory, per instance
 *  E. concurrency          per account  2, per instance 12        memory, per instance
 *  F. edge (Vercel WAF)    —            out of scope              Vercel
 *
 * Only A is a contract. B is part of the contract too (it is published). C and
 * E are protective **because they are keyed on the account**: no shared address
 * can multiply, divide or exhaust what one account is entitled to.
 *
 * D is a ceiling on an address, not on a person. It is derived to stay four
 * times above the largest published burst, so it cannot bind a single account;
 * but an address carrying more than four heavy accounts will meet it. That is
 * deliberate — an address is the only thing a script farm cannot rotate for
 * free — and it is why D is never keyed on anything else the client controls.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THIS MODULE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 *  • It does not touch the network or the database. Its only environment read is
 *    `VERCEL`, which `clientKeyFromHeaders` uses to decide whether the
 *    platform-issued client-IP headers may be trusted at all.
 *  • It does not decide identity: the caller must already have authenticated the
 *    request and must pass the verified account id.
 *  • Its counters live in the memory of one serverless instance. They reset on a
 *    cold start and do not aggregate across instances. That is acceptable for a
 *    guard rail, never for a quota — hence layer A in PostgreSQL.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PLAN_LIMITS, limitsFor, type PlanId } from "../src/lib/planLimits.js";

// ---------------------------------------------------------------------------
// Contract limits, read from the single source of truth
// ---------------------------------------------------------------------------

/** Per-plan burst allowance published on the pricing page. */
export const PLAN_BURST_LIMITS: Readonly<Record<PlanId, number>> = {
  decouverte: PLAN_LIMITS.decouverte.requestsPerMinute,
  plus: PLAN_LIMITS.plus.requestsPerMinute,
  pro: PLAN_LIMITS.pro.requestsPerMinute,
};

/** The most permissive burst any plan may legitimately reach. */
export const MAX_PLAN_REQUESTS_PER_MINUTE = Math.max(
  PLAN_LIMITS.decouverte.requestsPerMinute,
  PLAN_LIMITS.plus.requestsPerMinute,
  PLAN_LIMITS.pro.requestsPerMinute,
);

/** The largest finite daily message allowance any plan may legitimately reach. */
export const MAX_PLAN_MESSAGES_PER_DAY = Math.max(
  PLAN_LIMITS.decouverte.messagesPerDay ?? 0,
  PLAN_LIMITS.plus.messagesPerDay ?? 0,
  PLAN_LIMITS.pro.messagesPerDay ?? 0,
);

// ---------------------------------------------------------------------------
// Protective limits — DERIVED, never hardcoded
// ---------------------------------------------------------------------------
// Deriving them is the point: a future edit cannot reintroduce "10/minute for
// everyone" without also changing the plans. `assertAntiAbuseContract()` (and
// its test) fails loudly if the relationship is ever broken.

/**
 * Headroom demanded between the most permissive plan and the shared-IP net.
 *
 * An IP is not a person: offices, mobile carriers (CGNAT) and shared wifi put
 * several accounts behind one address. Four times the largest plan burst is the
 * documented floor.
 */
export const IP_MINUTE_HEADROOM = 4;

/** Headroom between the largest daily allowance and the hourly IP ceiling. */
export const IP_HOUR_HEADROOM = 2;

/** Layer D — authenticated requests from one IP, per minute. */
export const IP_REQUESTS_PER_MINUTE = MAX_PLAN_REQUESTS_PER_MINUTE * IP_MINUTE_HEADROOM;

/** Layer D — authenticated requests from one IP, per hour. */
export const IP_REQUESTS_PER_HOUR = Math.max(
  MAX_PLAN_MESSAGES_PER_DAY * IP_HOUR_HEADROOM,
  MAX_PLAN_REQUESTS_PER_MINUTE * IP_HOUR_HEADROOM * 10,
);

/** Layer C — failed authentications from one IP, per minute. */
export const AUTH_FAILURES_PER_MINUTE = 20;

/**
 * Layer E — concurrent requests, **per account** (never per address: see
 * `admitConcurrency`), and in total per serverless instance.
 */
export const MAX_CONCURRENT_REQUESTS_PER_ACCOUNT = 2;
export const MAX_CONCURRENT_REQUESTS_PER_INSTANCE = 12;

/** Retry hint attached to a saturated-concurrency refusal. */
export const BUSY_RETRY_AFTER_SECONDS = 5;

/**
 * Layer E — how long an in-flight slot is believed before it is reclaimed.
 *
 * The longest a chat request can legitimately hold a slot is the provider
 * timeout (45 s) plus the quota round trips, i.e. under 60 s. A lease of two
 * minutes therefore expires only a slot whose `release()` was never called —
 * which happens when the platform kills the function mid-request. Without this
 * bound, one such death would permanently consume one of the account's two
 * slots, and the customer would be told "too many simultaneous requests" until
 * a cold start. A guard rail must not be able to lock a paying account out.
 */
export const CONCURRENCY_LEASE_MS = 120_000;

/**
 * How often the concurrency map is swept for expired leases.
 *
 * Sweeping on every admission would cost a full map scan per request. The map is
 * bounded by MAX_TRACKED_ACCOUNTS and, in practice, by the instance ceiling, so
 * a sweep every few seconds is enough to keep a leaked slot short-lived.
 */
export const CONCURRENCY_SWEEP_INTERVAL_MS = 5_000;

/** How often idle sliding-window buckets are dropped (see `createSlidingWindowLimiter`). */
export const WINDOW_SWEEP_INTERVAL_MS = 30_000;

/** Bookkeeping bounds, so memory cannot grow without limit. */
export const MAX_TRACKED_CLIENTS = 5_000;
export const MAX_TRACKED_ACCOUNTS = 5_000;

/**
 * Verify the relationship between the contract and the guard rails.
 *
 * Deliberately **not** executed at import time: a broken constant must fail the
 * test suite, not crash a live function. Call it from tests (and from any
 * future startup check you trust).
 *
 * @throws Error describing every violated invariant.
 */
export function assertAntiAbuseContract(): void {
  const problems: string[] = [];

  for (const [plan, burst] of Object.entries(PLAN_BURST_LIMITS)) {
    if (burst > IP_REQUESTS_PER_MINUTE) {
      problems.push(`plan ${plan} allows ${burst}/min but the IP net allows ${IP_REQUESTS_PER_MINUTE}/min`);
    }
  }

  if (IP_REQUESTS_PER_MINUTE < MAX_PLAN_REQUESTS_PER_MINUTE * IP_MINUTE_HEADROOM) {
    problems.push(
      `IP minute net (${IP_REQUESTS_PER_MINUTE}) is below ${IP_MINUTE_HEADROOM}× the largest plan burst (${MAX_PLAN_REQUESTS_PER_MINUTE})`,
    );
  }

  if (MAX_PLAN_MESSAGES_PER_DAY > IP_REQUESTS_PER_HOUR * IP_HOUR_HEADROOM) {
    problems.push(
      `largest daily allowance (${MAX_PLAN_MESSAGES_PER_DAY}) exceeds the hourly IP net (${IP_REQUESTS_PER_HOUR}) beyond the allowed headroom`,
    );
  }

  if (IP_REQUESTS_PER_MINUTE <= MAX_PLAN_REQUESTS_PER_MINUTE) {
    problems.push("the IP minute net must be strictly above every plan burst");
  }

  if (problems.length > 0) {
    throw new Error(`rateLimits: anti-abuse contract violated — ${problems.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Sliding-window limiter (in-memory, per instance)
// ---------------------------------------------------------------------------

export type RateLimitVerdict =
  | { ok: true; used: number; limit: number }
  | { ok: false; used: number; limit: number; retryAfterSeconds: number };

export type SlidingWindowLimiter = {
  /** Count this request when the limit allows it, then report the verdict. */
  take(key: string, limit: number, nowMs?: number): RateLimitVerdict;
  /** Report the verdict without counting anything. */
  peek(key: string, limit: number, nowMs?: number): RateLimitVerdict;
  /** Number of tracked keys. */
  size(): number;
  /**
   * Drop the buckets whose entries are past their TTL, and report how many.
   *
   * Called periodically by `take`; exported so tests can prove the expiry
   * without waiting for a real clock.
   */
  sweep(nowMs?: number): number;
  /** Drop every bucket. Tests only. */
  reset(): void;
};

type Bucket = { timestamps: number[]; lastSeenAt: number };

export type SlidingWindowOptions = {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Idle buckets older than this are dropped. */
  entryTtlMs: number;
  /** Hard cap on tracked keys. */
  maxKeys: number;
};

/**
 * A rolling window keyed by an opaque string.
 *
 * `limit` is passed per call, not at construction: the same limiter instance
 * serves every plan, the limit being read from `planLimits` by the caller. This
 * is what makes "the plan decides, the guard rail only protects" enforceable
 * rather than a comment.
 */
export function createSlidingWindowLimiter(options: SlidingWindowOptions): SlidingWindowLimiter {
  const { windowMs, entryTtlMs, maxKeys } = options;
  const buckets = new Map<string, Bucket>();

  /**
   * Drop every bucket whose last sighting is older than the TTL.
   *
   * Verdict-neutral by construction: a bucket idle for `entryTtlMs` has an empty
   * window (`entryTtlMs >= windowMs` for every limiter built here), so removing
   * it cannot make a caller pass that would otherwise be refused. It only gives
   * memory back.
   */
  function pruneIdle(nowMs: number): number {
    let dropped = 0;
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.lastSeenAt > entryTtlMs) {
        buckets.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  let lastSweepAt = 0;

  function evictOldest(): void {
    // Leave room for the key about to be inserted: the map must never exceed
    // `maxKeys`, otherwise memory would keep growing by one entry per new key.
    while (buckets.size >= maxKeys) {
      let oldestKey: string | null = null;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [key, bucket] of buckets) {
        if (bucket.lastSeenAt < oldestSeen) {
          oldestSeen = bucket.lastSeenAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      buckets.delete(oldestKey);
    }
  }

  function active(key: string, nowMs: number): Bucket | null {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    bucket.timestamps = bucket.timestamps.filter((stamp) => nowMs - stamp < windowMs);
    return bucket;
  }

  function verdict(bucket: Bucket | null, limit: number, nowMs: number): RateLimitVerdict {
    const used = bucket?.timestamps.length ?? 0;
    if (used < limit) return { ok: true, used, limit };
    const oldest = bucket?.timestamps[0] ?? nowMs;
    const waitMs = Math.max(1_000, oldest + windowMs - nowMs);
    return { ok: false, used, limit, retryAfterSeconds: Math.ceil(waitMs / 1_000) };
  }

  return {
    take(key, limit, nowMs = Date.now()) {
      // Expired entries are given back on a schedule, not only when the map is
      // full: a quiet instance must not keep thousands of dead buckets for the
      // lifetime of the process.
      if (nowMs - lastSweepAt >= WINDOW_SWEEP_INTERVAL_MS) {
        pruneIdle(nowMs);
        lastSweepAt = nowMs;
      }
      // Only a *new* key can grow the map: an existing key must never evict
      // another one, or a busy instance would thrash its own counters.
      if (!buckets.has(key) && buckets.size >= maxKeys) {
        pruneIdle(nowMs);
        evictOldest();
      }
      const bucket = active(key, nowMs) ?? { timestamps: [], lastSeenAt: nowMs };
      const current = verdict(bucket, limit, nowMs);
      bucket.lastSeenAt = nowMs;
      if (current.ok) bucket.timestamps.push(nowMs);
      buckets.set(key, bucket);
      return current;
    },
    peek(key, limit, nowMs = Date.now()) {
      return verdict(active(key, nowMs), limit, nowMs);
    },
    size: () => buckets.size,
    sweep(nowMs = Date.now()) {
      lastSweepAt = nowMs;
      return pruneIdle(nowMs);
    },
    reset() {
      buckets.clear();
      lastSweepAt = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

const ipMinuteLimiter = createSlidingWindowLimiter({
  windowMs: 60_000,
  entryTtlMs: 5 * 60_000,
  maxKeys: MAX_TRACKED_CLIENTS,
});

const ipHourLimiter = createSlidingWindowLimiter({
  windowMs: 60 * 60_000,
  entryTtlMs: 2 * 60 * 60_000,
  maxKeys: MAX_TRACKED_CLIENTS,
});

const userMinuteLimiter = createSlidingWindowLimiter({
  windowMs: 60_000,
  entryTtlMs: 5 * 60_000,
  maxKeys: MAX_TRACKED_ACCOUNTS,
});

const authFailureLimiter = createSlidingWindowLimiter({
  windowMs: 60_000,
  entryTtlMs: 5 * 60_000,
  maxKeys: MAX_TRACKED_CLIENTS,
});

/**
 * Opaque key for a bucket: counters never need the raw account id or IP, and a
 * digest cannot be turned back into an identity if the process is inspected.
 * Same approach as `quotaKey` in `server/access.ts`.
 */
export function rateKey(prefix: "ip" | "user" | "client", value: string): string {
  const digest = createHash("sha256").update(`${prefix}:${(value ?? "").trim()}`, "utf8").digest("hex");
  return `${prefix}:${digest.slice(0, 32)}`;
}

/**
 * Key used when no trustworthy address can be established. It is a bucket like
 * any other: every unidentifiable caller shares it and is limited at the same
 * shared-IP ceiling, so a missing IP is never a free pass.
 */
export const UNKNOWN_CLIENT_KEY = "unknown";

/**
 * Environment shape read by `clientKeyFromHeaders`. Injectable so that tests
 * never depend on the ambient `process.env` of the machine running them.
 */
export type ClientKeyEnv = Record<string, string | undefined>;

/** Longest textual IPv6 form is 45 characters; anything near 64 is junk. */
const MAX_CLIENT_KEY_LENGTH = 64;

/**
 * Headers that may carry the client address, **in trust order**.
 *
 *  • `x-vercel-forwarded-for` — written by the Vercel platform itself and, unlike
 *    `x-forwarded-for`, still meaningful when another proxy sits in front of
 *    Vercel.
 *  • `x-real-ip` — documented as identical to `x-forwarded-for`.
 *  • `x-forwarded-for` — last resort, and only when it holds a single address.
 *
 * The leftmost entry of a list is never trusted: in an `x-forwarded-for` list
 * the leftmost element is the part a caller can write, so reading it would be a
 * spoofing bug rather than an optimisation.
 */
const CLIENT_IP_HEADERS = ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"] as const;

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  // Header names are case-insensitive: scan instead of guessing a casing.
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    // Several values for one header is ambiguous: refuse that source instead of
    // guessing which of them is the real peer.
    if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
    return value;
  }
  return undefined;
}

/**
 * Accept a header value only if it is exactly one valid IP address.
 *
 * Anything else — a comma-separated list, `host:port`, a zone index, a
 * hostname, a padded value, an oversized value — yields `undefined` instead of
 * an invented key.
 */
function singleIp(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || value.length > MAX_CLIENT_KEY_LENGTH) return undefined;
  // Explicit, rather than delegated to `isIP`: a list must never be resolved by
  // silently picking a side.
  if (value.includes(",")) return undefined;
  // `isIP` accepts an IPv6 zone index (`fe80::1%eth0`); a header value never
  // legitimately carries one, and allowing it would let one address occupy as
  // many buckets as there are spellings.
  if (value.includes("%")) return undefined;
  const version = isIP(value);
  if (version === 4) return value;
  // Canonical form, so `2001:DB8::1` and `2001:db8::1` share one bucket.
  if (version === 6) return value.toLowerCase();
  return undefined;
}

/**
 * Derive the client key used by layers C, D and E.
 *
 * Trust model — the platform guard comes first. Unless the code runs on Vercel
 * (`VERCEL === "1"`, written by the platform inside every deployed function),
 * the address headers are attacker-controlled and are ignored entirely; every
 * caller then shares `unknown` and therefore the strictest shared ceiling.
 * Failing closed keeps this guard from becoming an anonymity tool.
 *
 * The result is `unknown` whenever the address cannot be established with
 * certainty — callers must throttle `unknown` exactly like any other key.
 */
export function clientKeyFromHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  env: ClientKeyEnv = process.env,
): string {
  if (env?.VERCEL !== "1") return UNKNOWN_CLIENT_KEY;
  for (const name of CLIENT_IP_HEADERS) {
    const ip = singleIp(headerValue(headers, name));
    if (ip) return ip;
  }
  return UNKNOWN_CLIENT_KEY;
}

// ---------------------------------------------------------------------------
// Layer B — the contractual burst, per account
// ---------------------------------------------------------------------------

export type UserBurstVerdict =
  | { ok: true; used: number; limit: number }
  | { ok: false; kind: "rate_minute"; used: number; limit: number; retryAfterSeconds: number };

/** Count one request against the account's published per-minute allowance. */
export function checkUserBurst(
  userId: string,
  plan: PlanId | string,
  nowMs: number = Date.now(),
): UserBurstVerdict {
  const limit = limitsFor(plan).requestsPerMinute;
  const key = rateKey("user", userId);
  const result = userMinuteLimiter.take(key, limit, nowMs);
  if (result.ok) return result;
  return {
    ok: false,
    kind: "rate_minute",
    used: result.used,
    limit: result.limit,
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

// ---------------------------------------------------------------------------
// Layer D — the shared-IP net
// ---------------------------------------------------------------------------

export type IpNetVerdict =
  | { ok: true }
  | {
      ok: false;
      kind: "ip_rate_limited";
      window: "minute" | "hour";
      used: number;
      limit: number;
      retryAfterSeconds: number;
    };

/**
 * Count one **authenticated** request against the shared-IP net.
 *
 * Apply it *after* the account burst: this net exists to stop loops and script
 * leaks, never to define what a plan is worth.
 */
export function checkIpNet(ip: string, nowMs: number = Date.now()): IpNetVerdict {
  const key = rateKey("ip", ip);

  const minute = ipMinuteLimiter.take(key, IP_REQUESTS_PER_MINUTE, nowMs);
  if (!minute.ok) {
    return {
      ok: false,
      kind: "ip_rate_limited",
      window: "minute",
      used: minute.used,
      limit: minute.limit,
      retryAfterSeconds: minute.retryAfterSeconds,
    };
  }

  const hour = ipHourLimiter.take(key, IP_REQUESTS_PER_HOUR, nowMs);
  if (!hour.ok) {
    return {
      ok: false,
      kind: "ip_rate_limited",
      window: "hour",
      used: hour.used,
      limit: hour.limit,
      retryAfterSeconds: hour.retryAfterSeconds,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Layer C — failed authentications, per IP
// ---------------------------------------------------------------------------

export type AuthFailureVerdict = {
  blocked: boolean;
  used: number;
  limit: number;
  retryAfterSeconds: number;
};

/**
 * Read the failure counter without changing it.
 *
 * This guard only ever sees requests that **failed** to authenticate, so it can
 * never refuse a legitimate signed-in request whatever the plan.
 */
export function checkAuthFailures(ip: string, nowMs: number = Date.now()): AuthFailureVerdict {
  const result = authFailureLimiter.peek(rateKey("ip", ip), AUTH_FAILURES_PER_MINUTE, nowMs);
  return {
    blocked: !result.ok,
    used: result.used,
    limit: result.limit,
    retryAfterSeconds: result.ok ? 0 : result.retryAfterSeconds,
  };
}

/** Record one failed authentication (401 / 403 / invalid token). */
export function recordAuthFailure(ip: string, nowMs: number = Date.now()): AuthFailureVerdict {
  const result = authFailureLimiter.take(rateKey("ip", ip), AUTH_FAILURES_PER_MINUTE, nowMs);
  return {
    blocked: !result.ok,
    used: result.used,
    limit: result.limit,
    retryAfterSeconds: result.ok ? 0 : result.retryAfterSeconds,
  };
}

// ---------------------------------------------------------------------------
// Layer E — concurrency
// ---------------------------------------------------------------------------

export type ConcurrencyAdmission =
  | { ok: true; release: () => void }
  | { ok: false; kind: "rate_limited" | "busy"; retryAfterSeconds: number };

/**
 * In-flight slots per account, with the lease bookkeeping layer E was missing.
 *
 * `active` is the number of slots held right now; `lastAt` is the last time this
 * entry was touched (admission or release), which is what the lease TTL measures.
 */
type ConcurrencyEntry = { active: number; lastAt: number };

const accountConcurrency = new Map<string, ConcurrencyEntry>();
let instanceConcurrency = 0;
let lastConcurrencySweepAt = 0;

/**
 * Reclaim the slots whose lease expired, and report how many were reclaimed.
 *
 * An expired entry means a request that never released — a killed function, not
 * a slow customer. Its slots are subtracted from the instance counter too, so
 * the two numbers can never drift apart. A release that arrives *after* its own
 * entry was reclaimed finds nothing and changes nothing (see `release` below):
 * double-counting a departed request would hand out a slot that does not exist.
 */
export function sweepConcurrency(nowMs: number = Date.now()): number {
  let reclaimed = 0;
  for (const [key, entry] of accountConcurrency) {
    if (nowMs - entry.lastAt <= CONCURRENCY_LEASE_MS) continue;
    reclaimed += entry.active;
    accountConcurrency.delete(key);
  }
  if (reclaimed > 0) instanceConcurrency = Math.max(0, instanceConcurrency - reclaimed);
  lastConcurrencySweepAt = nowMs;
  return reclaimed;
}

/** Tracked accounts with at least one live slot, and total in-flight requests. */
export function concurrencySnapshot(): { accounts: number; instance: number } {
  return { accounts: accountConcurrency.size, instance: instanceConcurrency };
}

/**
 * Admit one in-flight request for one **verified account**, or explain why not.
 * Always `release()` the admission, in a `finally`.
 *
 * The key must be the account id — the one verified from the token — never the
 * client address. An address is not a person: keying on it would give a whole
 * office two slots for all its users (refusing a customer whose own plan allows
 * more) while letting a script farm rotate addresses at will. The instance
 * ceiling below is what bounds total concurrency.
 *
 * Passing anything other than the verified account id reintroduces a bug: the
 * IP layer must never decide what a plan is worth.
 */
export function admitConcurrency(accountId: string, nowMs: number = Date.now()): ConcurrencyAdmission {
  const key = rateKey("client", accountId);

  // Expired leases are reclaimed before the decision, so a slot leaked by a
  // killed request is never the reason a live customer is refused.
  if (nowMs - lastConcurrencySweepAt >= CONCURRENCY_SWEEP_INTERVAL_MS) sweepConcurrency(nowMs);

  // A periodic sweep alone would not be exact: a sweep that runs just before a
  // leash expires postpones the reclaim by a whole interval, and the customer
  // would be refused in the meantime. So the account being decided on is always
  // checked on its own, in O(1), whatever the schedule says.
  const held = accountConcurrency.get(key);
  if (held && nowMs - held.lastAt > CONCURRENCY_LEASE_MS) {
    instanceConcurrency = Math.max(0, instanceConcurrency - held.active);
    accountConcurrency.delete(key);
  }

  const entry = accountConcurrency.get(key);
  if ((entry?.active ?? 0) >= MAX_CONCURRENT_REQUESTS_PER_ACCOUNT) {
    return { ok: false, kind: "rate_limited", retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
  }
  if (instanceConcurrency >= MAX_CONCURRENT_REQUESTS_PER_INSTANCE) {
    // Before refusing the whole instance, give back anything that has expired:
    // a ceiling made of dead slots is not a saturation, and saying "busy" for it
    // would be a lie told to a customer who did nothing wrong.
    sweepConcurrency(nowMs);
  }
  if (instanceConcurrency >= MAX_CONCURRENT_REQUESTS_PER_INSTANCE) {
    return { ok: false, kind: "busy", retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
  }
  // Last line of defence against unbounded growth: refuse rather than let the
  // map pass its cap. Unreachable in practice — the instance ceiling is twelve,
  // and every entry above that has to be an expired lease, which was just
  // reclaimed.
  if (!entry && accountConcurrency.size >= MAX_TRACKED_ACCOUNTS) {
    return { ok: false, kind: "busy", retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
  }

  const next: ConcurrencyEntry = entry ?? { active: 0, lastAt: nowMs };
  next.active += 1;
  next.lastAt = nowMs;
  accountConcurrency.set(key, next);
  instanceConcurrency += 1;

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      // Identity, not just presence: an entry that was reclaimed and then
      // replaced by a *new* admission for the same account is a different
      // object. Releasing the old one must not decrement the new one — that
      // would hand the next caller a slot that is actually in use.
      if (accountConcurrency.get(key) !== next) return;
      next.active -= 1;
      next.lastAt = Date.now();
      if (next.active <= 0) accountConcurrency.delete(key);
      instanceConcurrency = Math.max(0, instanceConcurrency - 1);
    },
  };
}

/** In-flight requests on this instance. */
export function activeInstanceRequests(): number {
  return instanceConcurrency;
}

/** Forget every counter. Tests only — not reachable from any route. */
export function resetRateLimits(): void {
  ipMinuteLimiter.reset();
  ipHourLimiter.reset();
  userMinuteLimiter.reset();
  authFailureLimiter.reset();
  accountConcurrency.clear();
  instanceConcurrency = 0;
  lastConcurrencySweepAt = 0;
}

/**
 * Run every expiry sweep now, and report what was dropped.
 *
 * Exists so a test can prove the TTL behaviour without waiting for a real clock,
 * and so an operator could force a cleanup if a deployment ever suspected a leak.
 * Not reachable from any route.
 */
export function sweepExpiredEntries(nowMs: number = Date.now()): {
  concurrency: number;
  windows: number;
} {
  const concurrency = sweepConcurrency(nowMs);
  const windows =
    ipMinuteLimiter.sweep(nowMs) +
    ipHourLimiter.sweep(nowMs) +
    userMinuteLimiter.sweep(nowMs) +
    authFailureLimiter.sweep(nowMs);
  return { concurrency, windows };
}
