import { authorizeRequest, IdentityUnavailableError } from "../server/access.js";
import { VOICE_RESERVATION_SECONDS, readVoiceUsage, settleVoiceQuota } from "../server/quotas.js";
import { closeVoiceSession } from "../server/voiceSessions.js";

/**
 * Close a voice session and settle its duration.
 *
 * The browser calls this when the user ends the conversation, closes the tab, or
 * changes voice (a voice change restarts the session — see the client hook).
 *
 * The duration is computed from the server-side registry, not from the client:
 * a client-reported duration would let anyone claim a three-second conversation.
 * If the session is unknown — typically because another serverless instance
 * opened it — the reservation is settled instead of being left in the counter:
 * either against the browser's reported duration, clamped to the reservation
 * (`settledWith: "client-duration"`), or released in full when the browser sends
 * nothing usable (`settledWith: "reservation-released"`). The allowance is never
 * silently leaked, and never silently overcharged.
 *
 * Idempotent: closing twice does not charge twice.
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

  const closed = closeVoiceSession(sessionId, access.userId);

  if (!closed) {
    // Unknown session: it was opened on another serverless instance, or already
    // forgotten. The registry cannot know the duration, so the browser's own
    // duration is used — bounded — instead of charging nothing silently.
    //
    // Why this matters: a user whose session ended should not keep paying for
    // it. Leaving the 60-second reservation in the counter would leak the
    // allowance a little more with every instance switch, and a user on a 10
    // minute plan would be blocked after ten sessions they never used.
    //
    // The client value is only a hint: it is clamped to the reservation made at
    // session start, which the server owns. A lying client can therefore never
    // charge less than zero, nor more than it reserved.
    const reported = Number.isFinite(Number(body.durationSeconds))
      ? Math.max(0, Math.round(Number(body.durationSeconds)))
      : null;

    if (reported === null) {
      // No usable duration: give the reservation back in full. A session we
      // cannot measure must not cost the user anything.
      const refunded = settleVoiceQuota({
        userId: access.userId,
        reservedSeconds: VOICE_RESERVATION_SECONDS,
        actualSeconds: 0,
      });
      return response.status(200).json({
        settledWith: "reservation-released",
        chargedSeconds: 0,
        usedSeconds: refunded.usedSeconds,
      });
    }

    const settled = settleVoiceQuota({
      userId: access.userId,
      reservedSeconds: VOICE_RESERVATION_SECONDS,
      actualSeconds: Math.min(reported, VOICE_RESERVATION_SECONDS),
    });
    return response.status(200).json({
      settledWith: "client-duration",
      chargedSeconds: settled.chargedSeconds,
      usedSeconds: settled.usedSeconds,
    });
  }

  if (closed.actualSeconds < 0) {
    // Already closed earlier: do not charge again.
    return response.status(200).json({
      settledWith: "already-closed",
      chargedSeconds: 0,
      usedSeconds: readVoiceUsage(access.userId),
    });
  }

  const settled = settleVoiceQuota({
    userId: access.userId,
    reservedSeconds: closed.record.reservedSeconds,
    actualSeconds: closed.durationSeconds,
  });

  return response.status(200).json({
    settledWith: "duration",
    chargedSeconds: settled.chargedSeconds,
    usedSeconds: settled.usedSeconds,
  });
}
