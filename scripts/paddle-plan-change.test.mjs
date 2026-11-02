/**
 * Plan-change tests — Plus → Pro, in place, through the Paddle API.
 *
 * What these tests are really protecting
 * --------------------------------------
 * Money moves on four conditions being true at once: the caller is who they say,
 * the subscription belongs to them, the price we send is one the webhook can
 * name, **and the amount was shown and accepted before the change was sent**.
 * Every case below removes one of them and checks that the route refuses before
 * Paddle is called — or, in the amount case, that Paddle is asked again and the
 * patch is abandoned when the figure moved.
 *
 * The invariants that would be catastrophic to lose are asserted as such:
 *   1. `custom_data` never appears in the PATCH body — it holds the attribution
 *      proof, and overwriting it would silently break every later webhook;
 *   2. `subscriptions` is never written here — the webhook stays its only writer,
 *      so the plan cannot change without a signed Paddle event;
 *   3. a success says "change requested", never "plan changed";
 *   4. no PATCH happens without a signed quote, twice from one quote, or while
 *      another change is already in flight.
 *
 * `fetch` is stubbed for both Supabase and Paddle. No request leaves the process.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import handler from "../api/paddle-plan-change.ts";
import {
  PADDLE_API_BASE_URLS,
  buildPlanChangeBody,
  isPaddleLockCode,
  paddleKeyEnvironment,
  readPaddleApiConfig,
} from "../server/paddleApi.ts";
import { handlePlanChangeRequest } from "../server/planChange.ts";
import {
  QUOTE_TTL_MS,
  createPlanChangeQuote,
  toWireQuote,
  verifyPlanChangeQuote,
} from "../server/planChangeQuote.ts";
import {
  PLAN_CHANGE_RATE_LIMITS,
  consumeRateLimit,
  resetPlanChangeGuard,
} from "../server/planChangeGuard.ts";
import { priceIdForPlan, resolvePlanFromPriceId } from "../src/lib/paddlePrices.ts";
import { evaluatePlanChange, pickSubscriptionForChange } from "../src/lib/planChange.ts";
import { formatMinorAmount } from "../src/lib/paddlePlanChange.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const SUPABASE_URL = "https://stub-project.supabase.test";
const ANON_KEY = "sb_publishable_stub_key";
const SERVICE_KEY = "sb_secret_stub_key";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q";

/**
 * Key fixtures.
 *
 * Deliberately synthetic: `paddleKeyEnvironment` decides from the prefix alone,
 * so the tests need the marker and nothing else. They must never contain
 * something shaped like a real credential — GitHub's push protection blocks
 * such a push, and rightly so: a fixture that looks real is indistinguishable
 * from a leak, and it would sit in the history for ever.
 */
const SANDBOX_KEY = "pdl_sdbx_apikey_fixture_not_a_credential";
const LIVE_KEY = "pdl_live_apikey_fixture_not_a_credential";

const SUBSCRIPTION_ID = "sub_01hv8y5ehszzq0yv20ttx3166y";
const SUB_A = `sub_${"a".repeat(26)}`;
const SUB_B = `sub_${"b".repeat(26)}`;
const FUTURE = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
const PAST = new Date(Date.now() - 24 * 3_600_000).toISOString();

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PADDLE_API_KEY",
  "PADDLE_ENVIRONMENT",
  "VITE_PADDLE_ENVIRONMENT",
  "VITE_PADDLE_PRICE_PRO_MONTH",
  "PADDLE_PRICE_PRO_MONTH",
];

const BASE_ENV = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  PADDLE_API_KEY: SANDBOX_KEY,
  VITE_PADDLE_ENVIRONMENT: "sandbox",
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function row(overrides = {}) {
  return {
    user_id: USER_ID,
    paddle_subscription_id: SUBSCRIPTION_ID,
    plan: "plus",
    status: "active",
    billing_interval: "month",
    current_period_ends_at: FUTURE,
    ...overrides,
  };
}

const PREVIEW_BODY = (amount) => ({
  data: { update_summary: { result: { action: "charge", amount, currency_code: "USD" } } },
});

/**
 * Install one stub for everything: Supabase auth, Supabase REST, Paddle.
 *
 * Every call is recorded with its method, URL and body so the tests can prove
 * what was sent — and, just as importantly, what was never sent.
 */
function installStub({
  identity = "ok",
  rows = [row()],
  restStatus = 200,
  paddlePreview = { status: 200, body: null },
  /** Optional per-call sequence, for tests where the amount moves. */
  paddlePreviews = null,
  paddlePatch = { status: 200, body: null },
} = {}) {
  const calls = [];
  let previewIndex = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const rawBody = typeof init.body === "string" ? init.body : null;
    calls.push({ url, method, body: rawBody, headers: init.headers ?? {} });

    // --- Supabase auth -----------------------------------------------------
    if (url.includes("/auth/v1/user")) {
      if (identity === "invalid") return json({ message: "invalid JWT" }, 401);
      if (identity === "down") throw new Error("auth unreachable");
      return json({
        id: USER_ID,
        email: "client@veyvro.test",
        email_confirmed_at:
          identity === "unconfirmed" ? null : "2026-10-01T00:00:00.000Z",
      });
    }

    // --- Supabase REST -----------------------------------------------------
    if (url.includes("/rest/v1/subscriptions")) {
      if (restStatus !== 200) return new Response("denied", { status: restStatus });
      return json(rows);
    }

    // --- Paddle ------------------------------------------------------------
    if (
      url.startsWith(PADDLE_API_BASE_URLS.sandbox) ||
      url.startsWith(PADDLE_API_BASE_URLS.production)
    ) {
      if (url.endsWith("/preview")) {
        let spec = paddlePreview;
        if (paddlePreviews) {
          spec = paddlePreviews[Math.min(previewIndex, paddlePreviews.length - 1)];
          previewIndex += 1;
        }
        if (spec.throw) throw new Error("paddle unreachable");
        return json(spec.body ?? PREVIEW_BODY("800"), spec.status ?? 200);
      }
      if (paddlePatch.throw) throw new Error("paddle unreachable");
      return json(paddlePatch.body ?? { data: { id: SUBSCRIPTION_ID, status: "active" } }, paddlePatch.status);
    }

    throw new Error(`unexpected outbound call: ${method} ${url}`);
  };

  return calls;
}

function setEnv(overrides = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  // Every scenario starts from a clean guard: the counters, locks and spent
  // nonces are per instance, and no test may inherit another's budget.
  resetPlanChangeGuard();
}

function restore() {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
}

function makeResponse() {
  const out = { status: 0, body: null, headers: {} };
  const response = {
    status(code) {
      out.status = code;
      return response;
    },
    json(body) {
      out.body = body;
      return response;
    },
    setHeader(name, value) {
      out.headers[name] = value;
    },
  };
  return { response, out };
}

/** Call the route as the browser would. */
async function call(body, { method = "POST", token = TOKEN, ip = null } = {}) {
  const { response, out } = makeResponse();
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (ip) headers["x-forwarded-for"] = ip;
  await handler({ method, headers, body }, response);
  return out;
}

/** Ask for a quote, then build the confirmation body a browser would send. */
async function withQuote(body = { targetPlan: "pro", interval: "month" }) {
  const quoted = await call({ ...body, preview: true });
  assert.equal(quoted.status, 200, `un devis doit pouvoir être obtenu (reçu ${quoted.status})`);
  assert.ok(quoted.body.quote?.token, "le devis doit être signé");
  return { ...body, preview: false, quoteToken: quoted.body.quote.token };
}

const previewCalls = (calls) => calls.filter((entry) => entry.url.endsWith("/preview"));
const patchCalls = (calls) =>
  calls.filter((entry) => entry.method === "PATCH" && !entry.url.endsWith("/preview"));
const paddleCalls = (calls) => calls.filter((entry) => entry.url.includes("paddle.com"));
const supabaseWrites = (calls) =>
  calls.filter(
    (entry) => entry.url.includes("/rest/v1/subscriptions") && entry.method !== "GET",
  );

const REQUEST = { targetPlan: "pro", interval: "month", preview: false };

// ---------------------------------------------------------------------------
// 1. Identity and configuration come first
// ---------------------------------------------------------------------------

setEnv();
{
  const calls = installStub();
  const out = await call(REQUEST, { method: "GET" });
  assert.equal(out.status, 405);
  assert.equal(calls.length, 0, "aucun appel sortant pour une méthode refusée");
  pass("méthode GET : 405 avant tout appel réseau");
}

setEnv();
{
  const calls = installStub();
  const out = await call(REQUEST, { token: null });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "auth_required");
  assert.equal(calls.length, 0);
  pass("sans jeton : 401 `auth_required`, aucun appel sortant");
}

setEnv();
{
  installStub({ identity: "invalid" });
  const out = await call(REQUEST);
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "invalid_token");
  pass("jeton refusé par Supabase : 401 `invalid_token`");
}

setEnv();
{
  installStub({ identity: "down" });
  const out = await call(REQUEST);
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "identity_unavailable");
  pass("Supabase Auth injoignable : 503, distinct d'un jeton invalide");
}

setEnv();
{
  installStub({ identity: "unconfirmed" });
  const out = await call(REQUEST);
  assert.equal(out.status, 403);
  assert.equal(out.body.code, "email_unconfirmed");
  pass("adresse non confirmée : 403 avant toute modification");
}

setEnv({ PADDLE_API_KEY: undefined });
{
  const calls = installStub();
  const out = await call(REQUEST);
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "paddle_not_configured");
  assert.equal(paddleCalls(calls).length, 0, "aucun appel Paddle sans clé");
  pass("clé API absente : 503 `paddle_not_configured`, Paddle jamais appelé");
}

setEnv({ PADDLE_API_KEY: LIVE_KEY });
{
  const calls = installStub();
  const out = await call(REQUEST);
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "paddle_environment_mismatch");
  assert.equal(paddleCalls(calls).length, 0, "aucun appel avec une clé live");
  pass("clé live sur un déploiement sandbox : refusée, aucun appel Paddle");
}

// ---------------------------------------------------------------------------
// 2. The subscription is read server-side and the rules are applied
// ---------------------------------------------------------------------------

setEnv();
{
  const calls = installStub({ rows: [] });
  const out = await call(REQUEST);
  assert.equal(out.status, 404);
  assert.equal(out.body.code, "no_subscription");

  const read = calls.find((entry) => entry.url.includes("/rest/v1/subscriptions"));
  assert.match(read.url, new RegExp(`user_id=eq\\.${USER_ID}`), "lecture filtrée sur le compte vérifié");
  assert.equal(read.headers.apikey, SERVICE_KEY, "la lecture serveur utilise la clé de service");
  pass("aucun abonnement : 404, et la lecture est filtrée sur le compte du jeton");
}

setEnv();
{
  const calls = installStub({ rows: [row({ status: "past_due" })] });
  const out = await call(REQUEST);
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "not_in_good_standing");
  assert.equal(paddleCalls(calls).length, 0, "past_due ne doit jamais atteindre Paddle");
  pass("abonnement past_due : 409 `not_in_good_standing`, Paddle jamais appelé");
}

setEnv();
{
  installStub({ rows: [row({ status: "paused" })] });
  const out = await call(REQUEST);
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "not_in_good_standing");
  pass("abonnement en pause : 409, aucune modification en place possible");
}

setEnv();
{
  installStub({ rows: [row({ status: "trialing" })] });
  const out = await call(REQUEST);
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "trialing_not_supported");
  pass("abonnement en essai : 409 `trialing_not_supported` (Paddle n'autorise que do_not_bill)");
}

setEnv();
{
  installStub({ rows: [row({ plan: "pro" })] });
  const out = await call({ ...REQUEST, targetPlan: "pro" });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "same_plan");
  pass("formule déjà en place : 409 `same_plan`, rien n'est facturé");
}

setEnv();
{
  installStub({ rows: [row({ plan: "pro" })] });
  const out = await call({ ...REQUEST, targetPlan: "plus" });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "downgrade_not_supported");
  pass("descente Pro → Plus : 409, hors périmètre, aucun remboursement improvisé");
}

setEnv();
{
  const calls = installStub();
  const out = await call({ ...REQUEST, interval: "year" });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "interval_change_not_supported");
  assert.equal(paddleCalls(calls).length, 0);
  pass("changement de périodicité : 409 avant Paddle, la date de renouvellement n'est pas déplacée");
}

setEnv();
{
  installStub();
  const out = await call({ ...REQUEST, targetPlan: "decouverte" });
  assert.equal(out.status, 400);
  assert.equal(out.body.code, "invalid_target_plan");
  pass("formule cible inconnue ou gratuite : 400 `invalid_target_plan`");
}

setEnv();
{
  // A body that tries to name another account or another subscription must be
  // ignored entirely: the identity and the subscription come from the server.
  const calls = installStub({ rows: [row()] });
  const quoted = await withQuote();
  const out = await call({
    ...quoted,
    userId: OTHER_ID,
    subscriptionId: "sub_01aaaaaaaaaaaaaaaaaaaaaaaaaa",
    priceId: "pri_01bbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(out.status, 202);

  const patch = patchCalls(calls)[0];
  assert.ok(patch.url.includes(SUBSCRIPTION_ID), "l'identifiant Paddle vient de la base, pas du corps");
  assert.ok(!patch.url.includes("sub_01aaaaaaaaaaaaaaaaaaaaaaaaaa"));
  pass("corps falsifié (autre compte, autre abonnement, autre prix) : entièrement ignoré");
}

// ---------------------------------------------------------------------------
// 3. Preview first: Paddle's own figure, signed, nothing charged
// ---------------------------------------------------------------------------

setEnv();
{
  const calls = installStub();
  const out = await call({ ...REQUEST, preview: true });

  assert.equal(out.status, 200);
  assert.deepEqual(out.body.preview, { action: "charge", amountMinor: 800, currencyCode: "USD" });
  assert.equal(out.body.changeRequested, undefined, "un aperçu ne demande aucun changement");

  assert.equal(previewCalls(calls).length, 1, "un seul appel d'aperçu");
  assert.equal(patchCalls(calls).length, 0, "un aperçu ne modifie jamais l'abonnement");
  pass("aperçu : montant au prorata renvoyé (8,00 $), aucun changement appliqué");
}

setEnv();
{
  // The safe default: anything but an explicit `preview: false` previews.
  installStub();
  const out = await call({ targetPlan: "pro", interval: "month" });
  assert.equal(out.status, 200);
  assert.ok(out.body.preview, "sans `preview: false`, on ne fait qu'un devis");
  pass("absence de `preview: false` : devis seulement, jamais un débit");
}

setEnv();
{
  installStub();
  const before = Date.now();
  const out = await call({ ...REQUEST, preview: true });

  const { token, expiresAt, targetPlan, interval } = out.body.quote;
  assert.equal(typeof token, "string");
  assert.ok(token.startsWith("v1."), "le devis est un jeton versionné");
  assert.equal(targetPlan, "pro");
  assert.equal(interval, "month", "le devis fixe la périodicité : la confirmation ne relira pas le sélecteur");

  const expiresAtMs = Date.parse(expiresAt);
  assert.ok(expiresAtMs > before, "le devis expire dans le futur");
  assert.ok(
    expiresAtMs - before <= QUOTE_TTL_MS + 1_000,
    "la durée de vie du devis reste courte (5 minutes)",
  );
  pass("aperçu : devis signé, lié à la formule et à la périodicité, expiration courte");
}

setEnv();
{
  installStub({ paddlePreview: { status: 200, body: PREVIEW_BODY(0) } });
  const out = await call({ ...REQUEST, preview: true });
  assert.equal(out.body.noCharge, true);
  pass("prorata nul : annoncé explicitement (`noCharge: true`)");
}

setEnv();
{
  installStub({ paddlePreview: { status: 200, body: { data: {} } } });
  const out = await call({ ...REQUEST, preview: true });
  assert.equal(out.status, 422);
  assert.equal(out.body.code, "paddle_refused");
  assert.equal(out.body.quote, undefined, "aucun devis signé pour un montant illisible");
  pass("aperçu illisible : refusé plutôt qu'un montant inventé, et aucun devis émis");
}

// ---------------------------------------------------------------------------
// 4. Applying the change: exact body, no custom_data, no database write
// ---------------------------------------------------------------------------

setEnv();
{
  const calls = installStub();
  const out = await call(await withQuote());

  assert.equal(out.status, 202, "202 : accepté, pas « formule changée »");
  assert.equal(out.body.changeRequested, true);
  assert.equal(out.body.plan, undefined, "la route n'annonce jamais la nouvelle formule");
  assert.equal(out.body.status, undefined);

  const patch = patchCalls(calls);
  assert.equal(patch.length, 1);
  assert.ok(patch[0].url.endsWith(`/subscriptions/${SUBSCRIPTION_ID}`), "PATCH sur l'abonnement existant");
  assert.equal(patch[0].method, "PATCH");

  const sent = JSON.parse(patch[0].body);
  const expectedPrice = priceIdForPlan("pro", "month", process.env);
  assert.deepEqual(sent.items, [{ price_id: expectedPrice, quantity: 1 }]);
  assert.equal(sent.proration_billing_mode, "prorated_immediately");
  assert.equal(sent.on_payment_failure, "prevent_change");
  pass("changement : PATCH sur l'abonnement existant, prix cible, prorata immédiat, prevent_change");
}

setEnv();
{
  const calls = installStub();
  await call(await withQuote());
  const sent = JSON.parse(patchCalls(calls)[0].body);

  assert.ok(!("custom_data" in sent), "custom_data ne doit JAMAIS être envoyé");
  assert.ok(!JSON.stringify(sent).includes("attribution_proof"));
  assert.ok(!("custom_data" in buildPlanChangeBody("pri_x")), "même le constructeur ne peut pas le produire");
  pass("corps du PATCH : aucun `custom_data`, la preuve d'attribution reste intacte");
}

setEnv();
{
  const calls = installStub();
  await call(await withQuote());

  assert.deepEqual(supabaseWrites(calls), [], "aucune écriture dans subscriptions depuis cette route");
  const supabaseCalls = calls.filter((entry) => entry.url.includes("/rest/v1/"));
  assert.ok(supabaseCalls.every((entry) => entry.method === "GET"), "le webhook reste l'unique écrivain");
  pass("aucun INSERT ni UPDATE dans subscriptions : le webhook reste seul écrivain");
}

setEnv();
{
  const calls = installStub();
  await call(await withQuote());
  const paddleCall = paddleCalls(calls)[0];

  assert.equal(paddleCall.headers.Authorization, `Bearer ${SANDBOX_KEY}`);
  assert.ok(paddleCall.url.startsWith(PADDLE_API_BASE_URLS.sandbox), "environnement sandbox respecté");
  pass("appel Paddle : hôte sandbox, clé en en-tête Bearer uniquement");
}

setEnv();
{
  // The key lives in one place only: the outgoing Authorization header (already
  // asserted above). It must not surface in any response body or in any URL —
  // a URL ends up in logs, proxies and error reports.
  const calls = installStub();
  const out = await call(await withQuote());
  const secretPart = SANDBOX_KEY.slice(-22);
  const visible = JSON.stringify(out) + JSON.stringify(calls.map((entry) => entry.url));

  assert.ok(!visible.includes(SANDBOX_KEY), "la clé ne doit pas apparaître dans une réponse ou une URL");
  assert.ok(!visible.includes(secretPart), "le secret de la clé ne doit pas apparaître dans une URL");
  assert.equal(out.body.apiKey, undefined);
  assert.equal(out.body.key, undefined);
  pass("la clé API n'apparaît ni dans la réponse ni dans l'URL");
}

setEnv({ VITE_PADDLE_PRICE_PRO_MONTH: "pri_01custompromonth0000000000" });
{
  const calls = installStub();
  await call(await withQuote());
  const sent = JSON.parse(patchCalls(calls)[0].body);
  assert.equal(sent.items[0].price_id, "pri_01custompromonth0000000000");
  pass("prix cible : la variable d'environnement l'emporte, exactement comme le webhook");
}

// ---------------------------------------------------------------------------
// 5. The signed quote: no change without a figure that was shown
// ---------------------------------------------------------------------------

setEnv();
{
  const calls = installStub();
  const out = await call({ targetPlan: "pro", interval: "month", preview: false });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_required");
  assert.equal(paddleCalls(calls).length, 0, "aucun appel Paddle sans devis accepté");
  pass("confirmation sans devis : 409 `quote_required`, Paddle jamais appelé");
}

setEnv();
{
  const calls = installStub();
  const quoted = await withQuote();
  const tampered = `${quoted.quoteToken.slice(0, -4)}AAAA`;
  const out = await call({ ...quoted, quoteToken: tampered });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_invalid");
  assert.equal(patchCalls(calls).length, 0);
  pass("devis altéré : signature refusée, aucun PATCH");
}

setEnv();
{
  const calls = installStub();
  const forged = createPlanChangeQuote({
    secret: `${SANDBOX_KEY}-someone-else`,
    userId: USER_ID,
    subscriptionId: SUBSCRIPTION_ID,
    targetPlan: "pro",
    interval: "month",
    priceId: priceIdForPlan("pro", "month", process.env),
    preview: { action: "charge", amountMinor: 800, currencyCode: "USD" },
  });
  const out = await call({ ...REQUEST, quoteToken: forged.token });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_invalid");
  assert.equal(patchCalls(calls).length, 0);
  pass("devis signé avec un autre secret : refusé, aucun PATCH");
}

setEnv();
{
  installStub();
  const quoted = await withQuote();

  // Ten minutes later: the amount quoted has expired.
  const out = await handlePlanChangeRequest(
    {
      accessToken: TOKEN,
      targetPlan: "pro",
      interval: "month",
      preview: false,
      quoteToken: quoted.quoteToken,
      clientIp: null,
    },
    process.env,
    { nowMs: Date.now() + 10 * 60_000 },
  );

  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_expired");
  pass("devis expiré : 409 `quote_expired`, la confirmation est refusée");
}

setEnv();
{
  const calls = installStub();
  // A genuine quote, but issued for another account.
  const other = createPlanChangeQuote({
    secret: process.env.PADDLE_API_KEY,
    userId: OTHER_ID,
    subscriptionId: SUBSCRIPTION_ID,
    targetPlan: "pro",
    interval: "month",
    priceId: priceIdForPlan("pro", "month", process.env),
    preview: { action: "charge", amountMinor: 800, currencyCode: "USD" },
  });
  const out = await call({ ...REQUEST, quoteToken: other.token });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_mismatch");
  assert.equal(patchCalls(calls).length, 0);
  pass("devis appartenant à un autre compte : 409, jamais appliqué ici");
}

setEnv();
{
  const calls = installStub();
  // A genuine quote for another plan: the figure shown was not this one.
  const wrongPlan = createPlanChangeQuote({
    secret: process.env.PADDLE_API_KEY,
    userId: USER_ID,
    subscriptionId: SUBSCRIPTION_ID,
    targetPlan: "plus",
    interval: "month",
    priceId: priceIdForPlan("plus", "month", process.env),
    preview: { action: "charge", amountMinor: 800, currencyCode: "USD" },
  });
  const out = await call({ ...REQUEST, quoteToken: wrongPlan.token });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_mismatch");
  assert.equal(patchCalls(calls).length, 0);
  pass("devis d'une autre formule : 409 `quote_mismatch`, aucun PATCH");
}

setEnv();
{
  // The subscription changed between the quote and the confirmation: the quote
  // was about a different one, so it does not describe this change.
  const quoted = await withQuote();
  const calls = installStub({ rows: [row({ paddle_subscription_id: SUB_B })] });
  const out = await call(quoted);
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_mismatch");
  assert.equal(patchCalls(calls).length, 0);
  pass("devis lié à un autre abonnement : 409, aucun PATCH");
}

setEnv();
{
  // Proration moves by the minute: the second preview is Paddle's answer, and
  // it no longer matches the signed figure. Nothing may be charged.
  const calls = installStub({
    paddlePreviews: [
      { status: 200, body: PREVIEW_BODY("800") },
      { status: 200, body: PREVIEW_BODY("1240") },
    ],
  });
  const quoted = await withQuote();
  const out = await call(quoted);

  assert.equal(out.status, 409);
  assert.equal(out.body.code, "quote_stale");
  assert.equal(patchCalls(calls).length, 0, "aucun PATCH quand le montant a bougé");
  pass("montant changé entre devis et confirmation : 409 `quote_stale`, rien n'est prélevé");
}

setEnv();
{
  // Same amount on both previews: the change goes through, after two previews
  // and exactly one PATCH, all on the same subscription and the same items.
  const calls = installStub();
  const quoted = await withQuote();
  const out = await call(quoted);

  assert.equal(out.status, 202);
  const previews = previewCalls(calls);
  const patches = patchCalls(calls);
  assert.equal(previews.length, 2, "un devis, puis une vérification");
  assert.equal(patches.length, 1);

  const previewUrls = new Set(previews.map((entry) => entry.url));
  assert.equal(previewUrls.size, 1, "les deux aperçus portent sur le même abonnement");
  assert.equal(
    JSON.parse(previews[0].body).items[0].price_id,
    JSON.parse(patches[0].body).items[0].price_id,
    "le PATCH porte sur la liste d'articles qui a été chiffrée",
  );
  pass("aperçu et PATCH : même abonnement, mêmes articles, montant vérifié avant d'appliquer");
}

setEnv();
{
  const calls = installStub();
  const quoted = await withQuote();

  const first = await call(quoted);
  assert.equal(first.status, 202);

  const second = await call(quoted);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "quote_reused");
  assert.equal(patchCalls(calls).length, 1, "un devis ne peut servir qu'une fois");
  pass("rejeu du même devis : 409 `quote_reused`, un seul PATCH au total");
}

// ---------------------------------------------------------------------------
// 6. One change at a time, and a budget for the route
// ---------------------------------------------------------------------------

setEnv();
{
  const calls = installStub();
  const first = await withQuote();
  const second = await withQuote();

  const [a, b] = await Promise.all([call(first), call(second)]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [202, 409], "un seul changement accepté");

  const refused = a.status === 409 ? a : b;
  assert.equal(refused.body.code, "change_in_progress");
  assert.equal(patchCalls(calls).length, 1, "jamais deux PATCH simultanés");
  pass("deux confirmations simultanées : une seule passe, l'autre reçoit 409 `change_in_progress`");
}

setEnv();
{
  // A refused change releases the lock: the customer can try again at once.
  installStub({ paddlePatch: { status: 422, body: { error: { code: "transaction_payment_failed" } } } });
  const first = await call(await withQuote());
  assert.equal(first.status, 422);

  installStub();
  const retry = await call(await withQuote());
  assert.equal(retry.status, 202, "le verrou n'est pas resté pris après un échec");
  pass("après un refus de Paddle, le verrou est libéré et une nouvelle tentative passe");
}

setEnv();
{
  installStub();
  const limit = PLAN_CHANGE_RATE_LIMITS.preview.limit;
  let last = null;
  for (let index = 0; index <= limit; index += 1) {
    last = await call({ targetPlan: "pro", interval: "month", preview: true });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, "rate_limited");
  assert.ok(Number(last.headers["Retry-After"]) > 0, "429 accompagné d'un `Retry-After`");
  pass("devis en rafale : 429 `rate_limited` avec `Retry-After`, au-delà du budget par compte");
}

setEnv();
{
  const ip = "203.0.113.7";
  installStub();
  // Fill one address's budget directly: the per-account budget is smaller, so a
  // single account can never reach it by itself.
  for (let index = 0; index < PLAN_CHANGE_RATE_LIMITS.ip.limit; index += 1) {
    consumeRateLimit(`plan-change-ip:${ip}`, PLAN_CHANGE_RATE_LIMITS.ip, Date.now());
  }
  const out = await call({ targetPlan: "pro", interval: "month", preview: true }, { ip });
  assert.equal(out.status, 429);
  assert.equal(out.body.code, "rate_limited");
  assert.ok(Number(out.headers["Retry-After"]) > 0);
  pass("budget par adresse : lu depuis `x-forwarded-for`, 429 une fois épuisé");
}

setEnv();
{
  // No address header at all: the route must still work (a proxy may strip it).
  installStub();
  const out = await call({ targetPlan: "pro", interval: "month", preview: true });
  assert.equal(out.status, 200);
  pass("sans en-tête d'adresse : le devis reste possible, la limite par compte suffit");
}

// ---------------------------------------------------------------------------
// 7. Paddle errors are classified, never swallowed
// ---------------------------------------------------------------------------

setEnv();
{
  const calls = installStub({
    paddlePatch: {
      status: 409,
      body: { error: { type: "request_error", code: "subscription_locked_renewal" } },
    },
  });
  const out = await call(await withQuote());
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "paddle_locked");
  assert.equal(out.body.detail, "subscription_locked_renewal");
  assert.ok(patchCalls(calls).length === 1, "aucune tentative répétée en boucle");
  pass("Paddle 409 `subscription_locked_renewal` : 409 `paddle_locked`, à réessayer plus tard");
}

setEnv();
{
  installStub({
    paddlePatch: { status: 400, body: { error: { code: "subscription_update_when_past_due" } } },
  });
  const out = await call(await withQuote());
  assert.equal(out.status, 409);
  assert.equal(out.body.code, "not_in_good_standing");
  pass("Paddle refuse un abonnement en retard : 409 `not_in_good_standing`");
}

setEnv();
{
  installStub({ paddlePatch: { status: 403, body: { error: { code: "forbidden" } } } });
  const out = await call(await withQuote());
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "paddle_credentials");
  pass("clé sans permission ou refusée : 503 `paddle_credentials` (problème de déploiement)");
}

setEnv();
{
  installStub({ paddlePatch: { status: 500, body: {} } });
  const out = await call(await withQuote());
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "paddle_unavailable");
  pass("Paddle 5xx : 503 `paddle_unavailable`, réessayable");
}

setEnv();
{
  installStub({ paddlePatch: { throw: true } });
  const out = await call(await withQuote());
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "paddle_unavailable");
  pass("Paddle injoignable : 503, aucun plantage");
}

setEnv();
{
  installStub({ paddlePatch: { status: 429, body: { error: { code: "too_many_requests" } } } });
  const out = await call(await withQuote());
  assert.equal(out.status, 429);
  assert.equal(out.body.code, "paddle_rate_limited");
  assert.ok(Number(out.headers["Retry-After"]) > 0, "le délai de Paddle est transmis");
  pass("Paddle 429 : 429 `paddle_rate_limited` avec `Retry-After`, jamais un succès simulé");
}

setEnv();
{
  installStub({ paddlePatch: { status: 422, body: { error: { code: "transaction_payment_failed" } } } });
  const out = await call(await withQuote());
  assert.equal(out.status, 422);
  assert.equal(out.body.code, "paddle_refused");
  assert.equal(out.body.detail, "transaction_payment_failed");
  pass("paiement refusé par Paddle : 422 `paddle_refused` avec le code d'origine");
}

// ---------------------------------------------------------------------------
// 8. Deterministic selection of the subscription
// ---------------------------------------------------------------------------

{
  // Two rows that look alike in every way a human would sort on: the answer must
  // not depend on the order PostgREST returned them in.
  const rowsA = [row({ paddle_subscription_id: SUB_B }), row({ paddle_subscription_id: SUB_A })];
  const rowsB = [...rowsA].reverse();

  const first = pickSubscriptionForChange(rowsA, USER_ID);
  const second = pickSubscriptionForChange(rowsB, USER_ID);

  assert.deepEqual(first, second, "le choix ne dépend pas de l'ordre des lignes");
  assert.equal(first.subscriptionId, SUB_A, "départage total par identifiant Paddle");
  assert.ok(first.subscriptionId, "l'identifiant Paddle voyage avec la sélection");
  pass("sélection déterministe : deux lignes identiques donnent toujours le même abonnement");
}

setEnv();
{
  // And the PATCH names that exact row, not the first one returned.
  const calls = installStub({
    rows: [row({ paddle_subscription_id: SUB_B }), row({ paddle_subscription_id: SUB_A })],
  });
  const out = await call(await withQuote());
  assert.equal(out.status, 202);
  assert.ok(patchCalls(calls)[0].url.endsWith(`/subscriptions/${SUB_A}`));
  pass("le PATCH porte sur l'abonnement exact retenu par les règles");
}

// ---------------------------------------------------------------------------
// 9. The shared pieces that make all of the above possible
// ---------------------------------------------------------------------------

{
  // Round trip through the same catalogue the webhook uses. A price that cannot
  // be read back is a charge with no plan attached.
  for (const plan of ["plus", "pro"]) {
    for (const interval of ["month", "year"]) {
      const priceId = priceIdForPlan(plan, interval, {});
      assert.ok(priceId, `prix introuvable pour ${plan}/${interval}`);
      assert.deepEqual(
        resolvePlanFromPriceId(priceId, {}),
        { plan, interval },
        `le webhook ne reconnaît pas le prix envoyé pour ${plan}/${interval}`,
      );
    }
  }
  pass("aller-retour prix : les 4 prix envoyés sont exactement ceux que le webhook reconnaît");
}

{
  const config = readPaddleApiConfig({ PADDLE_API_KEY: SANDBOX_KEY, PADDLE_ENVIRONMENT: "sandbox" });
  assert.equal(config.ok, true);
  assert.equal(config.config.baseUrl, PADDLE_API_BASE_URLS.sandbox);

  const live = readPaddleApiConfig({ PADDLE_API_KEY: LIVE_KEY, PADDLE_ENVIRONMENT: "production" });
  assert.equal(live.ok, true);
  assert.equal(live.config.baseUrl, PADDLE_API_BASE_URLS.production);

  const swapped = readPaddleApiConfig({ PADDLE_API_KEY: LIVE_KEY, VITE_PADDLE_ENVIRONMENT: "sandbox" });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.reason, "environment_mismatch");

  // Sandbox is the default: an unset environment never means "take real money".
  const byDefault = readPaddleApiConfig({ PADDLE_API_KEY: SANDBOX_KEY });
  assert.equal(byDefault.ok, true);
  assert.equal(byDefault.config.environment, "sandbox");

  const legacy = readPaddleApiConfig({ PADDLE_API_KEY: "cle_sans_marqueur_d_environnement" });
  assert.equal(legacy.ok, false, "une clé sans marqueur d'environnement n'est pas utilisée au hasard");

  assert.equal(paddleKeyEnvironment(SANDBOX_KEY), "sandbox");
  assert.equal(paddleKeyEnvironment(LIVE_KEY), "production");
  pass("configuration : hôte selon l'environnement, sandbox par défaut, clé mal appariée refusée");
}

{
  assert.equal(isPaddleLockCode("subscription_locked_processing"), true);
  assert.equal(isPaddleLockCode("subscription_outstanding_transaction"), true);
  assert.equal(isPaddleLockCode("subscription_locked_renewal"), true);
  assert.equal(isPaddleLockCode("something_else"), false);
  assert.equal(isPaddleLockCode(null), false);
  pass("verrous Paddle : les trois codes de « réessayez plus tard » sont reconnus, et eux seuls");
}

{
  const active = { subscriptionId: SUBSCRIPTION_ID, plan: "plus", status: "active", interval: "month" };
  assert.deepEqual(evaluatePlanChange(active, { plan: "pro", interval: "month" }), { ok: true });
  assert.equal(evaluatePlanChange(null, { plan: "pro", interval: "month" }).code, "no_subscription");
  assert.equal(evaluatePlanChange({ ...active, status: "past_due" }, { plan: "pro", interval: "month" }).code, "not_in_good_standing");
  assert.equal(evaluatePlanChange({ ...active, status: "canceled" }, { plan: "pro", interval: "month" }).code, "not_in_good_standing");
  assert.equal(evaluatePlanChange(active, { plan: "plus", interval: "month" }).code, "same_plan");
  assert.equal(evaluatePlanChange({ ...active, interval: null }, { plan: "pro", interval: "month" }).code, "interval_change_not_supported");
  pass("règles pures : upgrade autorisé, tout le reste refusé avec son propre code");
}

{
  const secret = "pdl_sdbx_apikey_unit_test_secret";
  const created = createPlanChangeQuote({
    secret,
    userId: USER_ID,
    subscriptionId: SUBSCRIPTION_ID,
    targetPlan: "pro",
    interval: "month",
    priceId: priceIdForPlan("pro", "month", {}),
    preview: { action: "charge", amountMinor: 800, currencyCode: "USD" },
    nowMs: 1_800_000_000_000,
  });
  const expected = {
    userId: USER_ID,
    subscriptionId: SUBSCRIPTION_ID,
    targetPlan: "pro",
    interval: "month",
    priceId: priceIdForPlan("pro", "month", {}),
  };

  const ok = verifyPlanChangeQuote({ secret, token: created.token, nowMs: 1_800_000_010_000, expected });
  assert.equal(ok.ok, true);
  assert.equal(ok.quote.amountMinor, 800);

  const expired = verifyPlanChangeQuote({ secret, token: created.token, nowMs: 1_800_000_000_000 + QUOTE_TTL_MS + 1, expected });
  assert.equal(expired.reason, "expired");

  const otherSecret = verifyPlanChangeQuote({ secret: `${secret}x`, token: created.token, nowMs: 1_800_000_010_000, expected });
  assert.equal(otherSecret.reason, "bad_signature");

  const otherAmount = verifyPlanChangeQuote({
    secret,
    token: created.token,
    nowMs: 1_800_000_010_000,
    expected: { ...expected, priceId: priceIdForPlan("plus", "month", {}) },
  });
  assert.equal(otherAmount.reason, "mismatch");

  // The wire shape never exposes the signature material beyond the token itself.
  const wire = toWireQuote(created);
  assert.deepEqual(Object.keys(wire).sort(), ["expiresAt", "interval", "targetPlan", "token"]);
  pass("devis signé : vérification, expiration, signature et liaison contrôlées séparément");
}

{
  assert.equal(formatMinorAmount(800, "USD"), "8,00 $");
  assert.equal(formatMinorAmount(0, "USD"), "0,00 $");
  assert.equal(formatMinorAmount(129_50, "USD"), "129,50 $");
  pass("montant : formaté de façon déterministe, en unité mineure");
}

// ---------------------------------------------------------------------------
// 10. The interface obeys: a quote is confirmed, never re-derived
// ---------------------------------------------------------------------------

{
  const pricing = readFileSync(new URL("../src/components/PricingView.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/lib/paddlePlanChange.ts", import.meta.url), "utf8");

  assert.match(
    pricing,
    /decision\.reason === "upgrade"[\s\S]{0,120}startPlanChange\(plan\)/,
    "un passage à Pro part vers le changement de formule, pas vers un checkout",
  );
  assert.match(
    pricing,
    /if \(decision\.reason === "upgrade"\) \{\s*setNotice\(decision\.hint\);\s*void startPlanChange\(plan\);/,
    "même appelé directement, handleCheckout refuse un upgrade",
  );
  assert.match(client, /\/api\/paddle-plan-change/);
  assert.ok(!/Paddle\.Checkout|paddle\.Checkout|Checkout\.open/.test(client), "le client ne touche jamais au checkout");
  assert.ok(!/pdl_(live|sdbx)_apikey|PADDLE_API_KEY/.test(client), "aucune clé API côté navigateur");
  pass("interface : upgrade → route serveur, jamais un second Checkout.open, aucune clé dans le bundle");
}

{
  const pricing = readFileSync(new URL("../src/components/PricingView.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/lib/paddlePlanChange.ts", import.meta.url), "utf8");

  // The confirmation sends the signed quote, and nothing about it is recomputed
  // from the current render.
  assert.match(
    pricing,
    /await requestPlanChange\(\{ accessToken, quote \}\)/,
    "la confirmation envoie le devis, pas une reformulation de la demande",
  );
  assert.ok(
    !/requestPlanChange\(\{[^}]*interval/.test(pricing),
    "la périodicité n'est jamais relue dans le sélecteur au moment de confirmer",
  );
  assert.match(client, /quoteToken: options\.quote\.token/, "le jeton accompagne la confirmation");
  assert.match(client, /quote\.targetPlan/, "la formule envoyée vient du devis");
  assert.ok(/export function isQuoteExpired/.test(client), "le client sait reconnaître un devis expiré");
  pass("confirmation : formule, périodicité et jeton viennent du devis signé, jamais du sélecteur");
}

{
  const pricing = readFileSync(new URL("../src/components/PricingView.tsx", import.meta.url), "utf8");

  assert.match(pricing, /const changeLock = useRef\(false\)/, "verrou synchrone du changement de formule");
  assert.match(
    pricing,
    /const confirmPlanChange = async \(\) => \{[\s\S]{0,400}if \(changeLock\.current\) return;/,
    "la confirmation elle-même refuse un second appel dans le même tick",
  );
  assert.match(
    pricing,
    /useEffect\(\(\) => \{\s*changeLock\.current = false;\s*setChangeStage\(IDLE_CHANGE\);\s*\}, \[userId\]\)/,
    "déconnexion ou changement de compte : l'état du changement est remis à zéro",
  );
  assert.match(pricing, /isQuoteExpired\(changeStage\.quote, clock\)/, "l'expiration est affichée et désactive la confirmation");
  assert.ok(
    !/setSnapshot\(\{ kind: "subscribed"/.test(pricing),
    "aucun chemin d'interface ne déclare une formule : seule la lecture de la base le fait",
  );
  pass("interface : verrou, réinitialisation au changement de compte, expiration visible, formule jamais auto-déclarée");
}

restore();
console.log(`\n${checks} vérifications du changement de formule passées.`);
