/**
 * Price catalogue: the one place that knows which price ID belongs to which
 * plan, in both directions.
 *
 * Why one module
 * --------------
 * Two sides must agree exactly:
 * - the **webhook** turns an incoming price ID into a plan (`resolvePlanFromPriceId`);
 * - the **plan-change route** turns a target plan into the price ID to send to
 *   Paddle (`priceIdForPlan`).
 *
 * If they disagreed, a customer could be charged for a price the webhook does
 * not recognise: the event would be rejected with `unknown_price_id`, the money
 * would be taken and the account would keep its old plan. Sharing the same
 * precedence — `VITE_PADDLE_PRICE_*`, then `PADDLE_PRICE_*`, then the built-in
 * Sandbox catalogue — makes that disagreement impossible to introduce by
 * accident, and a test proves the round trip.
 *
 * Pure and environment-agnostic: imports nothing but the public catalogue, so
 * it runs identically on the server and in the browser bundle.
 */

import {
  BILLING_INTERVALS,
  PAID_PLAN_IDS,
  SANDBOX_PRICE_IDS,
  type BillingInterval,
  type PaidPlanId,
} from "./paddleCore";

type Env = Record<string, string | undefined>;

/**
 * Environment variable names for one plan and interval, in precedence order.
 *
 * `VITE_` first because that is the name already configured on the project;
 * the plain name is accepted too, exactly as the webhook always did.
 */
export function priceEnvNames(plan: PaidPlanId, interval: BillingInterval): [string, string] {
  const suffix = `${plan.toUpperCase()}_${interval.toUpperCase()}`;
  return [`VITE_PADDLE_PRICE_${suffix}`, `PADDLE_PRICE_${suffix}`];
}

/** Price ID configured in the environment, if any. */
export function priceIdFromEnv(
  plan: PaidPlanId,
  interval: BillingInterval,
  env: Env,
): string | null {
  for (const name of priceEnvNames(plan, interval)) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Map a Paddle price ID to our plan.
 *
 * The environment wins over the built-in Sandbox catalogue, so a project that
 * configured production price IDs resolves those first.
 */
export function resolvePlanFromPriceId(
  priceId: string | null | undefined,
  env: Env = process.env,
): { plan: PaidPlanId; interval: BillingInterval } | null {
  if (!priceId) return null;

  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (priceIdFromEnv(plan, interval, env) === priceId) return { plan, interval };
      if (SANDBOX_PRICE_IDS[plan][interval] === priceId) return { plan, interval };
    }
  }
  return null;
}

/**
 * The price ID to bill for a plan, resolved like the webhook resolves it.
 *
 * Returns `null` when nothing is configured and the built-in catalogue does not
 * cover the pair: the caller must then refuse the change rather than guess,
 * because a wrong price ID means a wrong amount, or a plan the webhook cannot
 * name.
 */
export function priceIdForPlan(
  plan: PaidPlanId,
  interval: BillingInterval,
  env: Env = process.env,
): string | null {
  const fromEnv = priceIdFromEnv(plan, interval, env);
  if (fromEnv) return fromEnv;
  return SANDBOX_PRICE_IDS[plan]?.[interval] ?? null;
}

export type PriceCatalogueEntry = {
  plan: PaidPlanId;
  interval: BillingInterval;
  priceId: string;
  /** `true` when the ID comes from the built-in Sandbox catalogue. */
  sandboxFallback: boolean;
};

/** Every resolvable price, for diagnostics and tests. */
export function priceCatalogue(env: Env = process.env): PriceCatalogueEntry[] {
  const entries: PriceCatalogueEntry[] = [];
  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      const priceId = priceIdForPlan(plan, interval, env);
      if (!priceId) continue;
      entries.push({
        plan,
        interval,
        priceId,
        sandboxFallback: priceIdFromEnv(plan, interval, env) === null,
      });
    }
  }
  return entries;
}
