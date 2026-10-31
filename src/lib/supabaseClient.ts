import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-side Supabase client.
 *
 * The Vercel variables are named `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Vite
 * only inlines `VITE_`-prefixed variables, so those two are invisible to the
 * bundle: they are read by the server and fetched from `/api/supabase-config`.
 * Nothing here is a secret — the anon key only grants what the row level
 * security policies allow, and privileged writes stay behind a server route.
 *
 * This module must never import a server-only value, and must never read
 * `SUPABASE_SERVICE_ROLE_KEY` or `VEYVRO_DATABASE_URL`.
 */

/** Same-origin endpoint exposing the two public values. */
const SUPABASE_CONFIG_ENDPOINT = "/api/supabase-config";

export type SupabasePublicConfig = {
  url: string | null;
  anonKey: string | null;
};

/** Raised when the public configuration is missing or unusable. */
export class SupabaseConfigError extends Error {
  readonly missingKeys: readonly string[];

  constructor(message: string, missingKeys: readonly string[] = []) {
    super(message);
    this.name = "SupabaseConfigError";
    this.missingKeys = missingKeys;
  }
}

/**
 * Ask the server for the public configuration.
 * Returns `null` on any transport failure; a successful response may still
 * carry `null` fields when a variable is absent.
 */
export async function fetchSupabaseConfig(
  signal?: AbortSignal,
): Promise<SupabasePublicConfig | null> {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(SUPABASE_CONFIG_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Partial<SupabasePublicConfig> | null;
    const url = typeof payload?.url === "string" ? payload.url.trim() : "";
    const anonKey = typeof payload?.anonKey === "string" ? payload.anonKey.trim() : "";
    return { url: url || null, anonKey: anonKey || null };
  } catch {
    return null;
  }
}

let clientPromise: Promise<SupabaseClient> | null = null;

/**
 * Resolve the shared client, creating it at most once.
 *
 * Throws `SupabaseConfigError` naming the missing variables — never their
 * values — when the server cannot supply them.
 */
export function getSupabaseClient(): Promise<SupabaseClient> {
  if (clientPromise) return clientPromise;

  clientPromise = fetchSupabaseConfig().then((config) => {
    if (!config) {
      throw new SupabaseConfigError(
        "Configuration Supabase illisible : la route /api/supabase-config est injoignable.",
      );
    }

    const missing: string[] = [];
    if (!config.url) missing.push("SUPABASE_URL");
    if (!config.anonKey) missing.push("SUPABASE_ANON_KEY");
    if (missing.length > 0 || !config.url || !config.anonKey) {
      throw new SupabaseConfigError(
        `Configuration Supabase incomplète. Variables manquantes : ${missing.join(", ")}.`,
        missing,
      );
    }

    if (!/^https?:\/\//i.test(config.url)) {
      throw new SupabaseConfigError(
        "Configuration Supabase invalide : SUPABASE_URL doit commencer par https://.",
        ["SUPABASE_URL"],
      );
    }

    return createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The confirmation e-mail brings the session back on the site root,
        // so the client must pick it up from the URL it lands on.
        detectSessionInUrl: true,
      },
    });
  });

  // Do not cache a failure: a transient 500 on the config route would otherwise
  // poison the client for the whole page life.
  clientPromise.catch(() => {
    clientPromise = null;
  });

  return clientPromise;
}

/** Test/diagnostic helper: drop the memoised client. */
export function resetSupabaseClientCache(): void {
  clientPromise = null;
}
