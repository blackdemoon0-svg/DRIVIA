import crypto from "node:crypto";
// `.js` extensions are mandatory here: `package.json` declares
// `"type": "module"` and Node rejects extensionless relative specifiers in ESM.
// Omitting them makes the function fail to load, and Vercel answers
// 500 FUNCTION_INVOCATION_FAILED without ever entering the handler.
import { verifyAttributionProofWithRing } from "../server/attribution.js";
// The secret ring: the current signing secret, plus the one it replaces while an
// explicit, bounded rotation window is open. See `server/webhookSecret.ts`.
import { readSecretRing, ringSecrets, secretKeyId } from "../server/webhookSecret.js";
import type { BillingInterval, PaidPlanId } from "../src/lib/paddleCore.js";
// The price catalogue lives in one module shared with the plan-change route, so
// an incoming price ID and the price ID sent to Paddle can never disagree.
import { resolvePlanFromPriceId } from "../src/lib/paddlePrices.js";

export { resolvePlanFromPriceId };

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

/**
 * Verify a `Paddle-Signature` against several secrets, current first.
 *
 * The freshness window is checked once, before any hashing: a stale delivery is
 * refused whatever the key. Each secret is then tried with the same
 * constant-time comparison, so the answer never reveals which key the server
 * holds, only that one of them matched.
 *
 * `keyIndex` is returned on success for one purpose: an operator must be able to
 * tell, after a rotation, whether deliveries are still arriving under the old
 * secret. It is an index, not a secret.
 */
export function verifySignatureWithRing(options: {
  rawBody: Buffer;
  header: string | null | undefined;
  secrets: readonly (string | null | undefined)[];
  toleranceSeconds?: number;
  nowSeconds?: number;
}): SignatureVerdict & { keyIndex?: number } {
  const usable = options.secrets.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (usable.length === 0) return { ok: false, reason: "missing_secret" };

  let last: SignatureVerdict = { ok: false, reason: "mismatch" };
  for (let index = 0; index < usable.length; index += 1) {
    const verdict = verifySignature({
      rawBody: options.rawBody,
      header: options.header,
      secret: usable[index],
      toleranceSeconds: options.toleranceSeconds,
      nowSeconds: options.nowSeconds,
    });
    if (verdict.ok) return { ok: true, keyIndex: index };
    // A header problem is the same for every key: stop at the first refusal
    // that is not about the key itself, rather than repeating the work.
    last = verdict;
    if (verdict.reason !== "mismatch") break;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Plan resolution
// ---------------------------------------------------------------------------

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

/** What a stored event row says, for the deduplication decision. */
export type StoredEventRecord = {
  status: WebhookEventRecord["status"];
  /** Paddle's event type, kept so a replay cannot change the subject. */
  event_type: string | null;
};

async function readEventRecord(
  supabase: SupabaseEnv,
  eventId: string,
): Promise<StoredEventRecord | null> {
  const response = await supabaseRequest(
    supabase,
    `/rest/v1/webhook_events?event_id=eq.${encodeURIComponent(
      eventId,
    )}&select=status,event_type`,
  );
  if (!response.ok) {
    throw new InfraError(`webhook_events read failed (${response.status})`);
  }
  const rows = (await response.json()) as Array<{ status?: string; event_type?: string }>;
  const row = rows[0];
  if (!row?.status) return null;
  return {
    status: row.status as WebhookEventRecord["status"],
    event_type: typeof row.event_type === "string" ? row.event_type : null,
  };
}

/**
 * Decide what a second delivery of an already stored event may do.
 *
 * `processed` and `ignored` are **final**: replaying them would either re-apply
 * a state that is already stored, or re-litigate a decision nobody asked to
 * revisit. Only `rejected` is replayable, and only because a rejection writes
 * nothing: the subscription table is untouched, so re-examining the event can
 * neither duplicate a right nor move an owner.
 *
 * The event type is compared too. A replay is supposed to be the *same* event
 * delivered again; one whose subject changed is not a replay, and treating it
 * as one would let a stale identifier carry a different decision.
 *
 * Pure and exported so every branch is testable without a network.
 */
export type ReplayDecision =
  | { kind: "continue" }
  | { kind: "replay" }
  | { kind: "duplicate"; reason: string | null };

export function decideReplay(
  stored: StoredEventRecord | null,
  incomingEventType: string,
): ReplayDecision {
  if (!stored) {
    // The insert conflicted but the row cannot be read: never guess.
    return { kind: "duplicate", reason: "event_unreadable" };
  }

  if (stored.status === "received") {
    // A previous attempt died mid-flight: finishing it is the original design.
    return { kind: "continue" };
  }

  if (stored.status === "rejected") {
    if (stored.event_type !== null && stored.event_type !== incomingEventType) {
      return { kind: "duplicate", reason: "replay_event_type_mismatch" };
    }
    return { kind: "replay" };
  }

  // `processed` and `ignored`, and any unknown stored value: nothing to do.
  return { kind: "duplicate", reason: null };
}

/**
 * Take exclusive ownership of a rejected event, for one replay only.
 *
 * The transition is a compare-and-swap performed by PostgREST itself:
 * `PATCH … ?status=eq.rejected` with `return=representation`. Postgres
 * serialises the two writers, so of two simultaneous deliveries exactly one
 * sees a row updated and the other sees an empty result — the second answers
 * "duplicate" instead of processing the event twice. An in-memory flag could not
 * do this: Vercel runs each request in its own instance.
 *
 * The event is moved to `received` first, which is the honest state while the
 * replay runs: if the function dies half-way it stays visible as unfinished
 * work, and the next delivery finishes it through the `continue` path.
 */
async function claimRejectedEvent(
  supabase: SupabaseEnv,
  eventId: string,
): Promise<boolean> {
  const response = await supabaseRequest(
    supabase,
    `/rest/v1/webhook_events?event_id=eq.${encodeURIComponent(
      eventId,
    )}&status=eq.rejected`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "received", reason: null }),
    },
  );
  if (!response.ok) {
    throw new InfraError(`webhook_events replay claim failed (${response.status})`);
  }
  const rows = (await response.json()) as unknown;
  return Array.isArray(rows) && rows.length === 1;
}

/**
 * Record why an event is stuck, without closing it.
 *
 * Used for unresolved conflicts: the status must stay `received` so the event
 * remains visible as unfinished work, while the reason explains what blocked it.
 */
async function annotateEvent(
  supabase: SupabaseEnv,
  eventId: string,
  reason: string | null,
): Promise<void> {
  const response = await supabaseRequest(
    supabase,
    `/rest/v1/webhook_events?event_id=eq.${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!response.ok) {
    throw new InfraError(`webhook_events annotate failed (${response.status})`);
  }
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
  /**
   * The paid period already stored.
   *
   * Read so an event that carries no billing period cannot erase it: the period
   * end is the only thing that grants access, so losing it would cut a paying
   * customer off over a partially-shaped payload.
   */
  current_period_started_at: string | null;
  current_period_ends_at: string | null;
};

async function findSubscriptionByPaddleId(
  supabase: SupabaseEnv,
  paddleSubscriptionId: string,
): Promise<StoredSubscription | null> {
  const response = await supabaseRequest(
    supabase,
    `/rest/v1/subscriptions?paddle_subscription_id=eq.${encodeURIComponent(
      paddleSubscriptionId,
    )}&select=user_id,paddle_customer_id,source_updated_at,current_period_started_at,current_period_ends_at`,
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

/**
 * Result of writing a subscription row.
 *
 * A `409` is never turned into a success: it is returned as `conflict` so the
 * caller can look for evidence before deciding anything.
 */
export type UpsertResult = { status: "written" } | { status: "conflict" };

async function upsertSubscription(
  supabase: SupabaseEnv,
  row: SubscriptionRow,
): Promise<UpsertResult> {
  // `on_conflict` is mandatory here: the table's primary key is `id`, not
  // `paddle_subscription_id`. Without the parameter PostgREST resolves
  // duplicates on the primary key, which the webhook never sends, so a retried
  // event would INSERT a second row instead of updating the first.
  // Migration 0002 creates the matching unique index on `paddle_subscription_id`.
  //
  // `currency_code` is dropped from the payload when unknown. The column is
  // NOT NULL in the deployed table (with a `USD` default) while the migrations
  // leave it nullable, so a literal `null` would fail the entire write and lose
  // a payment over a field this handler never reads back. Omitting the key lets
  // the default apply on insert, and keeps the stored value on update.
  const payload: Record<string, unknown> = { ...row };
  if (payload.currency_code === null) delete payload.currency_code;

  const response = await supabaseRequest(
    supabase,
    "/rest/v1/subscriptions?on_conflict=paddle_subscription_id",
    {
      method: "POST",
      headers: {
        // One row per Paddle subscription; a retried event overwrites, never doubles.
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );

  // 409 is a real answer, not an outage: PostgREST refused the write because of
  // a unique constraint. Which constraint matters, so it is investigated by the
  // caller instead of being answered with a retry loop.
  if (response.status === 409) return { status: "conflict" };
  if (!response.ok) {
    throw new InfraError(`subscriptions upsert failed (${response.status})`);
  }
  return { status: "written" };
}

/**
 * Everything needed to explain a conflict, read from the table itself.
 *
 * Only identity and state are read — never used as proof that a payment
 * happened. The only payment evidence is the signed Paddle event being handled.
 */
export type ConflictEvidence = {
  /** Row holding the same `paddle_subscription_id`, if any. */
  sameSubscriptionId: StoredConflictRow | null;
  /** In-force rows for the same Paddle customer, whatever their subscription id. */
  sameCustomerInForce: StoredConflictRow[];
};

export type StoredConflictRow = {
  paddle_subscription_id: string | null;
  user_id: string | null;
  paddle_customer_id: string | null;
  plan: string | null;
  status: string | null;
  paddle_price_id: string | null;
  current_period_ends_at: string | null;
};

const CONFLICT_COLUMNS =
  "paddle_subscription_id,user_id,paddle_customer_id,plan,status,paddle_price_id,current_period_ends_at";

/** Statuses covered by the partial unique index on `paddle_customer_id`. */
const IN_FORCE_STATUSES = ["active", "trialing", "past_due", "paused"] as const;

async function readConflictEvidence(
  supabase: SupabaseEnv,
  row: SubscriptionRow,
): Promise<ConflictEvidence> {
  const byIdResponse = await supabaseRequest(
    supabase,
    `/rest/v1/subscriptions?paddle_subscription_id=eq.${encodeURIComponent(
      row.paddle_subscription_id,
    )}&select=${CONFLICT_COLUMNS}`,
  );
  if (!byIdResponse.ok) {
    throw new InfraError(`subscriptions conflict read failed (${byIdResponse.status})`);
  }
  const byIdRows = (await byIdResponse.json()) as StoredConflictRow[];

  let sameCustomerInForce: StoredConflictRow[] = [];
  if (row.paddle_customer_id) {
    const byCustomerResponse = await supabaseRequest(
      supabase,
      `/rest/v1/subscriptions?paddle_customer_id=eq.${encodeURIComponent(
        row.paddle_customer_id,
      )}&status=in.(${IN_FORCE_STATUSES.join(",")})&select=${CONFLICT_COLUMNS}`,
    );
    if (!byCustomerResponse.ok) {
      throw new InfraError(`subscriptions conflict read failed (${byCustomerResponse.status})`);
    }
    sameCustomerInForce = (await byCustomerResponse.json()) as StoredConflictRow[];
  }

  return {
    sameSubscriptionId: byIdRows[0] ?? null,
    sameCustomerInForce: Array.isArray(sameCustomerInForce) ? sameCustomerInForce : [],
  };
}

export type ConflictVerdict =
  /** Provably the same state this event would write: nothing to reconcile. */
  | { kind: "already_applied"; reason: string }
  /** The payment is kept for a human: never discarded, never counted as done. */
  | { kind: "unresolved"; reason: string };

/**
 * Explain a `409` using the identifiers Paddle sent and what the table holds.
 *
 * The bar for "already_applied" is deliberately high: same subscription id, same
 * account, same plan, same status, same price, same period end. Anything less
 * is unresolved, because resolving it would mean guessing which of two payments
 * to keep. The reason string carries the Paddle ids so an operator can find the
 * payment in Paddle without a schema change.
 */
export function classifyConflict(
  evidence: ConflictEvidence,
  incoming: SubscriptionRow,
): ConflictVerdict {
  const evidenceTag = `${incoming.paddle_subscription_id}/${incoming.paddle_customer_id ?? "no-customer"}`;

  const sameId = evidence.sameSubscriptionId;
  if (sameId) {
    // The same Paddle subscription already exists under another account: the
    // payment must not be moved, and must not be silently dropped either.
    if (sameId.user_id && sameId.user_id !== incoming.user_id) {
      return {
        kind: "unresolved",
        reason: `conflict_other_account:${evidenceTag}`,
      };
    }

    const identical =
      sameId.user_id === incoming.user_id &&
      sameId.plan === incoming.plan &&
      sameId.status === incoming.status &&
      sameId.paddle_price_id === incoming.paddle_price_id &&
      sameId.current_period_ends_at === incoming.current_period_ends_at;

    if (identical) {
      return {
        kind: "already_applied",
        reason: `conflict_already_applied:${evidenceTag}`,
      };
    }

    // Same account, but the stored state differs from what this event carries
    // (a renewal, an upgrade, a cancellation). We could not write it, so it
    // stays for a human: assuming the older state is "fine" would lose money.
    return {
      kind: "unresolved",
      reason: `conflict_state_diverged:${evidenceTag}`,
    };
  }

  if (!incoming.paddle_customer_id) {
    return {
      kind: "unresolved",
      reason: `conflict_without_customer:${evidenceTag}`,
    };
  }

  const others = evidence.sameCustomerInForce.filter(
    (row) => row.paddle_subscription_id !== incoming.paddle_subscription_id,
  );

  if (others.length === 0) {
    // A conflict we cannot explain is not a success.
    return {
      kind: "unresolved",
      reason: `conflict_unexplained:${evidenceTag}`,
    };
  }

  // Another subscription is in force for this Paddle customer. Two live
  // subscriptions is a billing situation only a human can settle.
  const foreign = others.find((row) => row.user_id && row.user_id !== incoming.user_id);
  if (foreign) {
    return {
      kind: "unresolved",
      reason: `conflict_customer_bound_elsewhere:${evidenceTag}`,
    };
  }

  return {
    kind: "unresolved",
    reason: `conflict_second_subscription:${evidenceTag}`,
  };
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
  /** `reason` is set when the state was already applied and provably identical. */
  | { kind: "processed"; status: SubscriptionStatus; reason?: string }
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string }
  /**
   * A failure that means "our configuration does not match the payment we can
   * see" — typically a signing secret that changed under an in-flight payment.
   *
   * The event is left in `received` and Paddle is told to retry, so correcting
   * the configuration inside Paddle's retry window activates the subscription
   * with no human intervention. Nothing is granted while it fails, and if the
   * configuration is never corrected the notification ends `failed` in Paddle
   * rather than being reported as delivered.
   */
  | { kind: "retry"; reason: string }
  /**
   * A `409` that could not be resolved with certainty, or a real payment whose
   * billing email contradicts the account: plausible enough not to be thrown
   * away, unprovable enough not to be granted.
   *
   * The event is deliberately left in `received`: it is neither a success nor a
   * refusal, and it must stay visible so the payment behind it is not lost.
   */
  | { kind: "conflict"; reason: string };

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

/**
 * Paddle customer id of the subscription.
 *
 * The subscription entity carries it as `customer_id`; some payload versions
 * nest it as `customer.id`. Both are accepted because the column is NOT NULL:
 * a value must be found, or the write fails.
 */
function readPaddleCustomerId(data: Record<string, unknown>): string | null {
  const direct = data.customer_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const customer = asRecord(data.customer);
  const nested = customer?.id;
  if (typeof nested === "string" && nested.trim()) return nested.trim();

  return null;
}

/** Paddle only ever schedules `cancel`, `pause` or `resume`. */
const SCHEDULED_CHANGE_ACTIONS = ["cancel", "pause", "resume"] as const;

/**
 * Decide which paid period to store.
 *
 * The period end is the only field that grants access (`toGrant` refuses a row
 * without a future end), and the upsert replaces the whole row. Writing `null`
 * there because one event carried no `current_billing_period` would therefore
 * cut off a customer who has paid — the mirror image of the `currency_code` and
 * `paddle_customer_id` bugs fixed earlier.
 *
 * Rules, in order:
 * 1. a complete, self-consistent period from the event always wins;
 * 2. otherwise the missing side is filled from what is already stored, so an
 *    event may extend or correct a period but never erase it;
 * 3. if the merged pair would be inconsistent (`ends_at <= starts_at`, which the
 *    table's CHECK would refuse), the start is dropped and the end kept: a null
 *    start is legal and grants access, while a null end grants nothing.
 *
 * The returned `source` exists for one reason: an operator needs to know from
 * the response whether a period was taken from Paddle or inherited.
 */
export type ResolvedBillingPeriod = {
  start: string | null;
  end: string | null;
  source: "event" | "stored" | "merged" | "absent";
};

export function resolveBillingPeriod(
  period: Record<string, unknown> | null | undefined,
  existing: StoredSubscription | null | undefined,
): ResolvedBillingPeriod {
  const incomingStart = readTimestamp(period?.starts_at);
  const incomingEnd = readTimestamp(period?.ends_at);
  const storedStart = readTimestamp(existing?.current_period_started_at);
  const storedEnd = readTimestamp(existing?.current_period_ends_at);

  const ordered = (start: string | null, end: string | null): boolean =>
    start !== null && end !== null && Date.parse(end) > Date.parse(start);

  // 1. A complete, coherent period straight from the event.
  if (ordered(incomingStart, incomingEnd)) {
    return { start: incomingStart, end: incomingEnd, source: "event" };
  }

  // 2. Fill only what the event omitted.
  const start = incomingStart ?? storedStart;
  const end = incomingEnd ?? storedEnd;

  if (start === null && end === null) return { start: null, end: null, source: "absent" };
  if (start !== null && end !== null && Date.parse(end) <= Date.parse(start)) {
    // 3. Never trade a usable end for a coherent-looking pair.
    return { start: null, end, source: "merged" };
  }

  const untouched = incomingStart === null && incomingEnd === null;
  return { start, end, source: untouched ? "stored" : "merged" };
}

function readScheduledAction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const action = value.trim().toLowerCase();
  return (SCHEDULED_CHANGE_ACTIONS as readonly string[]).includes(action) ? action : null;
}

/**
 * Decide whether this event may write an entitlement.
 *
 * Two situations, deliberately handled in two separate branches.
 *
 * 1. `existing` is null — FIRST BINDING. The payment is being attached to an
 *    account right now, so the claim must be proven: `custom_data.user_id` has
 *    to be a well-formed id whose HMAC was minted by `api/paddle-attribution`
 *    for that exact id, the account must exist, its address must be confirmed,
 *    and a billing email carried by the payload must match it. Any gap refuses.
 *
 * 2. `existing` is not null — RENEWAL. The owner was fixed by the row written
 *    at binding time, and Paddle re-sends `custom_data` with every renewal.
 *    That copy is a *snapshot of the checkout*, frozen at payment time: it is
 *    not a fresh claim, and it still carries a proof signed with whatever key
 *    existed back then. The owner is therefore read from the database and never
 *    from the payload, and no proof is required — requiring one would tie every
 *    renewal to the signing secret, so a single key rotation would stop all
 *    renewals without any error surfacing. What the payload says about the
 *    owner is instead *checked against* the stored owner: naming another
 *    account is refused before any write.
 *
 * A refusal always grants nothing; how it is acknowledged (final, retryable, or
 * left open for a human) is decided by `classifyAttributionFailure`, because a
 * paid subscription must never be discarded over a configuration gap.
 */
async function verifyAttribution(
  supabase: SupabaseEnv,
  data: Record<string, unknown>,
  existing: StoredSubscription | null,
  secrets: readonly (string | null | undefined)[],
): Promise<
  | { ok: true; userId: string; binding: "first" | "renewal"; keyIndex?: number }
  | { ok: false; reason: string }
> {
  const claimedUserId = readCustomDataUserId(data);
  const customerId =
    typeof data.customer_id === "string" && data.customer_id.trim()
      ? data.customer_id.trim()
      : null;

  // --- Renewal: the owner is already established by an earlier write. ------
  if (existing) {
    const owner = existing.user_id;

    // The column is NOT NULL and references `auth.users`, so a row without an
    // owner should be impossible. Fail closed rather than invent one.
    if (!owner) return { ok: false, reason: "missing_subscription_owner" };

    if (claimedUserId && claimedUserId !== owner) {
      // A Paddle customer already bound to another account keeps the reason it
      // has always had; a claim pointing anywhere else gets its own name. Both
      // are refused, and neither can move the row.
      if (customerId && existing.paddle_customer_id) {
        return { ok: false, reason: "customer_bound_to_other_user" };
      }
      return { ok: false, reason: "subscription_owner_mismatch" };
    }

    // An event may not swap the Paddle customer under a known subscription,
    // even when it names the right owner.
    if (customerId && existing.paddle_customer_id && customerId !== existing.paddle_customer_id) {
      return { ok: false, reason: "customer_id_mismatch" };
    }

    // No proof, no account lookup, no email comparison: none of them could
    // change the owner, and each of them can break a legitimate renewal.
    return { ok: true, userId: owner, binding: "renewal" };
  }

  // --- First binding: nothing is established yet, so everything is checked. -
  if (!claimedUserId) return { ok: false, reason: "missing_custom_data_user_id" };

  // A user id alone is never trusted: the proof must match this exact id.
  // Swapping in another account's id makes the HMAC mismatch, so the event is
  // refused before any database write.
  const proof = readCustomDataProof(data);
  if (!proof) return { ok: false, reason: "missing_attribution_proof" };

  // The ring matters exactly here. A checkout opened just before a rotation
  // mints its proof with the secret in force at that moment; the delivery
  // arrives after the new secret is deployed. Trying only the current key would
  // refuse a genuine, already-paid subscription — the failure that left this
  // Preview project with `invalid_attribution_proof` and zero rows.
  //
  // The previous key is only ever tried while the documented rotation window is
  // open (`server/webhookSecret.ts`), so this is a grace period, not a
  // permanent second master key.
  const proofVerdict = verifyAttributionProofWithRing(secrets, claimedUserId, proof);
  if (!proofVerdict.ok) {
    return { ok: false, reason: "invalid_attribution_proof" };
  }
  const proofKeyIndex = proofVerdict.keyIndex ?? undefined;

  const user = await fetchUser(supabase, claimedUserId);
  if (!user) return { ok: false, reason: "unknown_user" };
  if (!user.email_confirmed_at) return { ok: false, reason: "unconfirmed_email" };

  // When the payload carries a billing email, it must match the account. This
  // only runs while binding: a customer who later edits the address in Paddle
  // must not lose access on their next renewal.
  const customer = asRecord(data.customer);
  const billingEmail = typeof customer?.email === "string" ? customer.email : null;
  if (billingEmail && user.email) {
    if (billingEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      return { ok: false, reason: "email_mismatch" };
    }
  }

  return { ok: true, userId: claimedUserId, binding: "first", keyIndex: proofKeyIndex };
}

/**
 * Turn an attribution failure into the right kind of outcome.
 *
 * The distinction is what decides whether a paid subscription can still be
 * activated automatically, so it is made once, here:
 *
 * - `invalid_attribution_proof` — the proof is well formed but does not verify.
 *   Either the signing secret changed after the checkout minted it, or the
 *   value is forged; the two are indistinguishable from the event alone. It is
 *   therefore treated as retryable: a corrected secret heals it on Paddle's
 *   next attempt, a forged value simply keeps failing until Paddle gives up.
 *   Nothing is ever granted while it fails.
 * - `email_mismatch` — a real payment whose billing email differs from the
 *   account's. A customer who typed another address at checkout is a plausible
 *   and legitimate case; discarding their payment would be a bug. Retrying
 *   cannot fix it, so it is kept open for a human.
 * - `customer_bound_to_other_user`, `subscription_owner_mismatch`,
 *   `customer_id_mismatch`, `missing_subscription_owner` — deliberate ownership
 *   refusals. A subscription never changes owner because an event says so, and
 *   no retry can turn another account's id into this subscription's owner.
 *   Final, acknowledged and recorded.
 * - everything else (`missing_custom_data_user_id`, `missing_attribution_proof`,
 *   `unknown_user`, `unconfirmed_email`, `unknown_status`) — a fact about this
 *   event that no amount of retrying changes. Acknowledged and recorded.
 */
function classifyAttributionFailure(reason: string): HandleOutcome {
  if (reason === "invalid_attribution_proof") return { kind: "retry", reason };
  if (reason === "email_mismatch") return { kind: "conflict", reason };
  return { kind: "rejected", reason };
}

export async function handleSubscriptionEvent(
  event: SubscriptionEvent,
  options: {
    supabase: SupabaseEnv;
    now?: () => string;
    attributionSecret?: string | null;
    /**
     * Extra keys to try when checking the attribution proof, in order.
     *
     * The caller passes the previous secret of an open rotation window; the
     * current secret always comes first. Used only while *binding* — a renewal
     * never needs a proof at all.
     */
    attributionSecrets?: readonly (string | null | undefined)[];
  },
): Promise<HandleOutcome> {
  const { supabase } = options;
  const attributionSecret =
    options.attributionSecret ??
    process.env[WEBHOOK_ENV_KEYS.signatureSecret]?.trim() ??
    null;
  const attributionSecrets = [attributionSecret, ...(options.attributionSecrets ?? [])];
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

  const attribution = await verifyAttribution(supabase, data, existing, attributionSecrets);
  if (!attribution.ok) {
    if (attribution.reason === "invalid_attribution_proof") {
      // The exact failure this integration suffered in silence: a real payment,
      // a proof that does not verify, and no way to tell why. One structured
      // line, fingerprints only — never the secret, never the proof, never the
      // user id. Comparing it with the secret actually used at checkout (a
      // rotation, or two deployments) answers the question in one step.
      console.warn(
        JSON.stringify({
          event: "paddle_attribution_rejected",
          reason: attribution.reason,
          acceptedKeyIds: attributionSecrets
            .map((value) => secretKeyId(value))
            .filter((value): value is string => value !== null),
        }),
      );
    }
    return classifyAttributionFailure(attribution.reason);
  }

  const priceId = readFirstPriceId(data);
  const mapping = resolvePlanFromPriceId(priceId);
  // A price the catalogue cannot name is a configuration gap, not a fact about
  // this customer: if the price variable is corrected inside Paddle's retry
  // window, the redelivery resolves it. Never a guessed plan.
  if (!mapping) return { kind: "retry", reason: "unknown_price_id" };

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

  // `paddle_customer_id` is NOT NULL in the deployed database, and a
  // subscription with no customer id could not be kept from being re-bound to
  // another account. A renewal keeps the customer already stored — an event may
  // not erase the payership — and a first binding must carry one.
  //
  // Refusing here would discard a real payment, so the outcome is a *retry*: the
  // event stays open, Paddle redelivers, and nothing is written half-way. The
  // reason is explicit, unlike the opaque write failure this used to produce.
  const paddleCustomerId = readPaddleCustomerId(data) ?? existing?.paddle_customer_id ?? null;
  if (!paddleCustomerId) return { kind: "retry", reason: "missing_customer_id" };

  const billingPeriod = resolveBillingPeriod(period, existing);

  const currencyCode = readCurrencyCode(data.currency_code);

  const row: SubscriptionRow = {
    paddle_subscription_id: paddleSubscriptionId,
    user_id: attribution.userId,
    plan: mapping.plan,
    status,
    paddle_price_id: priceId as string,
    paddle_product_id: readProductId(data),
    paddle_customer_id: paddleCustomerId,
    billing_interval: mapping.interval,
    currency_code: currencyCode,
    // Never `readTimestamp(period?.ends_at)` alone: an event without a period
    // would null the end date and silently revoke a paid customer's access.
    current_period_started_at: billingPeriod.start,
    current_period_ends_at: billingPeriod.end,
    scheduled_change_action: readScheduledAction(scheduledChange?.action),
    scheduled_change_effective_at: readTimestamp(scheduledChange?.effective_at),
    canceled_at: readTimestamp(data.canceled_at),
    source_updated_at: incomingAt ?? nowIso,
  };

  const written = await upsertSubscription(supabase, row);
  if (written.status === "written") return { kind: "processed", status };

  // 409: a unique constraint refused the write. Identify which one, with the
  // identifiers Paddle actually sent, before deciding anything.
  const evidence = await readConflictEvidence(supabase, row);
  const verdict = classifyConflict(evidence, row);

  if (verdict.kind === "already_applied") {
    // Provably the exact state this event carries — checked field by field, not
    // assumed. Reported as processed with its own reason so it stays auditable.
    return { kind: "processed", reason: verdict.reason, status };
  }

  // Unresolved: the payment is preserved, never discarded and never counted as
  // processed. The caller leaves the event for a human.
  return { kind: "conflict", reason: verdict.reason };
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
export type RawBodyRead =
  | {
      ok: true;
      buffer: Buffer;
      /** How the bytes were obtained — surfaced in rejection bodies. */
      source: "rawBody" | "stream" | "buffered" | "body-bytes" | "reserialized";
    }
  | { ok: false; reason: "body_empty" | "body_unreadable" };

/** How long to wait for a stream that may never emit again. */
const BODY_STREAM_TIMEOUT_MS = 1500;

type StreamLike = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  read?: () => unknown;
};

/**
 * Collect the body from the request stream.
 *
 * Waits for `end` rather than resolving on the first chunk: a fragmented
 * delivery would otherwise be hashed from its first chunk only. The timeout
 * exists so a stream that will never emit again cannot hang the function until
 * the platform kills it.
 */
function readBodyStream(request: unknown, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const stream = request as StreamLike;
    if (!stream || typeof stream.on !== "function") {
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    };

    try {
      stream.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
      });
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", finish);
    } catch {
      resolve(null);
      return;
    }

    timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Obtain the bytes Paddle signed.
 *
 * Ordering is the whole point. On Vercel's Node runtime `request.body` is a
 * LAZY GETTER: merely reading it parses the JSON and drains the stream, so the
 * bytes that were signed are gone. Reading `.body` first is what made every
 * delivery fail — as a 500 while the drained stream was iterated, then as a 401
 * once that had been guarded. The stream is therefore read BEFORE `.body` is
 * ever touched, and `.body` is only consulted when no bytes are left to read.
 *
 * Nothing here throws: an escaping exception is what turned a delivery into an
 * opaque `500 FUNCTION_INVOCATION_FAILED`.
 */
export async function readRawBody(
  request: ApiRequest,
  options: { timeoutMs?: number } = {},
): Promise<RawBodyRead> {
  const candidate = request as {
    rawBody?: unknown;
    body?: unknown;
  };

  // `rawBody` is a plain property, never a lazy getter: safe to consult first.
  if (Buffer.isBuffer(candidate.rawBody)) {
    return { ok: true, buffer: candidate.rawBody, source: "rawBody" };
  }
  if (typeof candidate.rawBody === "string" && candidate.rawBody.length > 0) {
    return { ok: true, buffer: Buffer.from(candidate.rawBody, "utf8"), source: "rawBody" };
  }

  // Stream first: this is the only path that yields the exact signed bytes.
  const streamed = await readBodyStream(request, options.timeoutMs ?? BODY_STREAM_TIMEOUT_MS);
  if (streamed && streamed.length > 0) {
    return { ok: true, buffer: streamed, source: "stream" };
  }

  // Whatever the stream buffered but never emitted.
  try {
    const stream = request as unknown as StreamLike;
    if (typeof stream.read === "function") {
      const remainder = stream.read();
      if (Buffer.isBuffer(remainder) && remainder.length > 0) {
        return { ok: true, buffer: remainder, source: "buffered" };
      }
    }
  } catch {
    // Fall through: no readable bytes remain.
  }

  // Last resort: the platform already parsed the body. Reading `.body` here is
  // deliberate — the stream is gone, so the getter is the only way in.
  const body = candidate.body;
  if (Buffer.isBuffer(body)) return { ok: true, buffer: body, source: "body-bytes" };
  if (typeof body === "string" && body.length > 0) {
    return { ok: true, buffer: Buffer.from(body, "utf8"), source: "body-bytes" };
  }
  if (body !== null && typeof body === "object") {
    try {
      const buffer = Buffer.from(JSON.stringify(body), "utf8");
      if (buffer.length > 0) return { ok: true, buffer, source: "reserialized" };
    } catch {
      // Unserialisable: report the failure explicitly.
    }
  }

  return {
    ok: false,
    reason: body === undefined || body === null ? "body_empty" : "body_unreadable",
  };
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

async function handleWebhook(request: ApiRequest, response: ApiResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST requests are supported." });
  }

  const raw = await readRawBody(request);
  if (!raw.ok) {
    // Never fall back to an unverified body. The reason is returned so a
    // delivery log answers "why" without needing server logs.
    return response.status(500).json({
      error: "Raw request body unavailable; the signature cannot be verified.",
      reason: raw.reason,
    });
  }
  const rawBody = raw.buffer;

  // The ring: the current secret, then the one it replaces while an explicit,
  // bounded rotation window is open (`server/webhookSecret.ts`).
  const ring = readSecretRing(process.env);
  const verdict = verifySignatureWithRing({
    rawBody,
    header: readHeader(request, "paddle-signature"),
    secrets: ringSecrets(ring),
  });

  if (!verdict.ok) {
    // One structured line, no secret: only a one-way fingerprint, so an operator
    // can compare two deployments after a rotation without either value ever
    // leaving its environment. This is the diagnosis the silent
    // `invalid_attribution_proof` failure was missing.
    //
    // Only the two reasons that mean "this deployment's configuration is wrong"
    // are logged. A malformed or missing header is what random traffic looks
    // like, and logging it would let anyone fill the function log.
    if (verdict.reason === "mismatch" || verdict.reason === "missing_secret") {
      console.warn(
        JSON.stringify({
          event: "paddle_webhook_rejected",
          reason: verdict.reason,
          expectedKeyId: secretKeyId(ring.current),
          previousKeyId: secretKeyId(ring.previous),
          previousRejection: ring.previousRejection,
        }),
      );
    }
    // 401 lets Paddle retry, and tells an attacker nothing beyond "rejected".
    // `bodySource` says how the bytes were obtained, which is the one thing the
    // notification log cannot otherwise reveal: "stream" means the signed bytes
    // were available, "reserialized" means the platform had already parsed them.
    return response
      .status(401)
      .json({ error: "Invalid signature.", reason: verdict.reason, bodySource: raw.source });
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

    let replayed = false;
    if (!created) {
      const stored = await readEventRecord(supabase, eventId);
      const decision = decideReplay(stored, eventType);

      if (decision.kind === "duplicate") {
        // Nothing is touched. The reason is returned only when it names a real
        // anomaly (a changed event type), never for the ordinary duplicate.
        if (decision.reason) {
          console.warn(
            JSON.stringify({
              event: "paddle_webhook_replay_refused",
              reason: decision.reason,
              event_id: eventId,
              event_type: eventType,
              stored_event_type: stored?.event_type ?? null,
              stored_status: stored?.status ?? null,
            }),
          );
        }
        return response.status(200).json({
          received: true,
          duplicate: true,
          event_id: eventId,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
      }

      if (decision.kind === "replay") {
        // A rejection left no right behind; the delivery is genuine (the
        // signature was verified above), so the event may be examined again.
        // Everything is re-checked from scratch: no verdict is reused.
        if (!(await claimRejectedEvent(supabase, eventId))) {
          return response.status(200).json({
            received: true,
            duplicate: true,
            event_id: eventId,
            reason: "replay_in_progress",
          });
        }
        replayed = true;
        console.info(
          JSON.stringify({
            event: "paddle_webhook_replay",
            event_id: eventId,
            event_type: eventType,
          }),
        );
      }
      // `continue`: a previous attempt crashed mid-flight — finish it.
    }

    const outcome = await handleSubscriptionEvent(
      { event_id: eventId, event_type: eventType, occurred_at: readTimestamp(event.occurred_at) ?? undefined, data: asRecord(event.data) ?? {} },
      {
        supabase,
        // The previous key is offered to the attribution check too: a checkout
        // opened before the rotation signed its proof with it, and refusing
        // that proof would discard a payment that has already been taken.
        attributionSecrets: ring.previous ? [ring.previous] : [],
      },
    );

    if (outcome.kind === "retry") {
      // Left open on purpose: `received`, never `processed` and never
      // `rejected`. 503 is what makes Paddle deliver it again, which is the
      // only way a configuration corrected after the payment can still
      // activate the subscription without a human.
      await annotateEvent(supabase, eventId, outcome.reason);
      return response.status(503).json({
        received: false,
        outcome: "retry",
        reason: outcome.reason,
        event_id: eventId,
      });
    }

    if (outcome.kind === "rejected" || outcome.kind === "ignored") {
      await finalizeEvent(supabase, eventId, outcome.kind, outcome.reason);
      // Acknowledged on purpose: a refusal is final, retrying cannot fix it.
      return response
        .status(200)
        .json({ received: true, outcome: outcome.kind, reason: outcome.reason, event_id: eventId });
    }

    if (outcome.kind === "conflict") {
      // Keep the row in `received`: it is not a success and not a refusal. The
      // reason carries the Paddle identifiers, so the payment behind it can be
      // found and settled by a human. 202 says "acknowledged, not completed" —
      // Paddle stops retrying, and nothing is silently discarded.
      await annotateEvent(supabase, eventId, outcome.reason);
      return response.status(202).json({
        received: true,
        outcome: "conflict",
        reason: outcome.reason,
        event_id: eventId,
      });
    }

    const reason = outcome.kind === "processed" ? outcome.reason ?? null : null;
    await finalizeEvent(supabase, eventId, "processed", reason);
    return response
      .status(200)
      .json({ received: true, reason, event_id: eventId, ...(replayed ? { replayed: true } : {}) });
  } catch (error) {
    const reason = error instanceof InfraError ? error.message : "unexpected_error";
    // 5xx so Paddle retries; no internal detail is echoed to the caller.
    return response.status(503).json({ error: "Temporary failure, retry later.", reason });
  }
}

/**
 * Vercel entry point.
 *
 * Everything above runs inside `handleWebhook`, but an exception raised *before*
 * its own `try` — while reading the body, or while verifying the signature —
 * used to escape and surface as Vercel's opaque
 * `500 FUNCTION_INVOCATION_FAILED`, with no trace and no reason for Paddle.
 *
 * This wrapper guarantees that a delivery always receives a JSON decision:
 * Paddle retries on 503, and the `reason` makes the failure diagnosable from
 * the notification log alone.
 */
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    return await handleWebhook(request, response);
  } catch (error) {
    const reason = error instanceof InfraError ? error.message : "unhandled_exception";
    try {
      return response
        .status(503)
        .json({ error: "Temporary failure, retry later.", reason });
    } catch {
      // The response object itself is unusable: nothing more can be said.
      return undefined;
    }
  }
}
