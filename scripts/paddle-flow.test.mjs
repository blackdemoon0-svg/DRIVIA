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
import paddleConfigHandler, { readClientToken } from "../api/paddle-config.ts";
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
  redactSensitive,
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
assert.match(markup, /PADDLE_CLIENT_TOKEN/);
assert.doesNotMatch(markup, /VITE_PADDLE_PRICE_/);
// The real Sandbox IDs are the ones rendered under each paid card.
assert.match(markup, new RegExp(REAL_IDS.plus.month));
assert.match(markup, new RegExp(REAL_IDS.pro.month));
assert.match(markup, /Sandbox/);
pass("rendu réel : Plus/Pro, prix USD, 2 boutons, price IDs Sandbox réels affichés, seul le token manque");

// 20. The server route accepts the variable name actually saved in Vercel.
assert.equal(readClientToken({ PADDLE_CLIENT_TOKEN: "test_server_token" }), "test_server_token");
assert.equal(
  readClientToken({ PADDLE_CLIENT_TOKEN: "  ", VITE_PADDLE_CLIENT_TOKEN: "test_build_token" }),
  "test_build_token",
);
assert.equal(readClientToken({}), null);
assert.equal(readClientToken({ PADDLE_CLIENT_TOKEN: "  " }), null);
// Priority: the server-side name wins when both are set.
assert.equal(
  readClientToken({ PADDLE_CLIENT_TOKEN: "server", VITE_PADDLE_CLIENT_TOKEN: "build" }),
  "server",
);
pass("route serveur : lit PADDLE_CLIENT_TOKEN (nom réellement enregistré), repli sur VITE_PADDLE_CLIENT_TOKEN");

// 21. Route behaviour: GET only, no-store, never leaks an API key.
function callRoute(method, env = {}) {
  const saved = { ...process.env };
  for (const key of Object.keys(env)) {
    // `process.env.X = undefined` stores the string "undefined": delete instead.
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  let statusCode = 200;
  let payload = null;
  const headers = {};
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
  };
  try {
    paddleConfigHandler({ method }, res);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return { statusCode, payload, headers };
}

const getRoute = callRoute("GET", { PADDLE_CLIENT_TOKEN: "test_route_token" });
assert.equal(getRoute.statusCode, 200);
assert.deepEqual(getRoute.payload, { clientToken: "test_route_token" });
assert.match(getRoute.headers["cache-control"], /no-store/);

const getRouteEmpty = callRoute("GET", { PADDLE_CLIENT_TOKEN: undefined });
assert.equal(getRouteEmpty.statusCode, 200);
assert.deepEqual(getRouteEmpty.payload, { clientToken: null });

const postRoute = callRoute("POST", { PADDLE_CLIENT_TOKEN: "test_route_token" });
assert.equal(postRoute.statusCode, 405);
assert.equal(postRoute.payload.clientToken, undefined);

const routeSource = read("api/paddle-config.ts");
assert.doesNotMatch(routeSource, /PADDLE_API_KEY|pdl_(live|sdbx)_apikey/i);
assert.doesNotMatch(routeSource, /console\.log/);
pass("route serveur : GET → 200 + no-store, POST → 405, aucune clé API lue ni journalisée");

// 22. Client hydration completes the config from the server when needed.
const checkoutSource = read("src/lib/paddleCheckout.ts");
assert.match(checkoutSource, /\/api\/paddle-config/);
assert.match(checkoutSource, /loadPaddleConfig/);
assert.match(checkoutSource, /const config = await loadPaddleConfig\(\)/);
assert.match(read("src/components/PricingView.tsx"), /loadPaddleConfig\(\)/);
assert.match(read("src/components/PricingView.tsx"), /useEffect/);
pass("hydratation : PricingView et le checkout complètent le token via /api/paddle-config");

// 23. Hydration never invents a token and keeps the 4 Sandbox price IDs.
const hydratedSource = checkoutSource;
assert.match(hydratedSource, /token \? \{ \.\.\.local, clientToken: token \} : local/);
assert.match(hydratedSource, /PricePreview/);
assert.match(hydratedSource, /verdict\.ok/);
pass("hydratation : aucun token inventé, PricePreview et le blocage sur écart conservés");

// ---------------------------------------------------------------------------
// Schéma officiel de checkout.error, exceptions synchrones, routage d'événements
// (developer.paddle.com/paddle-js/events/checkout-error.md)
// ---------------------------------------------------------------------------

// 24. Real Paddle.js payload: { name, type, code, detail } — no `message` field.
const realPaddleError = {
  name: "checkout.error",
  type: "api_error",
  code: "validation",
  detail: "Invalid request.",
  documentation_url: "https://developer.paddle.com/api-reference",
};
const classifiedReal = classifyCheckoutError(realPaddleError);
assert.equal(classifiedReal.code, "checkout");
assert.equal(classifiedReal.paddleDetail, "Invalid request.");
assert.equal(classifiedReal.paddleCode, "validation");
assert.equal(classifiedReal.paddleType, "api_error");
// The generic sentence is preserved AND the real cause is now visible.
assert.match(classifiedReal.message, /Paddle n'a pas pu ouvrir le paiement/);
assert.match(classifiedReal.message, /Invalid request\./);
assert.match(classifiedReal.message, /code validation/);
assert.match(classifiedReal.message, /type api_error/);
pass("schéma Paddle réel : detail/code/type lus à la racine, message générique + cause visible");

// 25. Existing messages and routing are preserved.
const domainMsg = "Ce domaine n'est pas autorisé dans Paddle Sandbox. Ajoutez l'URL du Preview dans Paddle > Checkout > Website approval, puis réessayez.";
assert.equal(classifyCheckoutError({ error: { message: "The domain is not approved" } }).message, domainMsg);
assert.equal(
  classifyCheckoutError({ name: "checkout.error", type: "api_error", code: "validation", detail: "The source domain is not approved" }).message,
  domainMsg,
);
const scriptMsg = "Le script de paiement Paddle n'a pas pu être chargé. Vérifiez la connexion réseau, un éventuel bloqueur de publicité, puis réessayez.";
assert.equal(classifyCheckoutError(new TypeError("Failed to fetch")).message, scriptMsg);
assert.equal(classifyCheckoutError(new Error("Paiement bloqué : devise non conforme")).code, "price");
// Unknown payload without detail: no dangling "Détail Paddle" suffix.
assert.doesNotMatch(classifyCheckoutError(new Error("boom")).message, /Détail Paddle/);
pass("messages existants inchangés (domaine, script, prix) et aucun suffixe vide");

// 26. Redaction: no token, key or email may reach the UI.
assert.equal(redactSensitive("token test_abcdefghijklmnop1234 rejected"), "token [token masqué] rejected");
assert.equal(redactSensitive("key pdl_sdbx_apikey_abcdef123 rejected"), "key [clé masquée] rejected");
assert.equal(redactSensitive("contact jo@example.com"), "contact [email masqué]");
const leaked = classifyCheckoutError({
  name: "checkout.error",
  type: "front-end_error",
  code: "invalid_token",
  detail: "Bad token test_abcdefghijklmnop1234 for jo@example.com",
});
assert.doesNotMatch(leaked.message, /test_abcdefghijklmnop1234/);
assert.doesNotMatch(leaked.message, /jo@example\.com/);
assert.match(leaked.message, /\[token masqué\]/);
pass("masquage : token Paddle, clé API et email jamais affichés");

// 27. Execution-level: sync throw from Checkout.open, event routing, single Initialize.
function installPaddleStub({ throwOnOpen = false, preview = true } = {}) {
  const calls = { init: 0, open: 0, preview: 0, attribution: 0, env: [], initOptions: null, lastOpenPayload: null };
  const paddle = {
    Environment: { set: (e) => calls.env.push(e) },
    Initialize: (options) => {
      calls.init += 1;
      calls.initOptions = options;
    },
    PricePreview: async () => {
      calls.preview += 1;
      if (!preview) throw new Error("preview down");
      return { data: { currency_code: "USD", details: { line_items: [{ totals: { total: "700", currency_code: "USD" } }] } } };
    },
    Checkout: {
      open: (payload) => {
        calls.open += 1;
        calls.lastOpenPayload = payload;
        if (throwOnOpen) throw new Error("Paddle.js rejected the items payload");
      },
    },
  };
  globalThis.window = {
    __VEYVRO_PADDLE__: {
      clientToken: "test_client_token_for_tests",
      environment: "sandbox",
      prices: { plus: { month: "pri_fixture_plus_month", year: "pri_fixture_plus_year" }, pro: { month: "pri_fixture_pro_month", year: "pri_fixture_pro_year" } },
    },
    Paddle: paddle,
  };
  globalThis.document = { getElementById: () => null, createElement: () => ({ addEventListener() {} }), head: { appendChild() {} } };
  // Two routes are called: the Paddle config and the attribution proof.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/paddle-attribution")) {
      calls.attribution += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ userId: TEST_USER_ID, proof: TEST_ATTRIBUTION_PROOF }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ clientToken: "test_client_token_for_tests" }) };
  };
  return { calls, paddle };
}

// Opaque Supabase-style user id used only inside this test file.
const TEST_USER_ID = "11111111-2222-3333-4444-555555555555";
// Placeholder proof: the checkout never verifies it, the server does.
const TEST_ATTRIBUTION_PROOF = "v1.test-proof-placeholder";
const TEST_ACCESS_TOKEN = "test-access-token";

const checkoutMod = await import("../src/lib/paddleCheckout.ts");

// 27a. Sync throw: surfaced as a classified error, and no "opened" signal.
{
  installPaddleStub({ throwOnOpen: true });
  checkoutMod.resetPaddleInitialization();
  checkoutMod.resetPaddleConfigCache();
  let opened = 0;
  let caught = null;
  try {
    await checkoutMod.openPaddleCheckout({ plan: "plus", interval: "month", userId: TEST_USER_ID, accessToken: TEST_ACCESS_TOKEN, onOpened: () => { opened += 1; } });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "une exception synchrone de Checkout.open doit être propagée");
  assert.equal(caught.name, "PaddleCheckoutError");
  assert.ok(caught.message.length > 0);
  // Re-classifying must not mangle the message that was already classified.
  assert.equal(classifyCheckoutError(caught).message, caught.message);
  assert.equal(opened, 0, "onOpened ne doit pas être appelé si le checkout n'a pas été chargé");
  pass("exception synchrone de Checkout.open : capturée, classée, aucune annonce d'ouverture");
}

// 27b. Event routing on the documented schema.
{
  const { calls } = installPaddleStub();
  checkoutMod.resetPaddleInitialization();
  checkoutMod.resetPaddleConfigCache();
  let opened = 0;
  let closed = 0;
  let errorMessage = null;

  await checkoutMod.openPaddleCheckout({
    plan: "plus",
    interval: "month",
    userId: TEST_USER_ID,
    accessToken: TEST_ACCESS_TOKEN,
    onOpened: () => { opened += 1; },
    onClosed: () => { closed += 1; },
    onError: (message) => { errorMessage = message; },
  });

  assert.equal(calls.open, 1);
  assert.equal(opened, 0, "onOpened ne doit PAS être appelé avant checkout.loaded");

  const emit = (event) => calls.initOptions.eventCallback(event);
  emit({ name: "checkout.loaded", data: { id: "che_01", status: "ready" } });
  assert.equal(opened, 1, "checkout.loaded déclenche onOpened");

  emit({ name: "checkout.closed", data: {} });
  assert.equal(closed, 1, "checkout.closed déclenche onClosed");

  emit({ name: "checkout.error", type: "api_error", code: "validation", detail: "Invalid request." });
  assert.ok(errorMessage, "checkout.error doit transmettre un message");
  assert.match(errorMessage, /Invalid request\./);
  assert.match(errorMessage, /code validation/);

  // Unknown events are ignored without throwing.
  emit({ name: "checkout.updated", data: {} });
  emit(undefined);
  pass("routage : checkout.loaded → onOpened, closed → onClosed, error → onError (schéma racine)");
}

// 27c. Regression guard: still a single Initialize across several checkouts.
{
  const { calls } = installPaddleStub();
  checkoutMod.resetPaddleInitialization();
  checkoutMod.resetPaddleConfigCache();
  await checkoutMod.openPaddleCheckout({ plan: "plus", interval: "month", userId: TEST_USER_ID, accessToken: TEST_ACCESS_TOKEN });
  await checkoutMod.openPaddleCheckout({ plan: "plus", interval: "month", userId: TEST_USER_ID, accessToken: TEST_ACCESS_TOKEN });
  assert.equal(calls.init, 1, `Paddle.Initialize doit rester unique (${calls.init} appels)`);
  assert.equal(calls.open, 2);
  assert.deepEqual(calls.env, ["sandbox"]);
  pass("régressions : un seul Initialize, deux checkouts, environnement Sandbox");
}

// 28a. customData is sent to Paddle, at the root, with the signed-in user id.
{
  const { calls } = installPaddleStub();
  checkoutMod.resetPaddleInitialization();
  checkoutMod.resetPaddleConfigCache();
  // The stub previews 700 USD cents, which is the announced Plus monthly price.
  await checkoutMod.openPaddleCheckout({ plan: "plus", interval: "month", userId: TEST_USER_ID, accessToken: TEST_ACCESS_TOKEN });

  const payload = calls.lastOpenPayload;
  assert.ok(payload, "Checkout.open doit recevoir un payload");
  assert.deepEqual(
    payload.customData,
    { user_id: TEST_USER_ID, attribution_proof: TEST_ATTRIBUTION_PROOF },
    "customData doit porter le user_id ET sa preuve, à la racine du payload",
  );
  assert.equal(typeof payload.customData.user_id, "string");
  assert.equal(typeof payload.customData.attribution_proof, "string");
  // Flat object: Paddle warns that nested custom data may not render correctly.
  assert.ok(Object.values(payload.customData).every((v) => typeof v !== "object"));
  // The user id must not leak into `settings`, where Paddle ignores it.
  assert.equal("customData" in (payload.settings ?? {}), false);
  // The access token must never reach Paddle.
  assert.equal(JSON.stringify(payload).includes(TEST_ACCESS_TOKEN), false);
  pass("customData : user_id + preuve d'attribution à la racine, objet plat, jeton jamais transmis");
}

// 28b. A checkout without a user is refused before any network call.
{
  const { calls } = installPaddleStub();
  checkoutMod.resetPaddleInitialization();
  checkoutMod.resetPaddleConfigCache();

  for (const missing of [undefined, "", "   ", null, 42]) {
    let caught = null;
    try {
      await checkoutMod.openPaddleCheckout({ plan: "plus", interval: "month", userId: missing, accessToken: TEST_ACCESS_TOKEN });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "userId " + JSON.stringify(missing) + " doit être refusé");
    assert.equal(caught.name, "PaddleCheckoutError");
    assert.match(caught.message, /Connectez-vous/);
  }
  assert.equal(calls.open, 0, "aucun checkout ne doit être ouvert sans utilisateur");
  assert.equal(calls.preview, 0, "aucun appel réseau ne doit précéder le refus");
  pass("checkout sans utilisateur : refusé, aucun appel Paddle, message explicite");
}

// 28c. An over-long user id is refused instead of being silently truncated.
{
  const { calls } = installPaddleStub();
  checkoutMod.resetPaddleInitialization();
  checkoutMod.resetPaddleConfigCache();
  let caught = null;
  try {
    await checkoutMod.openPaddleCheckout({ plan: "plus", interval: "month", userId: "u".repeat(129), accessToken: TEST_ACCESS_TOKEN });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "un identifiant trop long doit être refusé");
  assert.equal(calls.open, 0);
  pass("identifiant utilisateur trop long : refusé, aucun checkout ouvert");
}

console.log(`\n${checks} vérifications du parcours d'abonnement passées.`);
