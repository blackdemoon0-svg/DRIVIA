/**
 * Browser client for the plan change (Plus → Pro).
 *
 * It calls our own route and nothing else: Paddle's API is never reached from
 * the browser, and no API key exists in the bundle. The route decides, the
 * webhook writes; this module only asks and reports.
 *
 * Three honesties are encoded here:
 * - the preview amount is Paddle's figure, returned by the server, never a local
 *   computation;
 * - the preview also returns a **signed quote**, and the confirmation sends that
 *   token back. The server refuses to apply a change without it, so no charge
 *   can happen without a figure having been shown;
 * - `requestPlanChange` resolves to "the request was accepted", never to "the
 *   plan changed". The caller must re-read the account before saying anything
 *   about the new formula.
 */

import type { BillingInterval, PaidPlanId } from "./paddleCore";

const PLAN_CHANGE_ENDPOINT = "/api/paddle-plan-change";

/** Wire shape of the prorated amount Paddle computed. */
export type PlanChangePreview = {
  action: "charge" | "credit";
  /** Amount in the lowest denomination (US cents). */
  amountMinor: number;
  currencyCode: string;
};

/**
 * The signed quote returned with a preview.
 *
 * `expiresAt` is an ISO timestamp: the amount is only valid until then, and the
 * server re-checks both the signature and the amount before patching.
 */
export type PlanChangeQuote = {
  token: string;
  expiresAt: string;
  targetPlan: PaidPlanId;
  interval: BillingInterval;
};

export type PlanChangeQuoteResult = {
  preview: PlanChangePreview;
  quote: PlanChangeQuote;
  /** `true` when Paddle says the change costs nothing. */
  noCharge: boolean;
};

export class PlanChangeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** Seconds to wait, when the server or Paddle asked for a delay. */
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "PlanChangeError";
  }
}

type WireResponse = {
  ok?: unknown;
  preview?: unknown;
  quote?: unknown;
  changeRequested?: unknown;
  noCharge?: unknown;
  code?: unknown;
  error?: unknown;
};

function readPreview(payload: WireResponse): PlanChangePreview | null {
  const preview = payload.preview;
  if (!preview || typeof preview !== "object") return null;

  const action = (preview as { action?: unknown }).action;
  const amountMinor = (preview as { amountMinor?: unknown }).amountMinor;
  const currencyCode = (preview as { currencyCode?: unknown }).currencyCode;

  if (action !== "charge" && action !== "credit") return null;
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) return null;
  if (typeof currencyCode !== "string" || !/^[A-Z]{3}$/.test(currencyCode)) return null;

  return { action, amountMinor, currencyCode };
}

/**
 * Read the signed quote.
 *
 * The plan and interval are taken from the quote rather than from the button the
 * customer is looking at: what is confirmed must be exactly what was quoted, even
 * if the monthly/yearly toggle was moved in the meantime.
 */
function readQuote(payload: WireResponse): PlanChangeQuote | null {
  const quote = payload.quote;
  if (!quote || typeof quote !== "object") return null;

  const token = (quote as { token?: unknown }).token;
  const expiresAt = (quote as { expiresAt?: unknown }).expiresAt;
  const targetPlan = (quote as { targetPlan?: unknown }).targetPlan;
  const interval = (quote as { interval?: unknown }).interval;

  if (typeof token !== "string" || token.length < 20) return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  if (targetPlan !== "plus" && targetPlan !== "pro") return null;
  if (interval !== "month" && interval !== "year") return null;

  return { token, expiresAt, targetPlan, interval };
}

/** `Retry-After` is a whole number of seconds; anything else is ignored. */
function readRetryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

async function post(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: WireResponse }> {
  if (!accessToken) {
    throw new PlanChangeError("auth_required", describePlanChangeError("auth_required"), 401);
  }

  let response: Response;
  try {
    response = await fetch(PLAN_CHANGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch {
    throw new PlanChangeError("paddle_unavailable", describePlanChangeError("paddle_unavailable"), 0);
  }

  const payload = (await response.json().catch(() => ({}))) as WireResponse;

  if (!response.ok) {
    const code = typeof payload.code === "string" && payload.code ? payload.code : "paddle_refused";
    throw new PlanChangeError(
      code,
      describePlanChangeError(code),
      response.status,
      readRetryAfter(response),
    );
  }

  return { status: response.status, payload };
}

/**
 * Ask what the change would cost. Nothing is modified by this call.
 *
 * Returns the amount **and** the signed quote that must be sent back to confirm
 * it, along with the plan and interval the figure was computed for.
 */
export async function previewPlanChange(options: {
  accessToken: string | null;
  targetPlan: PaidPlanId;
  interval: BillingInterval;
}): Promise<PlanChangeQuoteResult> {
  const { payload } = await post(options.accessToken ?? "", {
    targetPlan: options.targetPlan,
    interval: options.interval,
    preview: true,
  });

  const preview = readPreview(payload);
  const quote = readQuote(payload);

  if (!preview || !quote) {
    // An unreadable or unsigned answer is not an amount we can show. Refuse
    // rather than display a guessed price, and refuse rather than later confirm
    // something the server would not accept.
    throw new PlanChangeError(
      "unreadable_preview",
      "Le montant du changement n'a pas pu être obtenu. Aucun paiement n'a été lancé.",
      502,
    );
  }

  return { preview, quote, noCharge: payload.noCharge === true };
}

/**
 * Apply the change a quote describes.
 *
 * The plan and the interval come from the quote object, not from the caller's
 * current selection: an upgrade quoted as monthly must not be sent as yearly
 * because a toggle moved.
 *
 * Resolves only when Paddle accepted the request. It deliberately does not
 * return a plan: the subscription row is written by the webhook, and the caller
 * must re-read the account to learn what is in force.
 */
export async function requestPlanChange(options: {
  accessToken: string | null;
  quote: PlanChangeQuote;
}): Promise<{ changeRequested: true }> {
  const { payload } = await post(options.accessToken ?? "", {
    targetPlan: options.quote.targetPlan,
    interval: options.quote.interval,
    preview: false,
    quoteToken: options.quote.token,
  });

  if (payload.changeRequested !== true) {
    throw new PlanChangeError(
      "change_not_confirmed",
      "Le changement n'a pas été confirmé par Paddle. Votre formule actuelle est inchangée.",
      502,
    );
  }

  return { changeRequested: true };
}

/** True when the quote's expiry has passed and it must be computed again. */
export function isQuoteExpired(quote: PlanChangeQuote, nowMs: number = Date.now()): boolean {
  const expiresAtMs = Date.parse(quote.expiresAt);
  if (Number.isNaN(expiresAtMs)) return true;
  return nowMs >= expiresAtMs;
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/**
 * Format a minor-unit amount deterministically.
 *
 * Deliberately not `Intl.NumberFormat`: the output would then depend on the ICU
 * data of the runtime, and this figure is quoted next to a real charge.
 */
export function formatMinorAmount(amountMinor: number, currencyCode: string): string {
  const safe = Number.isFinite(amountMinor) ? Math.abs(Math.round(amountMinor)) : 0;
  const units = Math.floor(safe / 100);
  const cents = String(safe % 100).padStart(2, "0");
  const symbol = CURRENCY_SYMBOLS[currencyCode] ?? `${currencyCode} `;
  return `${units},${cents} ${symbol}`.trim();
}

const MESSAGES: Record<string, string> = {
  auth_required: "Votre session est introuvable. Reconnectez-vous, puis réessayez.",
  invalid_token: "Votre session a expiré. Reconnectez-vous, puis réessayez.",
  email_unconfirmed:
    "Confirmez votre adresse e-mail avant de changer de formule : ouvrez le lien reçu, puis réessayez.",
  no_subscription:
    "Aucun abonnement payant n'est enregistré sur votre compte. Choisissez d'abord une formule.",
  same_plan: "Cette formule est déjà la vôtre.",
  downgrade_not_supported:
    "Le passage à une formule inférieure ne se fait pas ici : il s'organise auprès de Paddle.",
  interval_change_not_supported:
    "Changer de périodicité (mensuel ↔ annuel) n'est pas encore pris en charge ici.",
  not_in_good_standing:
    "Votre abonnement n'est pas en règle : paiement en retard, en pause ou résilié. Régularisez-le depuis Paddle, puis réessayez.",
  trialing_not_supported:
    "Un abonnement en période d'essai ne peut pas changer de formule depuis cette page.",
  paddle_locked:
    "Paddle traite déjà une opération sur cet abonnement (renouvellement ou changement en cours). Réessayez dans quelques minutes.",
  paddle_credentials: "Le paiement n'est pas correctement configuré sur cet environnement.",
  paddle_not_configured: "Le paiement n'est pas configuré sur cet environnement.",
  paddle_environment_mismatch: "Le paiement n'est pas configuré correctement pour cet environnement.",
  paddle_refused: "Paddle a refusé le changement. Votre formule actuelle est inchangée.",
  paddle_unavailable: "Paddle est momentanément injoignable. Réessayez dans un instant.",
  paddle_rate_limited:
    "Paddle reçoit trop de demandes pour le moment. Patientez une minute, puis réessayez.",
  identity_unavailable: "Le service est momentanément indisponible. Réessayez dans un instant.",
  invalid_target_plan: "Demande invalide : formule inconnue.",
  invalid_interval: "Demande invalide : périodicité inconnue.",
  invalid_body: "Demande invalide.",
  not_configured: "Le service n'est pas configuré pour identifier les comptes.",
  change_not_confirmed: "Le changement n'a pas été confirmé par Paddle. Votre formule est inchangée.",
  unreadable_preview: "Le montant du changement n'a pas pu être obtenu. Aucun paiement n'a été lancé.",
  quote_unavailable: "Le montant n'a pas pu être préparé. Aucun paiement n'a été lancé.",
  quote_required:
    "Confirmez d'abord le montant affiché : aucun changement n'est envoyé sans un devis accepté.",
  quote_expired:
    "Le montant affiché a expiré (le prorata change à la minute). Recalculez-le avant de confirmer.",
  quote_invalid: "Le devis n'a pas pu être vérifié. Recalculez le montant, puis confirmez.",
  quote_mismatch:
    "Le devis ne correspond plus à cette demande. Recalculez le montant, puis confirmez.",
  quote_stale:
    "Le montant a changé depuis le devis. Recalculez-le : rien n'a été prélevé.",
  quote_reused: "Ce devis a déjà servi. Recalculez le montant pour relancer un changement.",
  change_in_progress:
    "Un changement est déjà en cours sur cet abonnement. Patientez avant de réessayer.",
  rate_limited: "Trop de demandes en peu de temps. Patientez une minute, puis réessayez.",
  unexpected_error: "Une erreur inattendue est survenue. Aucun changement n'a été enregistré.",
};

/** French, actionable wording for every code this feature can produce. */
export function describePlanChangeError(code: string): string {
  return MESSAGES[code] ?? "Le changement de formule a échoué. Votre formule actuelle est inchangée.";
}
