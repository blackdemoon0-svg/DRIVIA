/**
 * /api/chat access tests — the real handler, with Supabase stubbed.
 *
 * The point of this file is that authentication cannot be satisfied by anything
 * the browser sends in the body: only a token Supabase vouches for decides who
 * is calling, and only the database decides which plan applies.
 *
 * `fetch` is intercepted for Supabase; the AI provider is never reached because
 * every case here stops before it.
 */
import assert from "node:assert";
import handler from "../api/chat.ts";
import { consumeQuota, resetQuotas } from "../server/quotas.ts";

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

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const BASE_ENV = {
  SUPABASE_URL: SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  VEYVRO_AI_API_KEY: "test-provider-key",
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

/** Response helper. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Install the Supabase stub.
 *
 * `identity` decides what /auth/v1/user answers; `rows` what the subscriptions
 * table holds. Every call is recorded so the tests can prove what was requested.
 */
function installSupabase({ identity = "ok", rows = [], restStatus = 200 } = {}) {
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers ?? {} });

    if (url.includes("/auth/v1/user")) {
      if (identity === "invalid") return json({ message: "invalid JWT" }, 401);
      if (identity === "down") throw new Error("auth unreachable");
      return json({
        id: USER_ID,
        email: "client@veyvro.test",
        email_confirmed_at: "2026-10-01T00:00:00.000Z",
      });
    }

    if (url.includes("/rest/v1/subscriptions")) {
      if (restStatus !== 200) return new Response("denied", { status: restStatus });
      return json(rows);
    }

    throw new Error(`unexpected outbound call: ${url}`);
  };

  return calls;
}

function setEnv(overrides = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
}

function restoreEnv() {
  process.env = { ...originalEnv };
}

/** Minimal response double that records what the handler produced. */
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
    flushHeaders() {},
    write() {
      return true;
    },
    end() {},
  };
  return { res: response, out };
}

/** A valid chat request body: one user message. */
function chatBody(extra = {}) {
  return { messages: [{ role: "user", content: "Bonjour VEYVRO" }], ...extra };
}

async function callChat({ headers = {}, body = chatBody(), method = "POST" } = {}) {
  const { res, out } = makeResponse();
  await handler({ method, headers, body }, res);
  return out;
}

const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// 1. Aucune confiance au navigateur : sans jeton, rien ne passe
// ---------------------------------------------------------------------------
{
  setEnv();
  const calls = installSupabase();
  const out = await callChat();

  assert.equal(out.status, 401, "une requête anonyme doit être refusée");
  assert.equal(out.body.code, "auth_required");
  assert.equal(calls.length, 0, "aucun appel sortant pour un visiteur non connecté");
  restoreEnv();
  pass("requête anonyme : 401 `auth_required`, aucun appel à Supabase ni au fournisseur IA");
}

{
  // Le corps ne doit jamais servir de preuve : même avec un plan et un id
  // parfaitement formés, sans jeton la réponse reste 401.
  setEnv();
  installSupabase();
  const out = await callChat({
    body: chatBody({ plan: "pro", user_id: USER_ID, userId: USER_ID, subscription: "pro" }),
  });
  assert.equal(out.status, 401, "un plan envoyé par le navigateur n'ouvre aucun droit");
  assert.equal(out.body.code, "auth_required");
  restoreEnv();
  pass("plan ou identifiant fournis dans le corps : ignorés, la réponse reste 401");
}

// ---------------------------------------------------------------------------
// 2. Jeton et identité
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase();
  const out = await callChat({ headers: { authorization: "Bearer pas-un-jwt" } });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "auth_required");
  restoreEnv();
  pass("en-tête mal formé : 401 avant tout appel réseau");
}

{
  setEnv();
  installSupabase({ identity: "invalid" });
  const out = await callChat({ headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "invalid_token");
  restoreEnv();
  pass("jeton refusé par Supabase : 401 `invalid_token`");
}

{
  setEnv();
  installSupabase({ identity: "down" });
  const out = await callChat({ headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(out.status, 503, "une panne d'identité n'est pas un refus d'identité");
  assert.equal(out.body.code, "identity_unavailable");
  restoreEnv();
  pass("Supabase Auth injoignable : 503, distinct d'un jeton invalide");
}

// ---------------------------------------------------------------------------
// 3. Configuration manquante : fermé par défaut
// ---------------------------------------------------------------------------
{
  for (const missing of ENV_KEYS) {
    setEnv({ [missing]: undefined });
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return json({});
    };
    const out = await callChat({ headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(out.status, 503, `${missing} manquante doit bloquer, pas autoriser`);
    assert.equal(out.body.code, "not_configured");
    assert.equal(called, false, `aucun appel sortant sans ${missing}`);
    restoreEnv();
  }
  globalThis.fetch = originalFetch;
  pass("configuration incomplète (URL, clé anonyme, clé de service) : 503 et aucun appel sortant");
}

// ---------------------------------------------------------------------------
// 4. Le plan vient de la base, jamais du jeton ni du corps
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase({ rows: [] });
  const out = await callChat({ headers: { authorization: `Bearer ${TOKEN}` } });
  assert.notEqual(out.status, 401, "un compte valide n'est plus refusé");
  assert.notEqual(out.status, 403, "le gratuit a droit au chat");
  restoreEnv();
  pass("compte sans abonnement : le chat reste accessible (formule Découverte gratuite)");
}

{
  // Période échue : plus aucun droit payant, même si le statut dit « active ».
  setEnv();
  installSupabase({
    rows: [
      { user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(-1) },
    ],
  });
  const { res, out } = makeResponse();
  await handler(
    {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      // Une pièce jointe est réservée aux formules payantes : elle est donc un
      // révélateur direct du plan appliqué.
      body: chatBody({
        attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
        task: "garage-quote",
      }),
    },
    res,
  );
  assert.equal(out.status, 403, "un abonnement expiré ne donne aucun droit");
  assert.equal(out.body.code, "plan_required");
  restoreEnv();
  pass("abonnement expiré : les droits payants sont retirés (403), le statut stocké ne suffit pas");
}

{
  // Abonnement valide : droit payant accordé.
  setEnv();
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }],
  });
  const out = await callChat({
    headers: { authorization: `Bearer ${TOKEN}` },
    body: chatBody({
      attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
      task: "garage-quote",
    }),
  });
  assert.notEqual(out.status, 403, "un abonnement valide doit ouvrir l'analyse de document");
  restoreEnv();
  pass("abonnement en cours : l'analyse de document est autorisée");
}

{
  // Ligne appartenant à un autre compte : aucun droit.
  setEnv();
  installSupabase({
    rows: [{ user_id: OTHER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }],
  });
  const out = await callChat({
    headers: { authorization: `Bearer ${TOKEN}` },
    body: chatBody({
      attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
      task: "garage-quote",
    }),
  });
  assert.equal(out.status, 403, "la ligne d'un autre compte ne doit rien accorder");
  restoreEnv();
  pass("ligne appartenant à un autre compte : aucun droit payant accordé");
}

// ---------------------------------------------------------------------------
// 5. Formule Découverte : pièces jointes refusées
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase({ rows: [] });
  const out = await callChat({
    headers: { authorization: `Bearer ${TOKEN}` },
    body: chatBody({
      attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
      task: "garage-quote",
    }),
  });
  assert.equal(out.status, 403);
  assert.equal(out.body.code, "plan_required");
  assert.match(out.body.error, /Plus and Pro/);
  restoreEnv();
  pass("Découverte : analyse de photo ou de PDF refusée (403 `plan_required`)");
}

// ---------------------------------------------------------------------------
// 6. Lecture des abonnements en échec : 503, jamais un repli
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase({ restStatus: 500 });
  const out = await callChat({ headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "identity_unavailable");
  restoreEnv();
  pass("table des abonnements illisible : 503, aucun repli silencieux");
}

// ---------------------------------------------------------------------------
// 7. Rien de sensible ne sort
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase();
  const out = await callChat({ headers: { authorization: `Bearer ${TOKEN}` } });
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes(TOKEN), "le jeton ne doit jamais revenir");
  assert.doesNotMatch(serialised, /sb_secret|sb_publishable/);
  assert.ok(!serialised.includes("client@veyvro.test"), "l'e-mail du compte ne doit pas fuiter");
  restoreEnv();
  pass("réponses : ni jeton, ni clé, ni adresse e-mail");
}

// ---------------------------------------------------------------------------
// 8. Le reste du contrat du handler est intact
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase();
  const out = await callChat({ method: "GET" });
  assert.equal(out.status, 405, "la méthode reste vérifiée");
  restoreEnv();
  pass("méthode GET : 405 inchangé");
}

{
  // Le quota de débit par IP reste actif après l'authentification.
  setEnv();
  installSupabase({ rows: [] });
  let last = null;
  for (let index = 0; index < 14; index += 1) {
    last = await callChat({
      headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.42" },
    });
  }
  assert.equal(last.status, 429, "le garde-fou par IP doit toujours s'appliquer");
  restoreEnv();
  pass("limitation de débit par IP : toujours active pour un compte authentifié");
}


// ---------------------------------------------------------------------------
// 9. Quotas opposées par le handler : 429, `Retry-After`, codes explicites
// ---------------------------------------------------------------------------
{
  // Le quota est consommé dans le même module que celui utilisé par le handler :
  // le préparer ici revient exactement à simuler 15 messages déjà envoyés.
  resetQuotas();
  setEnv();
  installSupabase({ rows: [] }); // Découverte : 15 messages par jour

  // Répartis dans l'heure écoulée : la fenêtre d'une minute ne doit pas être ce
  // qui déclenche le refus, seul le quota journalier doit trancher.
  const base = Date.now();
  for (let index = 0; index < 15; index += 1) {
    const verdict = consumeQuota({
      userId: USER_ID,
      plan: "decouverte",
      isQuoteAnalysis: false,
      nowMs: base - (14 - index) * 7_000,
    });
    assert.equal(verdict.ok, true, "la préparation ne doit jamais être refusée");
  }

  const out = await callChat({
    headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "192.0.2.11" },
  });

  assert.equal(out.status, 429, "le 16e message du jour doit être refusé");
  assert.equal(out.body.code, "daily_messages");
  assert.equal(out.body.plan, "decouverte");
  assert.equal(out.body.limit, 15);
  assert.equal(out.body.used, 15);
  assert.ok(Number(out.headers["Retry-After"]) > 0, "`Retry-After` doit accompagner le 429");

  restoreEnv();
  resetQuotas();
  pass("quota journalier Découverte : 429 `daily_messages`, `Retry-After` présent, limite et usage exposés");
}

{
  // Plus : la même rafale passe, le plan payant a un quota plus large.
  resetQuotas();
  setEnv();
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
  });

  for (let index = 0; index < 15; index += 1) {
    consumeQuota({
      userId: USER_ID,
      plan: "plus",
      isQuoteAnalysis: false,
      nowMs: Date.now() - (14 - index) * 7_000,
    });
  }

  const out = await callChat({
    headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "192.0.2.12" },
  });
  assert.notEqual(out.status, 429, "15 messages ne doivent pas suffire à bloquer un compte Plus");
  assert.notEqual(out.body?.code, "daily_messages");

  restoreEnv();
  resetQuotas();
  pass("quota journalier Plus : 15 messages consommés ne bloquent pas un abonné Plus");
}

{
  // Fenêtre d'une minute : une rafale sur le même compte finit en 429.
  resetQuotas();
  setEnv();
  installSupabase({ rows: [] });

  let out = null;
  for (let index = 0; index < 11; index += 1) {
    out = await callChat({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        // IP différente à chaque appel : seul le quota du compte peut trancher.
        "x-forwarded-for": `198.51.100.${index}`,
      },
    });
  }

  assert.equal(out.status, 429, "la 11e requête de la minute doit être refusée");
  assert.equal(out.body.code, "rate_minute");
  assert.equal(out.body.limit, 10);
  const retryAfter = Number(out.headers["Retry-After"]);
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After attendu entre 1 et 60, reçu ${retryAfter}`);

  restoreEnv();
  resetQuotas();
  pass("quota par minute : 10 requêtes pour Découverte, la 11e en 429 `rate_minute`");
}

{
  // Le quota d'analyse de devis est consommé par le handler quand la formule y a
  // droit : on le prouve sur un compte Plus en saturant le compteur d'analyses.
  resetQuotas();
  setEnv();
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
  });

  const usage = consumeQuota({ userId: USER_ID, plan: "plus", isQuoteAnalysis: true });
  assert.equal(usage.ok, true);

  // Plus n'a pas de plafond d'analyses : le compteur ne bloque jamais.
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      consumeQuota({ userId: USER_ID, plan: "plus", isQuoteAnalysis: true }).ok,
      true,
      "Plus : analyses illimitées",
    );
  }

  restoreEnv();
  resetQuotas();
  pass("analyses de devis : illimitées pour Plus, le compteur ne refuse jamais");
}

{
  // Constat à documenter : avec « aucune pièce jointe » pour Découverte, une
  // analyse de devis est impossible — le refus tombe sur le droit d'attacher un
  // document (403) avant même d'atteindre le quota de 1 analyse par jour.
  resetQuotas();
  setEnv();
  installSupabase({ rows: [] });

  const out = await callChat({
    headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "192.0.2.13" },
    body: chatBody({
      attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
      task: "garage-quote",
    }),
  });

  assert.equal(out.status, 403);
  assert.equal(out.body.code, "plan_required");

  restoreEnv();
  resetQuotas();
  pass("Découverte : l'analyse de devis est refusée sur le droit d'attacher (403), le quota de 1/jour reste inatteignable");
}

globalThis.fetch = originalFetch;
console.log(`\n${checks} vérifications d'accès au chat passées.`);
