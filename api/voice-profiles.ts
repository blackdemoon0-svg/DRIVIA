import {
  authorizeRequest,
  readAccessEnv,
  resolveIdentity,
  IdentityUnavailableError,
} from "../server/access.js";
import { DEFAULT_VOICE_ID, listVoices, publicVoice, resolveVoice } from "../server/ai/voiceCatalog.js";

/**
 * Voice catalogue and per-account preference.
 *
 *   GET  /api/voice-profiles            → catalogue + the caller's saved voice
 *   PUT  /api/voice-profiles { voice }  → validate and save the choice
 *
 * Why a route rather than reading `user_metadata` from the browser: the browser
 * can already read its own metadata, but it must not be able to *write* an
 * arbitrary voice id, and the catalogue must stay server-authoritative so an id
 * that disappears from the documentation stops being offered.
 *
 * Where the preference is stored: `auth.users.raw_user_meta_data`, through the
 * user's own authenticated session — exactly the mechanism the project already
 * uses for `avatar_url` (`client.auth.updateUser`). No new table, no migration,
 * no service-role key, and the value survives sessions and devices because it
 * lives on the account. Writing it must not touch the keys the avatar uses, so
 * the merge semantics of `/auth/v1/user` matter here (see `saveVoice`).
 *
 * The value is not a secret: it is the name of a voice.
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

/** Metadata key, prefixed like the other application keys. */
export const VOICE_METADATA_KEY = "veyvro_voice";

function readRequestHeader(request: ApiRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value ? value : null;
}

function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length >= 20 ? token : null;
}

/** Read the voice stored on the account, if it is still a known id. */
export function readStoredVoice(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const raw = (metadata as Record<string, unknown>)[VOICE_METADATA_KEY];
  const voice = resolveVoice(raw);
  return voice ? voice.id : null;
}

/**
 * Save the voice on the account, WITHOUT destroying the other preferences.
 *
 * The first version of this route used the admin endpoint
 * (`PUT /auth/v1/admin/users/{id}` with `{ data: … }`), which replaces the whole
 * `raw_user_meta_data` object. That would have silently wiped `avatar_url`,
 * `avatar_path` and `avatar_updated_at` — the profile photo the project already
 * stores in the same place — the first time a user picked a voice. A voice
 * setting must never cost a user their photo.
 *
 * So the write goes through the user's own session (`PUT /auth/v1/user` with the
 * caller's token), exactly like `client.auth.updateUser` used by the avatar
 * feature: Supabase merges the supplied `data` keys instead of replacing them.
 * No service-role key is needed, which is also one secret less in this route.
 */
async function saveVoice(
  env: { url: string; anonKey: string },
  accessToken: string,
  voiceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const response = await fetchImpl(`${env.url}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      // `data` is merged into the existing metadata by Supabase, not substituted.
      body: JSON.stringify({ data: { [VOICE_METADATA_KEY]: voiceId } }),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        error: "Impossible d'enregistrer la voix sur le compte. / Could not save the voice on the account.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      status: 502,
      error: "Le service de compte est injoignable. / The account service is unreachable.",
    };
  }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "GET" && request.method !== "PUT") {
    return response.status(405).json({ error: "Only GET and PUT requests are supported." });
  }

  const authorization = readRequestHeader(request, "authorization");
  const token = readBearer(authorization);

  const catalogue = listVoices().map(publicVoice);

  // The catalogue is public information: it is returned even to an anonymous
  // visitor, so the picker can render before sign-in. The preference is not.
  if (request.method === "GET" && !token) {
    return response.status(200).json({
      defaultVoice: DEFAULT_VOICE_ID,
      voices: catalogue,
      selected: null,
    });
  }

  // Everything past this point needs an identity. A PUT without a token must be
  // refused here rather than relying on Supabase rejecting an empty bearer:
  // fail closed on our side, always.
  if (!token) {
    return response.status(401).json({ code: "auth_required", error: "Sign in to choose a voice." });
  }

  const env = readAccessEnv();
  if (!env) {
    return response.status(503).json({ code: "not_configured", error: "Server configuration is incomplete." });
  }

  let identity: { userId: string; metadata: Record<string, unknown> } | null = null;
  try {
    identity = await resolveIdentityWithMetadata(token, env);
  } catch (error) {
    if (error instanceof IdentityUnavailableError) {
      return response.status(503).json({ code: "identity_unavailable", error: error.message });
    }
    throw error;
  }
  if (!identity) {
    return response.status(401).json({ code: "auth_required", error: "Sign in to choose a voice." });
  }

  if (request.method === "GET") {
    return response.status(200).json({
      defaultVoice: DEFAULT_VOICE_ID,
      voices: catalogue,
      selected: readStoredVoice(identity.metadata) ?? DEFAULT_VOICE_ID,
    });
  }

  // PUT: the plan does not gate *choosing* a voice — only using it. A Découverte
  // user may prepare the choice before upgrading.
  const body =
    typeof request.body === "object" && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {};
  const requested = resolveVoice(body.voice);
  if (!requested) {
    return response.status(400).json({
      code: "unknown_voice",
      error: "This voice does not exist in the VEYVRO catalogue.",
    });
  }

  const saved = await saveVoice(env, token, requested.id);
  if (!saved.ok) {
    return response.status(saved.status).json({ code: "save_failed", error: saved.error });
  }

  return response.status(200).json({
    selected: requested.id,
    voice: publicVoice(requested),
  });
}

/**
 * Resolve the caller AND read their metadata.
 *
 * `resolveIdentity` deliberately returns only an id and a confirmation flag — it
 * never exposes account data to a caller. The voice preference needs one extra
 * field, read from the same authenticated response, so the token is still
 * validated by Supabase and never by us.
 */
async function resolveIdentityWithMetadata(
  accessToken: string,
  env: { url: string; anonKey: string },
): Promise<{ userId: string; metadata: Record<string, unknown> } | null> {
  const identity = await resolveIdentity(accessToken, { ...env, serviceRoleKey: "" });
  if (!identity) return null;

  // The metadata comes from the same endpoint `resolveIdentity` just validated.
  const response = await fetch(`${env.url}/auth/v1/user`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => null)) as
    | { user_metadata?: unknown }
    | null;
  const metadata =
    typeof payload?.user_metadata === "object" && payload.user_metadata !== null
      ? (payload.user_metadata as Record<string, unknown>)
      : {};
  return { userId: identity.userId, metadata };
}

// Referenced so the import is not dropped: `authorizeRequest` is intentionally
// not used here, because this route must answer the catalogue to anonymous
// visitors, which `authorizeRequest` refuses by design.
void authorizeRequest;
