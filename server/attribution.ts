import crypto from "node:crypto";

/**
 * Attribution proof: the cryptographic link between a payment and an account.
 *
 * Problem it solves. `customData` is sent by the browser, so a user can rewrite
 * `user_id` in the console before paying. A bare `user_id` in a webhook is
 * therefore a claim, not a proof.
 *
 * How it works:
 * 1. the browser presents its Supabase access token to `api/paddle-attribution`;
 * 2. that route asks Supabase who the token belongs to (never trusting the body);
 * 3. it returns `proof = HMAC(key, "veyvro:attribution:v1:" + userId)`;
 * 4. the checkout puts `{ user_id, attribution_proof }` in `customData`;
 * 5. the webhook recomputes the same HMAC for the claimed `user_id` and compares
 *    in constant time.
 *
 * Swapping `user_id` for another account now invalidates the proof, because the
 * HMAC is bound to the exact id. Only the server can produce a valid pair.
 *
 * Key derivation. The key is derived from `PADDLE_WEBHOOK_SECRET`, so no extra
 * environment variable is needed. A dedicated HMAC with a fixed label is used
 * instead of the raw secret, so the two purposes never share key material.
 *
 * Server-only module: never import it from `src/`.
 */

/** Domain separator, versioned so a future scheme can coexist. */
const ATTRIBUTION_CONTEXT = "veyvro:attribution:v1";

/** Prefix of the emitted proof, so a scheme change is detectable. */
export const ATTRIBUTION_PROOF_VERSION = "v1";

/** Length in bytes of the derived key and of the HMAC output. */
const KEY_LENGTH = 32;

/**
 * Derive the attribution key from the webhook secret.
 * Throws when the secret is missing so a caller can never fall back to an
 * unkeyed value.
 */
export function deriveAttributionKey(secret: string | null | undefined): Buffer {
  const trimmed = (secret ?? "").trim();
  if (!trimmed) {
    throw new Error("Cannot derive an attribution key without a secret.");
  }
  return crypto
    .createHmac("sha256", trimmed)
    .update(`${ATTRIBUTION_CONTEXT}:key`)
    .digest()
    .subarray(0, KEY_LENGTH);
}

/** `v1.<base64url>` proof binding a user id to the server secret. */
export function computeAttributionProof(
  secret: string | null | undefined,
  userId: string,
): string {
  const id = (userId ?? "").trim();
  if (!id) throw new Error("Cannot sign an empty user id.");

  const mac = crypto
    .createHmac("sha256", deriveAttributionKey(secret))
    .update(`${ATTRIBUTION_CONTEXT}:${id}`)
    .digest("base64url");

  return `${ATTRIBUTION_PROOF_VERSION}.${mac}`;
}

/** Constant-time comparison that tolerates length differences. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Verify a proof against the *claimed* user id.
 *
 * Returns false for a missing proof, an unknown version, a malformed value, or
 * a proof that belongs to another account. Never throws: a caller only needs a
 * boolean decision.
 */
export function verifyAttributionProof(
  secret: string | null | undefined,
  userId: string,
  proof: string | null | undefined,
): boolean {
  const candidate = (proof ?? "").trim();
  const id = (userId ?? "").trim();
  if (!candidate || !id) return false;

  const separator = candidate.indexOf(".");
  if (separator <= 0) return false;
  if (candidate.slice(0, separator) !== ATTRIBUTION_PROOF_VERSION) return false;

  let expected: string;
  try {
    expected = computeAttributionProof(secret, id);
  } catch {
    // Missing secret: fail closed.
    return false;
  }
  return safeEqual(candidate, expected);
}
