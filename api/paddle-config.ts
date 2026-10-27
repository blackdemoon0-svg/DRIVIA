/**
 * Public Paddle configuration endpoint.
 *
 * Why this route exists: Vite only inlines variables prefixed with `VITE_` into
 * the browser bundle. A variable saved in Vercel as `PADDLE_CLIENT_TOKEN` is
 * therefore readable **only by the server**. This handler exposes that single
 * public value to the browser so the checkout can initialise Paddle.js without
 * renaming the Vercel variable.
 *
 * What it deliberately does NOT do:
 * - never returns, reads or logs the Paddle API key (server-side secret);
 * - never accepts a secret through a `VITE_` variable;
 * - no cache: the value is re-read per request so a rotated client token is
 *   picked up without a rebuild.
 *
 * The Paddle client token is public by design: it only authorises opening a
 * checkout overlay for the configured environment, and every price is verified
 * separately with `Paddle.PricePreview` before any payment.
 */

type ApiRequest = {
  method?: string;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

/**
 * Read the client token from the environment, accepting both the variable saved
 * by the project owner (`PADDLE_CLIENT_TOKEN`) and the Vite-prefixed variant
 * used for build-time inlining. The first non-empty value wins.
 */
export function readClientToken(env: Record<string, string | undefined> = process.env): string | null {
  for (const name of ["PADDLE_CLIENT_TOKEN", "VITE_PADDLE_CLIENT_TOKEN"]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export default function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Only GET requests are supported." });
  }

  // Only the publishable client token is exposed. No API key, no price list:
  // price IDs are already part of the public bundle.
  return response.status(200).json({ clientToken: readClientToken() });
}
