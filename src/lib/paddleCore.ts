/**
 * Pure helpers for the VEYVRO subscription flow (Paddle Billing).
 *
 * Deliberately free of `import.meta`, `window` and React so the exact same
 * logic can be unit-tested from Node (`npx tsx scripts/paddle-flow.test.mjs`).
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
export type PaidPlanId = "essentiel" | "expert";
export type PlanId = "decouverte" | PaidPlanId;

export type RawPaddleEnv = Record<string, unknown>;

/** Public (build-time) configuration keys consumed by the frontend. */
export const PADDLE_KEYS = {
  clientToken: "VITE_PADDLE_CLIENT_TOKEN",
  environment: "VITE_PADDLE_ENVIRONMENT",
  successUrl: "VITE_PADDLE_SUCCESS_URL",
} as const;

export const PAID_PLAN_IDS: readonly PaidPlanId[] = ["essentiel", "expert"];
export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

/** Exact environment-variable name expected for a given plan + interval. */
export function priceKeyFor(plan: PaidPlanId, interval: BillingInterval): string {
  return `VITE_PADDLE_PRICE_${plan.toUpperCase()}_${interval === "month" ? "MONTH" : "YEAR"}`;
}

/** Every price variable a complete configuration must provide. */
export const PADDLE_PRICE_KEYS: readonly string[] = PAID_PLAN_IDS.flatMap((plan) =>
  BILLING_INTERVALS.map((interval) => priceKeyFor(plan, interval)),
);

export type PricingPlan = {
  id: PlanId;
  name: string;
  tagline: string;
  monthly: number;
  yearly: number;
  features: readonly string[];
  cta: string;
  featured?: boolean;
  badge?: string;
};

/**
 * Display catalogue. Amounts are indicative marketing copy in EUR: the amount
 * actually charged is the one attached to the Paddle price ID, and Paddle shows
 * it again in the checkout overlay before payment.
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
    id: "essentiel",
    name: "Essentiel",
    tagline: "Pour vérifier ses devis et ses occasions.",
    monthly: 9.99,
    yearly: 99,
    features: [
      "Tout Découverte",
      "Devis et factures de garage illimités",
      "Analyse de photos et de PDF",
      "Historique de vos conversations",
    ],
    cta: "Choisir Essentiel",
    featured: true,
    badge: "Le plus choisi",
  },
  {
    id: "expert",
    name: "Expert",
    tagline: "Pour préparer un achat en profondeur.",
    monthly: 19.99,
    yearly: 199,
    features: [
      "Tout Essentiel",
      "Comparatifs détaillés et rapports exportables",
      "Vérification d'occasion guidée, étape par étape",
      "Réponses prioritaires",
    ],
    cta: "Choisir Expert",
  },
];

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
  const prices = {} as Record<PaidPlanId, Record<BillingInterval, string>>;

  for (const plan of PAID_PLAN_IDS) {
    prices[plan] = { month: "", year: "" };
    for (const interval of BILLING_INTERVALS) {
      const runtimePrice = overrides.prices?.[plan]?.[interval];
      prices[plan][interval] =
        (typeof runtimePrice === "string" ? runtimePrice.trim() : "") ||
        readString(env, priceKeyFor(plan, interval));
    }
  }

  return {
    clientToken: (overrides.clientToken ?? "").trim() || readString(env, PADDLE_KEYS.clientToken),
    environment: normalizeEnvironment(
      overrides.environment !== undefined ? overrides.environment : readString(env, PADDLE_KEYS.environment),
    ),
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
        )}. Ajoutez-les dans Vercel (environnement Preview uniquement), puis redéployez le Preview — les variables Vite sont figées au build.`;

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

export type CheckoutErrorCode = "config" | "script" | "domain" | "checkout";

export type CheckoutErrorInfo = {
  code: CheckoutErrorCode;
  message: string;
};

/**
 * Turn any failure of the checkout path into a message a user can act on.
 * Paddle surfaces most failures as free-form strings, so matching is defensive.
 */
export function classifyCheckoutError(error: unknown): CheckoutErrorInfo {
  if (error instanceof PaddleConfigError) {
    return { code: "config", message: error.message };
  }

  const rawMessage =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { error?: { message?: unknown } } | null)?.error?.message === "string"
          ? String((error as { error: { message: string } }).error.message)
          : "";
  const message = rawMessage.toLowerCase();

  if (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("script") ||
    message.includes("import") ||
    message.includes("blocked")
  ) {
    return {
      code: "script",
      message:
        "Le script de paiement Paddle n'a pas pu être chargé. Vérifiez la connexion réseau, un éventuel bloqueur de publicité, puis réessayez.",
    };
  }

  if (message.includes("domain") || message.includes("approved") || message.includes("origin")) {
    return {
      code: "domain",
      message:
        "Ce domaine n'est pas autorisé dans Paddle Sandbox. Ajoutez l'URL du Preview dans Paddle > Checkout > Website approval, puis réessayez.",
    };
  }

  return {
    code: "checkout",
    message:
      "Paddle n'a pas pu ouvrir le paiement. Vérifiez l'environnement (Sandbox), le token client et le price ID de la formule choisie, puis réessayez.",
  };
}

export function formatPlanPrice(plan: PricingPlan, interval: BillingInterval): string {
  if (plan.monthly === 0) return "Gratuit";
  const amount = interval === "month" ? plan.monthly : plan.yearly;
  const formatted = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return interval === "month" ? `${formatted} / mois` : `${formatted} / an`;
}

export function planBillingNote(plan: PricingPlan, interval: BillingInterval): string {
  if (plan.monthly === 0) return "Sans carte bancaire";
  const monthly = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(plan.monthly);
  return interval === "month"
    ? `Soit ${monthly} par mois, résiliable à tout moment`
    : `Équivalent à ${monthly} par mois, facturé une fois par an`;
}
