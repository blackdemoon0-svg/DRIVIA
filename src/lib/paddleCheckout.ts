/**
 * Browser-side Paddle Billing (v2) integration.
 *
 * Paddle.js is loaded on demand from Paddle's CDN — no npm dependency, no
 * server route, no secret in the bundle. Default environment is sandbox
 * (see `paddleCore.normalizeEnvironment`), so a Preview can never take a live
 * payment by accident.
 */
import {
  PaddleConfigError,
  classifyCheckoutError,
  getPriceId,
  priceKeyFor,
  resolvePaddleConfig,
  validatePaddleConfig,
  type BillingInterval,
  type PaddleConfig,
  type PaddleConfigOverrides,
  type PaidPlanId,
} from "./paddleCore";

const PADDLE_SCRIPT_ID = "veyvro-paddle-js";
const PADDLE_SCRIPT_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js";

type PaddleEvent = {
  name?: string;
  error?: unknown;
  data?: unknown;
};

type PaddleGlobal = {
  Environment: { set: (environment: "sandbox" | "production") => void };
  Initialize: (options: { token: string; eventCallback?: (event: PaddleEvent) => void }) => void;
  Checkout: { open: (options: Record<string, unknown>) => void };
};

type PaddleRuntimeWindow = Window & {
  __VEYVRO_PADDLE__?: PaddleConfigOverrides;
  Paddle?: PaddleGlobal;
};

let paddleLoader: Promise<PaddleGlobal> | null = null;
let initializedToken: string | null = null;
let configuredEnvironment: string | null = null;

/** Read the effective configuration (runtime override > build-time env). */
export function readPaddleConfig(): PaddleConfig {
  if (typeof window === "undefined") return resolvePaddleConfig({});
  const runtime = (window as PaddleRuntimeWindow).__VEYVRO_PADDLE__;
  return resolvePaddleConfig({ ...import.meta.env } as Record<string, unknown>, runtime);
}

export function readPaddleConfigStatus() {
  return validatePaddleConfig(readPaddleConfig());
}

function injectPaddleScript(): Promise<PaddleGlobal> {
  const existing = (window as PaddleRuntimeWindow).Paddle;
  if (existing) return Promise.resolve(existing);

  return new Promise<PaddleGlobal>((resolve, reject) => {
    const fail = () => {
      paddleLoader = null;
      reject(
        new PaddleConfigError(
          "Le script de paiement Paddle n'a pas pu être chargé (réseau ou bloqueur de publicité).",
        ),
      );
    };

    const current = document.getElementById(PADDLE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = current ?? document.createElement("script");

    script.addEventListener("load", () => {
      const paddle = (window as PaddleRuntimeWindow).Paddle;
      if (paddle) resolve(paddle);
      else fail();
    });
    script.addEventListener("error", fail);

    if (!current) {
      script.id = PADDLE_SCRIPT_ID;
      script.src = PADDLE_SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

/** Idempotent loader: one script tag, one rejected promise retried at most once. */
export function loadPaddle(): Promise<PaddleGlobal> {
  if (typeof window === "undefined") {
    return Promise.reject(new PaddleConfigError("Paddle ne peut pas être chargé hors navigateur."));
  }
  const existing = (window as PaddleRuntimeWindow).Paddle;
  if (existing) return Promise.resolve(existing);
  if (!paddleLoader) {
    paddleLoader = injectPaddleScript().catch((error: unknown) => {
      paddleLoader = null;
      throw error;
    });
  }
  return paddleLoader;
}

export type OpenCheckoutOptions = {
  plan: PaidPlanId;
  interval: BillingInterval;
  onOpened?: () => void;
  onClosed?: () => void;
  onError?: (message: string) => void;
};

/**
 * Open the Paddle overlay checkout for a paid plan.
 * Throws `PaddleConfigError` when the public configuration is incomplete, so
 * callers can show the exact missing variables instead of a dead button.
 */
export async function openPaddleCheckout({
  plan,
  interval,
  onOpened,
  onClosed,
  onError,
}: OpenCheckoutOptions): Promise<void> {
  const config = readPaddleConfig();
  const status = validatePaddleConfig(config);

  if (!status.ready) {
    throw new PaddleConfigError(
      status.configurationError ?? "Configuration Paddle incomplète.",
      status.missingKeys,
    );
  }

  const priceId = getPriceId(config, plan, interval);
  if (!priceId) {
    throw new PaddleConfigError(
      `Aucun price ID Paddle configuré pour la formule « ${plan} » (${interval}).`,
      [priceKeyFor(plan, interval)],
    );
  }

  const paddle = await loadPaddle();

  // Environment must be set before Initialize.
  if (configuredEnvironment !== config.environment) {
    paddle.Environment.set(config.environment);
    configuredEnvironment = config.environment;
    initializedToken = null;
  }

  if (initializedToken !== config.clientToken) {
    paddle.Initialize({
      token: config.clientToken,
      eventCallback: (event) => {
        const name = event?.name ?? "";
        if (name === "checkout.error") {
          onError?.(classifyCheckoutError(event.error ?? event).message);
        } else if (name === "checkout.closed") {
          onClosed?.();
        }
      },
    });
    initializedToken = config.clientToken;
  }

  const settings: Record<string, unknown> = {
    displayMode: "overlay",
    locale: "fr",
    theme: "dark",
    variant: "one-page",
  };
  if (config.successUrl) settings.successUrl = config.successUrl;

  onOpened?.();
  paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    settings,
  });
}

