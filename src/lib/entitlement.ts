/**
 * Subscription display for the account page.
 *
 * Rules enforced here:
 * - the plan is **read from the database**, never taken from a prop, a URL, a
 *   query string or local storage: there is no way for the browser to claim a
 *   plan;
 * - the query is filtered by `user_id`, and every returned row is checked again
 *   against the signed-in id. Row level security is the real barrier, this is
 *   defence in depth;
 * - a missing subscription, a malformed row and an unknown plan are reported as
 *   "no subscription" rather than guessed;
 * - `canceled` and `past_due` are surfaced explicitly, with the date the change
 *   takes effect when Paddle scheduled one.
 *
 * This module only *displays* state. It does not gate anything, and no other
 * module may treat it as an authorisation check: the server remains the only
 * authority for access decisions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabaseClient";

/**
 * Table already present in the `veyvro-preview` project and aligned by
 * `supabase/migrations/0002_align_subscriptions.sql`.
 *
 * The column names below are the ones that exist in the database, not the ones
 * this module first assumed: the code follows the schema, never the reverse.
 */
export const SUBSCRIPTION_TABLE = "subscriptions";

/** Columns read by the account page. Identifiers stay server-side. */
export const SUBSCRIPTION_COLUMNS = [
  "user_id",
  "plan",
  "status",
  "current_period_ends_at",
  "scheduled_change_effective_at",
  "canceled_at",
  "source_updated_at",
].join(", ");

export type PlanId = "plus" | "pro";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "canceled";

const KNOWN_PLANS: readonly PlanId[] = ["plus", "pro"];
const KNOWN_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
];

/** Raw row as PostgREST returns it. Every field is untrusted until checked. */
export type RawSubscriptionRow = {
  user_id?: unknown;
  plan?: unknown;
  status?: unknown;
  current_period_ends_at?: unknown;
  scheduled_change_effective_at?: unknown;
  canceled_at?: unknown;
  source_updated_at?: unknown;
};

/** A row that passed validation for one specific account. */
export type Subscription = {
  userId: string;
  plan: PlanId;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  scheduledChangeAt: string | null;
  canceledAt: string | null;
  occurredAt: string | null;
};

export type EntitlementResult =
  | { kind: "none" }
  | { kind: "subscription"; subscription: Subscription }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asTimestamp(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}

function asPlan(value: unknown): PlanId | null {
  const raw = asTrimmedString(value);
  return raw && (KNOWN_PLANS as readonly string[]).includes(raw) ? (raw as PlanId) : null;
}

function asStatus(value: unknown): SubscriptionStatus | null {
  const raw = asTrimmedString(value);
  return raw && (KNOWN_STATUSES as readonly string[]).includes(raw)
    ? (raw as SubscriptionStatus)
    : null;
}

/**
 * Validate one row **for a given account**.
 *
 * Returns `null` when the row belongs to someone else, or when its plan or
 * status is not one this application knows. A refused row is never partially
 * used: callers see "nothing", not a guessed plan.
 */
export function parseSubscriptionRow(
  row: RawSubscriptionRow | null | undefined,
  expectedUserId: string,
): Subscription | null {
  if (!row || typeof row !== "object") return null;

  const expected = (expectedUserId ?? "").trim();
  if (!expected) return null;

  // Ownership check: a row for another account is discarded even if RLS leaked it.
  const rowUserId = asTrimmedString(row.user_id);
  if (!rowUserId || rowUserId !== expected) return null;

  const plan = asPlan(row.plan);
  const status = asStatus(row.status);
  if (!plan || !status) return null;

  return {
    userId: rowUserId,
    plan,
    status,
    currentPeriodEnd: asTimestamp(row.current_period_ends_at),
    scheduledChangeAt: asTimestamp(row.scheduled_change_effective_at),
    canceledAt: asTimestamp(row.canceled_at),
    occurredAt: asTimestamp(row.source_updated_at),
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Display priority: the state that matters most to the customer comes first. */
const STATUS_PRIORITY: Record<SubscriptionStatus, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  paused: 3,
  canceled: 4,
};

/**
 * Pick the subscription to display when an account has several rows
 * (for example an old cancelled plan and a current one).
 *
 * Ordering is deterministic: most relevant status first, then the most recent
 * Paddle event, then the period end.
 */
export function selectSubscription(
  rows: readonly (RawSubscriptionRow | null | undefined)[],
  expectedUserId: string,
): Subscription | null {
  const candidates = rows
    .map((row) => parseSubscriptionRow(row, expectedUserId))
    .filter((value): value is Subscription => value !== null);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const byStatus = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (byStatus !== 0) return byStatus;

    const aOccurred = a.occurredAt ? Date.parse(a.occurredAt) : 0;
    const bOccurred = b.occurredAt ? Date.parse(b.occurredAt) : 0;
    if (aOccurred !== bOccurred) return bOccurred - aOccurred;

    const aEnd = a.currentPeriodEnd ? Date.parse(a.currentPeriodEnd) : 0;
    const bEnd = b.currentPeriodEnd ? Date.parse(b.currentPeriodEnd) : 0;
    return bEnd - aEnd;
  });

  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the Supabase client used here, so the reader can be tested
 * with a stub instead of a live project.
 */
export type SubscriptionReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
    };
  };
};

/**
 * Read the subscription of one account.
 *
 * The query is filtered on `user_id`, and the result is validated again: an
 * account can only ever see its own row. `expectedUserId` comes from the
 * verified session, never from user input.
 */
export async function readEntitlement(
  client: SubscriptionReader,
  expectedUserId: string,
): Promise<EntitlementResult> {
  const userId = (expectedUserId ?? "").trim();
  if (!userId) return { kind: "none" };

  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await client
      .from(SUBSCRIPTION_TABLE)
      .select(SUBSCRIPTION_COLUMNS)
      .eq("user_id", userId);
  } catch {
    return {
      kind: "error",
      message: "Impossible de lire votre formule pour le moment.",
    };
  }

  if (response.error) {
    // A missing table (migration not applied yet) or an RLS refusal lands here.
    return {
      kind: "error",
      message: "Votre formule est momentanément illisible. Réessayez dans un instant.",
    };
  }

  const rows = Array.isArray(response.data) ? (response.data as RawSubscriptionRow[]) : [];
  const subscription = selectSubscription(rows, userId);
  return subscription ? { kind: "subscription", subscription } : { kind: "none" };
}

/** Same as `readEntitlement`, using the shared browser client. */
export async function fetchEntitlement(expectedUserId: string): Promise<EntitlementResult> {
  let client: SupabaseClient;
  try {
    client = await getSupabaseClient();
  } catch {
    return {
      kind: "error",
      message: "Service de compte indisponible : votre formule ne peut pas être affichée.",
    };
  }
  return readEntitlement(client as unknown as SubscriptionReader, expectedUserId);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const PLAN_LABELS: Record<PlanId, string> = {
  plus: "VEYVRO Plus",
  pro: "VEYVRO Pro",
};

/** French label for a plan. */
export function planLabel(plan: PlanId): string {
  return PLAN_LABELS[plan] ?? "Formule inconnue";
}

/** `12 novembre 2026` — deterministic and locale-stable for tests. */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

export type SubscriptionSummary = {
  plan: string;
  statusLabel: string;
  /** One sentence the customer can act on. */
  detail: string;
  tone: "ok" | "warning" | "neutral" | "inactive";
};

/**
 * Turn a stored subscription into display text.
 *
 * Wording is deliberately factual: it never promises access that the server
 * would not grant, and it keeps `canceled` and `past_due` distinct.
 */
export function summarizeSubscription(subscription: Subscription): SubscriptionSummary {
  const plan = planLabel(subscription.plan);
  const periodEnd = formatDate(subscription.currentPeriodEnd);
  const scheduled = formatDate(subscription.scheduledChangeAt);

  switch (subscription.status) {
    case "active":
      return {
        plan,
        statusLabel: "Active",
        detail: periodEnd
          ? `Prochain renouvellement le ${periodEnd}.`
          : "Abonnement actif.",
        tone: "ok",
      };
    case "trialing":
      return {
        plan,
        statusLabel: "Période d'essai",
        detail: periodEnd ? `Essai jusqu'au ${periodEnd}.` : "Période d'essai en cours.",
        tone: "ok",
      };
    case "past_due":
      return {
        plan,
        statusLabel: "Paiement en retard",
        detail:
          "Le dernier paiement n'a pas abouti. Mettez à jour votre moyen de paiement depuis le portail Paddle pour éviter la suspension.",
        tone: "warning",
      };
    case "paused":
      return {
        plan,
        statusLabel: "En pause",
        detail: scheduled
          ? `Abonnement en pause ; reprise prévue le ${scheduled}.`
          : "Abonnement en pause.",
        tone: "inactive",
      };
    case "canceled":
    default:
      return {
        plan,
        statusLabel: "Résilié",
        detail: scheduled
          ? `Résiliation enregistrée ; l'accès se termine le ${scheduled}.`
          : "Abonnement résilié.",
        tone: "inactive",
      };
  }
}
