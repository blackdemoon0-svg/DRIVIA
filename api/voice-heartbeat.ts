import { authorizeRequest, IdentityUnavailableError, readAccessEnv } from "../server/access.js";
import { touchVoiceSession, VoiceStoreUnavailableError } from "../server/voiceUsage.js";
import { LIVE_MAX_SESSION_SECONDS, LIVE_SESSION_LEASE_SECONDS } from "../server/ai/voiceCatalog.js";

/**
 * Heartbeat of a live voice conversation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY A SERVER ROUTE FOR A HEARTBEAT
 * ─────────────────────────────────────────────────────────────────────────────
 * The reservation caps what can be BILLED. It did not, by itself, stop the
 * conversation: the only thing ending a session at the ceiling was a
 * `setTimeout` in the browser. A suspended tab, a throttled timer or a modified
 * client kept the audio flowing — and the provider kept being paid for time
 * PostgreSQL had already stopped charging.
 *
 * The browser now asks this route every `VOICE_HEARTBEAT_SECONDS`. PostgreSQL
 * answers with the reservation that remains, and closes the session itself as
 * soon as it is spent. `shouldStop` is an instruction, not a hint: the client
 * closes the peer connection on it.
 *
 * The client is never trusted for the duration. It sends only a session id.
 *
 * Nothing here can charge: `voice_touch` either reports the remaining seconds,
 * or closes and bills a session that already reached its reservation.
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
  maxDuration: 10,
  api: { bodyParser: { sizeLimit: "4kb" } },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRequestHeader(request: ApiRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST requests are supported." });
  }

  const access = await authorizeRequest(readRequestHeader(request, "authorization")).catch(
    (error: unknown) => {
      if (error instanceof IdentityUnavailableError) {
        return { identityUnavailable: error.message } as const;
      }
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
    return response.status(400).json({ code: "invalid_session", error: "A sessionId is required." });
  }
  if (!UUID_PATTERN.test(sessionId)) {
    return response.status(400).json({ code: "invalid_session", error: "The sessionId is not valid." });
  }

  const env = readAccessEnv();
  if (!env) {
    return response.status(503).json({
      code: "not_configured",
      error: "VEYVRO's voice store is not configured on the server.",
    });
  }

  try {
    const touched = await touchVoiceSession(
      { url: env.url, serviceRoleKey: env.serviceRoleKey },
      {
        userId: access.userId,
        sessionId,
        leaseSeconds: LIVE_SESSION_LEASE_SECONDS,
        maxSessionSeconds: LIVE_MAX_SESSION_SECONDS,
      },
    );

    // A session that is no longer active must be stopped by the client: keeping
    // the peer connection open would keep streaming audio nobody pays for.
    if (touched.shouldStop) {
      return response.status(200).json({
        stop: true,
        remainingSeconds: 0,
        settled: touched.expired,
        // `settled` confirms the database closed and billed the session during
        // this call, so the client does not need to call /api/voice-end.
        reason: touched.expired ? "ceiling_reached" : touched.kind,
      });
    }

    return response.status(200).json({
      stop: false,
      remainingSeconds: touched.remainingSeconds,
      settled: false,
      reason: "alive",
    });
  } catch (error) {
    if (!(error instanceof VoiceStoreUnavailableError)) throw error;
    // Fail open on the heartbeat, deliberately, and say why: refusing to answer
    // would cut a legitimate conversation every time Supabase hiccups, while
    // failing closed on the ledger would be worse still. The ceiling is still
    // enforced — `voice_close_overdue` bills and closes the session on the very
    // next reservation, and the billing bound does not depend on this call.
    return response.status(503).json({
      code: "voice_store_unavailable",
      error: "Le suivi de la conversation est momentanément indisponible. / Voice tracking is temporarily unavailable.",
    });
  }
}
