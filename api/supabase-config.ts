/**
 * Public Supabase configuration endpoint.
 *
 * Why this route exists: Vite only inlines variables prefixed with `VITE_` into
 * the browser bundle. The project's Supabase credentials are saved in Vercel as
 * `SUPABASE_URL` and `SUPABASE_ANON_KEY` (no prefix), so they are readable
 * **only by the server**. This handler bridges that gap and exposes those two
 * public values to the browser, without renaming a single Vercel variable.
 *
 * What it deliberately does NOT do:
 * - never reads, returns or logs `SUPABASE_SERVICE_ROLE_KEY` or any database
 *   URL: no secret is part of this response;
 * - refuses to return a key that looks like a secret, so a `SUPABASE_ANON_KEY`
 *   mistakenly filled with a service-role key can never reach the browser;
 * - no cache: values are re-read per request, so a rotated key is picked up
 *   without a rebuild.
 *
 * The Supabase anon key is public by design: it only authorises what the row
 * level security policies allow, and every privileged write goes through a
 * server route using a secret that never leaves the server.
 */

type ApiRequest = {
  method?: string;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

/** Variable names as configured in Vercel — read as-is, never renamed. */
export const SUPABASE_ENV_KEYS = {
  url: "SUPABASE_URL",
  anonKey: "SUPABASE_ANON_KEY",
} as const;

export type SupabasePublicConfig = {
  url: string | null;
  anonKey: string | null;
};

function readVar(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * Decode the `role` claim of a Supabase JWT without verifying it.
 *
 * Verification is pointless here: the goal is not to trust the key, it is to
 * refuse to *publish* one that claims elevated privileges.
 */
function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const parsed = JSON.parse(payload) as { role?: unknown };
    return typeof parsed.role === "string" ? parsed.role : null;
  } catch {
    return null;
  }
}

/**
 * True when a key must never be published: service-role JWTs and the newer
 * `sb_secret_…` keys. The legacy anon JWT (`role: "anon"`) and `sb_publishable_…`
 * keys both pass.
 */
export function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  return jwtRole(key) === "service_role";
}

/**
 * Read the two public values from the environment.
 * Returns `null` for anything missing or unsafe — never a fallback secret.
 */
export function readSupabaseConfig(
  env: Record<string, string | undefined> = process.env,
): SupabasePublicConfig {
  const url = readVar(env, SUPABASE_ENV_KEYS.url);
  const anonKey = readVar(env, SUPABASE_ENV_KEYS.anonKey);
  return {
    url,
    anonKey: anonKey && !isSecretKey(anonKey) ? anonKey : null,
  };
}

export default function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Only GET requests are supported." });
  }

  const config = readSupabaseConfig();

  // A publishable key is expected here. If the configured value is a secret,
  // report the misconfiguration without echoing anything that could identify it.
  if (config.anonKey === null && readVar(process.env, SUPABASE_ENV_KEYS.anonKey) !== null) {
    return response.status(500).json({
      ...config,
      error: "SUPABASE_ANON_KEY must be a publishable key. A secret key was refused and not returned.",
    });
  }

  return response.status(200).json(config);
}
