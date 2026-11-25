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

export type ReserveResult =
  | {
      ok: true;
      sessionId: string;
      reservedSeconds: number;
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
 * Reserve the session's seconds.
 *
 * `allowanceSeconds` comes from the plan read in the database by
 * `authorizeRequest` — never from the browser.
 */
export async function reserveVoiceSeconds(
  env: VoiceStoreEnv,
  options: {
    userId: string;
    allowanceSeconds: number;
    reserveSeconds: number;
    voiceId: string;
    /** How long the RESERVATION may sit unused before it is released. */
    ttlSeconds?: number;
    /** Hard session ceiling copied from the Live model's documented limit. */
    maxSessionSeconds?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<ReserveResult> {
  const payload = await callVoiceFunction(
    env,
    "voice_reserve",
    {
      p_user_id: options.userId,
      p_allowance_seconds: Math.max(0, Math.trunc(options.allowanceSeconds)),
      p_reserve_seconds: Math.max(1, Math.trunc(options.reserveSeconds)),
      p_voice_id: options.voiceId,
      p_ttl_seconds: Math.max(30, Math.trunc(options.ttlSeconds ?? 300)),
      p_max_session_seconds: Math.max(60, Math.trunc(options.maxSessionSeconds ?? 3_600)),
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
    return {
      ok: true,
      sessionId,
      reservedSeconds: Number(payload.reserved_seconds ?? options.reserveSeconds),
      usedSeconds: Number(payload.used_seconds ?? 0),
      remainingSeconds: Number(payload.remaining_seconds ?? 0),
    };
  }

  const retryAfter =
    Number(payload.retry_after_seconds ?? 0) ||
    (kind === "voice_minutes_exhausted" ? secondsUntilUtcMidnight() : 0);

  return {
    ok: false,
    kind:
      kind === "voice_not_in_plan" ||
      kind === "voice_minutes_exhausted" ||
      kind === "voice_session_open"
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
    /** Bound applied by the database; never a duration. */
    maxSessionSeconds?: number;
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
      p_max_session_seconds: Math.max(60, Math.trunc(options.maxSessionSeconds ?? 3_600)),
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

/**
 * Give the reservation back, for a session that never started.
 *
 * Called when the provider fails, times out, or returns no SDP: the user must
 * not pay for a conversation that did not happen. Idempotent in the database.
 */
export async function refundVoiceReservation(
  env: VoiceStoreEnv,
  options: { userId: string; sessionId: string; fetchImpl?: typeof fetch },
): Promise<{ kind: string }> {
  const payload = await callVoiceFunction(
    env,
    "voice_refund",
    { p_user_id: options.userId, p_session_id: options.sessionId },
    options.fetchImpl ?? fetch,
  );
  return { kind: typeof payload.kind === "string" ? payload.kind : "unknown" };
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
    /** How long the active session's lease should last. */
    leaseSeconds?: number;
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
      p_lease_seconds: Math.max(120, Math.trunc(options.leaseSeconds ?? 3_900)),
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
export async function touchVoiceSession(
  env: VoiceStoreEnv,
  options: { userId: string; sessionId: string; leaseSeconds?: number; fetchImpl?: typeof fetch },
): Promise<{ kind: string }> {
  const payload = await callVoiceFunction(
    env,
    "voice_touch",
    {
      p_user_id: options.userId,
      p_session_id: options.sessionId,
      p_lease_seconds: Math.max(120, Math.trunc(options.leaseSeconds ?? 3_900)),
    },
    options.fetchImpl ?? fetch,
  );
  return { kind: typeof payload.kind === "string" ? payload.kind : "unknown" };
}

/** Today's consumption for one account, without touching anything. */
export async function readVoiceAllowance(
  env: VoiceStoreEnv,
  options: { userId: string; fetchImpl?: typeof fetch },
): Promise<{ consumedSeconds: number; reservedSeconds: number; remainingSeconds: number }> {
  const payload = await callVoiceFunction(
    env,
    "voice_usage_read",
    { p_user_id: options.userId },
    options.fetchImpl ?? fetch,
  );
  const consumed = Number(payload.consumed_seconds ?? 0);
  const reserved = Number(payload.reserved_seconds ?? 0);
  return {
    consumedSeconds: Number.isFinite(consumed) ? consumed : 0,
    reservedSeconds: Number.isFinite(reserved) ? reserved : 0,
    remainingSeconds: Math.max(0, consumed + reserved),
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
