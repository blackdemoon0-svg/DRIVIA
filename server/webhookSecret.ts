/**
 * Webhook secret ring: the current signing secret, plus the one it replaces.
 *
 * Why this exists
 * ---------------
 * `PADDLE_WEBHOOK_SECRET` serves two purposes: verifying Paddle's
 * `Paddle-Signature`, and deriving the key that signs the attribution proof put
 * into `customData` at checkout. Rotating it therefore breaks two things at
 * once, and the second one is silent:
 *
 * - a delivery signed with the old secret answers 401 until the new secret is
 *   deployed (Paddle retries, so a fast deploy is enough);
 * - **a proof minted before the rotation no longer verifies** — and a customer
 *   who opened the checkout a minute before the rotation pays, then gets
 *   nothing. That is the failure this module exists to prevent: the webhook
 *   stored `invalid_attribution_proof` for a real, paid `subscription.created`.
 *
 * The ring is deliberately narrow:
 * - `PADDLE_WEBHOOK_SECRET` is always required and always authoritative;
 * - `PADDLE_WEBHOOK_SECRET_PREVIOUS` is honoured **only** inside an explicit,
 *   bounded window given by `PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL` (ISO 8601);
 * - a missing, unreadable, past or too-distant `_UNTIL` disables the old
 *   secret entirely — the ring fails closed, never open-ended;
 * - a `_PREVIOUS` equal to the current secret is ignored, so one value can
 *   never be counted twice.
 *
 * Nothing here logs or returns a secret. `secretKeyId` produces a short,
 * one-way fingerprint so an operator can tell *which* secret a delivery or a
 * proof was signed with, without ever seeing the value.
 *
 * Server-only module: never import it from `src/`.
 */

import crypto from "node:crypto";

/** Variable names exactly as configured in Vercel. */
export const RING_ENV_KEYS = {
  current: "PADDLE_WEBHOOK_SECRET",
  previous: "PADDLE_WEBHOOK_SECRET_PREVIOUS",
  previousUntil: "PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL",
} as const;

/** Upper bound on the grace window. Longer is a mistake, not a policy. */
export const SECRET_RING_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Why the previous secret, when declared, was not used. Never contains it. */
export type PreviousRejection =
  | "missing_until"
  | "unreadable_until"
  | "expired"
  | "window_too_long"
  | "duplicate_of_current";

export type SecretRing = {
  current: string | null;
  /** Usable previous secret, or null. */
  previous: string | null;
  /** True when a non-empty `_PREVIOUS` was configured at all. */
  previousDeclared: boolean;
  /** When set, why the declared previous secret was ignored. */
  previousRejection: PreviousRejection | null;
  /** Epoch ms of the window end, when one could be read. */
  previousUntilMs: number | null;
};

type Env = Record<string, string | undefined>;

function readValue(env: Env, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the ring from the environment.
 *
 * `nowMs` is injectable so the window is testable without freezing the clock.
 */
export function readSecretRing(env: Env, nowMs: number = Date.now()): SecretRing {
  const current = readValue(env, RING_ENV_KEYS.current) || null;
  const declared = readValue(env, RING_ENV_KEYS.previous);
  const previousDeclared = declared.length > 0;

  const base: SecretRing = {
    current,
    previous: null,
    previousDeclared,
    previousRejection: null,
    previousUntilMs: null,
  };

  if (!previousDeclared) return base;

  // A previous secret that is not distinct from the current one is not a ring:
  // counting the same value twice would only widen one key by accident.
  if (current && declared === current) {
    return { ...base, previousRejection: "duplicate_of_current" };
  }

  const untilRaw = readValue(env, RING_ENV_KEYS.previousUntil);
  if (!untilRaw) return { ...base, previousRejection: "missing_until" };

  const untilMs = Date.parse(untilRaw);
  if (!Number.isFinite(untilMs)) {
    return { ...base, previousRejection: "unreadable_until" };
  }

  // The window is a promise the operator makes to themselves. A date beyond the
  // policy maximum means the value is wrong, so it is refused rather than
  // silently clamped: clamping would keep an old secret alive longer than
  // anyone intended.
  if (untilMs - nowMs > SECRET_RING_MAX_WINDOW_MS) {
    return { ...base, previousUntilMs: untilMs, previousRejection: "window_too_long" };
  }

  // Expiry is inclusive of nothing: at `_UNTIL` and after, the old secret is
  // already ignored, even if the variable is still in place.
  if (untilMs <= nowMs) {
    return { ...base, previousUntilMs: untilMs, previousRejection: "expired" };
  }

  return { ...base, previous: declared, previousUntilMs: untilMs };
}

/**
 * The secrets to try, current first.
 *
 * The current secret is **required**: without it the ring is empty, so a
 * deployment that lost `PADDLE_WEBHOOK_SECRET` refuses every delivery instead of
 * silently falling back to the one it was supposed to retire. Fail-closed on the
 * current key is the whole point — the previous one is a grace period, never a
 * substitute.
 *
 * Order matters for observability only: the `keyIndex` returned by a successful
 * verification says which key matched, which is what an operator needs after a
 * rotation.
 */
export function ringSecrets(ring: SecretRing): string[] {
  if (!ring.current) return [];
  return ring.previous ? [ring.current, ring.previous] : [ring.current];
}

/**
 * Short, one-way fingerprint of a secret, for logs only.
 *
 * Eight hex characters of a dedicated HMAC: stable for a given secret, useless
 * for recovering it, and enough to tell two deployments' secrets apart — which
 * is exactly the question a `invalid_attribution_proof` raises.
 */
export function secretKeyId(secret: string | null | undefined): string | null {
  const trimmed = (secret ?? "").trim();
  if (!trimmed) return null;
  return crypto
    .createHmac("sha256", trimmed)
    .update("veyvro:webhook-key-id:v1")
    .digest("hex")
    .slice(0, 8);
}
