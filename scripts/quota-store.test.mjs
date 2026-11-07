/**
 * Durable usage store tests — an RPC client, stubbed at the transport boundary.
 *
 * Two families of guarantees are asserted here, and they are different:
 *
 *   • BEHAVIOUR — every PostgreSQL answer is mapped to one explicit outcome, and
 *     every failure mode fails closed. No network error, no 5xx and no unknown
 *     `reason` may ever produce "go ahead", and none may fall back to the
 *     in-memory counters.
 *
 *   • SHAPE — one operation is exactly one RPC call, to exactly one path, with
 *     the service role key and a `p_user_id`/`p_consumption_id` pair. This is
 *     what keeps the two writes of a consumption inside one SQL transaction: if
 *     a future refactor split them into two calls, these tests fail.
 *
 * The last block asserts that no table path is ever contacted: the server holds
 * no privilege on `ai_usage_daily` / `ai_usage_events`, by decision.
 */
import assert from "node:assert";
import { msUntilNextUtcDay, utcDayKey } from "../server/utcDay.ts";
import {
  USAGE_ENV_KEYS,
  USAGE_RPC,
  consumeDurableUsage,
  readDurableUsage,
  readUsageStoreEnv,
  refundDurableUsage,
  usageFailureStatus,
} from "../server/usageStore.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const SUPABASE_URL = "https://stub-project.supabase.test";
const SERVICE_KEY = "sb_secret_stub_service_key";
const ENV = { url: SUPABASE_URL, serviceRoleKey: SERVICE_KEY };
const RAW_ENV = {
  [USAGE_ENV_KEYS.supabaseUrl]: SUPABASE_URL,
  [USAGE_ENV_KEYS.serviceRoleKey]: SERVICE_KEY,
};

const USER_ID = "11111111-2222-4333-8444-555555555555";
const CONSUMPTION_ID = "8f14e45f-ceea-467f-a1b2-3c4d5e6f7a8b";
const NOW = Date.parse("2026-11-07T10:00:00.000Z");

/** Minimal Response-like object; the store only reads status, ok and json(). */
function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

/** Intercepting fetch: records every request, answers through `handler`. */
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const entry = {
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
      signal: init.signal,
    };
    calls.push(entry);
    return handler(entry, calls.length);
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
{
  assert.equal(readUsageStoreEnv({}), null);
  assert.equal(readUsageStoreEnv({ SUPABASE_URL: SUPABASE_URL }), null, "sans clé service role : non configuré");
  assert.equal(readUsageStoreEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }), null);

  const trimmed = readUsageStoreEnv({
    SUPABASE_URL: `  ${SUPABASE_URL}/  `,
    SUPABASE_SERVICE_ROLE_KEY: `  ${SERVICE_KEY}  `,
  });
  assert.deepEqual(trimmed, { url: SUPABASE_URL, serviceRoleKey: SERVICE_KEY });
  pass("readUsageStoreEnv : les deux variables sont exigées, espaces et slash final normalisés");
}

{
  const { impl, calls } = makeFetch(() => jsonResponse([]));

  const missing = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: null, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(missing, { ok: false, kind: "not_configured" });

  const blankUser = await consumeDurableUsage(
    { userId: "  ", consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(blankUser, { ok: false, kind: "unauthenticated" }, "un compte vide est un problème d'authentification (401), pas de configuration (503)");

  assert.equal(calls.length, 0, "une configuration absente ou un compte vide ne doit provoquer aucun appel réseau");
  pass("configuration absente ⇒ not_configured ; compte vide ⇒ unauthenticated (401) ; aucun appel réseau");
}

// ---------------------------------------------------------------------------
// 2. Request shape — one call, one path, service role only
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch(() =>
    jsonResponse([{ allowed: true, reason: null, used_messages: 3, used_quotes: 0, usage_day: "2026-11-07", replayed: false }]),
  );

  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );

  assert.equal(calls.length, 1, "une consommation = exactement un appel (donc une transaction SQL)");
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, `${SUPABASE_URL}/rest/v1/rpc/${USAGE_RPC.consume}`);
  assert.equal(call.headers.apikey, SERVICE_KEY);
  assert.equal(call.headers.Authorization, `Bearer ${SERVICE_KEY}`);
  assert.equal(call.headers["Content-Type"], "application/json");

  assert.deepEqual(Object.keys(call.body).sort(), [
    "p_consumption_id",
    "p_is_quote",
    "p_limit_messages",
    "p_limit_quotes",
    "p_user_id",
  ]);
  assert.equal(call.body.p_user_id, USER_ID);
  assert.equal(call.body.p_consumption_id, CONSUMPTION_ID);
  assert.equal(call.body.p_limit_messages, 15);
  assert.equal(call.body.p_limit_quotes, 1);
  assert.equal(call.body.p_is_quote, false);

  assert.deepEqual(outcome, {
    ok: true,
    kind: "consumed",
    usageDay: "2026-11-07",
    messages: 3,
    quotes: 0,
    limits: outcome.limits,
  });
  assert.equal(outcome.limits.messagesPerDay, 15);
  pass("forme de la requête : un seul POST /rpc/ai_usage_consume, service role, identifiants et limites du plan");
}

{
  const { impl, calls } = makeFetch(() => jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));
  await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "plus", isQuoteAnalysis: true },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    "p_consumption_id",
    "p_is_quote",
    "p_limit_messages",
    "p_limit_quotes",
    "p_user_id",
  ]);
  assert.equal(calls[0].body.p_limit_messages, 200);
  assert.equal(calls[0].body.p_limit_quotes, null, "PLUS a des analyses de devis illimitées : null explicite");
  assert.equal(calls[0].body.p_is_quote, true);
  pass("PLUS : 200 messages/jour et analyses de devis illimitées transmises en null explicite");
}

{
  const { impl, calls } = makeFetch(() => jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));

  // Production path: no explicit clock ⇒ no p_now ⇒ PostgreSQL decides the day.
  await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal("p_now" in calls[0].body, false, "le serveur ne choisit jamais la journée facturée");

  // Tests only: the clock is forwarded when explicitly provided.
  await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOW },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(calls[1].body.p_now, new Date(NOW).toISOString());
  pass("p_now n'est transmis que par les tests : la journée est toujours dérivée par PostgreSQL");
}

// ---------------------------------------------------------------------------
// 3. Duplicate — never a second charge, never a second AI call
// ---------------------------------------------------------------------------
{
  const { impl } = makeFetch(() =>
    jsonResponse([{ allowed: true, reason: "replay", used_messages: 4, used_quotes: 0, usage_day: "2026-11-07", replayed: true }]),
  );
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(outcome, { ok: false, kind: "duplicate", usageDay: "2026-11-07" });
  pass("rejeu d'un identifiant déjà consommé ⇒ kind « duplicate » (la route répondra 409, sans appel IA)");
}

{
  // Defensive: the flag missing but the reason present.
  const { impl } = makeFetch(() => jsonResponse([{ allowed: true, reason: "replay", used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.kind, "duplicate");
  pass("le motif « replay » seul suffit à classer un rejeu en doublon (pas de dépendance à un booléen)");
}

// ---------------------------------------------------------------------------
// 4. Quota refusals — 429 material, computed the same way every time
// ---------------------------------------------------------------------------
{
  const expectedRetry = Math.ceil(msUntilNextUtcDay(NOW) / 1_000);

  const { impl } = makeFetch(() =>
    jsonResponse([{ allowed: false, reason: "daily_messages", used_messages: 15, used_quotes: 0, usage_day: "2026-11-07", replayed: false }]),
  );
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "daily_messages");
  assert.equal(outcome.limit, 15);
  assert.equal(outcome.messages, 15);
  assert.equal(outcome.retryAfterSeconds, expectedRetry);
  assert.equal(outcome.usageDay, "2026-11-07");
  pass("plafond quotidien atteint ⇒ daily_messages avec limite, usage et Retry-After calculé sur minuit UTC");
}

{
  const { impl } = makeFetch(() =>
    jsonResponse([{ allowed: false, reason: "daily_quotes", used_messages: 1, used_quotes: 1, usage_day: "2026-11-07" }]),
  );
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: true },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.kind, "daily_quotes");
  assert.equal(outcome.limit, 1);
  assert.equal(outcome.quotes, 1);
  pass("plafond d'analyses de devis atteint ⇒ daily_quotes avec la limite Découverte (1)");
}

// ---------------------------------------------------------------------------
// 5. Conflicts and unknown answers — fail closed
// ---------------------------------------------------------------------------
{
  const { impl } = makeFetch(() => jsonResponse([{ allowed: false, reason: "consumption_conflict", usage_day: "2026-11-07" }]));
  const conflict = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(conflict, { ok: false, kind: "conflict", usageDay: "2026-11-07" });

  const { impl: legacyImpl } = makeFetch(() => jsonResponse([{ allowed: false, reason: "consumption_refunded", usage_day: "2026-11-07" }]));
  const legacy = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: legacyImpl, now: () => NOW },
  );
  assert.equal(legacy.kind, "conflict", "un ancien déploiement doit rester compris");
  pass("conflit d'identité (y compris l'ancien motif « refunded ») ⇒ kind « conflict », aucun décompte supposé");
}

{
  const { impl } = makeFetch(() => jsonResponse([{ allowed: false, reason: "something_new", usage_day: "2026-11-07" }]));
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "unavailable");
  pass("motif inconnu ⇒ unavailable (jamais un « oui » implicite)");
}

{
  const { impl } = makeFetch(() => jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW, limits: { messagesPerDay: null, quoteAnalysesPerDay: null, quoteAnalysis: true, requestsPerMinute: 10 } },
  );
  assert.deepEqual(outcome, { ok: false, kind: "unsupported_limits" });
  pass("un plan sans plafond quotidien de messages ⇒ unsupported_limits (jamais « illimité » par accident)");
}

// ---------------------------------------------------------------------------
// 6. Transport failures
// ---------------------------------------------------------------------------
{
  const { impl } = makeFetch(() => jsonResponse({ message: "boom" }, 500));
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "unavailable");
  assert.match(outcome.detail, /answered 500/);
  pass("RPC en erreur 500 ⇒ unavailable (aucun repli mémoire, aucune autorisation accordée)");
}

{
  const { impl } = makeFetch(() => {
    throw new TypeError("network down");
  });
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.kind, "unavailable");
  assert.match(outcome.detail, /unreachable/);
  pass("réseau injoignable ⇒ unavailable, sans exception propagée");
}

{
  const { impl } = makeFetch(
    (call) =>
      new Promise((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  );
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW, timeoutMs: 20 },
  );
  assert.equal(outcome.kind, "unavailable");
  assert.match(outcome.detail, /timed out/);
  assert.equal(outcome.applied, "unknown", "une requête émise ne permet jamais d'affirmer « rien n'a été écrit »");
  pass("RPC qui ne répond pas ⇒ abandon après le délai, unavailable avec un motif exploitable");
}

// ---------------------------------------------------------------------------
// 6b. « applied » — ce qu'un échec démontre réellement
// ---------------------------------------------------------------------------
// Règle du module : « no » n'est produit que par un refus pré-vol, avant toute
// émission. Un code HTTP reçu par ce client ne prouve ni sa provenance
// (PostgREST, edge Supabase, proxy) ni qu'aucune écriture n'a eu lieu en amont.
// Ce bloc est le verrou contre la tentation de classer un 500 — ou un 4xx — en
// « pas appliqué ».
{
  const statuses = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];
  for (const status of statuses) {
    const { impl } = makeFetch(() => jsonResponse({ message: "boom" }, status));
    const outcome = await consumeDurableUsage(
      { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
      { env: ENV, fetchImpl: impl, now: () => NOW },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "unavailable");
    assert.equal(outcome.applied, "unknown", `HTTP ${status} ne démontre pas l'absence d'écriture`);
  }
  pass(`classification : ${statuses.length} codes HTTP (dont 500) ⇒ applied « unknown », aucune preuve supposée`);
}

{
  // Réseau injoignable et timeout : dans les deux cas, la requête était partie.
  for (const mode of ["network", "timeout"]) {
    const { impl } = makeFetch((call) =>
      mode === "network"
        ? Promise.reject(new TypeError("fetch failed"))
        : new Promise((_resolve, reject) => {
            call.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
    );
    const outcome = await consumeDurableUsage(
      { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
      { env: ENV, fetchImpl: impl, now: () => NOW, timeoutMs: 20 },
    );
    assert.equal(outcome.kind, "unavailable");
    assert.equal(outcome.applied, "unknown");
  }
  pass("réseau injoignable et timeout ⇒ applied « unknown » : la requête avait été émise");
}

{
  // 200 OK mais corps illisible : l'instruction A tourné. C'est le cas le plus
  // dangereux, et il ne doit jamais être confondu avec une absence d'écriture
  // ni avec une simple erreur réseau.
  const { impl } = makeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  }));
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.kind, "unavailable");
  assert.equal(outcome.applied, "unknown");
  assert.match(outcome.detail, /unreadable response/);
  assert.doesNotMatch(outcome.detail, /unreachable/);
  pass("réponse 200 au corps illisible ⇒ applied « unknown » et motif distinct (l'instruction a bien été exécutée)");
}

// ---------------------------------------------------------------------------
// 6c. Horloge non finie — refus avant tout appel réseau
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch(() =>
    jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07", replayed: false }]),
  );

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const consumed = await consumeDurableUsage(
      { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false, nowMs: value },
      { env: ENV, fetchImpl: impl, now: () => NOW },
    );
    assert.equal(consumed.kind, "unavailable");
    assert.equal(consumed.applied, "no", "rien n'a été émis : l'absence de frappe est démontrable");
    assert.match(consumed.detail, /non-finite clock/);

    const refunded = await refundDurableUsage(
      { userId: USER_ID, consumptionId: CONSUMPTION_ID, nowMs: value },
      { env: ENV, fetchImpl: impl, now: () => NOW },
    );
    assert.equal(refunded.ok, false);
    assert.equal(refunded.kind, "unavailable");

    const read = await readDurableUsage(
      { userId: USER_ID, nowMs: value },
      { env: ENV, fetchImpl: impl, now: () => NOW },
    );
    assert.equal(read.ok, false);
    assert.equal(read.kind, "unavailable");
  }

  // Une horloge injectée non finie est refusée de la même façon.
  const injected = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => Number.NaN },
  );
  assert.equal(injected.kind, "unavailable");
  assert.equal(injected.applied, "no");

  assert.equal(calls.length, 0, "une horloge invalide ne doit provoquer aucun appel réseau");
  pass("horloge non finie (consume, refund, read) ⇒ unavailable + applied « no », aucune exception, aucun appel");
}

{
  const { impl } = makeFetch(() => jsonResponse([]));
  const outcome = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.kind, "unavailable");
  pass("réponse vide (aucune ligne) ⇒ unavailable : un verdict manquant n'est jamais un accord");
}

// ---------------------------------------------------------------------------
// 7. Refund — idempotent by contract, best effort by design
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch(() => jsonResponse([{ refunded: true, reason: null, usage_day: "2026-11-07" }]));
  const outcome = await refundDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(outcome, { ok: true, refunded: true, usageDay: "2026-11-07" });
  assert.equal(calls[0].url, `${SUPABASE_URL}/rest/v1/rpc/${USAGE_RPC.refund}`);
  assert.deepEqual(calls[0].body, { p_user_id: USER_ID, p_consumption_id: CONSUMPTION_ID });
  pass("remboursement : POST /rpc/ai_usage_refund avec les deux identifiants, aucun autre paramètre");
}

{
  const { impl } = makeFetch(() => jsonResponse([{ refunded: false, reason: "not_refundable", usage_day: null }]));
  const outcome = await refundDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(outcome, { ok: true, refunded: false, usageDay: null });
  pass("second remboursement du même identifiant ⇒ refunded:false, sans erreur (idempotence côté SQL)");
}

{
  const { impl } = makeFetch(() => jsonResponse({}, 503));
  const outcome = await refundDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "unavailable");
  pass("échec du remboursement ⇒ résultat explicite, jamais une exception qui casserait la réponse en cours");
}

// ---------------------------------------------------------------------------
// 8. Read — read-only, zeros when the account has not consumed anything
// ---------------------------------------------------------------------------
{
  const { impl } = makeFetch(() => jsonResponse([]));
  const outcome = await readDurableUsage(
    { userId: USER_ID, nowMs: NOW },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(outcome, { ok: true, usageDay: utcDayKey(NOW), messages: 0, quotes: 0 });
  pass("lecture sans ligne ⇒ zéro consommé pour la journée UTC courante (pas d'erreur, pas de valeur inventée)");
}

{
  const { impl, calls } = makeFetch(() => jsonResponse([{ usage_day: "2026-11-07", used_messages: 7, used_quotes: 1 }]));
  const outcome = await readDurableUsage(
    { userId: USER_ID },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.deepEqual(outcome, { ok: true, usageDay: "2026-11-07", messages: 7, quotes: 1 });
  assert.equal(calls[0].url, `${SUPABASE_URL}/rest/v1/rpc/${USAGE_RPC.read}`);
  assert.deepEqual(calls[0].body, { p_user_id: USER_ID });
  pass("lecture : POST /rpc/ai_usage_read, un seul paramètre, aucune écriture possible");
}

// ---------------------------------------------------------------------------
// 9. No table access, ever — the decision that keeps the writes atomic
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch((call) => {
    if (call.url.includes(USAGE_RPC.refund)) return jsonResponse([{ refunded: true, usage_day: "2026-11-07" }]);
    if (call.url.includes(USAGE_RPC.read)) return jsonResponse([{ usage_day: "2026-11-07", used_messages: 1, used_quotes: 0 }]);
    return jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07", replayed: false }]);
  });

  await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  await refundDurableUsage({ userId: USER_ID, consumptionId: CONSUMPTION_ID }, { env: ENV, fetchImpl: impl, now: () => NOW });
  await readDurableUsage({ userId: USER_ID }, { env: ENV, fetchImpl: impl, now: () => NOW });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`), `appel hors RPC interdit : ${call.url}`);
    assert.ok(!call.url.includes("/rest/v1/ai_usage_"), `accès table interdit : ${call.url}`);
    assert.ok(!call.url.includes("/rest/v1/subscriptions"), "ce module ne touche jamais aux abonnements");
    assert.equal(call.headers.apikey, SERVICE_KEY);
  }
  pass("aucun accès direct aux tables : uniquement les trois RPC (les deux écritures restent dans une transaction)");
}

// ---------------------------------------------------------------------------
// 10. Default environment path
// ---------------------------------------------------------------------------
{
  const { impl, calls } = makeFetch(() => jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));
  await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { fetchImpl: impl, now: () => NOW },
    RAW_ENV,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bearer ${SERVICE_KEY}`);
  pass("les variables du serveur (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) alimentent le client RPC");
}

// ---------------------------------------------------------------------------
// 11. Refus avant appel — identité (L4), identifiant (L2), réponse (L5)
// ---------------------------------------------------------------------------
// Ces trois familles partagent une règle : une erreur du client ne doit jamais
// être présentée comme une panne du serveur, et une réponse illisible ne doit
// jamais être arrondie à zéro. Elles sont décidées AVANT toute émission réseau.
{
  // L4 — un compte absent ou inutilisable est une non-authentification (401).
  for (const userId of ["", "   ", "not-a-uuid", "1111", null, undefined]) {
    const { impl, calls } = makeFetch(() => jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));

    for (const outcome of [
      await consumeDurableUsage(
        { userId, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
        { env: ENV, fetchImpl: impl, now: () => NOW },
      ),
      await refundDurableUsage({ userId, consumptionId: CONSUMPTION_ID }, { env: ENV, fetchImpl: impl, now: () => NOW }),
      await readDurableUsage({ userId }, { env: ENV, fetchImpl: impl, now: () => NOW }),
    ]) {
      assert.equal(outcome.ok, false, `userId ${JSON.stringify(userId)} doit être refusé`);
      assert.equal(outcome.kind, "unauthenticated", `userId ${JSON.stringify(userId)} ⇒ unauthenticated`);
    }

    assert.equal(calls.length, 0, "un compte absent ne doit jamais atteindre le réseau");
  }

  // L'identité passe avant la configuration : un appelant non identifié reçoit
  // 401 même si le serveur est mal configuré — il doit se connecter, pas réessayer.
  const blankWithoutConfig = await consumeDurableUsage(
    { userId: "", consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: null, now: () => NOW },
  );
  assert.deepEqual(blankWithoutConfig, { ok: false, kind: "unauthenticated" });

  pass("L4 : compte absent, vide ou non-UUID ⇒ unauthenticated (401) sur consume, refund et read, sans appel réseau");
}

{
  // L2 — un identifiant qui n'est pas un UUID est une requête malformée (400).
  // Sans ce refus, PostgreSQL répondrait 22P02 et le module classerait la
  // réponse en « unavailable » : une faute de frappe deviendrait une panne.
  for (const consumptionId of ["", "   ", "abc", "8f14e45f-ceea-467f-a1b2", "not-a-uuid-at-all", `${CONSUMPTION_ID}x`]) {
    const { impl, calls } = makeFetch(() => jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));

    const consumed = await consumeDurableUsage(
      { userId: USER_ID, consumptionId, plan: "decouverte", isQuoteAnalysis: false },
      { env: ENV, fetchImpl: impl, now: () => NOW },
    );
    assert.equal(consumed.ok, false);
    assert.equal(consumed.kind, "invalid_identifier", `consommation ${JSON.stringify(consumptionId)} ⇒ invalid_identifier`);

    const refunded = await refundDurableUsage({ userId: USER_ID, consumptionId }, { env: ENV, fetchImpl: impl, now: () => NOW });
    assert.equal(refunded.ok, false);
    assert.equal(refunded.kind, "invalid_identifier", `remboursement ${JSON.stringify(consumptionId)} ⇒ invalid_identifier`);

    assert.equal(calls.length, 0, "un identifiant invalide ne doit jamais partir vers PostgREST");
  }

  // Un UUID valide en majuscules reste accepté : le motif est insensible à la casse.
  const { impl, calls } = makeFetch(() => jsonResponse([{ allowed: true, used_messages: 1, used_quotes: 0, usage_day: "2026-11-07" }]));
  const upper = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID.toUpperCase(), plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: impl, now: () => NOW },
  );
  assert.equal(upper.ok, true);
  assert.equal(calls.length, 1);

  pass("L2 : identifiant non-UUID ⇒ invalid_identifier (400) sans appel réseau ; UUID valide accepté quelle que soit la casse");
}

{
  // L5 — une réponse illisible est une erreur, jamais un zéro silencieux.
  const badCounts = [
    ["chaîne non numérique", "abc"],
    ["null", null],
    ["objet", {}],
    ["booléen", true],
    ["négatif", -1],
    ["fractionnaire", 1.5],
    ["NaN", Number.NaN],
  ];

  for (const [label, value] of badCounts) {
    const { impl } = makeFetch(() =>
      jsonResponse([{ allowed: true, used_messages: value, used_quotes: 0, usage_day: "2026-11-07", replayed: false }]),
    );
    const outcome = await consumeDurableUsage(
      { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
      { env: ENV, fetchImpl: impl, now: () => NOW },
    );
    assert.equal(outcome.ok, false, `compteur ${label} : jamais un accord`);
    assert.equal(outcome.kind, "invalid_response", `compteur ${label} ⇒ invalid_response`);
    assert.equal(outcome.applied, "unknown", "la fonction a répondu : rien ne prouve qu'aucune écriture n'a eu lieu");
    assert.notEqual(outcome.messages, 0, `compteur ${label} : aucun zéro inventé`);
  }

  // Le refus quotidien transporte aussi des compteurs : ils ne peuvent pas
  // devenir 0 sans mentir sur l'état du compte.
  const { impl: refusalImpl } = makeFetch(() =>
    jsonResponse([{ allowed: false, reason: "daily_messages", used_messages: "12abc", used_quotes: 0, usage_day: "2026-11-07" }]),
  );
  const refusal = await consumeDurableUsage(
    { userId: USER_ID, consumptionId: CONSUMPTION_ID, plan: "decouverte", isQuoteAnalysis: false },
    { env: ENV, fetchImpl: refusalImpl, now: () => NOW },
  );
  assert.equal(refusal.kind, "invalid_response");

  // Lecture : des compteurs illisibles ne deviennent pas « 0 consommé ».
  const { impl: readImpl } = makeFetch(() => jsonResponse([{ usage_day: "2026-11-07", used_messages: {}, used_quotes: null }]));
  const read = await readDurableUsage({ userId: USER_ID }, { env: ENV, fetchImpl: readImpl, now: () => NOW });
  assert.equal(read.ok, false);
  assert.equal(read.kind, "invalid_response");

  // Remboursement : un verdict non booléen n'est jamais interprété comme « false ».
  const { impl: refundImpl } = makeFetch(() => jsonResponse([{ refunded: "yes", usage_day: "2026-11-07" }]));
  const refund = await refundDurableUsage({ userId: USER_ID, consumptionId: CONSUMPTION_ID }, { env: ENV, fetchImpl: refundImpl, now: () => NOW });
  assert.equal(refund.ok, false);
  assert.equal(refund.kind, "invalid_response");

  pass("L5 : compteurs non entiers (7 formes) et verdict non booléen ⇒ invalid_response, jamais un 0 inventé");
}

{
  // Robustesse symétrique : une chaîne strictement numérique reste un compteur.
  const { impl } = makeFetch(() => jsonResponse([{ usage_day: "2026-11-07", used_messages: "7", used_quotes: "0" }]));
  const outcome = await readDurableUsage({ userId: USER_ID }, { env: ENV, fetchImpl: impl, now: () => NOW });
  assert.deepEqual(outcome, { ok: true, usageDay: "2026-11-07", messages: 7, quotes: 0 });
  pass("lecture : « 7 » reste un compteur valide — le refus porte sur l'illisible, pas sur le format JSON");
}

{
  // La table de correspondance est la seule autorité : aucun statut inventé.
  assert.deepEqual(
    {
      unauthenticated: usageFailureStatus("unauthenticated"),
      invalid_identifier: usageFailureStatus("invalid_identifier"),
      duplicate: usageFailureStatus("duplicate"),
      conflict: usageFailureStatus("conflict"),
      daily_messages: usageFailureStatus("daily_messages"),
      daily_quotes: usageFailureStatus("daily_quotes"),
      invalid_response: usageFailureStatus("invalid_response"),
      not_configured: usageFailureStatus("not_configured"),
      unavailable: usageFailureStatus("unavailable"),
      unsupported_limits: usageFailureStatus("unsupported_limits"),
    },
    {
      unauthenticated: 401,
      invalid_identifier: 400,
      duplicate: 409,
      conflict: 409,
      daily_messages: 429,
      daily_quotes: 429,
      invalid_response: 503,
      not_configured: 503,
      unavailable: 503,
      unsupported_limits: 503,
    },
  );

  // Chaque type d'échec doit être couvert : un statut manquant retomberait en 503.
  for (const kind of [
    "unauthenticated",
    "invalid_identifier",
    "invalid_response",
    "not_configured",
    "unavailable",
    "unsupported_limits",
    "duplicate",
    "conflict",
    "daily_messages",
    "daily_quotes",
  ]) {
    const status = usageFailureStatus(kind);
    assert.ok([400, 401, 409, 429, 503].includes(status), `${kind} ⇒ statut inattendu ${status}`);
  }

  pass("usageFailureStatus : 401 · 400 · 409 · 429 · 503 — une seule table, aucun statut improvisé côté route");
}

console.log(`\n${checks} vérifications du magasin d'usage durable passées.`);
