/**
 * Server-side orchestration of a plan change (Plus → Pro, in place).
 *
 * The order of the checks is the substance of this file. Each step exists
 * because the previous one cannot be trusted on its own:
 *
 * 1. **identity** — from the Supabase access token only. Nothing in the request
 *    body says who is calling, and the caller never names their subscription.
 * 2. **throttle** — per account, and per address when the platform provides one.
 *    Before any database or Paddle call, so a loop costs us nothing.
 * 3. **configuration** — the Paddle key must exist *and* belong to the
 *    environment this deployment believes it is in.
 * 4. **the subscription** — read with the service role key, filtered on the
 *    verified user id, re-validated row by row. The Paddle subscription id used
 *    in the PATCH is the one carried by the selected row, never one taken from
 *    the request: otherwise anyone could ask us to modify somebody else's
 *    subscription.
 * 5. **the rules** — `evaluatePlanChange`, which refuses `past_due`, downgrades,
 *    interval changes and no-op changes before a single byte reaches Paddle.
 * 6. **the price** — resolved with the very function the webhook uses to read a
 *    price back. A price the webhook cannot name would mean a charge with no
 *    plan attached.
 * 7. **a signed quote** — the preview returns a token binding the amount, the
 *    account, the subscription, the plan, the interval and the price, with a
 *    short expiry. Applying without one is refused, so no charge can happen
 *    without a figure having been shown.
 * 8. **one change at a time** — a per-subscription lock, then a fresh preview
 *    whose amount must equal the signed one, then a single-use nonce, and only
 *    then the PATCH.
 *
 * This module never writes `subscriptions`. The webhook is the only writer, and
 * that stays true: until it has written the new price, the plan has not
 * changed.
 */

import { readAccessEnv, resolveIdentity, type AccessEnv } from "./access.js";
import {
  applySubscriptionChange,
  buildPlanChangeBody,
  isNoOpPreview,
  isPaddleLockCode,
  previewSubscriptionChange,
  readPaddleApiConfig,
  type PaddleApiConfig,
  type PaddleApiFailure,
  type PlanChangePreview,
} from "./paddleApi.js";
import {
  PLAN_CHANGE_RATE_LIMITS,
  acquireSubscriptionLock,
  consumeQuoteNonce,
  consumeRateLimit,
} from "./planChangeGuard.js";
import {
  createPlanChangeQuote,
  readQuoteSecret,
  toWireQuote,
  verifyPlanChangeQuote,
  type PlanChangeQuoteWire,
  type QuoteRefusal,
} from "./planChangeQuote.js";
import { PAID_PLAN_IDS, type BillingInterval, type PaidPlanId } from "../src/lib/paddleCore.js";
import { priceIdForPlan } from "../src/lib/paddlePrices.js";
import {
  evaluatePlanChange,
  pickSubscriptionForChange,
  type SubscriptionForChange,
} from "../src/lib/planChange.js";
import { type StoredSubscriptionRow } from "../src/lib/subscriptionAccess.js";

type Env = Record<string, string | undefined>;

/** Columns needed to decide and to act. Nothing else is read. */
export const PLAN_CHANGE_COLUMNS =
  "user_id,paddle_subscription_id,plan,status,billing_interval,current_period_ends_at";

export type PlanChangeRequest = {
  accessToken: string | null;
  targetPlan: unknown;
  interval: unknown;
  /**
   * `true` returns the prorated amount without changing anything.
   * A change is only applied on an explicit `false`, and only with a quote.
   */
  preview: boolean;
  /** The signed quote returned by the preview this change confirms. */
  quoteToken: unknown;
  /** Caller address, when the platform forwarded one. Never trusted for identity. */
  clientIp: string | null;
};

/** Options that only the tests pass: a fixed clock. */
export type PlanChangeOptions = { nowMs?: number };

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;

export type PlanChangeOutcome =
  /** Preview only: nothing was changed, and the amount is signed. */
  | {
      status: 200;
      body: {
        ok: true;
        preview: PlanChangePreview;
        noCharge: boolean;
        quote: PlanChangeQuoteWire;
      };
    }
  /**
   * Paddle accepted the change. The plan is **not** announced as changed: the
   * webhook still has to write it, and the interface must re-read the database.
   */
  | { status: 202; body: { ok: true; changeRequested: true } }
  | {
      status: ErrorStatus;
      body: { error: string; code: string; detail?: string };
      /** Set on 429, so the route can answer with `Retry-After`. */
      retryAfterSeconds?: number;
    };

const TARGET_PLANS: readonly PaidPlanId[] = PAID_PLAN_IDS;

function isInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

/**
 * Read the account's own subscription rows with the service role key.
 *
 * Same shape as `readSubscriptions` in `access.ts`, different columns: a change
 * needs the Paddle subscription id and the billing interval, which access
 * decisions never look at.
 */
async function readOwnRows(
  userId: string,
  accessEnv: AccessEnv,
): Promise<StoredSubscriptionRow[] | null> {
  let response: Response;
  try {
    response = await fetch(
      `${accessEnv.url}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(
        userId,
      )}&select=${encodeURIComponent(PLAN_CHANGE_COLUMNS)}`,
      {
        headers: {
          apikey: accessEnv.serviceRoleKey,
          Authorization: `Bearer ${accessEnv.serviceRoleKey}`,
        },
      },
    );
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const rows = (await response.json().catch(() => null)) as unknown;
  return Array.isArray(rows) ? (rows as StoredSubscriptionRow[]) : [];
}

/** Two previews describe the same charge only if all three fields agree. */
function sameCharge(a: PlanChangePreview, b: PlanChangePreview): boolean {
  return a.action === b.action && a.amountMinor === b.amountMinor && a.currencyCode === b.currencyCode;
}

function rateLimited(retryAfterSeconds: number, scope: string): PlanChangeOutcome {
  return {
    status: 429,
    retryAfterSeconds,
    body: {
      error: `Trop de demandes de changement de formule (${scope}). Patientez avant de réessayer.`,
      code: "rate_limited",
    },
  };
}

/** Translate a quote refusal into an answer the interface can act on. */
function quoteFailure(reason: QuoteRefusal): PlanChangeOutcome {
  switch (reason) {
    case "missing":
      return {
        status: 409,
        body: {
          error: "A confirmed quote is required before a plan change is applied.",
          code: "quote_required",
        },
      };
    case "expired":
      return {
        status: 409,
        body: { error: "The quoted amount has expired.", code: "quote_expired" },
      };
    case "mismatch":
      return {
        status: 409,
        body: {
          error: "The quote does not describe this change.",
          code: "quote_mismatch",
        },
      };
    default:
      return {
        status: 409,
        body: { error: "The quote could not be verified.", code: "quote_invalid" },
      };
  }
}

/**
 * Decide what a plan-change request must answer.
 *
 * `env` and the clock are injectable so every branch can be tested without a
 * deployment.
 */
export async function handlePlanChangeRequest(
  request: PlanChangeRequest,
  env: Env = process.env,
  options: PlanChangeOptions = {},
): Promise<PlanChangeOutcome> {
  const nowMs = options.nowMs ?? Date.now();

  // 1. Identity — from the token alone.
  if (!request.accessToken) {
    return { status: 401, body: { error: "A valid Supabase access token is required.", code: "auth_required" } };
  }

  const accessEnv: AccessEnv | null = readAccessEnv(env);
  if (!accessEnv) {
    return {
      status: 503,
      body: { error: "Server is not configured to identify accounts.", code: "not_configured" },
    };
  }

  let identity: { userId: string; emailConfirmed: boolean } | null;
  try {
    identity = await resolveIdentity(request.accessToken, accessEnv);
  } catch {
    // Supabase unreachable: infrastructure, distinct from a bad token (401).
    return { status: 503, body: { error: "Identity provider unavailable, retry later.", code: "identity_unavailable" } };
  }

  if (!identity) {
    return { status: 401, body: { error: "Invalid or expired access token.", code: "invalid_token" } };
  }

  // An unconfirmed address cannot subscribe in the first place; it cannot
  // upgrade either, and saying so is clearer than letting Paddle decide.
  if (!identity.emailConfirmed) {
    return {
      status: 403,
      body: { error: "Email address must be confirmed before changing plan.", code: "email_unconfirmed" },
    };
  }

  // 2. Throttle, now that we know who is asking.
  const budget = request.preview ? PLAN_CHANGE_RATE_LIMITS.preview : PLAN_CHANGE_RATE_LIMITS.apply;
  const accountLimit = consumeRateLimit(`plan-change:${identity.userId}`, budget, nowMs);
  if (!accountLimit.ok) return rateLimited(accountLimit.retryAfterSeconds, "compte");

  // The address is a hint, not an identity: only enforced when the platform
  // supplies one, and never used to authorise anything.
  const clientIp = (request.clientIp ?? "").trim();
  if (clientIp) {
    const ipLimit = consumeRateLimit(`plan-change-ip:${clientIp}`, PLAN_CHANGE_RATE_LIMITS.ip, nowMs);
    if (!ipLimit.ok) return rateLimited(ipLimit.retryAfterSeconds, "adresse");
  }

  // 3. Target validation, before any network call.
  if (typeof request.targetPlan !== "string" || !TARGET_PLANS.includes(request.targetPlan as PaidPlanId)) {
    return { status: 400, body: { error: "Unknown target plan.", code: "invalid_target_plan" } };
  }
  if (!isInterval(request.interval)) {
    return { status: 400, body: { error: "Unknown billing interval.", code: "invalid_interval" } };
  }
  const target = { plan: request.targetPlan as PaidPlanId, interval: request.interval };

  // 4. Configuration.
  const apiConfig = readPaddleApiConfig(env);
  if (!apiConfig.ok) {
    // A key from the other Paddle account is a deployment error, not a user
    // error: 503 keeps the caller from thinking a new attempt will fix it.
    return {
      status: 503,
      body: {
        error: "Paddle API is not configured for this environment.",
        code: apiConfig.reason === "api_key_missing" ? "paddle_not_configured" : "paddle_environment_mismatch",
      },
    };
  }

  // 5. The subscription, read here and never taken from the request.
  const rows = await readOwnRows(identity.userId, accessEnv);
  if (rows === null) {
    return {
      status: 503,
      body: { error: "Server could not read subscriptions.", code: "identity_unavailable" },
    };
  }

  const current: SubscriptionForChange | null = pickSubscriptionForChange(rows, identity.userId);
  const decision = evaluatePlanChange(current, target);
  if (!decision.ok) {
    return {
      status: decision.code === "no_subscription" ? 404 : 409,
      body: {
        error: "This plan change is not allowed.",
        code: decision.code,
        ...(decision.status ? { detail: `status=${decision.status}` } : {}),
      },
    };
  }

  // 6. The price, resolved exactly as the webhook resolves it.
  const priceId = priceIdForPlan(target.plan, target.interval, env);
  if (!priceId) {
    return {
      status: 503,
      body: { error: "No Paddle price configured for that plan.", code: "price_not_configured" },
    };
  }

  // The Paddle subscription id is carried by the selected row itself — no
  // second lookup, no re-identification by `(plan, status)`.
  const subscriptionId = current?.subscriptionId ?? "";
  if (!subscriptionId) {
    return { status: 409, body: { error: "No Paddle subscription to update.", code: "no_subscription" } };
  }

  const body = buildPlanChangeBody(priceId);
  const config: PaddleApiConfig = apiConfig.config;

  // A quote is signed with the same key the calls are made with; without it
  // there is nothing to sign with and nothing to call Paddle with either.
  const quoteSecret = readQuoteSecret(env);
  if (!quoteSecret) {
    return {
      status: 503,
      body: { error: "Paddle API is not configured for this environment.", code: "paddle_not_configured" },
    };
  }

  // 7a. Preview: read Paddle's own figure, change nothing, sign it.
  if (request.preview) {
    const preview = await previewSubscriptionChange(config, subscriptionId, body);
    if (!preview.ok) return paddleFailure(preview.failure);

    const created = createPlanChangeQuote({
      secret: quoteSecret,
      userId: identity.userId,
      subscriptionId,
      targetPlan: target.plan,
      interval: target.interval,
      priceId,
      preview: preview.data,
      nowMs,
    });
    if (!created) {
      // A quote we cannot sign is a quote the confirmation could never honour.
      return {
        status: 503,
        body: { error: "Could not issue a quote for this change.", code: "quote_unavailable" },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        preview: preview.data,
        noCharge: isNoOpPreview(preview.data),
        quote: toWireQuote(created),
      },
    };
  }

  // 7b. Applying is only possible with the quote the customer was shown.
  const verification = verifyPlanChangeQuote({
    secret: quoteSecret,
    token: request.quoteToken,
    nowMs,
    expected: {
      userId: identity.userId,
      subscriptionId,
      targetPlan: target.plan,
      interval: target.interval,
      priceId,
    },
  });
  if (!verification.ok) return quoteFailure(verification.reason);

  // 7c. One change at a time for this subscription.
  const lock = acquireSubscriptionLock(subscriptionId, nowMs);
  if (!lock.ok) {
    return {
      status: 409,
      retryAfterSeconds: lock.retryAfterSeconds,
      body: {
        error: "A change is already in progress for this subscription.",
        code: "change_in_progress",
      },
    };
  }

  try {
    // 7d. Ask Paddle again: the amount must still be the signed one. Proration
    // is minute-based, and a renewal between the quote and the confirmation
    // would otherwise bill a figure the customer never saw.
    const recheck = await previewSubscriptionChange(config, subscriptionId, body);
    if (!recheck.ok) return paddleFailure(recheck.failure);
    if (!sameCharge(recheck.data, verification.quote)) {
      return {
        status: 409,
        body: {
          error: "The amount changed since the quote. A new quote is required.",
          code: "quote_stale",
        },
      };
    }

    // 7e. A quote is single-use: a replayed request cannot patch twice.
    const nonce = consumeQuoteNonce(verification.quote.nonce, verification.quote.expiresAtMs, nowMs);
    if (!nonce.ok) {
      return {
        status: 409,
        body: { error: "This quote has already been used.", code: "quote_reused" },
      };
    }

    // 7f. Apply. Paddle charges the prorated amount immediately; `prevent_change`
    // means a failed payment leaves the subscription exactly as it was.
    const applied = await applySubscriptionChange(config, subscriptionId, body);
    if (!applied.ok) return paddleFailure(applied.failure);

    return { status: 202, body: { ok: true, changeRequested: true } };
  } finally {
    lock.release();
  }
}

/** Translate a Paddle failure into an answer the interface can act on. */
function paddleFailure(failure: PaddleApiFailure): PlanChangeOutcome {
  if (failure.kind === "unavailable") {
    return { status: 503, body: { error: "Paddle is unreachable, retry later.", code: "paddle_unavailable" } };
  }

  // Paddle's own throttling: temporary, counted, and carrying a delay.
  if (failure.kind === "rate_limited") {
    const retryAfterSeconds = failure.retryAfterSeconds ?? 60;
    return {
      status: 429,
      retryAfterSeconds,
      body: {
        error: "Paddle is rate-limiting this environment, retry later.",
        code: "paddle_rate_limited",
      },
    };
  }

  const code = failure.code ?? null;
  const status = failure.status;

  // "The subscription is busy" is the only Paddle refusal worth retrying: it
  // happens near a renewal or while another change is processing.
  if (isPaddleLockCode(code) || code === "subscription_credit_creation_against_processing_transaction") {
    return {
      status: 409,
      body: { error: "Paddle is processing a change on this subscription.", code: "paddle_locked", ...(code ? { detail: code } : {}) },
    };
  }

  // A rejected key or a missing permission is our problem, not the customer's.
  if (status === 401 || status === 403) {
    return {
      status: 503,
      body: { error: "Paddle credentials were refused.", code: "paddle_credentials", ...(code ? { detail: code } : {}) },
    };
  }

  if (code === "subscription_update_when_past_due" || code === "subscription_past_due") {
    return { status: 409, body: { error: "Subscription is past due.", code: "not_in_good_standing" } };
  }

  return {
    status: 422,
    body: { error: "Paddle refused the change.", code: "paddle_refused", ...(code ? { detail: code } : {}) },
  };
}

/**
 * Parse the request body into the values this module reads.
 *
 * Only four fields are read; anything else the caller sends is ignored — in
 * particular a `userId`, a `subscriptionId` or a `priceId`, none of which this
 * route accepts from outside. `quoteToken` is the opaque token issued by a
 * previous preview: it is verified, never trusted as a statement of fact.
 */
export function readPlanChangeBody(body: unknown): {
  targetPlan: unknown;
  interval: unknown;
  preview: boolean;
  quoteToken: unknown;
} {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    targetPlan: record.targetPlan,
    interval: record.interval,
    // Anything but an explicit `false` is treated as a preview: the safe
    // default is the one that cannot take money.
    preview: record.preview !== false,
    quoteToken: record.quoteToken,
  };
}
