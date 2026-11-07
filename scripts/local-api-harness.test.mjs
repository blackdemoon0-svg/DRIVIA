/**
 * Local harness for api/chat.ts — no Vercel, no Supabase, no provider.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT CHANGED, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * The first version of this file asserted the *business* refusals (a
 * `garage-quote` task without an attachment must answer 400, a missing API key
 * must answer 503, the legacy VEYDRIVO_* / DRIVIA_* names must still be read).
 * Those assertions became unreachable the day `api/chat.ts` moved
 * authentication **before** every other check: without a verified session the
 * handler answers 401 or 503 and never reaches body validation. The suite kept
 * failing — and nobody noticed, because it was not part of `npm test`.
 *
 * It is now part of it, and it asserts the contract that actually exists:
 *
 *   405  wrong method, before anything else
 *   503  the account service is not configured (fail closed)
 *   401  no token, or a token that cannot even be parsed
 *   503  the session could not be verified (network/upstream failure)
 *
 * and, above all, the invariant the old file was silently documenting the
 * opposite of: **no request may reach the provider, and no body validation may
 * run, before the caller is authenticated.**
 *
 * The provider-configuration assertions are gone on purpose: reaching them now
 * requires a real Supabase session, which is an integration test for Preview
 * (P7), not a static harness. What remains is exactly what can be proven here.
 *
 * `globalThis.fetch` is replaced for the duration of every call: the harness
 * records the URLs the handler *would* have contacted, so "no provider call"
 * is an observation, not a promise.
 */
import handler from "../api/chat.ts";
import assert from "node:assert";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

/** Every variable the handler may read, so each case starts from a known state. */
const MANAGED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VEYVRO_AI_API_KEY",
  "VEYDRIVO_AI_API_KEY",
  "DRIVIA_AI_API_KEY",
  "VEYVRO_AI_PROVIDER",
  "VEYVRO_AI_BASE_URL",
  "VEYVRO_AI_MODEL",
];

const SUPABASE_URL = "https://harness.supabase.test";
const CONFIGURED = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: "anon-key-for-the-harness",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-the-harness",
};

function makeRes(label, record) {
  let statusCode = 200;
  const headers = {};
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      record[label] = { status: statusCode, body, headers: { ...headers } };
    },
    setHeader(name, value) {
      headers[name] = value;
      return this;
    },
    write() {
      return true;
    },
    end() {},
  };
}

/**
 * Run one request with an exact environment, a recording fetch stub and no real
 * network. Returns the response plus every URL the handler tried to contact.
 */
async function call({ body = undefined, method = "POST", headers = {}, env = {} } = {}) {
  const saved = new Map();
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const record = {};
  const attempted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    attempted.push(String(url));
    throw new TypeError("network disabled in this harness");
  };

  try {
    await handler({ method, body, headers }, makeRes("result", record));
  } finally {
    globalThis.fetch = realFetch;
    for (const key of MANAGED_ENV) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.ok(record.result, "le handler doit toujours produire une réponse");
  return { ...record.result, attempted };
}

/** The validation messages that must never be reachable before authentication. */
const BODY_VALIDATION = [
  "A user message is required",
  "Request body must be valid JSON",
  "The requested analysis task is not supported",
];

function assertNoBodyValidation(result, context) {
  const serialized = JSON.stringify(result.body ?? {});
  for (const message of BODY_VALIDATION) {
    assert.ok(
      !serialized.includes(message),
      `${context} : la validation du corps a été atteinte avant l'authentification (${message})`,
    );
  }
  assert.notEqual(result.status, 400, `${context} : 400 avant authentification — la garde d'accès a été contournée`);
}

// ---------------------------------------------------------------------------
// 1. Method guard — the only check that precedes authentication
// ---------------------------------------------------------------------------
{
  const result = await call({ method: "GET" });
  assert.equal(result.status, 405);
  assert.match(result.body.error, /Only POST requests are supported/);
  assert.equal(result.attempted.length, 0, "aucun appel réseau pour une méthode refusée");
  pass("GET /api/chat → 405, avant toute authentification et sans aucun appel réseau");
}

// ---------------------------------------------------------------------------
// 2. Fail closed when the account service is not configured (503)
// ---------------------------------------------------------------------------
{
  const result = await call({ body: { messages: [{ role: "user", content: "bonjour" }] } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "not_configured");
  assert.equal(result.attempted.length, 0, "une configuration absente n'émet aucune requête");
  assertNoBodyValidation(result, "configuration absente");

  pass("configuration absente → 503 not_configured, fail closed, aucun appel réseau");
}

// ---------------------------------------------------------------------------
// 3. No token at all → 401, without any network call
// ---------------------------------------------------------------------------
{
  const result = await call({
    body: { messages: [{ role: "user", content: "bonjour" }], task: "garage-quote" },
    env: CONFIGURED,
  });
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "auth_required");
  assert.equal(result.attempted.length, 0, "sans jeton, aucune requête n'est émise — pas même vers /auth/v1/user");
  assertNoBodyValidation(result, "sans jeton");

  pass("POST sans jeton → 401 auth_required, sans appel réseau, même avec un corps invalide");
}

// ---------------------------------------------------------------------------
// 4. A token that cannot be parsed is not "sent upstream" — 401, no network
// ---------------------------------------------------------------------------
{
  const unparsable = ["Bearer short", "Basic abcdefghijklmnopqrstuvwxyz", "Bearer no.dot.segments.here.but.long.enough"];

  for (const header of unparsable) {
    const result = await call({
      body: { messages: [{ role: "user", content: "bonjour" }] },
      headers: { authorization: header },
      env: CONFIGURED,
    });
    assert.equal(result.status, 401, `jeton ${JSON.stringify(header)} → 401`);
    assert.equal(result.body.code, "auth_required");
    assert.equal(result.attempted.length, 0, "un jeton illisible ne part pas vers Supabase");
    assertNoBodyValidation(result, "jeton illisible");
  }

  pass("jetons illisibles (3 formes) → 401 auth_required, aucun appel réseau");
}

// ---------------------------------------------------------------------------
// 5. A well-formed token is verified upstream — and only there
// ---------------------------------------------------------------------------
{
  const jwtLike = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJlLWhhcm5haXM";
  const result = await call({
    body: { messages: [{ role: "user", content: "bonjour" }] },
    headers: { authorization: `Bearer ${jwtLike}` },
    env: CONFIGURED,
  });

  // The harness fetch always fails: the identity cannot be verified, so the
  // handler must answer 503 — never a default plan, never a 400.
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "identity_unavailable");
  assertNoBodyValidation(result, "session invérifiable");

  assert.equal(result.attempted.length, 1, "un seul appel : la vérification de session");
  assert.ok(
    result.attempted[0].startsWith(`${SUPABASE_URL}/auth/v1/user`),
    `seul /auth/v1/user doit être contacté, or : ${result.attempted[0]}`,
  );
  assert.ok(
    !result.attempted.some((url) => url.includes("/chat/completions")),
    "le fournisseur IA ne doit jamais être appelé avant une session vérifiée",
  );
  assert.ok(
    !result.attempted.some((url) => url.includes("/rest/v1/subscriptions")),
    "le plan n'est lu qu'après une identité vérifiée",
  );

  pass("session invérifiable → 503 identity_unavailable ; seul /auth/v1/user est contacté, jamais le fournisseur");
}

// ---------------------------------------------------------------------------
// 6. Regression lock — authentication cannot move back behind body validation
// ---------------------------------------------------------------------------
{
  const bodies = [
    undefined,
    "not json at all",
    {},
    { messages: [] },
    { messages: [{ role: "user", content: "bonjour" }], task: "garage-quote" },
    { messages: [{ role: "user", content: "bonjour" }], task: "une-autre-tache" },
  ];

  let seen = 0;
  for (const body of bodies) {
    const result = await call({ body, env: CONFIGURED });
    assert.equal(result.status, 401, "un corps quelconque sans jeton reste un refus d'authentification");
    assert.equal(result.body.code, "auth_required");
    assertNoBodyValidation(result, "verrou d'ordre");
    seen += 1;
  }

  assert.ok(seen >= 6);
  pass(`verrou d'ordre : 6 corps différents sans jeton → tous 401, aucune validation de corps atteinte`);
}

// ---------------------------------------------------------------------------
// 7. The harness itself must not depend on ambient configuration
// ---------------------------------------------------------------------------
{
  const before = { ...process.env };
  await call({ env: CONFIGURED });
  const after = { ...process.env };

  for (const key of MANAGED_ENV) {
    assert.equal(after[key], before[key], `la variable ${key} doit être restaurée après le test`);
  }

  pass("isolation : chaque cas part d'un environnement connu et le restaure");
}

console.log(`\n${checks} vérifications du harnais API local passées.`);
