/**
 * VEYVRO — durable AI usage store (PostgREST RPC client).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THIS MODULE IS
 * ─────────────────────────────────────────────────────────────────────────────
 * The server-side half of the durable quotas. It speaks **only** to the three
 * PostgreSQL functions of migration 0003, through PostgREST RPC:
 *
 *   ai_usage_consume  → charge one message, atomically and idempotently
 *   ai_usage_refund   → give the message back when the AI provider failed
 *   ai_usage_read     → read today's counters, read-only
 *
 * It never reads or writes `public.ai_usage_daily` / `public.ai_usage_events`
 * directly. That is deliberate and load-bearing:
 *
 *   • the two writes of one consumption (ledger row + counter) happen inside the
 *     *same* SQL function, therefore in the same transaction — splitting them
 *     into two PostgREST calls from here would destroy that atomicity;
 *   • the server holds no table privilege, so a future refactor cannot quietly
 *     reintroduce a non-atomic path: the request would simply fail.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  FAIL-CLOSED, ALWAYS
 * ─────────────────────────────────────────────────────────────────────────────
 * Missing configuration, an RPC error, a timeout or an unreachable network all
 * produce `not_configured` / `unavailable` — never a "go ahead" and never a
 * fallback to the in-memory counters. The same philosophy as
 * `server/access.ts:readAccessEnv`, which answers 503 rather than grant a plan.
 *
 * This module never throws for an operational reason: every outcome is a
 * discriminated result the route can translate. A non-finite clock is refused
 * before anything is sent, rather than formatted into an invalid `Date`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REFUSED BEFORE THE CALL — 401 and 400, not 503
 * ─────────────────────────────────────────────────────────────────────────────
 * Two families of client error are decided here, before any byte is sent:
 *
 *   • no usable account identifier ⇒ `unauthenticated` (HTTP 401). An empty or
 *     malformed `userId` is an authentication problem: telling the caller to
 *     "retry shortly" (503) would hide a session that has to be renewed.
 *   • a `consumptionId` that is not a UUID ⇒ `invalid_identifier` (HTTP 400).
 *     Forwarded as-is, PostgreSQL would answer 22P02 and this client would report
 *     a 503 outage for what is a malformed request.
 *
 * The rule is the same for a malformed *answer*: counters that are not
 * non-negative integers produce `invalid_response` (503), never a silent zero.
 * A zero would be a lie in the reassuring direction — the worst kind here.
 * `usageFailureStatus()` below is the single place that turns an outcome into a
 * status code, so a route cannot invent its own mapping.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT IS NOT GUARANTEED (yet)
 * ─────────────────────────────────────────────────────────────────────────────
 * Idempotence and atomicity are properties of migration 0003, which does not
 * exist yet. The tests of this module stub the transport: they prove the
 * MAPPING of every answer and the fail-closed behaviour — not the behaviour of
 * PostgreSQL. Nothing here may claim more until the SQL is written (P2),
 * applied and probed (P3), and exercised by the live suite (P4).
 *
 * `applied` on an `unavailable` outcome follows one strict rule: `"no"` only
 * where the absence of any request is provable by construction, i.e. a
 * pre-flight refusal that emitted nothing. Every failure that went through the
 * network is `"unknown"` — including a 4xx and a 500, because a status received
 * by this client demonstrates neither the provenance of the answer nor that
 * nothing was written upstream. Being wrong towards `"unknown"` costs one
 * harmless idempotent refund call; the opposite error loses a paid message.
 */

import { limitsFor, type PlanId, type PlanLimits } from "../src/lib/planLimits.js";
import { msUntilNextUtcDay, utcDayKey } from "./utcDay.js";
import { CONSUMPTION_ID_PATTERN } from "./consumptionId.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Variable names exactly as configured in Vercel — read as-is, never renamed. */
export const USAGE_ENV_KEYS = {
  supabaseUrl: "SUPABASE_URL",
  serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
} as const;

/** PostgreSQL functions of migration 0003. Only these are ever called. */
export const USAGE_RPC = {
  consume: "ai_usage_consume",
  refund: "ai_usage_refund",
  read: "ai_usage_read",
} as const;

/** PostgREST prefix. No table path is ever built by this module. */
const REST_RPC_PREFIX = "/rest/v1/rpc/";

const DEFAULT_TIMEOUT_MS = 5_000;

export type UsageStoreEnv = {
  url: string;
  serviceRoleKey: string;
};

type RawEnv = Record<string, string | undefined>;

/**
 * Read the server configuration.
 *
 * Returns `null` when either value is missing: the caller must then answer 503
 * rather than count anything. Missing configuration is never "unlimited".
 */
export function readUsageStoreEnv(env: RawEnv = process.env): UsageStoreEnv | null {
  const url = env[USAGE_ENV_KEYS.supabaseUrl]?.trim().replace(/\/+$/, "");
  const serviceRoleKey = env[USAGE_ENV_KEYS.serviceRoleKey]?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type UsageStoreOptions = {
  /** Injected in tests; defaults to `readUsageStoreEnv()`. */
  env?: UsageStoreEnv | null;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected clock, in milliseconds. */
  now?: () => number;
  /** Abort delay for one RPC call. */
  timeoutMs?: number;
  /**
   * Plan limits override. **Test seam only**: production always derives them
   * from the plan id through `limitsFor`, which is the single source of truth.
   */
  limits?: PlanLimits;
};

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

/**
 * A transport-level failure. It is always `applied: "unknown"`: this client
 * cannot prove that nothing was written upstream — see "WHAT IS NOT GUARANTEED".
 * `"no"` is only ever produced by a pre-flight refusal, before any call here.
 */
type RpcFailure = { ok: false; detail: string; applied: "unknown" };
type RpcSuccess<T> = { ok: true; rows: T[] };

async function callRpc<T>(
  env: UsageStoreEnv,
  functionName: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<RpcSuccess<T> | RpcFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetchImpl(`${env.url}${REST_RPC_PREFIX}${functionName}`, {
      method: "POST",
      headers: {
        // The service role key never leaves the server: it is the only reason
        // these functions are executable at all (see migration 0003).
        apikey: env.serviceRoleKey,
        Authorization: `Bearer ${env.serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      // The status is safe to log; the body could echo input, so it is dropped.
      // The status is deliberately NOT interpreted: a code received here proves
      // neither who produced it (PostgREST, the Supabase edge, a proxy on top)
      // nor that nothing was written before it was emitted. Hence "unknown" —
      // for a 500 as much as for a 4xx.
      return {
        ok: false,
        detail: `${functionName} answered ${response.status}`,
        applied: "unknown",
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // `response.ok` means the statement RAN: an unreadable body is the most
      // dangerous failure of all and must never be reported as "nothing
      // happened". It is not a network failure either, so it gets its own motif.
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        detail: aborted ? `${functionName} timed out` : `${functionName} unreadable response`,
        applied: "unknown",
      };
    }
    // PostgREST returns a JSON array for a `returns table` function; a single
    // object is accepted defensively so an API change cannot silently pass.
    if (Array.isArray(payload)) return { ok: true, rows: payload as T[] };
    if (payload && typeof payload === "object") return { ok: true, rows: [payload as T] };
    return { ok: true, rows: [] };
  } catch (error) {
    // The request was emitted: whether PostgreSQL saw it is unknowable here.
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      detail: aborted ? `${functionName} timed out` : `${functionName} unreachable`,
      applied: "unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveDeps(env: RawEnv, options: UsageStoreOptions) {
  return {
    env: options.env === undefined ? readUsageStoreEnv(env) : options.env,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A counter, or `null` when the value cannot be one.
 *
 * Deliberately **not** "default to 0": a malformed answer must surface as an
 * error, never as "nothing was consumed". PostgREST returns JSON numbers for
 * `integer` columns; a digit-only string is accepted for robustness. Everything
 * else — `null`, `undefined`, an object, a boolean, a negative, a fractional, a
 * `NaN` or an infinity — is refused. A zero is a statement about the account,
 * so it must never be invented from garbage.
 */
function asCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The shape of an account identifier this store may act on.
 *
 * `server/access.ts` only ever hands over an `auth.users.id`, which is a UUID;
 * anything else is not an identity this module can bill. Kept local on purpose:
 * the store must not import the access layer (and its Supabase client) just to
 * reuse a regex.
 */
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IdentityCheck = { ok: true; userId: string } | { ok: false; kind: "unauthenticated" };
type IdentifierCheck = { ok: true; consumptionId: string } | { ok: false; kind: "invalid_identifier" };

/**
 * Verify the account before anything else — including the configuration.
 *
 * An unidentifiable caller is an authentication failure whatever the state of
 * the server: answering 503 would send a signed-out user to a "service
 * unavailable" page instead of a sign-in form.
 */
function checkIdentity(raw: unknown): IdentityCheck {
  const userId = typeof raw === "string" ? raw.trim() : "";
  if (!userId || !USER_ID_PATTERN.test(userId)) return { ok: false, kind: "unauthenticated" };
  return { ok: true, userId };
}

/**
 * Verify the consumption identifier before anything else.
 *
 * `CONSUMPTION_ID_PATTERN` is the same rule `server/consumptionId.ts` applies
 * when it builds an identifier, so a value accepted here is always one the SQL
 * primary key can store. A present-but-wrong value is refused, never replaced:
 * silently generating a new one would turn a retry into a second charge.
 */
function checkConsumptionId(raw: unknown): IdentifierCheck {
  const consumptionId = typeof raw === "string" ? raw.trim() : "";
  if (!CONSUMPTION_ID_PATTERN.test(consumptionId)) return { ok: false, kind: "invalid_identifier" };
  return { ok: true, consumptionId };
}

/**
 * A usable epoch-ms value, or `null`.
 *
 * `new Date(NaN).toISOString()` throws a `RangeError`, and `utcDayKey(NaN)`
 * would do the same: an invalid clock must be refused *before* it reaches
 * either, so this module keeps its promise of never throwing.
 */
function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

export type ConsumeOutcome =
  | {
      ok: true;
      kind: "consumed";
      usageDay: string;
      messages: number;
      quotes: number;
      limits: PlanLimits;
    }
  /** The identifier was already consumed: no AI call, no second charge. */
  | { ok: false; kind: "duplicate"; usageDay: string | null }
  /** The identifier exists for another account, or another kind of message. */
  | { ok: false; kind: "conflict"; usageDay: string | null }
  | {
      ok: false;
      kind: "daily_messages" | "daily_quotes";
      usageDay: string | null;
      messages: number;
      quotes: number;
      limit: number;
      retryAfterSeconds: number;
    }
  /** A plan with no finite daily message allowance: refused, never "unlimited". */
  | { ok: false; kind: "unsupported_limits" }
  | { ok: false; kind: "not_configured" }
  /** No usable account: the caller must sign in — HTTP 401, never 503. */
  | { ok: false; kind: "unauthenticated" }
  /** The identifier is not a UUID: malformed request — HTTP 400. */
  | { ok: false; kind: "invalid_identifier" }
  /** The function answered something unusable: an error, never a silent zero. */
  | { ok: false; kind: "invalid_response"; detail: string; applied: "unknown" }
  /**
   * The outcome is unknown. `applied` states whether a request was emitted at
   * all: `"no"` is a pre-flight refusal (nothing was sent, nothing can have been
   * charged), `"unknown"` means the call went out and may or may not have been
   * committed. The route must treat `"unknown"` as "possibly charged" — see the
   * refund policy in the module header.
   */
  | { ok: false; kind: "unavailable"; detail: string; applied: "no" | "unknown" };

export type ConsumeParams = {
  /** Identity verified from the Supabase token — never from a request body. */
  userId: string;
  /** Canonical identifier produced by `server/consumptionId.ts`. */
  consumptionId: string;
  plan: PlanId | string;
  isQuoteAnalysis: boolean;
  /**
   * Explicit clock, in milliseconds.
   *
   * When provided — tests only — it is forwarded as `p_now`. Production never
   * provides it, so the UTC day is always derived by PostgreSQL from `now()`,
   * which removes any way for a caller to pick the day it is charged on.
   */
  nowMs?: number;
};

type ConsumeRow = {
  allowed?: unknown;
  reason?: unknown;
  used_messages?: unknown;
  used_quotes?: unknown;
  usage_day?: unknown;
  replayed?: unknown;
};

/**
 * Charge one message against the durable daily counters.
 *
 * Atomicity and idempotence are obligations of `ai_usage_consume`: the ledger
 * insert and the counter increment must happen inside that one function, in one
 * transaction, and the identifier must make a replay a no-op. This module cannot
 * verify either — the SQL does not exist yet (see "WHAT IS NOT GUARANTEED").
 */
export async function consumeDurableUsage(
  params: ConsumeParams,
  options: UsageStoreOptions = {},
  rawEnv: RawEnv = process.env,
): Promise<ConsumeOutcome> {
  const deps = resolveDeps(rawEnv, options);

  // Identity, then identifier, then configuration: the most specific answer
  // wins. A signed-out caller gets 401 even when the server is misconfigured,
  // and a malformed identifier gets 400 without a round trip.
  const identity = checkIdentity(params.userId);
  if (!identity.ok) return identity;
  const identifier = checkConsumptionId(params.consumptionId);
  if (!identifier.ok) return identifier;
  if (!deps.env) return { ok: false, kind: "not_configured" };

  const userId = identity.userId;
  const consumptionId = identifier.consumptionId;

  const limits = options.limits ?? limitsFor(params.plan);
  // The SQL refuses a NULL message limit; refusing here keeps the failure
  // explicit instead of turning a bad plan row into an unlimited allowance.
  if (limits.messagesPerDay === null) return { ok: false, kind: "unsupported_limits" };

  const nowMs = finiteMs(params.nowMs ?? deps.now());
  if (nowMs === null) {
    // Refused before anything is built: this is the only place where the
    // absence of a request — and therefore of a charge — is provable.
    return {
      ok: false,
      kind: "unavailable",
      detail: "ai_usage_consume: non-finite clock",
      applied: "no",
    };
  }

  const body: Record<string, unknown> = {
    p_user_id: userId,
    p_consumption_id: consumptionId,
    p_limit_messages: limits.messagesPerDay,
    p_limit_quotes: limits.quoteAnalysesPerDay,
    p_is_quote: params.isQuoteAnalysis,
  };
  if (params.nowMs !== undefined) body.p_now = new Date(nowMs).toISOString();

  const result = await callRpc<ConsumeRow>(deps.env, USAGE_RPC.consume, body, deps.fetchImpl, deps.timeoutMs);
  if (!result.ok) {
    return { ok: false, kind: "unavailable", detail: result.detail, applied: result.applied };
  }

  const row = result.rows[0];
  if (!row) {
    return {
      ok: false,
      kind: "unavailable",
      detail: "ai_usage_consume returned no row",
      applied: "unknown",
    };
  }

  const usageDay = asString(row.usage_day);
  const messages = asCount(row.used_messages);
  const quotes = asCount(row.used_quotes);
  const reason = asString(row.reason);

  // Whatever this client cannot read unambiguously is an error, never a zero:
  // "0 consumed" is a claim about the account, not a safe default.
  const unusable = (what: string): ConsumeOutcome => ({
    ok: false,
    kind: "invalid_response",
    detail: `ai_usage_consume returned unusable ${what}`,
    applied: "unknown",
  });

  if (row.allowed === true) {
    if (!usageDay || messages === null || quotes === null) return unusable("counters");
    // A replay means the message was already charged: the route must answer 409
    // and must not call the AI provider — otherwise one identifier would buy
    // unlimited answers.
    if (row.replayed === true || reason === "replay") return { ok: false, kind: "duplicate", usageDay };
    return { ok: true, kind: "consumed", usageDay, messages, quotes, limits };
  }

  switch (reason) {
    case "daily_messages":
    case "daily_quotes":
      if (!usageDay || messages === null || quotes === null) return unusable("counters");
      return {
        ok: false,
        kind: reason,
        usageDay,
        messages,
        quotes,
        limit: reason === "daily_messages" ? (limits.messagesPerDay ?? 0) : (limits.quoteAnalysesPerDay ?? 0),
        retryAfterSeconds: Math.ceil(msUntilNextUtcDay(nowMs) / 1_000),
      };
    case "consumption_conflict":
    // No longer emitted by the corrected SQL (a refunded identifier is
    // re-consumable), kept mapped so an older deployment is still understood.
    case "consumption_refunded":
      if (!usageDay) return unusable("usage_day");
      return { ok: false, kind: "conflict", usageDay };
    default:
      // Unknown reason: fail closed rather than guess a verdict. The function
      // answered, so this module cannot claim nothing was written.
      return {
        ok: false,
        kind: "unavailable",
        detail: `ai_usage_consume refused: ${reason ?? "no reason"}`,
        applied: "unknown",
      };
  }
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

export type RefundOutcome =
  | { ok: true; refunded: boolean; usageDay: string | null }
  | {
      ok: false;
      kind: "not_configured" | "unavailable" | "unauthenticated" | "invalid_identifier" | "invalid_response";
      detail?: string;
    };

export type RefundParams = {
  userId: string;
  consumptionId: string;
  /** Tests only: forwarded as `p_now`. */
  nowMs?: number;
};

type RefundRow = { refunded?: unknown; reason?: unknown; usage_day?: unknown };

/**
 * Give one message back, e.g. when the AI provider failed before any text was
 * delivered.
 *
 * Idempotence is an obligation of `ai_usage_refund`, not a property of this
 * module: the function must accept only the first `consumed → refunded`
 * transition, so repeated calls never decrement twice. The day decremented must
 * be the one stored on the event, not "today" — a refund at 00:00:05 for a
 * message sent at 23:59:59 corrects the day that was actually charged. Neither
 * behaviour is verified yet (see "WHAT IS NOT GUARANTEED").
 *
 * Because a refund is a no-op when nothing was charged, it is safe to call on
 * an ambiguous consumption (`applied: "unknown"`) — but only while the SQL
 * allows a refunded identifier to be consumed again; otherwise the identifier
 * becomes unusable. That decision belongs to the route, in P5.
 *
 * Best-effort by contract: callers must not fail the user's request because a
 * refund could not be recorded.
 */
export async function refundDurableUsage(
  params: RefundParams,
  options: UsageStoreOptions = {},
  rawEnv: RawEnv = process.env,
): Promise<RefundOutcome> {
  const deps = resolveDeps(rawEnv, options);

  const identity = checkIdentity(params.userId);
  if (!identity.ok) return identity;
  const identifier = checkConsumptionId(params.consumptionId);
  if (!identifier.ok) return identifier;
  if (!deps.env) return { ok: false, kind: "not_configured" };

  const userId = identity.userId;
  const consumptionId = identifier.consumptionId;

  const clock = params.nowMs === undefined ? null : finiteMs(params.nowMs);
  if (params.nowMs !== undefined && clock === null) {
    return { ok: false, kind: "unavailable", detail: "ai_usage_refund: non-finite clock" };
  }

  const body: Record<string, unknown> = { p_user_id: userId, p_consumption_id: consumptionId };
  if (clock !== null) body.p_now = new Date(clock).toISOString();

  const result = await callRpc<RefundRow>(deps.env, USAGE_RPC.refund, body, deps.fetchImpl, deps.timeoutMs);
  if (!result.ok) return { ok: false, kind: "unavailable", detail: result.detail };

  const row = result.rows[0];
  if (!row) return { ok: false, kind: "unavailable", detail: "ai_usage_refund returned no row" };

  // A verdict is a boolean. Anything else is a malformed answer and is
  // reported as such: guessing "false" would hide a lost refund.
  if (typeof row.refunded !== "boolean") {
    return {
      ok: false,
      kind: "invalid_response",
      detail: "ai_usage_refund returned a non-boolean verdict",
    };
  }

  return { ok: true, refunded: row.refunded === true, usageDay: asString(row.usage_day) };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type UsageReadOutcome =
  | { ok: true; usageDay: string; messages: number; quotes: number }
  | {
      ok: false;
      kind: "not_configured" | "unavailable" | "unauthenticated" | "invalid_response";
      detail?: string;
    };

export type UsageReadParams = {
  userId: string;
  /** Tests only: forwarded as `p_now`. */
  nowMs?: number;
};

type UsageReadRow = { usage_day?: unknown; used_messages?: unknown; used_quotes?: unknown };

/**
 * Read today's counters for one account. Read-only: `ai_usage_read` cannot
 * write, so this is safe to call from the quota endpoint.
 *
 * An absent row means "nothing consumed today" and is reported as zeros, with
 * the UTC day computed the same way PostgreSQL does.
 */
export async function readDurableUsage(
  params: UsageReadParams,
  options: UsageStoreOptions = {},
  rawEnv: RawEnv = process.env,
): Promise<UsageReadOutcome> {
  const deps = resolveDeps(rawEnv, options);

  const identity = checkIdentity(params.userId);
  if (!identity.ok) return identity;
  if (!deps.env) return { ok: false, kind: "not_configured" };

  const userId = identity.userId;

  const nowMs = finiteMs(params.nowMs ?? deps.now());
  if (nowMs === null) {
    // Also guards `utcDayKey(nowMs)` below, which would throw on an invalid Date.
    return { ok: false, kind: "unavailable", detail: "ai_usage_read: non-finite clock" };
  }

  const body: Record<string, unknown> = { p_user_id: userId };
  if (params.nowMs !== undefined) body.p_now = new Date(nowMs).toISOString();

  const result = await callRpc<UsageReadRow>(deps.env, USAGE_RPC.read, body, deps.fetchImpl, deps.timeoutMs);
  if (!result.ok) return { ok: false, kind: "unavailable", detail: result.detail };

  const row = result.rows[0];
  // No row is a fact, not a default: the account simply has not consumed
  // anything today, and ai_usage_read is read-only.
  if (!row) return { ok: true, usageDay: utcDayKey(nowMs), messages: 0, quotes: 0 };

  const messages = asCount(row.used_messages);
  const quotes = asCount(row.used_quotes);
  if (messages === null || quotes === null) {
    return {
      ok: false,
      kind: "invalid_response",
      detail: "ai_usage_read returned unusable counters",
    };
  }

  return {
    ok: true,
    // A missing day is harmless here: the counters are the fact, and the day is
    // only context. The UTC day is recomputed the same way PostgreSQL does.
    usageDay: asString(row.usage_day) ?? utcDayKey(nowMs),
    messages,
    quotes,
  };
}

// ---------------------------------------------------------------------------
// Outcome → HTTP status — the only mapping, so a route cannot invent one
// ---------------------------------------------------------------------------

/** Every failure an outcome can carry. Success (`consumed`) has no status. */
export type UsageFailureKind =
  | "unauthenticated"
  | "invalid_identifier"
  | "invalid_response"
  | "not_configured"
  | "unavailable"
  | "unsupported_limits"
  | "duplicate"
  | "conflict"
  | "daily_messages"
  | "daily_quotes";

/**
 * The HTTP status a route must answer for a failed outcome.
 *
 * Centralising it here is deliberate: the difference between 400, 401, 409,
 * 429 and 503 *is* the contract with the client. A route that mapped
 * `invalid_identifier` to 503 would turn a typo into an outage, which is
 * exactly the defect this function exists to prevent.
 *
 * 401 sign in · 400 malformed request · 409 replay/conflict · 429 quota ·
 * 503 anything the server could not decide or read.
 */
export function usageFailureStatus(kind: UsageFailureKind): number {
  switch (kind) {
    case "unauthenticated":
      return 401;
    case "invalid_identifier":
      return 400;
    case "duplicate":
    case "conflict":
      return 409;
    case "daily_messages":
    case "daily_quotes":
      return 429;
    default:
      return 503;
  }
}
