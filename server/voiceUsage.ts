/**
 * Persistence of the voice allowance, in Supabase.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The allowance used to live in a `Map` inside `server/quotas.ts`. That made it
 * per-instance: a cold start forgot everything, and two Vercel instances each
 * believed the account had its full daily allowance. A Pro account could
 * therefore consume 30 minutes per instance rather than 30 minutes a day.
 *
 * The truth now lives in Postgres (migration `0004_voice_usage.sql`), where the
 * rules that matter are enforced by the database itself:
 *
 *   • one open session per account — a partial unique index, not a check in
 *     application code that two instances could both pass;
 *   • an atomic reservation — the authorisation condition sits in the `UPDATE`
 *     ... `WHERE`, so two concurrent reservations cannot both succeed;
 *   • settlement and refund are idempotent — the session row records that it
 *     was already settled, whatever the network did;
 *   • the charged duration is `now() - started_at`, computed in SQL. No
 *     duration parameter exists anywhere on this path: a forged
 *     `durationSeconds` cannot reach the database.
 *
 * This module only carries the calls. It holds no allowance state of its own: a
 * second instance reading the same account sees the same numbers.
 *
 * Fail closed: every failure is raised as `VoiceStoreUnavailableError`, and the
 * caller refuses the session — it never falls back to an in-memory counter,
 * because that would silently reintroduce the split the migration removes.
 */

export type VoiceStoreEnv = {
  /** Project URL, without trailing slash. */
  url: string;
  /** Service role key: the only credential that may execute the voice_* functions. */
  serviceRoleKey: string;
};

/** Raised when Supabase cannot be reached or answers anything but 2xx. */
export class VoiceStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceStoreUnavailableError";
  }
}

/** The functions return JSON; this is the shape they share. */
type FunctionPayload = Record<string, unknown>;

function asRecord(value: unknown): FunctionPayload {
  return typeof value === "object" && value !== null ? (value as FunctionPayload) : {};
}

/**
 * Call one `voice_*` function with the service role.
 *
 * `POST /rest/v1/rpc/<name>` is the documented way to invoke a PostgREST
 * function; the arguments are the function's parameter names.
 *
 * No retry: a reservation is not idempotent by itself (calling it twice opens
 * two reservations, and the second is refused as `voice_session_open`, which
 * would confuse the caller). Retrying is the caller's decision, and it has the
 * session id needed to settle.
 */
async function callVoiceFunction(
  env: VoiceStoreEnv,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<FunctionPayload> {
  let response: Response;
  try {
    response = await fetchImpl(`${env.url.replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.serviceRoleKey,
        Authorization: `Bearer ${env.serviceRoleKey}`,
      },
      body: JSON.stringify(args),
    });
  } catch {
    // Network failure, DNS, TLS: nothing reached the database.
    throw new VoiceStoreUnavailableError(`Supabase RPC ${name} is unreachable.`);
  }

  if (!response.ok) {
    // A missing migration shows up here as a 404. The message says so, because
    // the alternative is a mystifying "voice unavailable" in production.
    const hint =
      response.status === 404
        ? " (migration 0004_voice_usage.sql is probably not applied)"
        : "";
    throw new VoiceStoreUnavailableError(
      `Supabase RPC ${name} failed (${response.status})${hint}.`,
    );
  }

  const payload = await response.json().catch(() => null);
  return asRecord(payload);
}

/**
 * Refuse a missing ceiling instead of substituting one.
 *
 * Every previous bug on this path came from a silent default: 3600 here, 3900
 * there, 60 as a "reservation". A throw at the call site is louder than a
 * number chosen in a hurry, and it names the caller.
 */
function requireCeiling(caller: string, value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${caller}: maxSessionSeconds is required (no default).`);
  }
  return Math.trunc(value);
}

export type ReserveResult =
  | {
      ok: true;
      sessionId: string;
      /**
       * What the database reserved, and therefore the MOST this session can ever
       * be billed. Equal to `maxSessionSeconds`: the reservation is the ceiling.
       * Not a fixed amount — on an account with 90 s left it is 90, not 3600.
       */
      reservedSeconds: number;
      /** Duration the browser may announce, identical to `reservedSeconds`. */
      maxSessionSeconds: number;
      usedSeconds: number;
      remainingSeconds: number;
    }
  | {
      ok: false;
      kind: "voice_not_in_plan" | "voice_minutes_exhausted" | "voice_session_open";
      /** Seconds the caller should wait before retrying, when known. */
      retryAfterSeconds: number;
      usedSeconds: number;
      limitSeconds: number;
    };

/**
 * Reserve the session.
 *
 * `allowanceSeconds` comes from the plan read in the database by
 * `authorizeRequest` — never from the browser.
 *
 * There is no `reserveSeconds`: the amount is decided by `voice_reserve`, which
 * reserves the WHOLE remaining allowance, bounded by `maxSessionSeconds` and by
 * the time left before UTC midnight. Passing an amount from here would put a
 * second decision-maker next to the database, and the previous version's flat
 * 60 s is exactly how a Pro account with a minute left came to overrun a
 * 30-minute quota.
 */
export async function reserveVoiceSeconds(
  env: VoiceStoreEnv,
  options: {
    userId: string;
    allowanceSeconds: number;
    voiceId: string;
    /**
     * Hard session ceiling, from `LIVE_MAX_SESSION_SECONDS`. REQUIRED: a default
     * here would be a second source of truth next to the SQL, and the two
     * billing paths could drift apart again.
     */
    maxSessionSeconds: number;
    /** How long the RESERVATION may sit unused before it is released. */
    ttlSeconds?: number;
    /** Floor below which a session is not worth opening. */
    minReservationSeconds?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<ReserveResult> {
  if (!Number.isFinite(options.maxSessionSeconds) || options.maxSessionSeconds <= 0) {
    throw new TypeError("reserveVoiceSeconds: maxSessionSeconds is required.");
  }
  const payload = await callVoiceFunction(
    env,
    "voice_reserve",
    {
      p_user_id: options.userId,
      p_allowance_seconds: Math.max(0, Math.trunc(options.allowanceSeconds)),
      p_max_session_seconds: Math.trunc(options.maxSessionSeconds),
      p_voice_id: options.voiceId,
      p_ttl_seconds: Math.max(30, Math.trunc(options.ttlSeconds ?? 300)),
      p_min_reservation_seconds: Math.max(1, Math.trunc(options.minReservationSeconds ?? 60)),
    },
    options.fetchImpl ?? fetch,
  );

  const kind = typeof payload.kind === "string" ? payload.kind : "";
  const usedSeconds = Number(payload.used_seconds ?? 0);
  const limitSeconds = Number(payload.limit_seconds ?? 0);

  if (payload.ok === true) {
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    if (!sessionId) {
      // A success without an id would be unusable: the session could never be
      // settled. Treat it as an outage rather than guessing.
      throw new VoiceStoreUnavailableError("voice_reserve returned no session id.");
    }
    // `max_session_seconds` is what the DATABASE granted, not what we asked for.
    // It is the number the browser must announce and the number settlement will
    // bound to. Falling back to the request would hide a database refusal.
    const granted = Number(payload.max_session_seconds ?? payload.reserved_seconds ?? 0);
    return {
      ok: true,
      sessionId,
      reservedSeconds: Number(granted),
      maxSessionSeconds: Number(granted),
      usedSeconds: Number(payload.used_seconds ?? 0),
      remainingSeconds: Number(payload.remaining_seconds ?? 0),
    };
  }

  const retryAfter =
    Number(payload.retry_after_seconds ?? 0) ||
    (kind === "voice_minutes_exhausted" ? secondsUntilUtcMidnight() : 0);

  return {
    ok: false,
    // `voice_curfew` (too little time left before UTC midnight) is reported as
    // exhaustion: from the user's side both mean "not now, come back".
    kind:
      kind === "voice_not_in_plan" || kind === "voice_session_open"
        ? kind
        : "voice_minutes_exhausted",
    retryAfterSeconds: Math.max(0, Math.trunc(retryAfter)),
    usedSeconds: Number.isFinite(usedSeconds) ? usedSeconds : 0,
    limitSeconds: Number.isFinite(limitSeconds) ? limitSeconds : 0,
  };
}

/**
 * Settle a session with its real duration.
 *
 * Returns `usedSeconds` when the database knows the answer, `null` when the
 * session is unknown to it (e.g. the migration was applied after the session
 * started). `null` is not an error: the caller decides what to report.
 */
export async function settleVoiceSeconds(
  env: VoiceStoreEnv,
  options: {
    userId: string;
    sessionId: string;
    /**
     * Safety ceiling applied by the database; never a duration. REQUIRED, and
     * the same constant as the reservation path: `LIVE_MAX_SESSION_SECONDS`.
     */
    maxSessionSeconds: number;
    fetchImpl?: typeof fetch;
  },
): Promise<{ kind: string; chargedSeconds: number; measuredSeconds: number | null; usedSeconds: number | null }> {
  // Deliberately NO duration parameter. The billed duration is `now() -
  // started_at`, computed by PostgreSQL. A previous version forwarded the
  // browser's `durationSeconds` here, which let a client send 0 and pay
  // nothing. Removing the parameter removes the possibility.
  const payload = await callVoiceFunction(
    env,
    "voice_settle",
    {
      p_user_id: options.userId,
      p_session_id: options.sessionId,
      p_max_session_seconds: requireCeiling("settleVoiceSeconds", options.maxSessionSeconds),
    },
    options.fetchImpl ?? fetch,
  );

  const kind = typeof payload.kind === "string" ? payload.kind : "unknown";
  const measured = payload.measured_seconds;
  const usedRaw = payload.used_seconds;
  return {
    kind,
    chargedSeconds: Number(payload.charged_seconds ?? 0),
    measuredSeconds: typeof measured === "number" && Number.isFinite(measured) ? measured : null,
    usedSeconds: typeof usedRaw === "number" && Number.isFinite(usedRaw) ? usedRaw : null,
  };
}

export type RefundResult = {
  kind: string;
  /** True only when the database actually gave the reservation back. */
  released: boolean;
  /** `active_not_refundable` means: settle it, do not try again. */
  refundable: boolean;
  state: string;
};

/**
 * Give the reservation back — for a `pending` session only.
 *
 * Called when the provider fails, times out, or returns no SDP: the user must
 * not pay for a conversation that did not happen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  SECURITY FIX — A REFUND MUST NEVER RELEASE AN ACTIVATED SESSION
 * ─────────────────────────────────────────────────────────────────────────────
 * `voice_activate` succeeding and its HTTP response being lost are two different
 * things. When the response was lost, this route used to assume the activation
 * had failed and refund. `voice_refund` accepted `active` rows, so an activated
 * conversation — real time consumed — was released in full and never billed.
 *
 * The database now refuses (`active_not_refundable`, `released: false`) and this
 * function surfaces that refusal instead of flattening it to a `kind` string,
 * so a caller cannot mistake a refusal for a success. `released` is the only
 * thing to branch on.
 */
export async function refundVoiceReservation(
  env: VoiceStoreEnv,
  options: { userId: string; sessionId: string; fetchImpl?: typeof fetch },
): Promise<RefundResult> {
  const payload = await callVoiceFunction(
    env,
    "voice_refund",
    { p_user_id: options.userId, p_session_id: options.sessionId },
    options.fetchImpl ?? fetch,
  );
  const kind = typeof payload.kind === "string" ? payload.kind : "unknown";
  return {
    kind,
    released: payload.released === true,
    // Anything that is not an explicit refusal is a completed release path:
    // `refunded` and `already_released` both leave the reservation with the
    // user, which is the outcome a caller wants.
    refundable: kind !== "active_not_refundable" && kind !== "unknown_session",
    state: typeof payload.state === "string" ? payload.state : "unknown",
  };
}

export type SessionStateResult =
  | { found: true; state: string; action: "refundable" | "settle" | "closed"; reservedSeconds: number; chargedSeconds: number }
  | { found: false; state: "unknown_session" };

/**
 * Read the REAL state of a session, without modifying anything.
 *
 * This is the answer to "did my write land?" — the question a lost HTTP response
 * leaves open. Used before any compensating action, so the decision rests on a
 * fact read from the database instead of on an assumption about the network.
 *
 * Throws `VoiceStoreUnavailableError` when the read itself fails: at that point
 * nothing is known, and the caller must not refund on a guess.
 */
export async function readVoiceSessionState(
  env: VoiceStoreEnv,
  options: { userId: string; sessionId: string; fetchImpl?: typeof fetch },
): Promise<SessionStateResult> {
  const payload = await callVoiceFunction(
    env,
    "voice_session_state",
    { p_user_id: options.userId, p_session_id: options.sessionId },
    options.fetchImpl ?? fetch,
  );
  if (payload.ok !== true || typeof payload.state !== "string") {
    return { found: false, state: "unknown_session" };
  }
  const action =
    payload.action === "refundable" || payload.action === "settle" || payload.action === "closed"
      ? payload.action
      : "closed";
  return {
    found: true,
    state: payload.state,
    action,
    reservedSeconds: Number(payload.reserved_seconds ?? 0),
    chargedSeconds: Number(payload.charged_seconds ?? 0),
  };
}

/**
 * Mark the reservation as a live conversation.
 *
 * Called AFTER the provider answered successfully. This is where `started_at`
 * is set, so the SDP exchange — up to 20 seconds — is not billed. Until this
 * call, the row is `pending` and cannot be charged.
 */
export async function activateVoiceSession(
  env: VoiceStoreEnv,
  options: {
    userId: string;
    sessionId: string;
    /** Safety ceiling; the database derives the lease from the reservation. */
    maxSessionSeconds: number;
    providerSessionId?: string | null;
    fetchImpl?: typeof fetch;
  },
): Promise<{ kind: string }> {
  const payload = await callVoiceFunction(
    env,
    "voice_activate",
    {
      p_user_id: options.userId,
      p_session_id: options.sessionId,
      p_max_session_seconds: requireCeiling("activateVoiceSession", options.maxSessionSeconds),
      p_provider_session_id: options.providerSessionId ?? null,
    },
    options.fetchImpl ?? fetch,
  );
  return { kind: typeof payload.kind === "string" ? payload.kind : "unknown" };
}

/**
 * Heartbeat: extends the lease of an active session.
 *
 * Never used for billing. Its absence does not extend anything either — the
 * hard session ceiling remains the only bound. It exists so a long
 * conversation stays visibly alive, and so `lease_expires_at` keeps a meaning
 * for diagnosis.
 */
export type TouchResult = {
  kind: string;
  /** Seconds of reservation left, as computed by PostgreSQL. */
  remainingSeconds: number;
  /** True when the session must end now — the database is the authority. */
  shouldStop: boolean;
  /** The database closed and billed the session during this call. */
  expired: boolean;
  state: string;
};

/**
 * Heartbeat that also ENFORCES the ceiling.
 *
 * `shouldStop` is not advice: it is PostgreSQL saying the reservation is spent.
 * The browser must close the conversation on it. A client that ignores it (a
 * modified client, a suspended tab, a throttled timer) still cannot run up an
 * unpaid session, because the ledger settles on the server side either way —
 * but relying on a JavaScript timer alone would leave the provider streaming
 * audio past the limit, which is exactly what this call exists to prevent.
 */
export async function touchVoiceSession(
  env: VoiceStoreEnv,
  options: {
    userId: string;
    sessionId: string;
    leaseSeconds: number;
    maxSessionSeconds: number;
    fetchImpl?: typeof fetch;
  },
): Promise<TouchResult> {
  const payload = await callVoiceFunction(
    env,
    "voice_touch",
    {
      p_user_id: options.userId,
      p_session_id: options.sessionId,
      p_lease_seconds: Math.max(120, Math.trunc(options.leaseSeconds)),
      p_max_session_seconds: requireCeiling("touchVoiceSession", options.maxSessionSeconds),
    },
    options.fetchImpl ?? fetch,
  );
  const remaining = Number(payload.remaining_seconds ?? 0);
  return {
    kind: typeof payload.kind === "string" ? payload.kind : "unknown",
    remainingSeconds: Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
    shouldStop: payload.should_stop === true,
    expired: payload.expired === true,
    state: typeof payload.state === "string" ? payload.state : "unknown",
  };
}

/**
 * Today's consumption for one account, without touching anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  `remainingSeconds` IS THE REMAINDER, NOT THE USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * This function used to return `Math.max(0, consumed + reserved)`: the amount
 * ALREADY USED, labelled as remaining. On an untouched Pro account (0 consumed)
 * it answered `0` seconds left, and on a half-used one it answered `900` — the
 * exact opposite of the truth, in a way that only shows on a screen.
 *
 * `allowanceSeconds` is therefore REQUIRED: a remaining figure cannot be derived
 * from consumption alone, and defaulting it would have produced a second, silent
 * version of the same lie.
 */
export async function readVoiceAllowance(
  env: VoiceStoreEnv,
  options: { userId: string; allowanceSeconds: number; fetchImpl?: typeof fetch },
): Promise<{
  consumedSeconds: number;
  reservedSeconds: number;
  /** Allowance minus consumed minus reserved. Never negative. */
  remainingSeconds: number;
}> {
  if (!Number.isFinite(options.allowanceSeconds) || options.allowanceSeconds < 0) {
    throw new TypeError("readVoiceAllowance: allowanceSeconds is required (no default).");
  }
  const payload = await callVoiceFunction(
    env,
    "voice_usage_read",
    { p_user_id: options.userId },
    options.fetchImpl ?? fetch,
  );
  const consumedRaw = Number(payload.consumed_seconds ?? 0);
  const reservedRaw = Number(payload.reserved_seconds ?? 0);
  const consumed = Number.isFinite(consumedRaw) ? Math.max(0, consumedRaw) : 0;
  const reserved = Number.isFinite(reservedRaw) ? Math.max(0, reservedRaw) : 0;
  return {
    consumedSeconds: consumed,
    reservedSeconds: reserved,
    // Both consumed AND reserved consume the allowance: a reservation is held
    // credit, not free credit.
    remainingSeconds: Math.max(0, Math.trunc(options.allowanceSeconds) - consumed - reserved),
  };
}

/** Milliseconds until the next UTC midnight, as seconds. Used for `Retry-After`. */
function secondsUntilUtcMidnight(nowMs: number = Date.now()): number {
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
  return Math.max(1, Math.ceil((nextMidnight - nowMs) / 1_000));
}
