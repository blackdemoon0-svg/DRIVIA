/**
 * Signed plan-change quote — the proof that a price was shown *and accepted*
 * before any money moves.
 *
 * The problem it solves
 * ---------------------
 * Without it, the route had two independent requests: one that asked Paddle
 * what the change costs (shown to the customer), and one that applied it. Any
 * client could skip the first and post the second directly, so a charge could be
 * taken without a single figure ever being displayed. Nothing tied the amount
 * the customer saw to the amount Paddle would bill.
 *
 * How it works
 * ------------
 * 1. the preview branch asks Paddle for `update_summary.result`;
 * 2. it signs that exact result into a token: user id, Paddle subscription id,
 *    target plan, interval, price id, action, amount, currency, issue time,
 *    expiry and a random nonce;
 * 3. the token is returned with the amount and shown in the confirmation panel;
 * 4. the apply branch refuses to call Paddle unless the token verifies against
 *    the account making the request, and then **re-runs the preview** and
 *    compares the amount before patching. A quote whose amount no longer
 *    matches is not applied: the customer is asked for a fresh one.
 *
 * Why the API key is the signing secret
 * ------------------------------------
 * No new environment variable is introduced. The plan-change route already
 * cannot work without `PADDLE_API_KEY`, so the key is guaranteed present
 * exactly when this module is used. It is used through an HMAC with a versioned
 * domain separator, so the derived key is never the API key itself, and the
 * token only ever exposes an HMAC output — from which the key cannot be
 * recovered. Rotating the API key invalidates outstanding quotes, which is
 * harmless: they expire in minutes and the customer simply asks for a new one.
 *
 * Server-only module: never import it from `src/`.
 */

import crypto from "node:crypto";
import {
  BILLING_INTERVALS,
  PAID_PLAN_IDS,
  type BillingInterval,
  type PaidPlanId,
} from "../src/lib/paddleCore.js";

/** Domain separator, versioned so a future scheme can coexist. */
const QUOTE_CONTEXT = "veyvro:plan-change-quote:v1";

/** Prefix of every emitted token, so a scheme change is detectable. */
export const QUOTE_VERSION = "v1";

/**
 * How long a quote is valid.
 *
 * Deliberately short. Proration is computed to the minute, so a long-lived quote
 * would drift from what Paddle would actually charge; five minutes is long
 * enough to read a figure and press "confirm", and short enough that the drift
 * stays at a few cents.
 */
export const QUOTE_TTL_MS = 5 * 60_000;

/** Tolerated clock difference on `issuedAt`, so a fair server is not refused. */
const CLOCK_SKEW_MS = 60_000;

/** Length of the derived HMAC key. */
const KEY_LENGTH = 32;

/** Fields the token binds. Every one of them is re-checked at confirmation. */
export type PlanChangeQuote = {
  userId: string;
  subscriptionId: string;
  targetPlan: PaidPlanId;
  interval: BillingInterval;
  priceId: string;
  action: "charge" | "credit";
  amountMinor: number;
  currencyCode: string;
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
};

/** Why a token was refused. Each one maps to a distinct answer. */
export type QuoteRefusal = "missing" | "malformed" | "bad_signature" | "expired" | "mismatch";

export type QuoteVerification =
  | { ok: true; quote: PlanChangeQuote }
  | { ok: false; reason: QuoteRefusal };

type Env = Record<string, string | undefined>;

/** The plan-change route needs this key anyway; no extra variable is created. */
export function readQuoteSecret(env: Env = process.env): string | null {
  const secret = (env.PADDLE_API_KEY ?? "").trim();
  return secret ? secret : null;
}

/** Derive the signing key. Throws on an empty secret: never fall back to none. */
function deriveQuoteKey(secret: string): Buffer {
  const trimmed = (secret ?? "").trim();
  if (!trimmed) throw new Error("Cannot derive a quote key without a secret.");
  return crypto
    .createHmac("sha256", trimmed)
    .update(`${QUOTE_CONTEXT}:key`)
    .digest()
    .subarray(0, KEY_LENGTH);
}

const UUID_LIKE = /^[0-9a-z-]{8,64}$/i;
const SUBSCRIPTION_ID = /^sub_[a-z\d]{26}$/;
const PRICE_ID = /^pri_[a-z\d]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const NONCE = /^[a-f0-9]{32}$/;

/** Every field is range-checked before it is signed or trusted. */
function isQuoteFields(value: unknown): value is PlanChangeQuote {
  if (!value || typeof value !== "object") return false;
  const q = value as Record<string, unknown>;

  if (typeof q.userId !== "string" || !UUID_LIKE.test(q.userId)) return false;
  if (typeof q.subscriptionId !== "string" || !SUBSCRIPTION_ID.test(q.subscriptionId)) return false;
  if (typeof q.targetPlan !== "string" || !(PAID_PLAN_IDS as readonly string[]).includes(q.targetPlan)) return false;
  if (typeof q.interval !== "string" || !(BILLING_INTERVALS as readonly string[]).includes(q.interval)) return false;
  if (typeof q.priceId !== "string" || !PRICE_ID.test(q.priceId)) return false;
  if (q.action !== "charge" && q.action !== "credit") return false;
  if (typeof q.amountMinor !== "number" || !Number.isInteger(q.amountMinor)) return false;
  if (q.amountMinor < 0 || q.amountMinor > 100_000_000) return false;
  if (typeof q.currencyCode !== "string" || !CURRENCY.test(q.currencyCode)) return false;
  if (typeof q.issuedAtMs !== "number" || !Number.isInteger(q.issuedAtMs) || q.issuedAtMs <= 0) return false;
  if (typeof q.expiresAtMs !== "number" || !Number.isInteger(q.expiresAtMs)) return false;
  if (q.expiresAtMs <= q.issuedAtMs) return false;
  // A token may never carry a lifetime longer than the policy allows, so a
  // signed-but-stale quote cannot be replayed indefinitely.
  if (q.expiresAtMs - q.issuedAtMs > QUOTE_TTL_MS) return false;
  if (typeof q.nonce !== "string" || !NONCE.test(q.nonce)) return false;

  return true;
}

/**
 * Canonical field order. The token is a string, not JSON: a JSON parse of
 * attacker-controlled bytes is one more surface for nothing.
 */
function canonicalize(quote: PlanChangeQuote): string {
  return [
    QUOTE_VERSION,
    quote.userId,
    quote.subscriptionId,
    quote.targetPlan,
    quote.interval,
    quote.priceId,
    quote.action,
    String(quote.amountMinor),
    quote.currencyCode,
    String(quote.issuedAtMs),
    String(quote.expiresAtMs),
    quote.nonce,
  ].join("|");
}

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", deriveQuoteKey(secret)).update(payload).digest("base64url");
}

/** Constant-time comparison that tolerates length differences. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export type CreateQuoteInput = {
  secret: string;
  userId: string;
  subscriptionId: string;
  targetPlan: PaidPlanId;
  interval: BillingInterval;
  priceId: string;
  preview: { action: "charge" | "credit"; amountMinor: number; currencyCode: string };
  nowMs?: number;
  ttlMs?: number;
  /** Only the tests pass this; production uses a fresh random nonce. */
  nonce?: string;
};

export type CreatedQuote = { token: string; quote: PlanChangeQuote };

/**
 * Sign one preview into a token.
 *
 * Returns `null` rather than throwing when the inputs do not form a valid quote:
 * a caller must then refuse the change instead of issuing something Paddle (or
 * a later verification) would reject.
 */
export function createPlanChangeQuote(input: CreateQuoteInput): CreatedQuote | null {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? QUOTE_TTL_MS;

  const quote: PlanChangeQuote = {
    userId: (input.userId ?? "").trim(),
    subscriptionId: (input.subscriptionId ?? "").trim(),
    targetPlan: input.targetPlan,
    interval: input.interval,
    priceId: (input.priceId ?? "").trim(),
    action: input.preview.action,
    amountMinor: Math.round(input.preview.amountMinor),
    currencyCode: (input.preview.currencyCode ?? "").trim(),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    nonce: input.nonce ?? crypto.randomBytes(16).toString("hex"),
  };

  if (!isQuoteFields(quote)) return null;

  const payload = Buffer.from(canonicalize(quote), "utf8").toString("base64url");
  const mac = sign(input.secret, `${QUOTE_VERSION}.${payload}`);
  return { token: `${QUOTE_VERSION}.${payload}.${mac}`, quote };
}

export type VerifyQuoteInput = {
  secret: string;
  token: unknown;
  nowMs?: number;
  /** What the current request is asking for. Any difference is a refusal. */
  expected: {
    userId: string;
    subscriptionId: string;
    targetPlan: PaidPlanId;
    interval: BillingInterval;
    priceId: string;
  };
};

/**
 * Verify a token against the request being made right now.
 *
 * Never throws: a caller only needs a decision plus, for the error message, the
 * reason. The signature is checked **before** anything is read out of the
 * payload, so an unsigned token cannot steer the answer.
 */
export function verifyPlanChangeQuote(input: VerifyQuoteInput): QuoteVerification {
  if (typeof input.token !== "string" || !input.token.trim()) {
    return { ok: false, reason: "missing" };
  }

  const parts = input.token.trim().split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [version, payload, mac] = parts as [string, string, string];
  if (version !== QUOTE_VERSION || !payload || !mac) return { ok: false, reason: "malformed" };

  let expectedMac: string;
  try {
    expectedMac = sign(input.secret, `${QUOTE_VERSION}.${payload}`);
  } catch {
    // No usable secret: fail closed.
    return { ok: false, reason: "malformed" };
  }
  if (!safeEqual(mac, expectedMac)) return { ok: false, reason: "bad_signature" };

  // The payload is a `|`-delimited canonical string, not JSON: decoding it can
  // never produce a second interpretation of the same token.
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const fields = decoded.split("|");
  if (fields.length !== 12) return { ok: false, reason: "malformed" };
  const [
    versionField,
    userId,
    subscriptionId,
    targetPlan,
    interval,
    priceId,
    action,
    amount,
    currencyCode,
    issuedAt,
    expiresAt,
    nonce,
  ] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (versionField !== QUOTE_VERSION) return { ok: false, reason: "malformed" };
  if (!/^\d+$/.test(amount) || !/^\d+$/.test(issuedAt) || !/^\d+$/.test(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }

  const quote: PlanChangeQuote = {
    userId,
    subscriptionId,
    targetPlan: targetPlan as PaidPlanId,
    interval: interval as BillingInterval,
    priceId,
    action: action as "charge" | "credit",
    amountMinor: Number(amount),
    currencyCode,
    issuedAtMs: Number(issuedAt),
    expiresAtMs: Number(expiresAt),
    nonce,
  };

  if (!isQuoteFields(quote)) return { ok: false, reason: "malformed" };

  // Refuse a non-canonical encoding (leading zeros, stray signs, ...): one quote
  // must have exactly one byte-level representation, or the same amount could
  // travel as several different tokens.
  if (canonicalize(quote) !== decoded) return { ok: false, reason: "malformed" };

  const nowMs = input.nowMs ?? Date.now();

  // A quote from the future is not a quote: it means a clock or a signature we
  // should not trust. Refuse rather than extend.
  if (quote.issuedAtMs - nowMs > CLOCK_SKEW_MS) return { ok: false, reason: "malformed" };
  if (nowMs >= quote.expiresAtMs) return { ok: false, reason: "expired" };

  const expected = input.expected;
  if (
    quote.userId !== (expected.userId ?? "").trim() ||
    quote.subscriptionId !== (expected.subscriptionId ?? "").trim() ||
    quote.targetPlan !== expected.targetPlan ||
    quote.interval !== expected.interval ||
    quote.priceId !== (expected.priceId ?? "").trim()
  ) {
    // Another account, another subscription, another plan, another period or
    // another price: the shown amount described something else entirely.
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true, quote };
}

/** Human-held shape of a quote, safe to return to the browser. */
export type PlanChangeQuoteWire = {
  token: string;
  expiresAt: string;
  targetPlan: PaidPlanId;
  interval: BillingInterval;
};

export function toWireQuote(created: CreatedQuote): PlanChangeQuoteWire {
  return {
    token: created.token,
    expiresAt: new Date(created.quote.expiresAtMs).toISOString(),
    targetPlan: created.quote.targetPlan,
    interval: created.quote.interval,
  };
}
