/**
 * VEYVRO — canonical consumption identifiers for the durable AI usage ledger.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The durable quotas need one identifier per user message. That identifier is
 * the primary key of `public.ai_usage_events`, so it decides three things at
 * once:
 *
 *   • idempotency — a network retry that reuses the same identifier must not be
 *     charged twice;
 *   • isolation   — a message of account A must never be able to collide with a
 *     message of account B, not even by replaying the other account's browser
 *     identifier;
 *   • non-forgeability — the browser must never be able to pick the primary key
 *     of a row that grants it a free message.
 *
 * The browser may therefore send a *request identifier* (`clientMessageId`), but
 * the primary key is always produced here, from the **verified** account id and
 * that request identifier. The client's value is input, never authority.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE RULE
 * ─────────────────────────────────────────────────────────────────────────────
 *   clientMessageId absent  → randomUUID()  (a genuinely new consumption)
 *   clientMessageId invalid → refused, never silently replaced
 *   clientMessageId valid   → uuidv8(sha256(DOMAIN + len(userId) + userId + clientMessageId))
 *
 * "Absent" means exactly `undefined` — a field the client did not send. `null`,
 * the empty string and blank strings are **present and wrong**: they are
 * refused, never replaced by a random identifier. Otherwise a retry that lost
 * its identifier would look like a brand-new message and be charged twice.
 *
 * The derivation is:
 *   • deterministic — the same (account, request id) pair yields the same
 *     identifier, so a retry lands on the same row instead of a second one;
 *   • scoped to the account — the same request id used by two accounts yields
 *     two different identifiers, so one account can never address, reuse or
 *     pre-claim another account's consumption row;
 *   • dependency-free — `node:crypto` only (the project ships no UUID library).
 *
 * `CONSUMPTION_ID_DOMAIN` is versioned and must never change once production has
 * written rows: changing it would re-key every retry and silently break
 * idempotency for in-flight messages.
 */

import { createHash, randomUUID } from "node:crypto";

/**
 * Domain separator, prefixed to every derivation.
 *
 * Versioned on purpose: a future algorithm change must use `v2`, so old and new
 * identifiers can never be confused. **Never edit the value of `v1`.**
 */
export const CONSUMPTION_ID_DOMAIN = "veyvro:ai-usage:v1:";

/**
 * A client-supplied request identifier: RFC 4122 **version 4** UUID.
 *
 * Case-insensitive on input (RFC 4122 UUIDs are), normalised to lower case
 * before derivation so `ABC…` and `abc…` are the same request.
 */
export const CLIENT_MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Shape of any consumption identifier this module produces.
 *
 * Version nibble is not pinned: derived identifiers are version 8 (custom),
 * random ones are version 4. Only the variant (RFC 4122) is enforced.
 */
export const CONSUMPTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `missing` is reserved for an absent field (`undefined`); anything present but
 * unusable is `not_a_string` or `invalid_format`.
 */
export type ClientMessageIdCheck =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "not_a_string" | "invalid_format" };

/**
 * Validate a client-supplied request identifier.
 *
 * Only `undefined` means "the client tagged nothing"; the caller then generates
 * a random identifier. Everything else that is not a v4 UUID is refused: a
 * present-and-wrong value is never silently replaced, because that would make a
 * retry look idempotent while actually being a second consumption.
 *
 * `null`, `""` and `"   "` fall in the "present and wrong" category on purpose:
 * a client that blanks the field on retry must see an explicit 400, not a new
 * consumption it did not ask for.
 */
export function checkClientMessageId(raw: unknown): ClientMessageIdCheck {
  if (raw === undefined) return { ok: false, reason: "missing" };
  // Covers `null` (typeof null === "object") as well as objects and numbers.
  if (typeof raw !== "string") return { ok: false, reason: "not_a_string" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "invalid_format" };
  if (!CLIENT_MESSAGE_ID_PATTERN.test(trimmed)) return { ok: false, reason: "invalid_format" };
  return { ok: true, value: trimmed.toLowerCase() };
}

/** A fresh identifier for a message the client did not tag. */
export function newConsumptionId(): string {
  const id = randomUUID();
  // Defensive: the value is handed to a database primary key.
  if (!CONSUMPTION_ID_PATTERN.test(id)) {
    throw new Error("consumptionId: randomUUID() produced an unusable identifier");
  }
  return id;
}

/**
 * Derive the canonical identifier of one message of one account.
 *
 * The length prefix on `userId` makes the concatenation unambiguous: without it
 * `("ab", "c…")` and `("a", "bc…")` could produce the same input string.
 */
export function consumptionIdFor(userId: string, clientMessageId: string): string {
  const account = (userId ?? "").trim();
  if (!account) throw new Error("consumptionId: a verified user id is required");
  const request = (clientMessageId ?? "").trim().toLowerCase();
  if (!CLIENT_MESSAGE_ID_PATTERN.test(request)) {
    throw new Error("consumptionId: clientMessageId must be a v4 UUID");
  }

  const digest = createHash("sha256")
    .update(`${CONSUMPTION_ID_DOMAIN}${account.length}:${account}:${request}`, "utf8")
    .digest("hex");

  // 32 hex characters → RFC 4122 layout, version 8 (custom) + RFC variant.
  const variant = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  const id = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `8${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");

  if (!CONSUMPTION_ID_PATTERN.test(id)) {
    throw new Error("consumptionId: derivation produced an unusable identifier");
  }
  return id;
}

export type ResolvedConsumptionId =
  | { ok: true; consumptionId: string; derived: boolean }
  | { ok: false; reason: "missing_user_id" | "invalid_client_message_id" };

/**
 * Single entry point used by the chat route.
 *
 * `userId` must be the identity **verified from the Supabase token** — never a
 * value read from the request body. Any other caller invariant breaks the
 * isolation property this module exists for.
 */
export function resolveConsumptionId(
  userId: string,
  rawClientMessageId: unknown,
): ResolvedConsumptionId {
  const account = typeof userId === "string" ? userId.trim() : "";
  if (!account) return { ok: false, reason: "missing_user_id" };

  const check = checkClientMessageId(rawClientMessageId);
  if (check.ok) return { ok: true, consumptionId: consumptionIdFor(account, check.value), derived: true };
  if (check.reason === "missing") return { ok: true, consumptionId: newConsumptionId(), derived: false };
  return { ok: false, reason: "invalid_client_message_id" };
}
