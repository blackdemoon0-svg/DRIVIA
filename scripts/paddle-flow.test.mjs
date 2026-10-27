/**
 * Offline checks for the VEYVRO subscription path (Paddle Billing).
 * No network, no Paddle account, no real key: configuration resolution,
 * error classification and the App/navigation wiring are asserted statically.
 *
 * Run with:  npx tsx scripts/paddle-flow.test.mjs
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PADDLE_KEYS,
  PADDLE_PRICE_KEYS,
  PAID_PLAN_IDS,
  PRICING_PLANS,
  PaddleConfigError,
  classifyCheckoutError,
  formatPlanPrice,
  getPriceId,
  normalizeEnvironment,
  normalizeSuccessUrl,
  priceKeyFor,
  resolvePaddleConfig,
  validatePaddleConfig,
} from "../src/lib/paddleCore.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
let checks = 0;
const pass = (message) => {
  checks += 1;
  console.log(`PASS  ${message}`);
};

// 1. Default configuration: sandbox, everything reported missing, no guessing.
const empty = resolvePaddleConfig({});
assert.equal(empty.environment, "sandbox");
const emptyStatus = validatePaddleConfig(empty);
assert.equal(emptyStatus.ready, false);
assert.equal(emptyStatus.clientTokenConfigured, false);
assert.ok(emptyStatus.missingKeys.includes(PADDLE_KEYS.clientToken));
for (const plan of PAID_PLAN_IDS) {
  for (const interval of ["month", "year"]) {
    assert.ok(
      emptyStatus.missingKeys.includes(priceKeyFor(plan, interval)),
      `missing key not reported: ${priceKeyFor(plan, interval)}`,
    );
  }
}
assert.match(emptyStatus.configurationError, /Paddle Sandbox/);
assert.match(emptyStatus.configurationError, /VITE_PADDLE_CLIENT_TOKEN/);
pass("sans configuration : environnement Sandbox par défaut + erreur listant chaque variable");

// 2. A complete environment (as injected by Vite) makes the flow ready.
const completeEnv = {
  VITE_PADDLE_CLIENT_TOKEN: "test_client_token_sandbox",
  VITE_PADDLE_ENVIRONMENT: "sandbox",
  VITE_PADDLE_PRICE_ESSENTIEL_MONTH: "pri_01_essentiel_month",
  VITE_PADDLE_PRICE_ESSENTIEL_YEAR: "pri_01_essentiel_year",
  VITE_PADDLE_PRICE_EXPERT_MONTH: "pri_01_expert_month",
  VITE_PADDLE_PRICE_EXPERT_YEAR: "pri_01_expert_year",
};
const complete = resolvePaddleConfig(completeEnv);
const completeStatus = validatePaddleConfig(complete);
assert.equal(completeStatus.ready, true);
assert.equal(completeStatus.configurationError, null);
assert.equal(getPriceId(complete, "essentiel", "year"), "pri_01_essentiel_year");
assert.equal(getPriceId(complete, "expert", "month"), "pri_01_expert_month");
assert.equal(complete.environment, "sandbox");
pass("configuration complète : prêt, price IDs résolus par formule et périodicité");

// 3. Every key used by the UI exists in PADDLE_PRICE_KEYS (no silent drift).
for (const plan of PAID_PLAN_IDS) {
  for (const interval of ["month", "year"]) {
    assert.ok(
      PADDLE_PRICE_KEYS.includes(priceKeyFor(plan, interval)),
      `documented key missing: ${priceKeyFor(plan, interval)}`,
    );
  }
}
assert.ok(PADDLE_PRICE_KEYS.length === PAID_PLAN_IDS.length * 2);
pass("catalogue de clés prix aligné sur les formules payantes (2 × 2)");

// 4. Runtime override wins over build-time env (lets the owner retry without rebuild).
const overridden = resolvePaddleConfig(completeEnv, { clientToken: "test_runtime_token" });
assert.equal(overridden.clientToken, "test_runtime_token");
assert.equal(getPriceId(overridden, "essentiel", "month"), "pri_01_essentiel_month");
pass("override runtime prioritaire sur les variables de build (sans casser les prix)");

// 5. Environment is sandbox unless explicitly opted out.
const envCases = [
  [undefined, "sandbox"],
  ["", "sandbox"],
  ["SANDBOX", "sandbox"],
  ["prod", "sandbox"],
  ["sandboxx", "sandbox"],
  ["production", "production"],
  [" LIVE ", "production"],
];
for (const [input, expected] of envCases) {
  assert.equal(normalizeEnvironment(input), expected, `normalizeEnvironment(${input})`);
}
pass("environnement : Sandbox par défaut, bascule uniquement sur production/live explicite");

// 6. successUrl must be https (Paddle rejects anything else).
assert.equal(normalizeSuccessUrl("https://veyvro.dev/merci"), "https://veyvro.dev/merci");
assert.equal(normalizeSuccessUrl("http://insecure.example"), null);
assert.equal(normalizeSuccessUrl(""), null);
assert.equal(normalizeSuccessUrl("pas une url"), null);
pass("successUrl : acceptée en HTTPS uniquement");

// 7. Error classification always yields an actionable message.
const configError = classifyCheckoutError(
  new PaddleConfigError("Configuration Paddle incomplète.", [PADDLE_KEYS.clientToken]),
);
assert.equal(configError.code, "config");
assert.match(configError.message, /incomplète/);
assert.equal(classifyCheckoutError(new TypeError("Failed to fetch")).code, "script");
assert.equal(classifyCheckoutError({ error: { message: "The domain is not approved" } }).code, "domain");
const generic = classifyCheckoutError(new Error("boom"));
assert.equal(generic.code, "checkout");
assert.match(generic.message, /Paddle/);
pass("erreurs classées (config / script / domaine / paiement) avec message actionnable");

// 8. Prices render without throwing and stay consistent with the interval.
for (const plan of PRICING_PLANS) {
  for (const interval of ["month", "year"]) {
    const label = formatPlanPrice(plan, interval);
    assert.ok(label.length > 0);
  }
}
assert.match(formatPlanPrice(PRICING_PLANS[0], "month"), /Gratuit/);
assert.match(formatPlanPrice(PRICING_PLANS[1], "year"), /an/);
pass("affichage des prix (gratuit + mensuel + annuel)");

// 9. Wiring: the view exists, is routed and reachable from the navigation.
const app = read("src/App.tsx");
assert.match(app, /from "\.\/components\/PricingView"/, "App.tsx must import PricingView");
assert.match(app, /type View = "ai" \| "battle" \| "pricing"/, "pricing must be part of the View union");
assert.match(app, /setView\("pricing"\)/, "a navigation control must open the pricing view");
assert.match(app, /<PricingView\b/, "PricingView must actually be rendered");
assert.match(app, /Tarifs/, "the navigation must expose a visible Tarifs entry");
pass("App.tsx : vue « pricing » déclarée, rendue et accessible depuis la navigation");

// 10. Wiring: the buttons are connected to the real Paddle checkout, not a dead click.
const view = read("src/components/PricingView.tsx");
assert.match(view, /openPaddleCheckout/)
assert.match(view, /plan\.id/, "the clicked plan must be forwarded to checkout");
assert.match(view, /interval/, "the selected interval must be forwarded to checkout");
assert.match(view, /role="alert"/, "checkout errors must be announced in the UI");
assert.match(view, /configuration Paddle/i, "missing configuration must be displayed");
const checkout = read("src/lib/paddleCheckout.ts");
assert.match(checkout, /Checkout\.open/, "the Paddle checkout overlay must be opened");
assert.match(checkout, /Environment\.set/, "the Paddle environment must be set before init");
assert.match(checkout, /cdn\.paddle\.com\/paddle\/v2\/paddle\.js/, "official Paddle.js v2 script");
assert.match(checkout, /classifyCheckoutError/, "checkout failures must be classified");
pass("PricingView → openPaddleCheckout → Paddle.Checkout.open : parcours réellement relié");

// 11. No secret material in the front-end sources.
const sources = [
  read("src/lib/paddleCore.ts"),
  read("src/lib/paddleCheckout.ts"),
  read("src/components/PricingView.tsx"),
  read("src/App.tsx"),
].join("\n");
assert.doesNotMatch(sources, /pdl_(live|sdbx)_apikey/i, "Paddle API key must never reach the bundle");
assert.doesNotMatch(sources, /pdl_(live|sdbx)_(ctok|client)/i);
assert.doesNotMatch(sources, /sk-[A-Za-z0-9_-]{20,}/);
pass("aucune clé Paddle secrète dans le code front (token client et price IDs uniquement)");

// 12. The component really renders (React 19, server render): prices, one
// subscription button per paid plan, and an explicit configuration warning.
const { default: PricingView } = await import("../src/components/PricingView.tsx");
const markup = renderToStaticMarkup(createElement(PricingView, { onStartFree: () => {} }));
for (const plan of PRICING_PLANS) {
  assert.ok(markup.includes(plan.name), `plan not rendered: ${plan.name}`);
}
assert.equal((markup.match(/class="pricing-cta"/g) ?? []).length, PAID_PLAN_IDS.length);
assert.equal((markup.match(/class="pricing-cta secondary"/g) ?? []).length, 1);
assert.match(markup, /VITE_PADDLE_CLIENT_TOKEN/, "missing config must be listed in the UI");
assert.match(markup, /role="alert"|pricing-config-note/, "configuration warning must be visible");
assert.match(markup, /Sandbox/, "sandbox must be the default environment shown");
pass("PricingView rendu : 3 formules, 2 boutons d'abonnement + 1 bouton gratuit, avertissement de config");

console.log(`\n${checks} vérifications du parcours d'abonnement passées.`);
