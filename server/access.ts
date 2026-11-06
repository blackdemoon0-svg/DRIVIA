/**
 * Server-side access control for the VEYVRO chat.
 *
 * Rules enforced here, and nowhere else:
 * - the identity comes from Supabase alone: the browser presents an access
 *   token, this module asks Supabase who it belongs to. An id, a plan or an
 *   e-mail sent in the request body is never read;
 * - the plan comes from `public.subscriptions`, filtered on the verified user
 *   id and re-checked row by row. Nothing the browser claims is trusted;
 * - every uncertain case **fails closed**: missing configuration, Supabase
 *   outage, malformed row, unknown status or expired period all mean "no paid
 *   access", never "probably fine";
 * - an expired subscription grants nothing, even if its status still says
 *   `active`: the period end is compared to the current time here, on the
 *   server, and the browser has no say in it.
 *
 * This module never returns a token, a key or an e-mail to its caller.
 */

import crypto from "node:crypto";
import { limitsFor, type PlanLimits } from "../src/lib/planLimits.js";
import {
  ENTITLED_STATUSES,
  findBlockingSubscription,
  resolveAccessPlan,
  toGrant,
  type AccessPlan,
  type BlockingSubscription,
  type PaidAccessPlan,
  type StoredSubscriptionRow,
  type SubscriptionStatus,
} from "../src/lib/subscriptionAccess.js";

/**
 * Plan identifiers, matching the public catalogue in `src/lib/paddleCore.ts`.
 * `AccessPlan` and `PaidAccessPlan` are re-exported from the shared rule module
 * so every caller keeps importing them from here.
 */
export type { AccessPlan, BlockingSubscription, PaidAccessPlan, SubscriptionStatus };

export { ENTITLED_STATUSES, findBlockingSubscription, resolveAccessPlan, toGrant };

/**
 * Environment variable names, exactly as configured in Vercel.
 * `SUPABASE_ANON_KEY` validates the token; the service role key reads
 * `subscriptions` server-side. Both are already present for the Paddle routes.
 */
export const ACCESS_ENV_KEYS = {
  supabaseUrl: "SUPABASE_URL",
  supabaseAnonKey: "SUPABASE_ANON_KEY",
  serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
} as const;

export type AccessEnv = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
};

type Env = Record<string, string | undefined>;

/**
 * Read the server configuration.
 *
 * Returns `null` when anything is missing: a caller must then answer 503 rather
 * than grant access. A deployment without these variables cannot decide
 * anything about a subscription, so it must not decide "yes".
 */
export function readAccessEnv(env: Env = process.env): AccessEnv | null {
  const url = env[ACCESS_ENV_KEYS.supabaseUrl]?.trim().replace(/\/+$/, "");
  const anonKey = env[ACCESS_ENV_KEYS.supabaseAnonKey]?.trim();
  const serviceRoleKey = env[ACCESS_ENV_KEYS.serviceRoleKey]?.trim();
  if (!url || !anonKey || !serviceRoleKey) return null;
  return { url, anonKey, serviceRoleKey };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token.
 *
 * Refuses anything that cannot be a Supabase access token: a JWT has three
 * segments. This keeps obviously malformed input from reaching the network.
 */
export function readBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token || token.length < 20) return null;
  if (token.split(".").length !== 3) return null;
  return token;
}

export type AccessIdentity = {
  userId: string;
  emailConfirmed: boolean;
};

/** Raised when Supabase cannot be reached: infrastructure, not a bad token. */
export class IdentityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityUnavailableError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ask Supabase who this token belongs to.
 *
 * `/auth/v1/user` validates the signature, the expiry and the revocation on
 * Supabase's side, which is exactly the authority required. The anon key is
 * used on purpose: the service role key must not touch a user-provided token.
 *
 * Returns `null` for an invalid or expired token. Throws
 * `IdentityUnavailableError` when Supabase cannot be reached, so the caller can
 * distinguish "you are not who you claim" (401) from "we cannot tell right now"
 * (503).
 */
export async function resolveIdentity(
  accessToken: string,
  env: AccessEnv,
): Promise<AccessIdentity | null> {
  let response: Response;
  try {
    response = await fetch(`${env.url}/auth/v1/user`, {
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw new IdentityUnavailableError("Supabase auth is unreachable.");
  }

  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new IdentityUnavailableError(`Supabase auth answered ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new IdentityUnavailableError("Supabase auth returned an unreadable body.");
  }

  const user = (payload ?? {}) as { id?: unknown; email_confirmed_at?: unknown };
  const userId = typeof user.id === "string" ? user.id.trim() : "";
  // A body without a usable id is not an identity: fail closed.
  if (!UUID_PATTERN.test(userId)) return null;

  return {
    userId,
    emailConfirmed: typeof user.email_confirmed_at === "string" && user.email_confirmed_at.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Subscription rows
// ---------------------------------------------------------------------------

/**
 * The row rule lives in `src/lib/subscriptionAccess.ts`, because the pricing
 * page needs the very same rule to decide which button may be pressed. Keeping
 * one copy is the point: two copies would drift, and the drift would either
 * offer a purchase the database refuses or hide one the customer needs.
 *
 * Nothing is loosened by the shared module: it is pure, imports nothing, and
 * only *this* module decides whether a request may run. The pricing page reads
 * the customer's own rows through row level security for display, and the guard
 * there is a courtesy — never an authorisation.
 */
export type RawSubscriptionRow = StoredSubscriptionRow;

// ---------------------------------------------------------------------------
// Reading subscriptions
// ---------------------------------------------------------------------------

/** Columns needed to decide access. Nothing else is fetched. */
export const ACCESS_COLUMNS = "user_id,plan,status,current_period_ends_at";

/**
 * Read the subscriptions of one account with the service role key.
 *
 * Filtered on `user_id` server-side, then validated again by `toGrant`: a
 * mis-scoped query still cannot grant another account's plan. Throws on any
 * failure — the caller must answer 503, never fall back to a default plan.
 */
export async function readSubscriptions(
  userId: string,
  env: AccessEnv,
): Promise<RawSubscriptionRow[]> {
  let response: Response;
  try {
    response = await fetch(
      `${env.url}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=${encodeURIComponent(
        ACCESS_COLUMNS,
      )}`,
      {
        headers: {
          apikey: env.serviceRoleKey,
          Authorization: `Bearer ${env.serviceRoleKey}`,
        },
      },
    );
  } catch {
    throw new IdentityUnavailableError("Supabase REST is unreachable.");
  }

  if (!response.ok) {
    throw new IdentityUnavailableError(`subscriptions read failed (${response.status}).`);
  }

  const rows = (await response.json()) as unknown;
  return Array.isArray(rows) ? (rows as RawSubscriptionRow[]) : [];
}

// ---------------------------------------------------------------------------
// Plan limits — the quotas validated with the product owner
// ---------------------------------------------------------------------------

/**
 * Quotas live in `src/lib/planLimits.ts` so the pricing page and this handler
 * read the same table. Re-exported here because access control is what applies
 * them, and callers should not have to know where they are declared.
 */
export { PLAN_LIMITS, limitsFor } from "../src/lib/planLimits.js";
export type { PlanLimits } from "../src/lib/planLimits.js";

// ---------------------------------------------------------------------------
// Full decision
// ---------------------------------------------------------------------------

export type AccessDecision =
  | { ok: true; userId: string; plan: AccessPlan; limits: PlanLimits }
  | {
      ok: false;
      status: 401 | 503;
      code:
        | "auth_required"
        | "invalid_token"
        | "identity_unavailable"
        | "not_configured";
      error: string;
    };

/**
 * Full access decision for one request.
 *
 * Order matters: configuration first (503), then token (401), then identity
 * (401), then subscriptions (503 → fail closed, never a free upgrade).
 */
export async function authorizeRequest(
  authorizationHeader: string | null | undefined,
  env: Env = process.env,
): Promise<AccessDecision> {
  const config = readAccessEnv(env);
  if (!config) {
    return {
      ok: false,
      status: 503,
      code: "not_configured",
      error: "VEYVRO's account service is not configured on the server.",
    };
  }

  const token = readBearerToken(authorizationHeader);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "auth_required",
      error: "Sign in to VEYVRO to use the chat.",
    };
  }

  let identity: AccessIdentity | null;
  try {
    identity = await resolveIdentity(token, config);
  } catch {
    return {
      ok: false,
      status: 503,
      code: "identity_unavailable",
      error: "VEYVRO cannot verify your session right now. Please retry shortly.",
    };
  }

  if (!identity) {
    return {
      ok: false,
      status: 401,
      code: "invalid_token",
      error: "Your session has expired. Sign in again.",
    };
  }

  let rows: RawSubscriptionRow[];
  try {
    rows = await readSubscriptions(identity.userId, config);
  } catch {
    // Fail closed: an unreadable subscription table is not an upgrade.
    return {
      ok: false,
      status: 503,
      code: "identity_unavailable",
      error: "VEYVRO cannot check your plan right now. Please retry shortly.",
    };
  }

  const plan = resolveAccessPlan(rows, identity.userId);
  return { ok: true, userId: identity.userId, plan, limits: limitsFor(plan) };
}

/**
 * Stable, non-reversible counter key for an account.
 *
 * The raw user id is not kept in memory: quotas only need to tell accounts
 * apart, and a digest cannot be turned back into an identity if the process is
 * ever inspected.
 */
export function quotaKey(userId: string): string {
  return crypto.createHash("sha256").update(userId.trim(), "utf8").digest("hex").slice(0, 32);
}
