/**
 * Browser-side Paddle Billing (v2) integration.
 *
 * Paddle.js is loaded on demand from Paddle's CDN — no npm dependency, no
 * server route, no secret in the bundle. Default environment is sandbox
 * (see `paddleCore.normalizeEnvironment`), so a Preview can never take a live
 * payment by accident.
 *
 * Before opening the checkout, the selected price ID is sent to Paddle's
 * `PricePreview` endpoint: currency and amount must match the announced price
 * exactly, otherwise the checkout is refused. That is what guarantees a button
 * is wired to the price ID of *its own* plan and billing interval.
 */
import {
  PaddleConfigError,
  PAID_PLAN_IDS,
  BILLING_INTERVALS,
  classifyCheckoutError,
  evaluatePricePreview,
  getPriceId,
  priceKeyFor,
  resolvePaddleConfig,
  validatePaddleConfig,
  type BillingInterval,
  type PaddleConfig,
  type PaddleConfigOverrides,
  type PaidPlanId,
  type PriceExpectation,
  type PricePreviewVerdict,
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
  PricePreview: (options: { items: Array<{ priceId: string; quantity: number }> }) => Promise<unknown>;
};

type PaddleRuntimeWindow = Window & {
  __VEYVRO_PADDLE__?: PaddleConfigOverrides;
  Paddle?: PaddleGlobal;
};

let paddleLoader: Promise<PaddleGlobal> | null = null;
let configuredEnvironment: string | null = null;

/**
 * Paddle.Initialize() can only be called ONCE per page — the second call
 * raises an error and poisons the session, so the following Checkout.open()
 * fails with Paddle's generic "Something went wrong" screen.
 *
 * The handler is therefore registered at initialization time behind a mutable
 * relay: callers swap `activeEventHandler` instead of re-initializing.
 */
let paddleInitialized = false;
let activeEventHandler: ((event: PaddleEvent) => void) | null = null;

/** Route a Paddle.js event to the handler currently installed by the caller. */
function relayPaddleEvent(event: PaddleEvent): void {
  activeEventHandler?.(event);
}

/**
 * Install the handler that receives Paddle.js events (checkout.error,
 * checkout.closed, ...). Replaces nothing on Paddle's side: the relay was
 * registered with the single Initialize() call, so no second one is needed.
 */
function setPaddleEventHandler(handler: ((event: PaddleEvent) => void) | null): void {
  activeEventHandler = handler;
}

/** Read the effective configuration (runtime override > build-time env). */
export function readPaddleConfig(): PaddleConfig {
  if (typeof window === "undefined") return resolvePaddleConfig({});
  const runtime = (window as PaddleRuntimeWindow).__VEYVRO_PADDLE__;
  return resolvePaddleConfig({ ...import.meta.env } as Record<string, unknown>, runtime);
}

export function readPaddleConfigStatus() {
  return validatePaddleConfig(readPaddleConfig());
}

/** Same-origin endpoint that exposes the public Paddle client token. */
const PADDLE_CONFIG_ENDPOINT = "/api/paddle-config";

/**
 * Ask the server for the client token.
 *
 * `VITE_PADDLE_CLIENT_TOKEN` is inlined by Vite at build time, but a variable
 * saved in Vercel without the `VITE_` prefix (e.g. `PADDLE_CLIENT_TOKEN`) is
 * only visible to the server. This fetch bridges that gap, so the checkout
 * works with the variable name the project owner actually configured.
 * Returns null on any failure: the caller then reports the missing token.
 */
export async function fetchServerClientToken(signal?: AbortSignal): Promise<string | null> {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(PADDLE_CONFIG_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { clientToken?: unknown } | null;
    const token = typeof payload?.clientToken === "string" ? payload.clientToken.trim() : "";
    return token || null;
  } catch {
    return null;
  }
}

let hydration: Promise<PaddleConfig> | null = null;

/**
 * Resolve the configuration, completing it from the server when the build did
 * not inline a client token. Memoised: concurrent clicks share one request.
 */
export function loadPaddleConfig(): Promise<PaddleConfig> {
  if (hydration) return hydration;
  const local = readPaddleConfig();
  if (local.clientToken) {
    hydration = Promise.resolve(local);
    return hydration;
  }
  hydration = fetchServerClientToken().then((token) =>
    token ? { ...local, clientToken: token } : local,
  );
  return hydration;
}

/** Test/diagnostic helper: drop the memoised configuration. */
export function resetPaddleConfigCache(): void {
  hydration = null;
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

/**
 * Load Paddle.js, apply the environment and initialize it exactly once.
 * Safe to call from every entry point: the module-level flag makes the
 * initialization idempotent.
 */
async function ensurePaddleReady(config: PaddleConfig): Promise<PaddleGlobal> {
  const paddle = await loadPaddle();

  // Environment must be set before Initialize.
  if (configuredEnvironment !== config.environment) {
    if (paddleInitialized) {
      // Paddle.js keeps its environment for the page lifetime; switching after
      // initialization is unsupported, so never guess. A reload is required.
      throw new PaddleConfigError(
        `Paddle.js est déjà initialisé en « ${configuredEnvironment} » ; impossible de passer à « ${config.environment} » sans recharger la page.`,
      );
    }
    paddle.Environment.set(config.environment);
    configuredEnvironment = config.environment;
  }

  if (!paddleInitialized) {
    // Single Initialize() for the whole page lifetime, with the relay attached
    // immediately so no event (especially checkout.error) is ever missed.
    paddle.Initialize({ token: config.clientToken, eventCallback: relayPaddleEvent });
    paddleInitialized = true;
  }

  return paddle;
}

/** Test/DI helpers: reset the one-shot initialization state. */
export function resetPaddleInitialization(): void {
  paddleInitialized = false;
  configuredEnvironment = null;
  activeEventHandler = null;
}

/**
 * Ask Paddle what the price ID really is (currency + amount) and compare it
 * with the announced price of the plan/interval it is supposed to represent.
 */
export async function verifyPriceWithPaddle(
  config: PaddleConfig,
  plan: PaidPlanId,
  interval: BillingInterval,
): Promise<PricePreviewVerdict> {
  const priceId = getPriceId(config, plan, interval);
  if (!priceId) {
    throw new PaddleConfigError(
      `Aucun price ID configuré pour ${plan} (${interval}). Renseignez ${priceKeyFor(plan, interval)}.`,
      [priceKeyFor(plan, interval)],
    );
  }

  const paddle = await ensurePaddleReady(config);
  const preview = await paddle.PricePreview({ items: [{ priceId, quantity: 1 }] });
  const expectation: PriceExpectation = { plan, interval, priceId };
  return evaluatePricePreview(preview, expectation);
}

/** Check every configured price ID at once (used by the diagnostic panel). */
export async function verifyAllPrices(config: PaddleConfig): Promise<PricePreviewVerdict[]> {
  const verdicts: PricePreviewVerdict[] = [];
  for (const plan of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (!getPriceId(config, plan, interval)) continue;
      // Sequential on purpose: a misconfigured ID must not be masked by a
      // parallel failure, and the overlay stays quiet.
      verdicts.push(await verifyPriceWithPaddle(config, plan, interval));
    }
  }
  return verdicts;
}

export type OpenCheckoutOptions = {
  plan: PaidPlanId;
  interval: BillingInterval;
  onOpened?: () => void;
  onClosed?: () => void;
  onError?: (message: string) => void;
  /** Result of the price verification, exposed for the UI. */
  onVerified?: (verdict: PricePreviewVerdict) => void;
};

/**
 * Open the Paddle overlay checkout for a paid plan.
 * Throws `PaddleConfigError` when the public configuration is incomplete or
 * when the price ID does not match the announced price, so a wrong amount can
 * never be charged.
 */
export async function openPaddleCheckout({
  plan,
  interval,
  onOpened,
  onClosed,
  onError,
  onVerified,
}: OpenCheckoutOptions): Promise<void> {
  // Server hydration first: the client token may live in a non-VITE_ variable.
  const config = await loadPaddleConfig();
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
      `Aucun price ID Paddle configuré pour ${plan} (${interval}).`,
      [priceKeyFor(plan, interval)],
    );
  }

  const paddle = await ensurePaddleReady(config);

  // Guard: never open a checkout whose real amount differs from the price shown.
  let verdict: PricePreviewVerdict;
  try {
    const preview = await paddle.PricePreview({ items: [{ priceId, quantity: 1 }] });
    verdict = evaluatePricePreview(preview, { plan, interval, priceId });
  } catch (error) {
    throw new PaddleConfigError(
      `Impossible de vérifier le tarif Paddle avant paiement (${classifyCheckoutError(error).message}). Paiement bloqué par prudence.`,
    );
  }

  onVerified?.(verdict);

  if (!verdict.ok) {
    throw new PaddleConfigError(
      `Paiement bloqué : le price ID configuré pour ${plan} (${interval}) ne correspond pas au tarif annoncé. ${verdict.problems.join(
        " ",
      )}`,
    );
  }

  // Paddle.Initialize() is already done (once) inside ensurePaddleReady. Only the
  // event handler is swapped here, through the relay registered at initialization.
  setPaddleEventHandler((event) => {
    const name = event?.name ?? "";
    if (name === "checkout.error") {
      onError?.(classifyCheckoutError(event.error ?? event).message);
    } else if (name === "checkout.closed") {
      onClosed?.();
    }
  });

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
