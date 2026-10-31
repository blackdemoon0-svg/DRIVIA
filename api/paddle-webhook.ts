import crypto from "node:crypto";
// `.js` extensions are mandatory here: `package.json` declares
// `"type": "module"` and Node rejects extensionless relative specifiers in ESM.
// Omitting them makes the function fail to load, and Vercel answers
// 500 FUNCTION_INVOCATION_FAILED without ever entering the handler.
import { verifyAttributionProof } from "../server/attribution.js";
import {
  BILLING_INTERVALS,
  PAID_PLAN_IDS,
  SANDBOX_PRICE_IDS,
  type BillingInterval,
  type PaidPlanId,
} from "../src/lib/paddleCore.js";

/**
 * Paddle webhook: signature verification, idempotency, subscription persistence.
 *
 * Verified against the official Paddle documentation:
 * - signature: `developer.paddle.com/webhooks/about/signature-verification` —
 *   header `Paddle-Signature: ts=<unix>;h1=<hex>`, signed payload is
 *   `ts + ":" + rawBody`, HMAC-SHA256 with the notification destination secret,
 *   compared with a timing-safe equality. The raw body must not be parsed,
 *   re-serialized or re-formatted before hashing.
 * - `custom_data` on the subscription: `build/transactions/custom-data` — custom
 *   data set at checkout is copied to the subscription created for recurring
 *   items, and `subscription.created` delivers the complete subscription entity.
 * - provisioning guidance: `build/subscriptions/provision-access-webhooks` —
 *   dedupe on `event_id`, and compare `source_updated_at` before applying an update
 *   because events can arrive out of order.
 *
 * This handler NEVER logs or returns a secret, and never echoes the request
 * body. Only opaque identifiers (`event_id`, `event_type`) appear in responses.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Raw body, when the platform hands it over already buffered. */
  rawBody?: unknown;
  /** Parsed body. Re-serializing it would break the signature: never used. */
  body?: unknown;
  [Symbol.asyncIterator]?: unknown;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type Env = Record<string, string | undefined>;

/** A subscription status Paddle can report. */
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "canceled";

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
];

/** Events this endpoint acts on. Everything else is acknowledged and ignored. */
export const HANDLED_EVENT_TYPES = [
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/** Variable names exactly as configured in Vercel. Never renamed, never VITE_. */
export const WEBHOOK_ENV_KEYS = {
  signatureSecret: "PADDLE_WEBHOOK_SECRET",
  supabaseUrl: "SUPABASE_URL",
  serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
} as const;

/**
 * Maximum age of a signature timestamp, in seconds.
 *
 * Paddle's own SDKs default to five seconds; the documentation recommends
 * applying the same tolerance for replay protection. Kept as a named constant
 * so it can be widened in one place if a deployment ever shows clock drift.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 5;

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export type ParsedSignature = { ts: string; h1: string[] };

/**
 * Parse `ts=1671552777;h1=…` into its timestamp and signature list.
 * Returns null when the header is not shaped like a Paddle signature.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (!header || typeof header !== "string") return null;

  let ts: string | null = null;
  const h1: string[] = [];

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!value) continue;
    if (key === "ts") ts = value;
    else if (key === "h1") h1.push(value);
  }

  if (!ts || h1.length === 0) return null;
  return { ts, h1 };
}

/** HMAC-SHA256 of `ts:rawBody`, hex encoded. */
export function computeSignature(rawBody: Buffer, ts: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${ts}:`, "utf8"), rawBody]))
    .digest("hex");
}

/** Constant-time comparison; length differences never short-circuit usefully. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export type SignatureVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_header" | "malformed_header" | "missing_secret" | "mismatch" | "stale";
    };

/**
 * Verify a `Paddle-Signature` header against the raw request body.
 *
 * `nowSeconds` is injectable so the freshness check is testable without
 * freezing the clock.
 */
export function verifySignature(options: {
  rawBody: Buffer;
  header: string | null | undefined;
  secret: string | null | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): SignatureVerdict {
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!options.secret) return { ok: false, reason: "missing_secret" };

  const parsed = parseSignatureHeader(options.header);
  if (!parsed) {
    return {
      ok: false,
      reason: options.header ? "malformed_header" : "missing_header",
    };
  }

  const timestamp = Number(parsed.ts);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "malformed_header" };

  // Replay protection: an old (or wildly future) timestamp is refused before
  // any hashing work, mirroring the Paddle SDK behaviour.
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "stale" };

  const expected = computeSignature(options.rawBody, parsed.ts, options.secret);
  // Paddle may send several `h1` values while a secret is being rotated.
  const matched = parsed.h1.some((candidate) => safeEqual(candidate, expected));
  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}

// ---------------------------------------------------------------------------
// Plan resolution
// ---------------------------------------------------------------------------

/**
 * Map a Paddle price ID to our plan.
 *
 * Environment names mirror the client (`VITE_PADDLE_PRICE_PLUS_MONTH`, …): they
 * are ordinary server-side variables too, so production IDs need no new
 * configuration. The built-in Sandbox IDs are the final fallback.
 */
export function resolvePlanFromPriceId(
  priceId: string | null | undefined,
  env: Env = process.env,
): { plan: PaidPlanId; interval: BillingInterval } | null {
  if (!priceId) return null;

  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      const suffix = `${plan.toUpperCase()}_${interval.toUpperCase()}`;
      for (const name of [`VITE_PADDLE_PRICE_${suffix}`, `PADDLE_PRICE_${suffix}`]) {
        if (env[name]?.trim() === priceId) return { plan, interval };
      }
      if (SANDBOX_PRICE_IDS[plan][interval] === priceId) return { plan, interval };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/** Shape check only: the authoritative check is the Supabase lookup. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUserIdShaped(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function readCustomDataUserId(data: Record<string, unknown>): string | null {
  const customData = data.custom_data;
  if (!customData || typeof customData !== "object") return null;
  const value = (customData as Record<string, unknown>)[PADDLE_CUSTOM_DATA_USER_ID];
  return isUserIdShaped(value) ? value.trim() : null;
}

/** Server-signed proof written at checkout, read back from `customData`. */
function readCustomDataProof(data: Record<string, unknown>): string | null {
  const customData = data.custom_data;
  if (!customData || typeof customData !== "object") return null;
  const value = (customData as Record<string, unknown>)[PADDLE_CUSTOM_DATA_PROOF_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Key written into `customData` at checkout. Duplicated here on purpose: the
 * server must not import the client checkout module, and a typo would silently
 * break every attribution.
 */
export const PADDLE_CUSTOM_DATA_USER_ID = "user_id";

/**
 * Key holding the server-signed attribution proof.
 *
 * A bare `user_id` is a browser claim: it can be rewritten in the console before
 * paying. The proof is an HMAC over the id, produced by `api/paddle-attribution`
 * only after Supabase confirmed the caller's token, so a rewritten id no longer
 * matches and the event is refused.
 */
export const PADDLE_CUSTOM_DATA_PROOF_KEY = "attribution_proof";

// ---------------------------------------------------------------------------
// Supabase REST (service role, server only)
// ---------------------------------------------------------------------------

type SupabaseEnv = { url: string; serviceRoleKey: string };

export function readSupabaseEnv(env: Env = process.env): SupabaseEnv | null {
  const url = env[WEBHOOK_ENV_KEYS.supabaseUrl]?.trim().replace(/\/+$/, "");
  const serviceRoleKey = env[WEBHOOK_ENV_KEYS.serviceRoleKey]?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

async function supabaseRequest(
  supabase: SupabaseEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("apikey", supabase.serviceRoleKey);
  headers.set("Authorization", `Bearer ${supabase.serviceRoleKey}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${supabase.url}${path}`, { ...init, headers });
}

export type WebhookEventRecord = {
  event_id: string;
  event_type: string;
  occurred_at: string | null;
  status: "received" | "processed" | "rejected" | "ignored";
  reason: string | null;
};

/** Insert the event; returns `false` when the row already exists. */
async function recordEvent(
  supabase: SupabaseEnv,
  record: Pick<WebhookEventRecord, "event_id" | "event_type" | "occurred_at">,
): Promise<boolean> {
  const response = await supabaseRequest(supabase, "/rest/v1/webhook_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...record, status: "received" }),
  });
  // 201 created, or 409 unique violation on `event_id`.
  if (response.status === 409) return false;
  if (!response.ok) {
    throw new InfraError(`webhook_events insert failed (${response.status})`);
  }
  return true;
}

async function readEventStatus(
  supabase: SupabaseEnv,
  eventId: string,
): Promise<WebhookEventRecord["status"] | null> {
  const response = await supabaseRequest(
    supabase,
    `/rest/v1/webhook_events?event_id=eq.${encodeURIComponent(eventId)}&select=status`,
  );
  if (!response.ok) {
    throw new InfraError(`webhook_events read failed (${response.status})`);
  }
  const rows = (await response.json()) as Array<{ status?: string }>;
  const status = rows[0]?.status;
  return (status as WebhookEventRecord["status"]) ?? null;
}

async function finalizeEvent(
  supabase: SupabaseEnv,
  eventId: string,
  status: "processed" | "rejected" | "ignored",
  reason: string | null,
): Promise<void> {
  const response = await supabaseRequest(
    supabase,
    `/rest/v1/webhook_events?event_id=eq.${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status, reason }),
    },
  );
  if (!response.ok) {
    throw new InfraError(`webhook_events update failed (${response.status})`);
  }
}

export type SupabaseUser = {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
};

async function fetchUser(supabase: SupabaseEnv, userId: string): Promise<SupabaseUser | null> {
  const response = await supabaseRequest(
    supabase,
    `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new InfraError(`auth admin lookup failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    id?: unknown;
    email?: unknown;
    email_confirmed_at?: unknown;
  };
  if (typeof payload.id !== "string") return null;
  return {
    id: payload.id,
    email: typeof payload.email === "string" ? payload.email : null,
    email_confirmed_at:
      typeof payload.email_confirmed_at === "string" ? payload.email_confirmed_at : null,
  };
}

export type StoredSubscription = {
  user_id: string;
  paddle_customer_id: string | null;
  source_updated_at: string | null;
};

async function findSubscriptionByPaddleId(
  supabase: SupabaseEnv,
  paddleSubscriptionId: string,
): Promise<StoredSubscription | null> {
  const response = await supabaseRequest(
    supabase,
    `/rest/v1/subscriptions?paddle_subscription_id=eq.${encodeURIComponent(
      paddleSubscriptionId,
    )}&select=user_id,paddle_customer_id,source_updated_at`,
  );
  if (!response.ok) {
    throw new InfraError(`subscriptions read failed (${response.status})`);
  }
  const rows = (await response.json()) as StoredSubscription[];
  return rows[0] ?? null;
}

/**
 * Row written to `public.subscriptions`.
 *
 * Column names are the ones that **already exist** in the `veyvro-preview`
 * project. They are not the names this integration first assumed: adapting the
 * code avoids duplicating data in parallel columns.
 *
 * `id` is deliberately absent: it is the table's uuid primary key with its own
 * default. Conflicts are resolved on `paddle_subscription_id` (see
 * `upsertSubscription`), never on `id`.
 */
export type SubscriptionRow = {
  paddle_subscription_id: string;
  user_id: string;
  plan: PaidPlanId;
  status: SubscriptionStatus;
  paddle_price_id: string;
  paddle_product_id: string | null;
  paddle_customer_id: string | null;
  billing_interval: BillingInterval | null;
  currency_code: string | null;
  current_period_started_at: string | null;
  current_period_ends_at: string | null;
  scheduled_change_action: string | null;
  scheduled_change_effective_at: string | null;
  canceled_at: string | null;
  source_updated_at: string;
};

async function upsertSubscription(
  supabase: SupabaseEnv,
  row: SubscriptionRow,
): Promise<void> {
  // `on_conflict` is mandatory here: the table's primary key is `id`, not
  // `paddle_subscription_id`. Without the parameter PostgREST resolves
  // duplicates on the primary key, which the webhook never sends, so a retried
  // event would INSERT a second row instead of updating the first.
  // Migration 0002 creates the matching unique index on `paddle_subscription_id`.
  const response = await supabaseRequest(
    supabase,
    "/rest/v1/subscriptions?on_conflict=paddle_subscription_id",
    {
      method: "POST",
      headers: {
        // One row per Paddle subscription; a retried event overwrites, never doubles.
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    },
  );
  if (!response.ok) {
    throw new InfraError(`subscriptions upsert failed (${response.status})`);
  }
}

/** Infrastructure failure: answer 5xx so Paddle retries. */
class InfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

type SubscriptionEvent = {
  event_id: string;
  event_type: string;
  occurred_at?: string;
  data: Record<string, unknown>;
};

export type HandleOutcome =
  | { kind: "processed"; status: SubscriptionStatus }
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFirstPriceId(data: Record<string, unknown>): string | null {
  const items = data.items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const record = asRecord(item);
    const price = asRecord(record?.price);
    const id = price?.id ?? record?.price_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

function readProductId(data: Record<string, unknown>): string | null {
  const items = data.items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const record = asRecord(item);
    const price = asRecord(record?.price);
    const id = price?.product_id ?? record?.product_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

/** ISO 4217, upper case. Anything else is dropped rather than stored as-is. */
function readCurrencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** Paddle only ever schedules `cancel`, `pause` or `resume`. */
const SCHEDULED_CHANGE_ACTIONS = ["cancel", "pause", "resume"] as const;

function readScheduledAction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const action = value.trim().toLowerCase();
  return (SCHEDULED_CHANGE_ACTIONS as readonly string[]).includes(action) ? action : null;
}

/**
 * Decide whether this event may write an entitlement.
 *
 * "Strict" here means: an unknown account, a malformed `custom_data.user_id`,
 * an unconfirmed address, an email that contradicts the account, or a Paddle
 * customer already bound to another account all lead to a refusal. A refusal is
 * recorded for audit and acknowledged, so Paddle stops retrying, but it never
 * grants access.
 */
async function verifyAttribution(
  supabase: SupabaseEnv,
  data: Record<string, unknown>,
  existing: StoredSubscription | null,
  secret: string | null,
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const userId = readCustomDataUserId(data);
  if (!userId) return { ok: false, reason: "missing_custom_data_user_id" };

  // A user id alone is never trusted: the proof must match this exact id.
  // Swapping in another account's id makes the HMAC mismatch, so the event is
  // refused before any database write.
  const proof = readCustomDataProof(data);
  if (!proof) return { ok: false, reason: "missing_attribution_proof" };
  if (!verifyAttributionProof(secret, userId, proof)) {
    return { ok: false, reason: "invalid_attribution_proof" };
  }
  if (!secret) return { ok: false, reason: "missing_attribution_secret" };

  const user = await fetchUser(supabase, userId);
  if (!user) return { ok: false, reason: "unknown_user" };
  if (!user.email_confirmed_at) return { ok: false, reason: "unconfirmed_email" };

  // When the payload carries a billing email, it must match the account.
  const customer = asRecord(data.customer);
  const billingEmail = typeof customer?.email === "string" ? customer.email : null;
  if (billingEmail && user.email) {
    if (billingEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      return { ok: false, reason: "email_mismatch" };
    }
  }

  const customerId = typeof data.customer_id === "string" ? data.customer_id : null;
  if (existing && customerId && existing.paddle_customer_id && existing.user_id !== userId) {
    // A Paddle customer cannot be re-bound to another account by replaying or
    // forging `customData`.
    return { ok: false, reason: "customer_bound_to_other_user" };
  }

  return { ok: true, userId };
}

export async function handleSubscriptionEvent(
  event: SubscriptionEvent,
  options: { supabase: SupabaseEnv; now?: () => string; attributionSecret?: string | null },
): Promise<HandleOutcome> {
  const { supabase } = options;
  const attributionSecret =
    options.attributionSecret ??
    process.env[WEBHOOK_ENV_KEYS.signatureSecret]?.trim() ??
    null;
  const nowIso = options.now?.() ?? new Date().toISOString();

  if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
    return { kind: "ignored", reason: "unhandled_event_type" };
  }

  const data = asRecord(event.data);
  if (!data) return { kind: "rejected", reason: "invalid_data" };

  const paddleSubscriptionId =
    typeof data.id === "string" ? data.id.trim() : "";
  if (!paddleSubscriptionId) return { kind: "rejected", reason: "missing_subscription_id" };

  const existing = await findSubscriptionByPaddleId(supabase, paddleSubscriptionId);

  // Out-of-order delivery: never let an older event overwrite a newer state.
  // Paddle guarantees at-least-once delivery, not ordered delivery.
  const incomingAt = readTimestamp(event.occurred_at ?? data.updated_at);
  if (existing?.source_updated_at && incomingAt) {
    if (Date.parse(existing.source_updated_at) > Date.parse(incomingAt)) {
      return { kind: "ignored", reason: "stale_event" };
    }
  }

  const attribution = await verifyAttribution(supabase, data, existing, attributionSecret);
  if (!attribution.ok) return { kind: "rejected", reason: attribution.reason };

  const priceId = readFirstPriceId(data);
  const mapping = resolvePlanFromPriceId(priceId);
  if (!mapping) return { kind: "rejected", reason: "unknown_price_id" };

  const rawStatus = typeof data.status === "string" ? data.status : "";
  const status = (SUBSCRIPTION_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as SubscriptionStatus)
    : event.event_type === "subscription.canceled"
      ? "canceled"
      : event.event_type === "subscription.past_due"
        ? "past_due"
        : null;
  if (!status) return { kind: "rejected", reason: "unknown_status" };

  const period = asRecord(data.current_billing_period);
  const scheduledChange = asRecord(data.scheduled_change);

  await upsertSubscription(supabase, {
    paddle_subscription_id: paddleSubscriptionId,
    user_id: attribution.userId,
    plan: mapping.plan,
    status,
    paddle_price_id: priceId as string,
    paddle_product_id: readProductId(data),
    paddle_customer_id: typeof data.customer_id === "string" ? data.customer_id : null,
    billing_interval: mapping.interval,
    currency_code: readCurrencyCode(data.currency_code),
    current_period_started_at: readTimestamp(period?.starts_at),
    current_period_ends_at: readTimestamp(period?.ends_at),
    scheduled_change_action: readScheduledAction(scheduledChange?.action),
    scheduled_change_effective_at: readTimestamp(scheduledChange?.effective_at),
    canceled_at: readTimestamp(data.canceled_at),
    source_updated_at: incomingAt ?? nowIso,
  });

  return { kind: "processed", status };
}

// ---------------------------------------------------------------------------
// Raw body access
// ---------------------------------------------------------------------------

/**
 * Read the exact bytes Paddle signed.
 *
 * A parsed body is deliberately refused: re-serializing it changes whitespace
 * and key ordering, which invalidates the signature. Refusing loudly is safer
 * than accepting an unverifiable event.
 */
export async function readRawBody(request: ApiRequest): Promise<Buffer | null> {
  const candidate = request as { rawBody?: unknown; body?: unknown };

  if (Buffer.isBuffer(candidate.rawBody)) return candidate.rawBody;
  if (typeof candidate.rawBody === "string") return Buffer.from(candidate.rawBody, "utf8");
  if (Buffer.isBuffer(candidate.body)) return candidate.body;
  if (typeof candidate.body === "string") return Buffer.from(candidate.body, "utf8");

  const iterable = request[Symbol.asyncIterator];
  if (typeof iterable === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    }
    return Buffer.concat(chunks);
  }

  // Body already parsed into an object, or absent: no verifiable bytes.
  return null;
}

function readHeader(request: ApiRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value ? value : null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Vercel must skip body parsing so the raw bytes are available for the HMAC.
 * Without this, `request.body` is an object and the signature cannot be checked.
 */
export const config = { api: { bodyParser: false } };

export default async function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST requests are supported." });
  }

  const rawBody = await readRawBody(request);
  if (!rawBody) {
    // Never fall back to an unverified body.
    return response
      .status(500)
      .json({ error: "Raw request body unavailable; the signature cannot be verified." });
  }

  const secret = process.env[WEBHOOK_ENV_KEYS.signatureSecret]?.trim();
  const verdict = verifySignature({
    rawBody,
    header: readHeader(request, "paddle-signature"),
    secret,
  });

  if (!verdict.ok) {
    // 401 lets Paddle retry, and tells an attacker nothing beyond "rejected".
    return response.status(401).json({ error: "Invalid signature.", reason: verdict.reason });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return response.status(400).json({ error: "Request body must be valid JSON." });
  }

  const event = asRecord(payload);
  const eventId = typeof event?.event_id === "string" ? event.event_id : "";
  const eventType = typeof event?.event_type === "string" ? event.event_type : "";
  if (!event || !eventId || !eventType) {
    return response.status(400).json({ error: "Malformed Paddle event." });
  }

  const supabase = readSupabaseEnv();
  if (!supabase) {
    return response
      .status(503)
      .json({ error: "Server is not configured to store subscriptions." });
  }

  try {
    const created = await recordEvent(supabase, {
      event_id: eventId,
      event_type: eventType,
      occurred_at: readTimestamp(event.occurred_at),
    });

    if (!created) {
      // Already seen: do not touch `subscriptions` again.
      const status = await readEventStatus(supabase, eventId);
      if (status && status !== "received") {
        return response.status(200).json({ received: true, duplicate: true, event_id: eventId });
      }
      // A previous attempt crashed mid-flight: fall through and finish it.
    }

    const outcome = await handleSubscriptionEvent(
      { event_id: eventId, event_type: eventType, occurred_at: readTimestamp(event.occurred_at) ?? undefined, data: asRecord(event.data) ?? {} },
      { supabase },
    );

    if (outcome.kind === "rejected" || outcome.kind === "ignored") {
      await finalizeEvent(supabase, eventId, outcome.kind, outcome.reason);
      // Acknowledged on purpose: a refusal is final, retrying cannot fix it.
      return response
        .status(200)
        .json({ received: true, outcome: outcome.kind, reason: outcome.reason, event_id: eventId });
    }

    await finalizeEvent(supabase, eventId, "processed", null);
    return response.status(200).json({ received: true, event_id: eventId });
  } catch (error) {
    const reason = error instanceof InfraError ? error.message : "unexpected_error";
    // 5xx so Paddle retries; no internal detail is echoed to the caller.
    return response.status(503).json({ error: "Temporary failure, retry later.", reason });
  }
}
