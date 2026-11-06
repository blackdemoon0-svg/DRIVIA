/**
 * Per-account quotas for the VEYVRO chat.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THESE COUNTERS ARE, AND WHAT THEY ARE NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * The counters live in the memory of a single serverless instance. That makes
 * them:
 *   • best-effort, NOT durable — a cold start, a redeploy or a second instance
 *     resets or splits them;
 *   • NOT resistant to a determined user, who can wait for a cold start, or
 *     simply be routed to an instance whose counters do not know them yet;
 *   • adequate for stopping accidental loops and casual overuse, which is the
 *     entire purpose here.
 *
 * They are explicitly NOT a billing meter and NOT an abuse-proof quota. A
 * durable counter needs a shared store (a table with a dated row per account,
 * or Redis), which means a migration: that is a separate, owner-approved step.
 * Until then, the honest description is "soft limits, per instance".
 *
 * What they DO enforce reliably, within these limits, is the product rule: a
 * Découverte account cannot exceed 15 messages a day while a Pro account can
 * reach 600, and the decision is taken from the plan read in the database —
 * never from anything the browser sends.
 */

import { limitsFor, type PlanLimits, type PlanId } from "../src/lib/planLimits.js";
import { quotaKey } from "./access.js";

/** One day, used to compute the retry delay of a daily quota. */
const DAY_MS = 86_400_000;

/** Counters are dropped when untouched for this long: memory cannot grow forever. */
const ENTRY_TTL_MS = 2 * DAY_MS;

/** Hard cap on tracked accounts per instance, so memory stays bounded. */
const MAX_TRACKED_ACCOUNTS = 5_000;

type AccountCounters = {
  /** `YYYY-MM-DD` in UTC: the day the counts below belong to. */
  day: string;
  messages: number;
  quotes: number;
  /** Timestamps of the requests in the current minute window. */
  requestTimestamps: number[];
  lastSeenAt: number;
};

const counters = new Map<string, AccountCounters>();

/** UTC day key: quotas reset at midnight UTC, the same instant for everyone. */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Milliseconds until the next UTC midnight, i.e. until the daily quota resets. */
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

function prune(nowMs: number) {
  for (const [key, entry] of counters) {
    if (nowMs - entry.lastSeenAt > ENTRY_TTL_MS) counters.delete(key);
  }

  // Still too many accounts: drop the least recently seen ones.
  if (counters.size <= MAX_TRACKED_ACCOUNTS) return;
  const ordered = [...counters.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  for (const [key] of ordered.slice(0, counters.size - MAX_TRACKED_ACCOUNTS)) {
    counters.delete(key);
  }
}

function entryFor(userId: string, nowMs: number): AccountCounters {
  const key = quotaKey(userId);
  const day = utcDayKey(nowMs);
  const existing = counters.get(key);

  if (!existing) {
    const fresh: AccountCounters = {
      day,
      messages: 0,
      quotes: 0,
      requestTimestamps: [],
      lastSeenAt: nowMs,
    };
    counters.set(key, fresh);
    return fresh;
  }

  // New UTC day: the daily counts start over. The minute window does not.
  if (existing.day !== day) {
    existing.day = day;
    existing.messages = 0;
    existing.quotes = 0;
  }
  existing.lastSeenAt = nowMs;
  return existing;
}

export type QuotaKind = "daily_messages" | "daily_quotes" | "rate_minute";

export type QuotaVerdict =
  | { ok: true; limits: PlanLimits; used: { messages: number; quotes: number } }
  | {
      ok: false;
      kind: QuotaKind;
      /** Seconds the caller should wait: sent as `Retry-After`. */
      retryAfterSeconds: number;
      limit: number;
      used: number;
      error: string;
    };

export type ConsumeOptions = {
  userId: string;
  plan: PlanId;
  /** True when the request is a garage-quote analysis, which has its own quota. */
  isQuoteAnalysis: boolean;
  nowMs?: number;
};

/**
 * Count one request against the account's quotas.
 *
 * Order of checks, and why:
 *  1. the per-minute window first — it is the cheapest to satisfy and keeps a
 *     burst from burning the daily allowance in seconds;
 *  2. the daily message allowance;
 *  3. the daily quote allowance, for garage-quote requests only.
 *
 * Nothing is consumed when a check fails, so a refused request cannot make the
 * next legitimate one fail as well. The counters are only incremented once the
 * request is about to be processed.
 */
export function consumeQuota(options: ConsumeOptions): QuotaVerdict {
  const nowMs = options.nowMs ?? Date.now();
  const limits = limitsFor(options.plan);

  if (counters.size > MAX_TRACKED_ACCOUNTS) prune(nowMs);

  const entry = entryFor(options.userId, nowMs);

  // 1. Rolling minute window, sized by the plan.
  entry.requestTimestamps = entry.requestTimestamps.filter((stamp) => nowMs - stamp < 60_000);
  if (entry.requestTimestamps.length >= limits.requestsPerMinute) {
    const oldest = entry.requestTimestamps[0] ?? nowMs;
    const waitMs = Math.max(1_000, oldest + 60_000 - nowMs);
    return {
      ok: false,
      kind: "rate_minute",
      retryAfterSeconds: Math.ceil(waitMs / 1_000),
      limit: limits.requestsPerMinute,
      used: entry.requestTimestamps.length,
      error: `Too many requests for your plan (${limits.requestsPerMinute} per minute). Please wait a moment.`,
    };
  }

  // 2. Daily message allowance. `null` means unlimited by contract.
  if (limits.messagesPerDay !== null && entry.messages >= limits.messagesPerDay) {
    return {
      ok: false,
      kind: "daily_messages",
      retryAfterSeconds: Math.ceil(msUntilNextUtcDay(nowMs) / 1_000),
      limit: limits.messagesPerDay,
      used: entry.messages,
      error: `You have reached your daily allowance of ${limits.messagesPerDay} messages. It resets at midnight UTC.`,
    };
  }

  // 3. Daily garage-quote allowance.
  if (
    options.isQuoteAnalysis &&
    limits.quoteAnalysesPerDay !== null &&
    entry.quotes >= limits.quoteAnalysesPerDay
  ) {
    return {
      ok: false,
      kind: "daily_quotes",
      retryAfterSeconds: Math.ceil(msUntilNextUtcDay(nowMs) / 1_000),
      limit: limits.quoteAnalysesPerDay,
      used: entry.quotes,
      error: `You have reached your daily allowance of ${limits.quoteAnalysesPerDay} garage-quote analysis. It resets at midnight UTC.`,
    };
  }

  // Everything passes: commit the consumption.
  entry.requestTimestamps.push(nowMs);
  entry.messages += 1;
  if (options.isQuoteAnalysis) entry.quotes += 1;

  return { ok: true, limits, used: { messages: entry.messages, quotes: entry.quotes } };
}

/** Current usage for one account, without consuming anything. */
export function readQuotaUsage(
  userId: string,
  nowMs: number = Date.now(),
): { messages: number; quotes: number; day: string } {
  const entry = counters.get(quotaKey(userId));
  const day = utcDayKey(nowMs);
  if (!entry || entry.day !== day) return { messages: 0, quotes: 0, day };
  return { messages: entry.messages, quotes: entry.quotes, day };
}

/**
 * Forget every counter.
 *
 * Exists for the tests, which must not influence each other, and for nothing
 * else: it is not reachable from any route.
 */
export function resetQuotas(): void {
  counters.clear();
}
