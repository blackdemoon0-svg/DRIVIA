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
 * Sandbox identifiers never cross into Live
 * -----------------------------------------
 * A Sandbox price ID is recognised as such *wherever it comes from*: the built-in
 * catalogue, or a deployment variable accidentally filled with a Sandbox value.
 * Outside Sandbox, all four are refused before any other rule applies, in both
 * directions:
 * - `resolvePlanFromPriceId` returns `null`, so a Sandbox event grants nothing;
 * - `priceIdForPlan` returns `null`, so a Sandbox price is never even sent to a
 *   Live account, and a missing Live variable blocks the change instead of
 *   falling back to the Sandbox catalogue.
 *
 * This is not a theoretical guard: copying the four variables from Sandbox to a
 * Live project is an ordinary launch mistake, and nothing in a Paddle price ID
 * says which environment it belongs to.
 *
 * Pure: imports nothing but the public catalogue, so it runs identically on the
 * server and in the browser bundle.
 */

import {
  BILLING_INTERVALS,
  PADDLE_KEYS,
  PAID_PLAN_IDS,
  SANDBOX_PRICE_IDS,
  normalizeEnvironment,
  type BillingInterval,
  type PaddleEnvironment,
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
 * Every identifier of the built-in Sandbox catalogue, as a set.
 *
 * Built once at module load. It answers one question — "is this a Sandbox
 * price?" — independently of where the identifier came from, which is what lets
 * a mis-filled deployment variable be caught just like the built-in catalogue.
 */
const SANDBOX_PRICE_ID_SET: ReadonlySet<string> = new Set(
  PAID_PLAN_IDS.flatMap((plan) =>
    BILLING_INTERVALS.map((interval) => SANDBOX_PRICE_IDS[plan][interval]),
  ),
);

/** All four Sandbox identifiers, for diagnostics and tests. */
export function sandboxPriceIds(): string[] {
  return [...SANDBOX_PRICE_ID_SET];
}

/** True when this identifier belongs to the built-in Sandbox catalogue. */
export function isSandboxPriceId(priceId: string | null | undefined): boolean {
  const id = (priceId ?? "").trim();
  return id.length > 0 && SANDBOX_PRICE_ID_SET.has(id);
}

/**
 * Environment variable names that may declare this deployment's Paddle
 * environment, mirroring `PADDLE_API_ENV_KEYS` on the server: the public
 * `VITE_` name is what the browser reads, the plain name is what an operator
 * sets server-side. Either one is enough.
 */
const ENVIRONMENT_ENV_NAMES: readonly string[] = ["PADDLE_ENVIRONMENT", PADDLE_KEYS.environment];

/**
 * Which Paddle environment this deployment runs in.
 *
 * Deliberately fail-closed: the deployment counts as **Production** as soon as
 * any of the accepted variables says so. Reading only one of them would leave a
 * hole — a Live project that declared `PADDLE_ENVIRONMENT=production` but
 * omitted the `VITE_` copy would be classified Sandbox here, and the Sandbox
 * catalogue would resolve on it, which is exactly what this guard exists to
 * prevent.
 *
 * A missing, empty or unreadable value everywhere means Sandbox: a deployment
 * that never declared itself Live keeps the Sandbox behaviour.
 */
export function resolvePaddleEnvironment(env: Env): PaddleEnvironment {
  for (const name of ENVIRONMENT_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && normalizeEnvironment(value) === "production") {
      return "production";
    }
  }
  return "sandbox";
}

/**
 * Map a Paddle price ID to our plan.
 *
 * Order of the rules, and why it is this order:
 * 0. Outside Sandbox, a Sandbox identifier is refused **first**. Checking the
 *    identifier itself — not just the built-in fallback — is what closes the
 *    case where a deployment variable was filled with a Sandbox value.
 * 1. A price explicitly configured for this deployment wins: it is the
 *    catalogue the operator actually bills with.
 * 2. The built-in Sandbox catalogue resolves only while this deployment runs in
 *    Sandbox. In production a 7 $ Sandbox purchase must never grant a real Pro
 *    subscription, even if the two environments happen to share a signing
 *    secret.
 */
export function resolvePlanFromPriceId(
  priceId: string | null | undefined,
  env: Env = process.env,
): { plan: PaidPlanId; interval: BillingInterval } | null {
  const candidate = (priceId ?? "").trim();
  if (!candidate) return null;

  const environment = resolvePaddleEnvironment(env);

  // 0. Sandbox identifier outside Sandbox: refused, whatever configured it.
  if (environment !== "sandbox" && isSandboxPriceId(candidate)) return null;

  // 1. A price explicitly configured for this deployment always wins.
  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (priceIdFromEnv(plan, interval, env) === candidate) return { plan, interval };
    }
  }

  // 2. The built-in Sandbox catalogue resolves only in Sandbox.
  if (environment !== "sandbox") return null;

  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (SANDBOX_PRICE_IDS[plan][interval] === candidate) return { plan, interval };
    }
  }
  return null;
}

/**
 * The price ID to bill for a plan, resolved like the webhook resolves it.
 *
 * Returns `null` when nothing usable is configured: the caller must then refuse
 * the change rather than guess, because a wrong price ID means a wrong amount,
 * or a plan the webhook cannot name.
 *
 * Outside Sandbox this function never returns a Sandbox identifier, from either
 * direction:
 * - a deployment variable holding a Sandbox value is treated as a configuration
 *   error and yields `null`, so such a price is never sent to a Live account;
 * - the built-in catalogue is not used as a fallback, so a missing Live
 *   variable blocks the change instead of charging a Sandbox price.
 */
export function priceIdForPlan(
  plan: PaidPlanId,
  interval: BillingInterval,
  env: Env = process.env,
): string | null {
  const environment = resolvePaddleEnvironment(env);
  const fromEnv = priceIdFromEnv(plan, interval, env);

  if (fromEnv) {
    if (environment !== "sandbox" && isSandboxPriceId(fromEnv)) return null;
    return fromEnv;
  }

  if (environment !== "sandbox") return null;
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
