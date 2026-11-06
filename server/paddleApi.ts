/**
 * Server-side Paddle Billing API client — used only to change an existing
 * subscription in place.
 *
 * Why this exists
 * ---------------
 * Paddle.js can open a checkout; it cannot modify a subscription. Opening a
 * second checkout for a customer who already subscribes creates a *second*
 * subscription, which the partial unique index on `paddle_customer_id` refuses:
 * the money is taken and the webhook is left with an unresolvable conflict. The
 * only correct way to move Plus → Pro is `PATCH /subscriptions/{id}` from the
 * server, with an API key no browser ever sees.
 *
 * What is deliberate here
 * -----------------------
 * - **The key never leaves this process.** It is not returned, not logged, not
 *   put in an error message, and not echoed in a response body.
 * - **Key and environment must agree.** A `pdl_live_` key on a Preview that
 *   believes it is sandbox would charge a real customer; a `pdl_sdbx_` key on
 *   production would silently do nothing. The mismatch is refused before any
 *   request is built.
 * - **`custom_data` is never sent.** The attribution proof lives in the
 *   subscription's `custom_data`; sending that field — even set to `null` —
 *   would erase it, and every later webhook would be rejected with
 *   `missing_attribution_proof`. `buildPlanChangeBody` cannot produce it.
 * - **Every failure is classified**, so the caller can tell "retry later"
 *   (Paddle is locked or unreachable) from "this will never work".
 */

type Env = Record<string, string | undefined>;

/** Variable names exactly as they must be configured in Vercel. */
export const PADDLE_API_ENV_KEYS = {
  /** Secret. Server-side only: never a `VITE_` name, never in the bundle. */
  apiKey: "PADDLE_API_KEY",
  /** Optional: falls back to the client's own environment variable. */
  environment: "PADDLE_ENVIRONMENT",
  environmentFallback: "VITE_PADDLE_ENVIRONMENT",
} as const;

/** Paddle's two hosts. A wrong pair (key/host) is a configuration error. */
export const PADDLE_API_BASE_URLS = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
} as const;

export type PaddleApiEnvironment = keyof typeof PADDLE_API_BASE_URLS;

export type PaddleApiConfig = {
  apiKey: string;
  environment: PaddleApiEnvironment;
  baseUrl: string;
};

export type PaddleApiConfigResult =
  | { ok: true; config: PaddleApiConfig }
  /** No key configured: the feature is unavailable, not broken. */
  | { ok: false; reason: "api_key_missing" }
  /**
   * The key belongs to the other Paddle account. Refused rather than used:
   * a live key on a sandbox deployment, or the reverse, is the one mistake that
   * cannot be undone once a payment is taken.
   */
  | { ok: false; reason: "environment_mismatch"; keyEnvironment: PaddleApiEnvironment; expected: PaddleApiEnvironment };

/** Which account a key belongs to, read from its documented prefix. */
export function paddleKeyEnvironment(apiKey: string | null | undefined): PaddleApiEnvironment | null {
  const key = (apiKey ?? "").trim();
  if (key.startsWith("pdl_sdbx_")) return "sandbox";
  if (key.startsWith("pdl_live_")) return "production";
  // A legacy 50-character key carries no environment marker. It is not used:
  // guessing the account is exactly what must not happen here.
  return null;
}

/** Sandbox unless the configuration explicitly says production. */
export function normalizeApiEnvironment(value: string | null | undefined): PaddleApiEnvironment {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "production" || normalized === "live" ? "production" : "sandbox";
}

/**
 * Read and validate the API configuration.
 *
 * Never includes the key in a returned value beyond the config object itself,
 * and never in a reason.
 */
export function readPaddleApiConfig(env: Env = process.env): PaddleApiConfigResult {
  const apiKey = (env[PADDLE_API_ENV_KEYS.apiKey] ?? "").trim();
  if (!apiKey) return { ok: false, reason: "api_key_missing" };

  const environment = normalizeApiEnvironment(
    env[PADDLE_API_ENV_KEYS.environment] ?? env[PADDLE_API_ENV_KEYS.environmentFallback],
  );

  const keyEnvironment = paddleKeyEnvironment(apiKey);
  if (!keyEnvironment) {
    // Unrecognised format: refuse rather than try it against an unknown account.
    return { ok: false, reason: "environment_mismatch", keyEnvironment: environment, expected: environment };
  }
  if (keyEnvironment !== environment) {
    return { ok: false, reason: "environment_mismatch", keyEnvironment, expected: environment };
  }

  return {
    ok: true,
    config: { apiKey, environment, baseUrl: PADDLE_API_BASE_URLS[environment] },
  };
}

/** Paddle subscription IDs are `sub_` followed by 26 lowercase alphanumerics. */
const SUBSCRIPTION_ID_PATTERN = /^sub_[a-z\d]{26}$/;

export function isPaddleSubscriptionId(value: unknown): value is string {
  return typeof value === "string" && SUBSCRIPTION_ID_PATTERN.test(value.trim());
}

/** Body of a plan change. Deliberately has no `custom_data` field. */
export type PlanChangeBody = {
  items: Array<{ price_id: string; quantity: number }>;
  proration_billing_mode: "prorated_immediately";
  on_payment_failure: "prevent_change";
};

/**
 * Build the PATCH body for an in-place plan change.
 *
 * `items` is the **complete** list (Paddle replaces the whole list; an omitted
 * item is removed), which is why the subscription is a single-item one and the
 * target price is sent alone.
 *
 * `custom_data` is intentionally absent and must stay absent: the attribution
 * proof is stored there and an items update has no reason to touch it.
 */
export function buildPlanChangeBody(priceId: string): PlanChangeBody {
  return {
    items: [{ price_id: priceId, quantity: 1 }],
    proration_billing_mode: "prorated_immediately",
    on_payment_failure: "prevent_change",
  };
}

/** Classified failure. `code` is Paddle's own error code when it sent one. */
export type PaddleApiFailure =
  /** Paddle answered 4xx: retrying the same request will not help by itself. */
  | { kind: "refused"; status: number; code: string | null }
  /** Network failure or 5xx: the caller may retry later. */
  | { kind: "unavailable" }
  /**
   * Paddle's own rate limit (`too_many_requests`). Distinct from `refused`
   * because it is temporary and carries a delay, and distinct from
   * `unavailable` because the request was understood and counted.
   */
  | { kind: "rate_limited"; retryAfterSeconds: number | null };

export type PaddleApiResult<T> = { ok: true; data: T } | { ok: false; failure: PaddleApiFailure };

/** Paddle errors that mean "the subscription is busy": retry after it settles. */
export const PADDLE_LOCK_CODES = [
  "subscription_locked_processing",
  "subscription_locked_renewal",
  "subscription_outstanding_transaction",
] as const;

export function isPaddleLockCode(code: string | null): boolean {
  return code !== null && (PADDLE_LOCK_CODES as readonly string[]).includes(code);
}

/** How long a Paddle call may take before we give up. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Read `Retry-After` as whole seconds.
 *
 * Paddle's rate-limit responses carry a hint; when it is missing or not a plain
 * integer the caller is told to wait a conservative minute rather than "now".
 */
function readRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

function readPaddleErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

/**
 * One authenticated request.
 *
 * The key is put in the header and in nothing else: no URL, no body, no log, no
 * error message.
 */
async function paddleRequest(
  config: PaddleApiConfig,
  method: "PATCH",
  path: string,
  body: unknown,
): Promise<PaddleApiResult<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  } finally {
    clearTimeout(timer);
  }

  // Paddle's own throttling, before the generic 5xx branch: a 429 is a "later",
  // not a "broken", and the delay it sends must reach the caller.
  if (response.status === 429) {
    return {
      ok: false,
      failure: { kind: "rate_limited", retryAfterSeconds: readRetryAfterSeconds(response.headers) },
    };
  }

  if (response.status >= 500) return { ok: false, failure: { kind: "unavailable" } };

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: { kind: "refused", status: response.status, code: readPaddleErrorCode(payload) },
    };
  }

  return { ok: true, data: payload };
}

/** `update_summary.result`: the net effect of the change, in minor units. */
export type PlanChangePreview = {
  /** `charge` when the customer owes something, `credit` otherwise. */
  action: "charge" | "credit";
  /** Amount in the lowest denomination (US cents), as Paddle reported it. */
  amountMinor: number;
  currencyCode: string;
};

function readMinorUnits(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Read the preview.
 *
 * The amount is taken from Paddle's own answer and never computed locally: it
 * is the only figure that accounts for the exact minute, taxes and the pricing
 * actually in force.
 */
export function readPlanChangePreview(payload: unknown): PlanChangePreview | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;

  const summary = (data as { update_summary?: unknown }).update_summary;
  if (!summary || typeof summary !== "object") return null;

  const result = (summary as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;

  const action = (result as { action?: unknown }).action;
  if (action !== "charge" && action !== "credit") return null;

  const amountMinor = readMinorUnits((result as { amount?: unknown }).amount);
  if (amountMinor === null) return null;

  const currency = (result as { currency_code?: unknown }).currency_code;
  const currencyCode =
    typeof currency === "string" && /^[A-Z]{3}$/.test(currency.trim()) ? currency.trim() : null;
  if (!currencyCode) return null;

  return { action, amountMinor, currencyCode };
}

/** True when Paddle says the change would cost nothing. */
export function isNoOpPreview(preview: PlanChangePreview): boolean {
  return preview.action === "charge" && preview.amountMinor === 0;
}

/**
 * Preview a change — `PATCH /subscriptions/{id}/preview`.
 *
 * Requires the `subscription.read` permission. Nothing is charged and nothing
 * is modified by this call.
 */
export async function previewSubscriptionChange(
  config: PaddleApiConfig,
  subscriptionId: string,
  body: PlanChangeBody,
): Promise<PaddleApiResult<PlanChangePreview>> {
  if (!isPaddleSubscriptionId(subscriptionId)) {
    return { ok: false, failure: { kind: "refused", status: 400, code: "invalid_subscription_id" } };
  }

  const result = await paddleRequest(
    config,
    "PATCH",
    `/subscriptions/${encodeURIComponent(subscriptionId.trim())}/preview`,
    body,
  );
  if (!result.ok) return result;

  const preview = readPlanChangePreview(result.data);
  if (!preview) {
    // A preview we cannot read is not a preview we can show. Refuse rather than
    // display a guessed amount.
    return { ok: false, failure: { kind: "refused", status: 502, code: "unreadable_preview" } };
  }
  return { ok: true, data: preview };
}

/**
 * Apply the change — `PATCH /subscriptions/{id}`.
 *
 * Requires the `subscription.write` permission. On success Paddle has updated
 * the subscription; our own access rule still changes only when the webhook has
 * written the row, which is why the caller must not report a new plan here.
 */
export async function applySubscriptionChange(
  config: PaddleApiConfig,
  subscriptionId: string,
  body: PlanChangeBody,
): Promise<PaddleApiResult<{ applied: true }>> {
  if (!isPaddleSubscriptionId(subscriptionId)) {
    return { ok: false, failure: { kind: "refused", status: 400, code: "invalid_subscription_id" } };
  }

  const result = await paddleRequest(
    config,
    "PATCH",
    `/subscriptions/${encodeURIComponent(subscriptionId.trim())}`,
    body,
  );
  if (!result.ok) return result;

  return { ok: true, data: { applied: true } };
}
