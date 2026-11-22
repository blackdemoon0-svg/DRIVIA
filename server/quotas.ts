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
  /** Voice seconds consumed today (UTC): a session is billed by duration. */
  voiceSeconds: number;
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
      voiceSeconds: 0,
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
    existing.voiceSeconds = 0;
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
): { messages: number; quotes: number; voiceSeconds: number; day: string } {
  const entry = counters.get(quotaKey(userId));
  const day = utcDayKey(nowMs);
  if (!entry || entry.day !== day) return { messages: 0, quotes: 0, voiceSeconds: 0, day };
  return {
    messages: entry.messages,
    quotes: entry.quotes,
    voiceSeconds: entry.voiceSeconds,
    day,
  };
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

// ---------------------------------------------------------------------------
// Voice Live allowance
// ---------------------------------------------------------------------------
//
// The voice allowance lives in the SAME counter object as messages and quotes:
// one account has one entry, reset at the same UTC midnight. It is a new field
// on the existing store, not a second quota system.
//
// Difference with messages: a voice session is not a discrete request, it has a
// duration. So the allowance is reserved when the session starts and released
// when it ends, instead of being incremented once and for all.
//
// Why a reservation: without it, a user could open several sessions in
// parallel, each one passing the check, and exceed the daily allowance by a
// multiple. With it, the seconds are reserved up front and adjusted down to the
// real duration at close time.

/** How long one reserved session may run before the server stops counting. */
export const VOICE_RESERVATION_SECONDS = 60;

export type VoiceQuotaVerdict =
  | {
      ok: true;
      limits: PlanLimits;
      /** Seconds reserved for this session, released when it closes. */
      reservedSeconds: number;
      /** Remaining seconds for the day after the reservation. */
      remainingSeconds: number;
    }
  | {
      ok: false;
      kind: "voice_not_in_plan" | "voice_minutes_exhausted";
      retryAfterSeconds: number;
      limit: number;
      used: number;
      error: string;
    };

/**
 * Reserve voice time for one session.
 *
 * Refuses before any provider call when the plan has no voice allowance
 * (`voiceMinutesPerDay === 0`) or when the day's allowance is spent. The
 * `/api/voice-session` route calls this *before* creating a Live session, so a
 * refused request never costs a cent at OpenAI.
 */
export function reserveVoiceQuota(options: {
  userId: string;
  plan: PlanId;
  /** Seconds to reserve. Defaults to the standard reservation. */
  seconds?: number;
  nowMs?: number;
}): VoiceQuotaVerdict {
  const nowMs = options.nowMs ?? Date.now();
  const limits = limitsFor(options.plan);
  const reserveSeconds = Math.max(1, Math.floor(options.seconds ?? VOICE_RESERVATION_SECONDS));

  if (limits.voiceMinutesPerDay <= 0) {
    return {
      ok: false,
      kind: "voice_not_in_plan",
      retryAfterSeconds: 0,
      limit: 0,
      used: 0,
      error:
        "La conversation vocale fait partie des formules VEYVRO Plus et Pro. / Voice conversation is part of the VEYVRO Plus and Pro plans.",
    };
  }

  if (counters.size > MAX_TRACKED_ACCOUNTS) prune(nowMs);
  const entry = entryFor(options.userId, nowMs);
  const allowanceSeconds = limits.voiceMinutesPerDay * 60;
  const usedSeconds = entry.voiceSeconds;

  if (usedSeconds + reserveSeconds > allowanceSeconds) {
    return {
      ok: false,
      kind: "voice_minutes_exhausted",
      retryAfterSeconds: Math.ceil(msUntilNextUtcDay(nowMs) / 1_000),
      limit: limits.voiceMinutesPerDay,
      used: Math.floor(usedSeconds / 60),
      error: `Vous avez atteint votre quota vocal de ${limits.voiceMinutesPerDay} minutes pour aujourd'hui. Il revient à minuit UTC. / You have reached your daily voice allowance of ${limits.voiceMinutesPerDay} minutes. It resets at midnight UTC.`,
    };
  }

  entry.voiceSeconds += reserveSeconds;

  return {
    ok: true,
    limits,
    reservedSeconds: reserveSeconds,
    remainingSeconds: allowanceSeconds - entry.voiceSeconds,
  };
}

/**
 * Settle a finished session: give back the reservation, keep the real duration.
 *
 * Called by `/api/voice-end`. A session that lasted 90 s with a 60 s
 * reservation must consume 90 s, not 60: the release is `reserved - real`, and
 * it is allowed to be negative (the extra time is charged).
 *
 * Idempotent per session, because the client may call it twice (tab closed, then
 * a late beacon): see `settledVoiceSessions`.
 */
export function settleVoiceQuota(options: {
  userId: string;
  reservedSeconds: number;
  actualSeconds: number;
  nowMs?: number;
}): { usedSeconds: number; chargedSeconds: number } {
  const nowMs = options.nowMs ?? Date.now();
  if (counters.size > MAX_TRACKED_ACCOUNTS) prune(nowMs);
  const entry = entryFor(options.userId, nowMs);

  const actual = Math.max(0, Math.floor(options.actualSeconds));
  const reserved = Math.max(0, Math.floor(options.reservedSeconds));
  // Replace the reservation with the truth (never below zero).
  entry.voiceSeconds = Math.max(0, entry.voiceSeconds - reserved + actual);

  return { usedSeconds: entry.voiceSeconds, chargedSeconds: actual };
}

/** Voice seconds used today, without consuming anything. */
export function readVoiceUsage(userId: string, nowMs: number = Date.now()): number {
  const entry = counters.get(quotaKey(userId));
  if (!entry || entry.day !== utcDayKey(nowMs)) return 0;
  return entry.voiceSeconds;
}
