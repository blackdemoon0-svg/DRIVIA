import crypto from "node:crypto";
import { authorizeRequest, IdentityUnavailableError, readAccessEnv } from "../server/access.js";
import {
  reserveVoiceSeconds,
  refundVoiceReservation,
  VoiceStoreUnavailableError,
  type VoiceStoreEnv,
} from "../server/voiceUsage.js";
import { VOICE_RESERVATION_SECONDS, VOICE_RESERVATION_TTL_SECONDS } from "../server/quotas.js";
import { buildLiveSessionConfig, buildSessionInput } from "./_liveConfig.js";
import { selectVoice, type LiveVoice } from "../server/ai/voiceCatalog.js";

/**
 * Start a GPT-Live WebRTC session.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE KEY NEVER LEAVES THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * The browser creates an SDP offer and posts it here. This route authenticates
 * the caller, checks the plan and the voice allowance, then exchanges the offer
 * for an answer with `POST /v1/live/sessions` using the project API key. The
 * browser only ever receives the SDP answer.
 *
 * The session configuration — model, voice, instructions, delegation target — is
 * built server-side (`server/liveConfig.ts`). The request cannot influence it
 * beyond the voice id, which is validated against the catalogue.
 *
 * Order of operations, and why:
 *   1. authentication — an anonymous caller must not consume anything;
 *   2. voice id validation — an unknown id is replaced by the default, and the
 *      fact is reported so the client can correct its stored preference;
 *   3. plan rights — `voiceMinutesPerDay === 0` refuses before any provider
 *      call, so a Découverte request costs nothing;
 *   4. quota reservation — seconds are reserved up front, IN POSTGRES, so the
 *      reservation is atomic and shared by every instance (migration
 *      0004_voice_usage.sql). The database also refuses a second open session
 *      for the same account, which is what makes two tabs harmless;
 *   5. provider call — and, if it fails, the reservation is immediately given
 *      back: a failed session must not eat the user's allowance.
 *
 * The reservation now returns the session id, so this route no longer keeps a
 * registry of its own: the row in `voice_sessions` IS the record, and it
 * survives a cold start.
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
  maxDuration: 30,
  api: { bodyParser: { sizeLimit: "512kb" } },
};

/** An SDP offer is a few kilobytes; anything far larger is not one. */
const MAX_SDP_CHARACTERS = 400_000;
const MAX_HISTORY_MESSAGES = 12;
const PROVIDER_TIMEOUT_MS = 20_000;

function readEnvVar(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readRequestHeader(request: ApiRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value ? value : null;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * The store needs the project URL and the service role key.
 *
 * `readAccessEnv()` already validates all three Supabase variables; these two
 * are the subset the RPC calls use. Returns `null` when incomplete, so the
 * caller can answer 503 rather than half-working.
 */
function voiceStoreEnv(): VoiceStoreEnv | null {
  const env = readAccessEnv();
  if (!env) return null;
  return { url: env.url, serviceRoleKey: env.serviceRoleKey };
}

/**
 * Read prior conversation to seed the session.
 *
 * Only text is taken: the voice channel does not need attachments, and passing
 * images would cost tokens for something the user cannot see while speaking.
 */
function readHistory(body: unknown): Array<{ role: "user" | "assistant"; content: string }> {
  const raw = bodyRecord(body).history;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (message): message is { role: "user" | "assistant"; content: string } =>
        typeof message === "object" &&
        message !== null &&
        ((message as { role?: unknown }).role === "user" ||
          (message as { role?: unknown }).role === "assistant") &&
        typeof (message as { content?: unknown }).content === "string",
    )
    .map((message) => ({ role: message.role, content: message.content.trim() }))
    .filter((message) => message.content.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
}

/**
 * A stable, privacy-preserving identifier for OpenAI's safety monitoring.
 *
 * The documentation recommends hashing the user id rather than sending anything
 * identifying. The same value is used for every request of this account.
 */
export function safetyIdentifier(userId: string): string {
  return crypto.createHash("sha256").update(`veyvro:${userId}`, "utf8").digest("hex").slice(0, 64);
}

type LiveSessionPayload = {
  id?: unknown;
  sdp?: unknown;
  session?: unknown;
};

/**
 * Exchange the browser's SDP offer for an SDP answer.
 *
 * Extracted so the tests can exercise the call without a route, and so the
 * provider error mapping stays in one place.
 */
export async function createLiveSession(options: {
  apiKey: string;
  baseUrl: string;
  sdp: string;
  voice: LiveVoice;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userId: string;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; sdp: string; providerSessionId: string | null }
  | { ok: false; status: number; code: string; error: string }
> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  const sessionConfig = buildLiveSessionConfig(options.voice);
  const input = buildSessionInput(options.history);

  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/live/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyIdentifier(options.userId),
      },
      body: JSON.stringify({
        session: input.length > 0 ? { ...sessionConfig, input } : sessionConfig,
        transport: { type: "webrtc", sdp: options.sdp },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      return classifyLiveError(response.status, payload);
    }

    const payload = (await response.json().catch(() => null)) as LiveSessionPayload | null;
    const sdp = typeof payload?.sdp === "string" ? payload.sdp : "";
    if (!sdp) {
      return {
        ok: false,
        status: 502,
        code: "provider_error",
        error:
          "Le fournisseur vocal n'a pas renvoyé de description de session. / The voice provider returned no session description.",
      };
    }
    return {
      ok: true,
      sdp,
      providerSessionId: typeof payload?.id === "string" ? payload.id : null,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: 504,
        code: "timeout",
        error:
          "Le fournisseur vocal a mis trop de temps à répondre. Réessayez. / The voice provider took too long to respond. Please try again.",
      };
    }
    void error;
    return {
      ok: false,
      status: 502,
      code: "provider_error",
      error:
        "Le service vocal est temporairement indisponible. / The voice service is temporarily unavailable.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Map an upstream failure to the code the interface already understands. */
export function classifyLiveError(
  status: number,
  payload: unknown,
): { ok: false; status: number; code: string; error: string } {
  const rawError =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error?: unknown }).error
      : null;
  const errorObj =
    typeof rawError === "object" && rawError !== null
      ? (rawError as Record<string, unknown>)
      : null;
  const upstreamCode = typeof errorObj?.code === "string" ? errorObj.code.toLowerCase() : "";
  const upstreamMessage =
    typeof errorObj?.message === "string" ? errorObj.message.toLowerCase() : "";

  if (status === 401 || upstreamCode === "invalid_api_key") {
    return {
      ok: false,
      status: 502,
      code: "invalid_api_key",
      error:
        "Clé API invalide ou rejetée par le fournisseur. Vérifiez VEYVRO_AI_API_KEY sur le serveur. / The provider rejected its API key. Check VEYVRO_AI_API_KEY on the server.",
    };
  }
  if (
    status === 402 ||
    upstreamCode === "insufficient_quota" ||
    (status === 429 && (upstreamMessage.includes("quota") || upstreamMessage.includes("billing")))
  ) {
    return {
      ok: false,
      status: 429,
      code: "insufficient_quota",
      error:
        "Quota API insuffisant ou facturation inactive sur le compte du fournisseur. / Insufficient API quota or inactive billing on the provider account.",
    };
  }
  if (status === 429) {
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      error:
        "Limite de débit atteinte auprès du fournisseur vocal. Réessayez dans un instant. / The voice provider is rate limited. Try again shortly.",
    };
  }
  if (
    status === 403 ||
    upstreamCode === "model_not_found" ||
    (status === 404 && upstreamMessage.includes("model")) ||
    upstreamMessage.includes("not available")
  ) {
    return {
      ok: false,
      status: 502,
      code: "voice_unavailable",
      error:
        "La conversation vocale n'est pas disponible pour ce compte (modèle ou voix non autorisé). / Voice conversation is not available for this account (model or voice not enabled).",
    };
  }
  if (status === 400) {
    return {
      ok: false,
      status: 400,
      code: "invalid_session",
      error:
        "La demande de session vocale est invalide. / The voice session request is invalid.",
    };
  }
  return {
    ok: false,
    status: 502,
    code: "provider_error",
    error:
      "Le service vocal est temporairement indisponible. / The voice service is temporarily unavailable.",
  };
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
  const sdp = typeof body.sdp === "string" ? body.sdp.trim() : "";
  if (!sdp || sdp.length > MAX_SDP_CHARACTERS) {
    return response.status(400).json({
      code: "invalid_offer",
      error: "A WebRTC session description (SDP offer) is required.",
    });
  }

  // An unknown voice id is never forwarded: it would be an arbitrary string sent
  // to OpenAI with our key. It is replaced by the default, and the client is told
  // so it can repair the account preference.
  const { voice, rejectedRequest } = selectVoice(body.voice);

  const storeEnv = voiceStoreEnv();
  if (!storeEnv) {
    return response.status(503).json({
      code: "not_configured",
      error: "VEYVRO's voice store is not configured on the server.",
    });
  }

  const apiKey = readEnvVar("VEYVRO_AI_API_KEY", "VEYDRIVO_AI_API_KEY", "DRIVIA_AI_API_KEY");
  if (!apiKey) {
    // Checked BEFORE reserving: a missing key is a deployment fault, and it
    // must not leave a reservation to refund.
    return response.status(503).json({
      code: "missing_api_key",
      error: "VEYVRO's AI provider is not configured. Set VEYVRO_AI_API_KEY on the server.",
    });
  }

  // Reserved atomically in Postgres. A Découverte account is refused here, by
  // `voice_not_in_plan`, before any provider call.
  let reservation: Awaited<ReturnType<typeof reserveVoiceSeconds>>;
  try {
    reservation = await reserveVoiceSeconds(storeEnv, {
      userId: access.userId,
      allowanceSeconds: access.limits.voiceMinutesPerDay * 60,
      reserveSeconds: VOICE_RESERVATION_SECONDS,
      voiceId: voice.id,
      ttlSeconds: VOICE_RESERVATION_TTL_SECONDS,
    });
  } catch (error) {
    if (error instanceof VoiceStoreUnavailableError) {
      return response.status(503).json({ code: "voice_store_unavailable", error: error.message });
    }
    throw error;
  }

  if (!reservation.ok) {
    if (reservation.retryAfterSeconds > 0) {
      response.setHeader("Retry-After", String(reservation.retryAfterSeconds));
    }
    // `voice_session_open` is a 409: the account already has a live session.
    // Answering 429 would make the interface suggest waiting for a quota reset
    // when the real cause is a tab that is still open.
    const status =
      reservation.kind === "voice_not_in_plan"
        ? 403
        : reservation.kind === "voice_session_open"
          ? 409
          : 429;
    const error =
      reservation.kind === "voice_not_in_plan"
        ? "La conversation vocale fait partie des formules VEYVRO Plus et Pro. / Voice conversation is part of the VEYVRO Plus and Pro plans."
        : reservation.kind === "voice_session_open"
          ? "Une conversation vocale est déjà en cours sur ce compte. Terminez-la avant d'en ouvrir une autre. / A voice conversation is already running on this account."
          : `Vous avez atteint votre quota vocal de ${Math.floor(reservation.limitSeconds / 60)} minutes pour aujourd'hui. Il revient à minuit UTC. / You have reached your daily voice allowance of ${Math.floor(reservation.limitSeconds / 60)} minutes. It resets at midnight UTC.`;
    return response.status(status).json({
      code: reservation.kind,
      error,
      plan: access.plan,
      limit: Math.floor(reservation.limitSeconds / 60),
      used: Math.floor(reservation.usedSeconds / 60),
      retryAfterSeconds: reservation.retryAfterSeconds,
    });
  }

  const baseUrl =
    readEnvVar("VEYVRO_AI_BASE_URL", "VEYDRIVO_AI_BASE_URL", "DRIVIA_AI_BASE_URL") ||
    "https://api.openai.com/v1";

  const created = await createLiveSession({
    apiKey,
    baseUrl,
    sdp,
    voice,
    history: readHistory(request.body),
    userId: access.userId,
  });

  if (!created.ok) {
    // A session that never started must not cost the user any of their minutes.
    // The refund is idempotent in the database, so a retried request cannot
    // give the reservation back twice.
    await refundVoiceReservation(storeEnv, {
      userId: access.userId,
      sessionId: reservation.sessionId,
    }).catch(() => null);
    if (created.status === 429) {
      response.setHeader("Retry-After", "5");
    }
    return response.status(created.status).json({ code: created.code, error: created.error });
  }

  return response.status(201).json({
    sessionId: reservation.sessionId,
    sdp: created.sdp,
    voice: {
      id: voice.id,
      label: voice.label,
      replacedInvalidRequest: rejectedRequest,
    },
    quota: {
      limitMinutes: Math.floor(access.limits.voiceMinutesPerDay),
      remainingSeconds: reservation.remainingSeconds,
      usedSeconds: reservation.usedSeconds,
    },
  });
}
