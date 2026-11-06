// The `.js` extension is required, not cosmetic: `package.json` declares
// `"type": "module"`, and Node refuses extensionless relative specifiers in ESM.
// Without it the whole function fails to load and Vercel answers
// 500 FUNCTION_INVOCATION_FAILED before the handler even runs.
// Same convention as `api/chat.ts` → `../server/veyvroSystemPrompt.js`.
import { computeAttributionProof, deriveAttributionKey } from "../server/attribution.js";

/**
 * Attribution endpoint: proves which account is about to pay.
 *
 * The browser presents its Supabase access token. This handler asks Supabase who
 * that token belongs to — the identity is never read from the request body — and
 * returns an HMAC proof bound to that exact user id.
 *
 * What this handler deliberately does NOT do:
 * - never returns the access token, the refresh token, the session, or the email;
 * - never accepts a `userId` from the caller: it is ignored if present;
 * - never issues a proof for an unconfirmed address;
 * - never touches a secret it does not need (`SUPABASE_SERVICE_ROLE_KEY` is not
 *   read here; the anon key plus the user token is enough).
 */

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

/** Variable names exactly as configured in Vercel. */
export const ATTRIBUTION_ENV_KEYS = {
  supabaseUrl: "SUPABASE_URL",
  supabaseAnonKey: "SUPABASE_ANON_KEY",
  attributionSecret: "PADDLE_WEBHOOK_SECRET",
} as const;

export type AttributionIdentity = {
  userId: string;
  emailConfirmed: boolean;
};

function readHeader(request: ApiRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value ? value : null;
}

/** Extract the bearer token, refusing obvious non-tokens early. */
export function readBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token || token.length < 20) return null;
  // A JWT has three segments; anything else is not a Supabase access token.
  if (token.split(".").length !== 3) return null;
  return token;
}

/**
 * Resolve the token's owner with Supabase.
 *
 * `/auth/v1/user` validates the JWT signature, expiry and revocation on
 * Supabase's side, which is exactly the authority we need. Returns null when the
 * token is invalid or expired.
 */
export async function resolveIdentity(
  accessToken: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AttributionIdentity | null> {
  const url = env[ATTRIBUTION_ENV_KEYS.supabaseUrl]?.trim().replace(/\/+$/, "");
  const anonKey = env[ATTRIBUTION_ENV_KEYS.supabaseAnonKey]?.trim();
  if (!url || !anonKey) {
    throw new AttributionConfigError(
      `Configuration serveur incomplète : ${ATTRIBUTION_ENV_KEYS.supabaseUrl} ou ${ATTRIBUTION_ENV_KEYS.supabaseAnonKey} manquante.`,
    );
  }

  const response = await fetch(`${url}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new AttributionConfigError(`Vérification du jeton impossible (${response.status}).`);
  }

  const payload = (await response.json()) as {
    id?: unknown;
    email_confirmed_at?: unknown;
    confirmed_at?: unknown;
  };

  if (typeof payload.id !== "string" || !payload.id) return null;

  return {
    userId: payload.id,
    emailConfirmed: Boolean(payload.email_confirmed_at ?? payload.confirmed_at),
  };
}

/** Raised for server misconfiguration, so the caller answers 5xx (retryable). */
export class AttributionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributionConfigError";
  }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST requests are supported." });
  }

  const accessToken = readBearerToken(readHeader(request, "authorization"));
  if (!accessToken) {
    return response.status(401).json({ error: "A valid Supabase access token is required." });
  }

  const secret = process.env[ATTRIBUTION_ENV_KEYS.attributionSecret]?.trim();
  if (!secret) {
    return response.status(503).json({ error: "Server is not configured to sign attributions." });
  }
  // Fail at startup of the request rather than emitting an unkeyed proof.
  deriveAttributionKey(secret);

  let identity: AttributionIdentity | null;
  try {
    identity = await resolveIdentity(accessToken);
  } catch {
    return response.status(503).json({ error: "Identity provider unavailable, retry later." });
  }

  if (!identity) {
    return response.status(401).json({ error: "Invalid or expired access token." });
  }

  if (!identity.emailConfirmed) {
    return response
      .status(403)
      .json({ error: "Email address must be confirmed before subscribing." });
  }

  // Only the opaque id and its proof leave the server.
  return response.status(200).json({
    userId: identity.userId,
    proof: computeAttributionProof(secret, identity.userId),
  });
}
