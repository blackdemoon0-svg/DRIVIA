/**
 * Tests for api/paddle-attribution.ts — the route that mints the proof.
 *
 * Supabase is replaced by a stub, so no token, key or network call is real. The
 * point of these tests is that the identity comes from the *token*, never from
 * anything the caller sends.
 */
import crypto from "node:crypto";
import assert from "node:assert";
import handler from "../api/paddle-attribution.ts";
import { computeAttributionProof, verifyAttributionProof } from "../server/attribution";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const SECRET = crypto.randomBytes(32).toString("hex");
const ANON_KEY = `sb_publishable_${crypto.randomBytes(8).toString("hex")}`;
const SUPABASE_URL = "https://stub-project.supabase.co";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_USER_ID = "99999999-8888-7777-6666-555555555555";

/** Structurally valid JWT (3 segments, long enough); never verified locally. */
function fakeJwt(label = "token") {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: label, exp: 9_999_999_999 })}.${"s".repeat(40)}`;
}

const GOOD_TOKEN = fakeJwt("good");

// ---------------------------------------------------------------------------
// Supabase stub: /auth/v1/user decides who the token belongs to
// ---------------------------------------------------------------------------
function installSupabaseStub({ users = {}, status = 200 } = {}) {
  const original = globalThis.fetch;
  const seen = { calls: 0, lastHeaders: null, lastUrl: null };

  globalThis.fetch = async (url, init = {}) => {
    seen.calls += 1;
    seen.lastUrl = String(url);
    seen.lastHeaders = new Headers(init.headers);
    if (String(url).includes("/auth/v1/user")) {
      const token = (seen.lastHeaders.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const user = users[token];
      if (status !== 200) {
        return new Response(JSON.stringify({ message: "nope" }), { status });
      }
      if (!user) {
        return new Response(JSON.stringify({ message: "invalid claim" }), { status: 401 });
      }
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
  };

  return {
    seen,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function makeResponse() {
  let statusCode = 200;
  const out = { status: statusCode, body: null, headers: {} };
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(body) {
      out.status = statusCode;
      out.body = body;
    },
    setHeader(name, value) {
      out.headers[name] = value;
    },
  };
  return { res, out };
}

async function call({ method = "POST", authorization, env = {}, body } = {}) {
  const saved = { ...process.env };
  for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "PADDLE_WEBHOOK_SECRET"]) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    SUPABASE_URL,
    SUPABASE_ANON_KEY: ANON_KEY,
    PADDLE_WEBHOOK_SECRET: SECRET,
    ...env,
  });

  const headers = {};
  if (authorization !== undefined) headers.authorization = authorization;

  const { res, out } = makeResponse();
  await handler({ method, headers, body }, res);
  process.env = saved;
  return out;
}

// ---------------------------------------------------------------------------
// 1. Transport and method guards
// ---------------------------------------------------------------------------
{
  const out = await call({ method: "GET", authorization: `Bearer ${GOOD_TOKEN}` });
  assert.equal(out.status, 405);
  pass("méthode autre que POST : 405");
}

{
  const out = await call({});
  assert.equal(out.status, 401);
  assert.match(out.body.error, /access token is required/);
  assert.equal(out.headers["Cache-Control"].includes("no-store"), true);
  pass("sans en-tête Authorization : 401, réponse non cachable");
}

{
  for (const header of ["Bearer court", "Basic abc", `Token ${GOOD_TOKEN}`, `Bearer ${"a".repeat(80)}`]) {
    const out = await call({ authorization: header });
    assert.equal(out.status, 401, `en-tête ${header.slice(0, 12)}… doit être refusé`);
  }
  pass("en-têtes malformés (pas un Bearer JWT à 3 segments) : 401");
}

{
  const out = await call({ authorization: `Bearer ${GOOD_TOKEN}`, env: { PADDLE_WEBHOOK_SECRET: "" } });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /not configured/);
  pass("secret manquant : 503, aucune preuve émise");
}

{
  const out = await call({ authorization: `Bearer ${GOOD_TOKEN}`, env: { SUPABASE_ANON_KEY: "" } });
  assert.equal(out.status, 503);
  pass("configuration Supabase incomplète : 503");
}

// ---------------------------------------------------------------------------
// 2. Identity comes from the token, never from the caller
// ---------------------------------------------------------------------------
{
  const stub = installSupabaseStub({
    users: { [GOOD_TOKEN]: { id: USER_ID, email: "client@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  const out = await call({ authorization: `Bearer ${GOOD_TOKEN}` });
  stub.restore();

  assert.equal(out.status, 200);
  assert.equal(out.body.userId, USER_ID);
  assert.equal(verifyAttributionProof(SECRET, USER_ID, out.body.proof), true);
  assert.deepEqual(Object.keys(out.body).sort(), ["proof", "userId"]);
  // No email, no token, no session in the response.
  const serialized = JSON.stringify(out.body);
  assert.equal(serialized.includes("client@veyvro.test"), false);
  assert.equal(serialized.includes(GOOD_TOKEN), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(ANON_KEY), false);
  pass("jeton valide : preuve valide renvoyée, réponse limitée à { userId, proof }");
}

{
  // A userId in the body must be ignored: the identity is the token's.
  const stub = installSupabaseStub({
    users: { [GOOD_TOKEN]: { id: USER_ID, email: "client@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  const out = await call({
    authorization: `Bearer ${GOOD_TOKEN}`,
    body: { userId: OTHER_USER_ID, user_id: OTHER_USER_ID },
  });
  stub.restore();

  assert.equal(out.body.userId, USER_ID, "un userId fourni par le client doit être ignoré");
  assert.equal(verifyAttributionProof(SECRET, OTHER_USER_ID, out.body.proof), false);
  pass("userId injecté dans le corps : ignoré, la preuve reste celle du jeton");
}

{
  const stub = installSupabaseStub({ users: {} }); // token unknown to Supabase
  const out = await call({ authorization: `Bearer ${GOOD_TOKEN}` });
  stub.restore();
  assert.equal(out.status, 401);
  assert.match(out.body.error, /Invalid or expired/);
  pass("jeton inconnu ou expiré : 401, aucune preuve");
}

{
  const stub = installSupabaseStub({ status: 500 });
  const out = await call({ authorization: `Bearer ${GOOD_TOKEN}` });
  stub.restore();
  assert.equal(out.status, 503);
  assert.match(out.body.error, /unavailable/);
  pass("fournisseur d'identité indisponible : 503 (retryable), pas de preuve");
}

{
  const stub = installSupabaseStub({
    users: { [GOOD_TOKEN]: { id: USER_ID, email: "client@veyvro.test", email_confirmed_at: null } },
  });
  const out = await call({ authorization: `Bearer ${GOOD_TOKEN}` });
  stub.restore();
  assert.equal(out.status, 403);
  assert.equal(out.body.proof, undefined);
  pass("adresse non confirmée : 403, aucune preuve émise");
}

// ---------------------------------------------------------------------------
// 3. Server-to-server call hygiene
// ---------------------------------------------------------------------------
{
  const stub = installSupabaseStub({
    users: { [GOOD_TOKEN]: { id: USER_ID, email: "client@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  await call({ authorization: `Bearer ${GOOD_TOKEN}` });
  const { seen } = stub;
  stub.restore();

  assert.match(seen.lastUrl, /\/auth\/v1\/user$/);
  assert.equal(seen.lastHeaders.get("apikey"), ANON_KEY);
  assert.equal(seen.lastHeaders.get("Authorization"), `Bearer ${GOOD_TOKEN}`);
  pass("appel Supabase : /auth/v1/user avec apikey anon + jeton utilisateur");
}

// ---------------------------------------------------------------------------
// 4. Round trip: minted proof is exactly what the webhook expects
// ---------------------------------------------------------------------------
{
  const stub = installSupabaseStub({
    users: { [GOOD_TOKEN]: { id: USER_ID, email: "client@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  const out = await call({ authorization: `Bearer ${GOOD_TOKEN}` });
  stub.restore();

  // Same derivation the webhook uses, from the same secret.
  assert.equal(out.body.proof, computeAttributionProof(SECRET, USER_ID));
  assert.equal(verifyAttributionProof(SECRET, USER_ID, out.body.proof), true);
  // Re-targeting the proof at another account fails.
  assert.equal(verifyAttributionProof(SECRET, OTHER_USER_ID, out.body.proof), false);
  pass("aller-retour : la preuve émise est exactement celle attendue par le webhook");
}

console.log(`\n${checks} vérifications de l'attribution passées.`);
