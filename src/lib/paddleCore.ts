/**
 * Pure helpers for the VEYVRO subscription flow (Paddle Billing).
 *
 * Deliberately free of `import.meta`, `window` and React so the exact same
 * logic can be unit-tested from Node (`npx tsx scripts/paddle-flow.test.mjs`).
 *
 * Official pricing (USD): VEYVRO Plus 7 $/mois or 59 $/an, VEYVRO Pro
 * 15 $/mois or 129 $/an. The amounts are checked against Paddle at runtime
 * (`evaluatePricePreview`) before any checkout is opened, so a price ID wired
 * to the wrong plan or the wrong currency can never charge the wrong amount.
 *
 * Security note: only *publishable* values live here — Paddle's client-side
 * token and price IDs. The Paddle API key (server-side secret) is never read,
 * stored or used by the frontend.
 *
 * Environment policy: sandbox unless explicitly set to "production". A missing
 * or mistyped value therefore falls back to sandbox, never to live payments.
 */

export type PaddleEnvironment = "sandbox" | "production";
export type BillingInterval = "month" | "year";
export type PaidPlanId = "plus" | "pro";
export type PlanId = "decouverte" | PaidPlanId;

export type RawPaddleEnv = Record<string, unknown>;

/** Every price is billed in US dollars. */
export const CURRENCY = "USD" as const;

/** Public (build-time) configuration keys consumed by the frontend. */
export const PADDLE_KEYS = {
  clientToken: "VITE_PADDLE_CLIENT_TOKEN",
  environment: "VITE_PADDLE_ENVIRONMENT",
  successUrl: "VITE_PADDLE_SUCCESS_URL",
} as const;

export const PAID_PLAN_IDS: readonly PaidPlanId[] = ["plus", "pro"];
export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

/** Exact environment-variable name expected for a given plan + interval. */
export function priceKeyFor(plan: PaidPlanId, interval: BillingInterval): string {
  return `VITE_PADDLE_PRICE_${plan.toUpperCase()}_${interval === "month" ? "MONTH" : "YEAR"}`;
}

/** Every price variable a complete configuration must provide. */
export const PADDLE_PRICE_KEYS: readonly string[] = PAID_PLAN_IDS.flatMap((plan) =>
  BILLING_INTERVALS.map((interval) => priceKeyFor(plan, interval)),
);

/**
 * Real Paddle **Sandbox** price IDs, wired to their plan and billing interval.
 *
 * Public by design (a price ID is sent to Paddle by the browser). They are only
 * used as a fallback when the environment resolves to `sandbox` and no
 * `VITE_PADDLE_PRICE_*` value is provided, so a Preview can exercise the whole
 * subscription path without any Vercel variable. Production never falls back to
 * them: `resolvePaddleConfig` ignores this catalogue unless the environment is
 * sandbox, which makes it impossible to charge a live customer with a sandbox
 * price.
 *
 * Amounts announced by these IDs are checked against `PRICING_PLANS` at runtime
 * by `evaluatePricePreview` (see `expectedAmount`), and a mismatch blocks the
 * checkout.
 */
export const SANDBOX_PRICE_IDS: Record<PaidPlanId, Record<BillingInterval, string>> = {
  plus: {
    month: "pri_01m57fxf3q0pdse5v8x98red1w",
    year: "pri_01m57n587d0qj874fk6hynqbg3",
  },
  pro: {
    month: "pri_01m57nftmhwpj83s38tjhbbepc",
    year: "pri_01m57njaaceedwc3f2pacqmjxk",
  },
};

/** True when the price ID is one of the built-in Sandbox identifiers. */
export function isSandboxPriceId(priceId: string | null): boolean {
  if (!priceId) return false;
  return PAID_PLAN_IDS.some((plan) =>
    BILLING_INTERVALS.some((interval) => SANDBOX_PRICE_IDS[plan][interval] === priceId),
  );
}

/**
 * Which plan/interval a price ID is declared for, according to the built-in
 * Sandbox catalogue. Used to detect a swapped wiring in tests and diagnostics.
 */
export function lookupSandboxPriceId(
  priceId: string,
): { plan: PaidPlanId; interval: BillingInterval } | null {
  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (SANDBOX_PRICE_IDS[plan][interval] === priceId) return { plan, interval };
    }
  }
  return null;
}

export type PricingPlan = {
  id: PlanId;
  name: string;
  tagline: string;
  /** Amount in whole US dollars per month, 0 for the free plan. */
  monthly: number;
  /** Amount in whole US dollars per year, 0 for the free plan. */
  yearly: number;
  features: readonly string[];
  cta: string;
  featured?: boolean;
  badge?: string;
};

/**
 * Official catalogue. Amounts are the announced prices in USD and are also
 * the amounts enforced against Paddle's price preview below.
 */
export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: "decouverte",
    name: "Découverte",
    tagline: "Pour essayer VEYVRO sans engagement.",
    monthly: 0,
    yearly: 0,
    features: [
      "Conversation IA automobile",
      "Analyse d'un devis de garage",
      "Comparateur VEYVRO Battle",
    ],
    cta: "Commencer gratuitement",
  },
  {
    id: "plus",
    name: "VEYVRO Plus",
    tagline: "Pour vérifier ses devis et ses occasions.",
    monthly: 7,
    yearly: 59,
    features: [
      "Tout Découverte",
      "Devis et factures de garage illimités",
      "Analyse de photos et de PDF",
      "Historique de vos conversations",
    ],
    cta: "Choisir VEYVRO Plus",
    featured: true,
    badge: "Le plus choisi",
  },
  {
    id: "pro",
    name: "VEYVRO Pro",
    tagline: "Pour préparer un achat en profondeur.",
    monthly: 15,
    yearly: 129,
    features: [
      "Tout VEYVRO Plus",
      "Comparatifs détaillés et rapports exportables",
      "Vérification d'occasion guidée, étape par étape",
      "Réponses prioritaires",
    ],
    cta: "Choisir VEYVRO Pro",
  },
];

/** Announced amount (major USD units) for a paid plan and billing interval. */
export function expectedAmount(plan: PaidPlanId, interval: BillingInterval): number {
  const entry = PRICING_PLANS.find((candidate) => candidate.id === plan);
  if (!entry) return 0;
  return interval === "month" ? entry.monthly : entry.yearly;
}

/** Announced amount expressed in Paddle's minor unit (US cents). */
export function expectedAmountInCents(plan: PaidPlanId, interval: BillingInterval): number {
  return Math.round(expectedAmount(plan, interval) * 100);
}

export type PaddleConfig = {
  clientToken: string;
  environment: PaddleEnvironment;
  successUrl: string | null;
  prices: Record<PaidPlanId, Record<BillingInterval, string>>;
};

export type PaddleConfigOverrides = {
  clientToken?: string;
  environment?: string;
  successUrl?: string | null;
  prices?: Partial<Record<PaidPlanId, Partial<Record<BillingInterval, string>>>>;
};

export type PaddleConfigStatus = {
  ready: boolean;
  environment: PaddleEnvironment;
  clientTokenConfigured: boolean;
  missingKeys: string[];
  configurationError: string | null;
};

function readString(source: RawPaddleEnv, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Sandbox is the safe default: only an explicit "production"/"live" opts out. */
export function normalizeEnvironment(value: string | null | undefined): PaddleEnvironment {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "production" || normalized === "live" ? "production" : "sandbox";
}

export function normalizeSuccessUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  // Paddle requires an absolute HTTPS URL; a relative or insecure value is dropped
  // rather than silently turned into a wrong post-checkout destination.
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Merge the three configuration sources, highest priority first:
 *   1. runtime overrides (`window.__VEYVRO_PADDLE__`, no rebuild needed)
 *   2. Vite build-time variables (`import.meta.env.VITE_PADDLE_*`)
 *   3. empty strings (reported as missing, never silently guessed)
 */
export function resolvePaddleConfig(
  env: RawPaddleEnv = {},
  overrides: PaddleConfigOverrides = {},
): PaddleConfig {
  const environment = normalizeEnvironment(
    overrides.environment !== undefined ? overrides.environment : readString(env, PADDLE_KEYS.environment),
  );
  const prices = {} as Record<PaidPlanId, Record<BillingInterval, string>>;

  for (const plan of PAID_PLAN_IDS) {
    prices[plan] = { month: "", year: "" };
    for (const interval of BILLING_INTERVALS) {
      const runtimePrice = overrides.prices?.[plan]?.[interval];
      const fromEnv = readString(env, priceKeyFor(plan, interval));
      // Priority: runtime override > build-time variable > built-in Sandbox ID.
      // The Sandbox catalogue is never used when the environment is production.
      const sandboxDefault = environment === "sandbox" ? SANDBOX_PRICE_IDS[plan][interval] : "";
      prices[plan][interval] =
        (typeof runtimePrice === "string" ? runtimePrice.trim() : "") || fromEnv || sandboxDefault;
    }
  }

  return {
    clientToken: (overrides.clientToken ?? "").trim() || readString(env, PADDLE_KEYS.clientToken),
    environment,
    successUrl: normalizeSuccessUrl(
      overrides.successUrl !== undefined ? overrides.successUrl : readString(env, PADDLE_KEYS.successUrl),
    ),
    prices,
  };
}

export function getPriceId(
  config: PaddleConfig,
  plan: PaidPlanId,
  interval: BillingInterval,
): string | null {
  const value = config.prices[plan]?.[interval]?.trim();
  return value ? value : null;
}

/** Human-readable French summary used by the UI and by the checkout guard. */
export function validatePaddleConfig(config: PaddleConfig): PaddleConfigStatus {
  const missingKeys: string[] = [];

  if (!config.clientToken) missingKeys.push(PADDLE_KEYS.clientToken);
  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (!getPriceId(config, plan, interval)) missingKeys.push(priceKeyFor(plan, interval));
    }
  }

  const configurationError =
    missingKeys.length === 0
      ? null
      : `Paiement indisponible : configuration Paddle ${config.environment === "sandbox" ? "Sandbox" : "Production"} incomplète. Variables manquantes : ${missingKeys.join(
          ", ",
        )}. Le token client peut aussi être fourni côté serveur via PADDLE_CLIENT_TOKEN (lu par /api/paddle-config) ; les price IDs sont déjà intégrés en Sandbox.`;

  return {
    ready: missingKeys.length === 0,
    environment: config.environment,
    clientTokenConfigured: Boolean(config.clientToken),
    missingKeys,
    configurationError,
  };
}

export class PaddleConfigError extends Error {
  public readonly missingKeys: string[];

  constructor(message: string, missingKeys: string[] = []) {
    super(message);
    this.name = "PaddleConfigError";
    this.missingKeys = missingKeys;
  }
}

// ---------------------------------------------------------------------------
// Price verification against Paddle (currency + exact amount)
// ---------------------------------------------------------------------------

export type PriceExpectation = {
  plan: PaidPlanId;
  interval: BillingInterval;
  priceId: string;
};

export type PricePreviewVerdict = {
  plan: PaidPlanId;
  interval: BillingInterval;
  priceId: string;
  expectedAmount: number;
  expectedCurrency: typeof CURRENCY;
  /** What Paddle actually reports, when readable. */
  currency: string | null;
  /** Amount in major units (e.g. 7 for 7 USD), when readable. */
  amount: number | null;
  ok: boolean;
  problems: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function pickString(source: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * Paddle reports money as an integer in the currency's smallest unit
 * (700 = 7.00 USD) but a decimal string means major units. Both are handled
 * explicitly instead of guessing from the magnitude.
 */
export function parsePaddleAmount(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return cleaned.includes(".") ? value : value / 100;
}

/**
 * Read Paddle's `PricePreview` payload defensively (snake_case API fields,
 * optionally wrapped in `data`) and compare it with the announced price.
 */
export function evaluatePricePreview(
  preview: unknown,
  expectation: PriceExpectation,
): PricePreviewVerdict {
  const problems: string[] = [];
  const expected = expectedAmount(expectation.plan, expectation.interval);

  const root = asRecord(preview);
  const data = asRecord(root?.data) ?? root;
  const details = asRecord(data?.details) ?? data;
  const lineItems = Array.isArray(details?.line_items)
    ? (details.line_items as unknown[])
    : Array.isArray(details?.lineItems)
      ? (details.lineItems as unknown[])
      : [];
  const firstLine = asRecord(lineItems[0]);
  const price = asRecord(firstLine?.price);
  const unitPrice = asRecord(price?.unit_price) ?? asRecord(price?.unitPrice);
  const totals = asRecord(firstLine?.totals);

  const currency =
    pickString(data, "currency_code", "currencyCode") ??
    pickString(unitPrice, "currency_code", "currencyCode") ??
    pickString(totals, "currency_code", "currencyCode");

  const amountRaw =
    pickString(totals, "total", "subtotal") ??
    pickString(unitPrice, "amount") ??
    pickString(price, "unit_price", "unitPrice");
  const amount = parsePaddleAmount(amountRaw);

  if (currency === null) {
    problems.push("Devise illisible dans la réponse Paddle.");
  } else if (currency.toUpperCase() !== CURRENCY) {
    problems.push(`Devise Paddle « ${currency} » au lieu de ${CURRENCY}.`);
  }

  if (amount === null) {
    problems.push("Montant illisible dans la réponse Paddle.");
  } else if (Math.round(amount * 100) !== Math.round(expected * 100)) {
    problems.push(
      `Montant Paddle ${amount.toFixed(2)} ${currency ?? CURRENCY} au lieu de ${expected.toFixed(2)} ${CURRENCY} annoncés.`,
    );
  }

  return {
    plan: expectation.plan,
    interval: expectation.interval,
    priceId: expectation.priceId,
    expectedAmount: expected,
    expectedCurrency: CURRENCY,
    currency,
    amount,
    ok: problems.length === 0,
    problems,
  };
}

export type CheckoutErrorCode = "config" | "script" | "price" | "domain" | "checkout";

export type CheckoutErrorInfo = {
  code: CheckoutErrorCode;
  message: string;
  /** Raw Paddle `detail`, already redacted, when the event carried one. */
  paddleDetail?: string;
  /** Raw Paddle `code` (e.g. "validation"), when present. */
  paddleCode?: string;
  /** Raw Paddle `type` ("api_error" | "front-end_error"), when present. */
  paddleType?: string;
};

/**
 * Thrown when the checkout path has already classified an error, so callers do
 * not classify it a second time and lose the original detail.
 */
export class PaddleCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaddleCheckoutError";
  }
}

/**
 * Turn any failure of the checkout path into a message a user can act on.
 * Price mismatches get their own code: they must never be treated as a
 * generic payment failure, because opening the checkout would charge the
 * wrong amount.
 */
export function classifyCheckoutError(error: unknown): CheckoutErrorInfo {
  if (error instanceof PaddleConfigError) {
    return { code: "config", message: error.message };
  }

  // Already classified by openPaddleCheckout(): keep the message as-is.
  if (error instanceof PaddleCheckoutError) {
    return { code: "checkout", message: error.message };
  }

  const candidate = asRecord(error);
  const nested = asRecord(candidate?.error);

  // Paddle.js `checkout.error` payloads carry their usable fields at the root:
  // { name, type, code, detail, documentation_url } — there is no `message`.
  // The previous implementation only read `message`, so every real Paddle error
  // fell through to the generic text.
  const paddleDetail = redactSensitive(pickString(candidate, "detail") ?? pickString(nested, "detail"));
  const paddleCode = pickString(candidate, "code") ?? pickString(nested, "code");
  const paddleType = pickString(candidate, "type") ?? pickString(nested, "type");

  const rawMessage =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : pickString(nested, "message") ?? pickString(candidate, "message") ?? paddleDetail ?? "";

  // Match against every textual field Paddle gives us, not just `message`.
  const haystack = [rawMessage, paddleDetail, paddleCode, paddleType]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();

  const details = { paddleDetail: paddleDetail ?? undefined, paddleCode: paddleCode ?? undefined, paddleType: paddleType ?? undefined };
  const suffix = describePaddleDetail(paddleDetail, paddleCode, paddleType);

  if (haystack.includes("failed to fetch") || haystack.includes("networkerror") || haystack.includes("script") || haystack.includes("import") || haystack.includes("blocked")) {
    return {
      code: "script",
      message:
        "Le script de paiement Paddle n'a pas pu être chargé. Vérifiez la connexion réseau, un éventuel bloqueur de publicité, puis réessayez.",
      ...details,
    };
  }

  if (haystack.includes("price") || haystack.includes("devise") || haystack.includes("montant")) {
    return { code: "price", message: rawMessage || "Montant ou devise refusé par Paddle.", ...details };
  }

  if (haystack.includes("domain") || haystack.includes("approved") || haystack.includes("origin")) {
    return {
      code: "domain",
      message:
        "Ce domaine n'est pas autorisé dans Paddle Sandbox. Ajoutez l'URL du Preview dans Paddle > Checkout > Website approval, puis réessayez.",
      ...details,
    };
  }

  return {
    code: "checkout",
    message:
      "Paddle n'a pas pu ouvrir le paiement. Vérifiez l'environnement (Sandbox), le token client et le price ID de la formule choisie, puis réessayez." +
      suffix,
    ...details,
  };
}

const MAX_DETAIL_LENGTH = 240;

/**
 * Never surface credentials. Paddle error details are short human sentences, but
 * they are third-party strings, so anything token-, key- or email-shaped is
 * masked before it can reach the UI or a log.
 */
export function redactSensitive(text: string | null): string | null {
  if (!text) return null;
  const redacted = text
    .replace(/\b(?:test|live)_[A-Za-z0-9]{16,}\b/g, "[token masqué]")
    .replace(/\bpdl_(?:live|sdbx)_(?:apikey|ctok)_[A-Za-z0-9]+\b/gi, "[clé masquée]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email masqué]");
  return redacted.length > MAX_DETAIL_LENGTH ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}…` : redacted;
}

/** Human-readable "(détail Paddle : …, code …, type …)" suffix, or "". */
function describePaddleDetail(
  detail: string | null,
  code: string | null,
  type: string | null,
): string {
  const parts: string[] = [];
  if (detail) parts.push(`« ${detail} »`);
  if (code) parts.push(`code ${code}`);
  if (type) parts.push(`type ${type}`);
  return parts.length === 0 ? "" : ` Détail Paddle : ${parts.join(", ")}.`;
}

/** "$7 / mois" — the currency is always visible, never implied. */
export function formatPlanPrice(plan: PricingPlan, interval: BillingInterval): string {
  if (plan.monthly === 0) return "Gratuit";
  const amount = interval === "month" ? plan.monthly : plan.yearly;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
  return interval === "month" ? `${formatted} / mois` : `${formatted} / an`;
}

export function planBillingNote(plan: PricingPlan, interval: BillingInterval): string {
  if (plan.monthly === 0) return "Sans carte bancaire";
  const monthly = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(plan.monthly);
  return interval === "month"
    ? `${plan.monthly} USD par mois, résiliable à tout moment`
    : `${plan.yearly} USD facturés une fois par an (soit ${monthly} par mois)`;
}
