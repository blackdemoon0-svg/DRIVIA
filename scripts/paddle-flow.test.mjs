/**
 * Offline checks for the VEYVRO subscription path (Paddle Billing, USD).
 * No network, no Paddle account, no real key: configuration resolution,
 * price verification, error classification and the App wiring are asserted
 * statically. The price IDs used here are obvious fixtures, never real IDs.
 *
 * Run with:  npx tsx scripts/paddle-flow.test.mjs
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  BILLING_INTERVALS,
  CURRENCY,
  PADDLE_KEYS,
  PADDLE_PRICE_KEYS,
  PAID_PLAN_IDS,
  PRICING_PLANS,
  SANDBOX_PRICE_IDS,
  PaddleConfigError,
  classifyCheckoutError,
  evaluatePricePreview,
  expectedAmount,
  expectedAmountInCents,
  formatPlanPrice,
  getPriceId,
  isSandboxPriceId,
  lookupSandboxPriceId,
  normalizeEnvironment,
  normalizeSuccessUrl,
  parsePaddleAmount,
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

/** Fixture payload shaped like Paddle's PricePreview response (minor units). */
const preview = ({ amountInCents, currency = "USD" }) => ({
  data: {
    currency_code: currency,
    details: {
      line_items: [
        {
          price: { id: "pri_fixture", unit_price: { amount: String(amountInCents), currency_code: currency } },
          totals: { total: String(amountInCents), currency_code: currency },
        },
      ],
    },
  },
});

// 1. Official pricing: VEYVRO Plus 7/59 USD, VEYVRO Pro 15/129 USD.
const plus = PRICING_PLANS.find((plan) => plan.id === "plus");
const pro = PRICING_PLANS.find((plan) => plan.id === "pro");
assert.ok(plus && pro, "both paid plans must exist");
assert.equal(plus.name, "VEYVRO Plus");
assert.equal(pro.name, "VEYVRO Pro");
assert.deepEqual([plus.monthly, plus.yearly], [7, 59]);
assert.deepEqual([pro.monthly, pro.yearly], [15, 129]);
assert.equal(expectedAmount("plus", "month"), 7);
assert.equal(expectedAmount("plus", "year"), 59);
assert.equal(expectedAmount("pro", "month"), 15);
assert.equal(expectedAmount("pro", "year"), 129);
assert.equal(expectedAmountInCents("pro", "year"), 12900);
assert.equal(CURRENCY, "USD");
pass("catalogue officiel : Plus 7/59 USD, Pro 15/129 USD, devise USD");

// 2. No legacy plan name survives anywhere.
for (const legacy of ["Essentiel", "Expert"]) {
  assert.doesNotMatch(read("src/lib/paddleCore.ts"), new RegExp(legacy, "i"));
  assert.doesNotMatch(read("src/components/PricingView.tsx"), new RegExp(legacy, "i"));
}
pass("aucune trace des anciens noms Essentiel / Expert");

// 3. Price keys are Plus/Pro and cover the 4 combinations.
assert.deepEqual([...PADDLE_PRICE_KEYS], [
  "VITE_PADDLE_PRICE_PLUS_MONTH",
  "VITE_PADDLE_PRICE_PLUS_YEAR",
  "VITE_PADDLE_PRICE_PRO_MONTH",
  "VITE_PADDLE_PRICE_PRO_YEAR",
]);
assert.equal(priceKeyFor("plus", "month"), "VITE_PADDLE_PRICE_PLUS_MONTH");
assert.equal(priceKeyFor("pro", "year"), "VITE_PADDLE_PRICE_PRO_YEAR");
pass("4 variables de prix : PLUS_MONTH / PLUS_YEAR / PRO_MONTH / PRO_YEAR");

// 4. Default configuration: sandbox, price IDs built in, client token reported.
const empty = resolvePaddleConfig({});
assert.equal(empty.environment, "sandbox");
const emptyStatus = validatePaddleConfig(empty);
assert.equal(emptyStatus.ready, false);
assert.deepEqual(emptyStatus.missingKeys, [PADDLE_KEYS.clientToken]);
assert.match(emptyStatus.configurationError, /Paddle Sandbox/);
assert.match(emptyStatus.configurationError, /VITE_PADDLE_CLIENT_TOKEN/);

// Without the Sandbox fallback (production), the 4 price variables are required.
const productionMissing = validatePaddleConfig(
  resolvePaddleConfig({ VITE_PADDLE_ENVIRONMENT: "production" }),
);
assert.equal(productionMissing.missingKeys.length, 5);
for (const key of PADDLE_PRICE_KEYS) {
  assert.ok(productionMissing.missingKeys.includes(key), `missing key not reported: ${key}`);
}
pass("sans configuration : Sandbox + price IDs intégrés → seul le token client manque ; en Production, les 5 manquent");

// 5. The 4 real Sandbox price IDs are wired to the right plan + interval.
const REAL_IDS = {
  plus: { month: "pri_01m57fxf3q0pdse5v8x98red1w", year: "pri_01m57n587d0qj874fk6hynqbg3" },
  pro: { month: "pri_01m57nftmhwpj83s38tjhbbepc", year: "pri_01m57njaaceedwc3f2pacqmjxk" },
};
assert.deepEqual(SANDBOX_PRICE_IDS, REAL_IDS);
for (const plan of PAID_PLAN_IDS) {
  for (const interval of ["month", "year"]) {
    const id = SANDBOX_PRICE_IDS[plan][interval];
    assert.match(id, /^pri_[a-z0-9]{20,}$/, `unexpected price ID shape: ${id}`);
    assert.deepEqual(lookupSandboxPriceId(id), { plan, interval });
    assert.equal(isSandboxPriceId(id), true);
    assert.equal(isSandboxPriceId("pri_not_veyvro"), false);
    assert.equal(isSandboxPriceId(null), false);
  }
}
// No ID is reused across plans or intervals.
const allIds = PAID_PLAN_IDS.flatMap((plan) => BILLING_INTERVALS.map((i) => SANDBOX_PRICE_IDS[plan][i]));
assert.equal(new Set(allIds).size, 4);
pass("4 price IDs Sandbox réels, chacun associé à une seule formule/périodicité (4/4 uniques)");

// 6. Fallback: a sandbox Preview needs no price variable at all.
const sandboxOnly = resolvePaddleConfig({ VITE_PADDLE_CLIENT_TOKEN: "test_client_token" });
assert.equal(sandboxOnly.environment, "sandbox");
assert.equal(getPriceId(sandboxOnly, "plus", "month"), REAL_IDS.plus.month);
assert.equal(getPriceId(sandboxOnly, "plus", "year"), REAL_IDS.plus.year);
assert.equal(getPriceId(sandboxOnly, "pro", "month"), REAL_IDS.pro.month);
assert.equal(getPriceId(sandboxOnly, "pro", "year"), REAL_IDS.pro.year);
assert.equal(validatePaddleConfig(sandboxOnly).missingKeys.length, 0);
pass("en Sandbox : les 4 price IDs réels sont utilisés par défaut (seul le token client manque)");

// 7. Production never inherits the Sandbox IDs.
const productionEmpty = resolvePaddleConfig({
  VITE_PADDLE_CLIENT_TOKEN: "test_client_token",
  VITE_PADDLE_ENVIRONMENT: "production",
});
for (const plan of PAID_PLAN_IDS) {
  for (const interval of ["month", "year"]) {
    assert.equal(getPriceId(productionEmpty, plan, interval), null, "production must not fall back to Sandbox IDs");
  }
}
assert.equal(validatePaddleConfig(productionEmpty).ready, false);
assert.equal(validatePaddleConfig(productionEmpty).missingKeys.length, 4);
pass("en Production : aucun repli sur les price IDs Sandbox, les 4 variables redeviennent obligatoires");

// 8. A variable always beats the built-in Sandbox value.
const envOverridden = resolvePaddleConfig({
  VITE_PADDLE_CLIENT_TOKEN: "test_client_token",
  VITE_PADDLE_PRICE_PLUS_MONTH: "pri_env_override_plus_month",
});
assert.equal(getPriceId(envOverridden, "plus", "month"), "pri_env_override_plus_month");
assert.equal(getPriceId(envOverridden, "pro", "year"), REAL_IDS.pro.year);

// 9. Runtime override wins over everything (retry without a rebuild).
const overridden = resolvePaddleConfig(
  { VITE_PADDLE_CLIENT_TOKEN: "test_client_token" },
  { clientToken: "test_runtime_token", prices: { plus: { month: "pri_runtime_plus_month" } } },
);
assert.equal(overridden.clientToken, "test_runtime_token");
assert.equal(getPriceId(overridden, "plus", "month"), "pri_runtime_plus_month");
assert.equal(getPriceId(overridden, "pro", "year"), REAL_IDS.pro.year);
pass("override runtime prioritaire, sans écraser les autres price IDs");

// 7. Environment is sandbox unless explicitly opted out.
for (const [input, expected] of [
  [undefined, "sandbox"],
  ["", "sandbox"],
  ["SANDBOX", "sandbox"],
  ["prod", "sandbox"],
  ["production", "production"],
  [" LIVE ", "production"],
]) {
  assert.equal(normalizeEnvironment(input), expected, `normalizeEnvironment(${input})`);
}
pass("environnement : Sandbox par défaut, bascule sur production/live explicite uniquement");

// 8. successUrl must be https (Paddle rejects anything else).
assert.equal(normalizeSuccessUrl("https://veyvro.dev/merci"), "https://veyvro.dev/merci");
assert.equal(normalizeSuccessUrl("http://insecure.example"), null);
assert.equal(normalizeSuccessUrl(""), null);
assert.equal(normalizeSuccessUrl("pas une url"), null);
pass("successUrl : HTTPS absolu uniquement");

// 9. Paddle amounts: minor-unit integers vs decimal major units.
assert.equal(parsePaddleAmount("700"), 7);
assert.equal(parsePaddleAmount("5900"), 59);
assert.equal(parsePaddleAmount("12900"), 129);
assert.equal(parsePaddleAmount("7.00"), 7);
assert.equal(parsePaddleAmount("abc"), null);
pass("lecture des montants Paddle (centimes entiers et décimales)");

// 10. Price verification accepts the right price and rejects every wrong one.
const okPlus = evaluatePricePreview(preview({ amountInCents: 700 }), {
  plan: "plus",
  interval: "month",
  priceId: REAL_IDS.plus.month,
});
assert.equal(okPlus.ok, true, okPlus.problems.join(" "));
assert.equal(okPlus.amount, 7);
assert.equal(okPlus.currency, "USD");
const okProYear = evaluatePricePreview(preview({ amountInCents: 12900 }), {
  plan: "pro",
  interval: "year",
  priceId: REAL_IDS.pro.year,
});
assert.equal(okProYear.ok, true);
pass("vérification : 700 = 7 USD (Plus mensuel) et 12900 = 129 USD (Pro annuel) acceptés");

const wrongAmount = evaluatePricePreview(preview({ amountInCents: 900 }), {
  plan: "plus",
  interval: "month",
  priceId: REAL_IDS.plus.month,
});
assert.equal(wrongAmount.ok, false);
assert.match(wrongAmount.problems.join(" "), /9\.00 USD au lieu de 7\.00 USD/);

const wrongCurrency = evaluatePricePreview(preview({ amountInCents: 700, currency: "EUR" }), {
  plan: "plus",
  interval: "month",
  priceId: REAL_IDS.plus.month,
});
assert.equal(wrongCurrency.ok, false);
assert.match(wrongCurrency.problems.join(" "), /devise Paddle « EUR »/i);

// A yearly price ID wired to a monthly button must be caught.
const swapped = evaluatePricePreview(preview({ amountInCents: 5900 }), {
  plan: "plus",
  interval: "month",
  priceId: REAL_IDS.plus.year,
});
assert.equal(swapped.ok, false);
assert.match(swapped.problems.join(" "), /59\.00 USD au lieu de 7\.00 USD/);

const unreadable = evaluatePricePreview({ data: {} }, {
  plan: "pro",
  interval: "month",
  priceId: REAL_IDS.pro.month,
});
assert.equal(unreadable.ok, false);
assert.equal(unreadable.problems.length, 2);
pass("vérification : montant erroné, devise EUR, price ID inversé et réponse illisible bloqués");

// 11. Error classification always yields an actionable message.
const configError = classifyCheckoutError(
  new PaddleConfigError("Configuration Paddle incomplète.", [PADDLE_KEYS.clientToken]),
);
assert.equal(configError.code, "config");
assert.equal(classifyCheckoutError(new TypeError("Failed to fetch")).code, "script");
assert.equal(classifyCheckoutError({ error: { message: "The domain is not approved" } }).code, "domain");
assert.equal(classifyCheckoutError(new Error("boom")).code, "checkout");
const priceError = classifyCheckoutError(new Error("Paiement bloqué : devise non conforme"));
assert.equal(priceError.code, "price");
assert.match(priceError.message, /devise/);
pass("erreurs classées (config / script / prix / domaine / paiement)");

// 12. Prices render in USD with the currency always visible.
assert.match(formatPlanPrice(plus, "month"), /^\$7 \/ mois$/);
assert.match(formatPlanPrice(plus, "year"), /^\$59 \/ an$/);
assert.match(formatPlanPrice(pro, "month"), /^\$15 \/ mois$/);
assert.match(formatPlanPrice(pro, "year"), /^\$129 \/ an$/);
assert.match(formatPlanPrice(PRICING_PLANS[0], "month"), /Gratuit/);
pass("affichage : $7/mois, $59/an, $15/mois, $129/an, Gratuit");

// 13. Wiring: the view is declared, routed and reachable from the navigation.
const app = read("src/App.tsx");
assert.match(app, /from "\.\/components\/PricingView"/);
assert.match(app, /type View = "ai" \| "battle" \| "pricing"/);
assert.match(app, /setView\("pricing"\)/);
assert.match(app, /<PricingView\b/);
assert.match(app, /Tarifs/);
pass("App.tsx : vue « pricing » déclarée, rendue et accessible depuis la navigation");

// 14. Wiring: buttons reach the real checkout, guarded by the price check.
const view = read("src/components/PricingView.tsx");
assert.match(view, /openPaddleCheckout/);
assert.match(view, /plan\.id/);
assert.match(view, /interval/);
assert.match(view, /role="alert"/);
assert.match(view, /verifyAllPrices/);
const checkout = read("src/lib/paddleCheckout.ts");
assert.match(checkout, /Checkout\.open/);
assert.match(checkout, /Environment\.set/);
assert.match(checkout, /PricePreview/);
assert.match(checkout, /verdict\.ok/, "checkout must be refused when the price does not match");
assert.match(checkout, /cdn\.paddle\.com\/paddle\/v2\/paddle\.js/);
pass("PricingView → openPaddleCheckout → PricePreview (garde-fou) → Checkout.open");

// 15. No secret material in the front-end sources.
const sources = [
  read("src/lib/paddleCore.ts"),
  read("src/lib/paddleCheckout.ts"),
  read("src/components/PricingView.tsx"),
  read("src/App.tsx"),
].join("\n");
assert.doesNotMatch(sources, /pdl_(live|sdbx)_apikey/i);
assert.doesNotMatch(sources, /pdl_(live|sdbx)_(ctok|client)/i);
assert.doesNotMatch(sources, /sk-[A-Za-z0-9_-]{20,}/);
pass("aucune clé Paddle secrète dans le code front (token client et price IDs uniquement)");

// 16. The component really renders: names, USD, both buttons, config warning.
const { default: PricingView } = await import("../src/components/PricingView.tsx");
const markup = renderToStaticMarkup(createElement(PricingView, { onStartFree: () => {} }));
assert.match(markup, /VEYVRO Plus/);
assert.match(markup, /VEYVRO Pro/);
// Default interval is monthly, so the annual amounts are asserted through
// formatPlanPrice above; the markup must show the monthly ones in USD.
assert.match(markup, /\$7 \/ mois/);
assert.match(markup, /\$15 \/ mois/);
assert.match(markup, /7 USD par mois/);
assert.match(markup, /15 USD par mois/);
assert.match(markup, /USD/);
assert.doesNotMatch(markup, /Essentiel|Expert/);
assert.equal((markup.match(/class="pricing-cta"/g) ?? []).length, PAID_PLAN_IDS.length);
assert.equal((markup.match(/class="pricing-cta secondary"/g) ?? []).length, 1);
// Only the client token is missing now: the 4 price IDs are built in.
assert.match(markup, /VITE_PADDLE_CLIENT_TOKEN/);
assert.doesNotMatch(markup, /VITE_PADDLE_PRICE_/);
// The real Sandbox IDs are the ones rendered under each paid card.
assert.match(markup, new RegExp(REAL_IDS.plus.month));
assert.match(markup, new RegExp(REAL_IDS.pro.month));
assert.match(markup, /Sandbox/);
pass("rendu réel : Plus/Pro, prix USD, 2 boutons, price IDs Sandbox réels affichés, seul le token manque");

console.log(`\n${checks} vérifications du parcours d'abonnement passées.`);
