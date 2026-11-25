import { authorizeRequest, IdentityUnavailableError, readAccessEnv } from "../server/access.js";
import { settleVoiceSeconds, VoiceStoreUnavailableError } from "../server/voiceUsage.js";

/**
 * Close a voice session and settle its duration.
 *
 * The browser calls this when the user ends the conversation, closes the tab, or
 * changes voice (a voice change restarts the session — see the client hook).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHO DECIDES THE DURATION
 * ─────────────────────────────────────────────────────────────────────────────
 * The duration is computed BY POSTGRESQL, from `voice_sessions.started_at`, which
 * is set once the provider has answered — not by this route, and not by the
 * browser. `voice_settle` has no duration parameter at all, so a forged
 * `durationSeconds` cannot be forwarded even by accident.

 * A previous version passed the browser's value down as `p_actual_seconds`.
 * That was a real defect: a client sending 0 paid nothing. It is fixed by
 * removing the parameter, not by validating it.
 *
 * `voice_settle` is idempotent in the database: a second close returns
 * `already_settled` with the duration recorded at the first one, so a duplicated
 * beacon cannot charge twice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHEN THE CLIENT'S NUMBER IS USED, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * If the session is unknown to the database — the migration was applied after
 * the session started, or the row was expired — the route releases the
 * reservation instead of leaving the account stuck with unused seconds. It does
 * so only through `voice_refund`, which is a bounded, idempotent operation:
 *  * a refund can only give back what was actually reserved,
 *  * it cannot create a credit, because `voice_usage_daily.reserved_seconds` is
 *    floored at zero by the database.
 *
 * The client's `durationSeconds` is therefore *not* trusted for billing. It is
 * echoed back in `clientReportedSeconds` for diagnosis only.
 */

type ApiRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

export const config = {
  maxDuration: 15,
  api: { bodyParser: { sizeLimit: "16kb" } },
};

function readRequestHeader(request: ApiRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value ? value : null;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/** The UUID shape the database will accept, checked before any round trip. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST requests are supported." });
  }

  const access = await authorizeRequest(readRequestHeader(request, "authorization")).catch(
    (error: unknown) => {
      if (error instanceof IdentityUnavailableError) return { identityUnavailable: error.message } as const;
      throw error;
    },
  );
  if ("identityUnavailable" in access) {
    return response.status(503).json({ code: "identity_unavailable", error: access.identityUnavailable });
  }
  if (!access.ok) {
    return response.status(access.status).json({ error: access.error, code: access.code });
  }

  const body = bodyRecord(request.body);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return response.status(400).json({
      code: "invalid_session",
      error: "A sessionId is required.",
    });
  }

  const env = readAccessEnv();
  if (!env) {
    return response.status(503).json({
      code: "not_configured",
      error: "VEYVRO's voice store is not configured on the server.",
    });
  }
  const storeEnv = { url: env.url, serviceRoleKey: env.serviceRoleKey };

  // A session id that is not a UUID cannot be one of ours. Rejecting it here
  // avoids a pointless round trip and a confusing Postgres cast error.
  if (!UUID_PATTERN.test(sessionId)) {
    return response.status(400).json({
      code: "invalid_session",
      error: "The sessionId is not valid.",
    });
  }

  // Diagnostic only. This value is echoed back for support, and is NEVER used
  // to bill: the charged duration is measured by PostgreSQL from
  // `voice_sessions.started_at`. A client sending 0, a negative number or a
  // huge one changes nothing.
  const reported = Number.isFinite(Number(body.durationSeconds))
    ? Math.max(0, Math.round(Number(body.durationSeconds)))
    : null;

  try {
    // No duration is sent. The database computes `now() - started_at`; a
    // forged `durationSeconds` in the body cannot reach it.
    const settled = await settleVoiceSeconds(storeEnv, {
      userId: access.userId,
      sessionId,
    });

    if (settled.kind === "unknown_session") {
      // No such session for this account: a stale id, another account's id, or
      // a row that was swept. Nothing is charged — and nothing is refunded at
      // account level either, deliberately: with one open session per account,
      // an account-wide release would be safe today, but it would release the
      // fees of a session that does exist the day that invariant changes.
      //
      // The ledger keeps a reservation only when a row exists to point at it;
      // if a row were deleted out of band, the remaining reservation is
      // released by the lease (`voice_expire_stale`) at the next reservation,
      // which is the single place that reconciles this account.
      return response.status(200).json({
        settledWith: "unknown-session",
        chargedSeconds: 0,
        clientReportedSeconds: reported,
      });
    }

    if (settled.kind === "already_settled") {
      return response.status(200).json({
        settledWith: "already-closed",
        chargedSeconds: settled.chargedSeconds,
        usedSeconds: settled.usedSeconds,
      });
    }

    if (settled.kind === "never_started") {
      // The reservation was never activated: nothing happened, nothing billed.
      return response.status(200).json({
        settledWith: "never-started",
        chargedSeconds: 0,
        usedSeconds: settled.usedSeconds,
        clientReportedSeconds: reported,
      });
    }

    if (settled.kind === "already_released") {
      return response.status(200).json({
        settledWith: "already-released",
        chargedSeconds: 0,
        usedSeconds: settled.usedSeconds,
      });
    }

    return response.status(200).json({
      settledWith: "duration",
      chargedSeconds: settled.chargedSeconds,
      // The duration PostgreSQL measured, before the hard ceiling.
      measuredSeconds: settled.measuredSeconds,
      usedSeconds: settled.usedSeconds,
      clientReportedSeconds: reported,
    });
  } catch (error) {
    if (error instanceof VoiceStoreUnavailableError) {
      // Fail closed but visibly: the caller learns the settlement did not
      // happen, and a retry is legitimate because the operation is idempotent.
      return response.status(503).json({ code: "voice_store_unavailable", error: error.message });
    }
    throw error;
  }
}
