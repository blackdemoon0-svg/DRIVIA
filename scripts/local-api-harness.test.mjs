/**
 * Local smoke harness for api/chat.ts (no Vercel, no real provider).
 * Simulates the Vercel req/res objects and asserts the handler's public
 * behavior: method guard, task validation, env-var fallback (the previous
 * VEYDRIVO_* names and the original DRIVIA_* names) and the missing-key path.
 */
import handler from "../api/chat.ts";
import assert from "node:assert";

function makeRes(label, record) {
  let statusCode = 200;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      record[label] = { status: statusCode, body };
    },
    setHeader() {},
    write() {
      return true;
    },
    end() {},
  };
}

async function call(body, method = "POST", env = {}) {
  const saved = { ...process.env };
  for (const key of Object.keys(env)) process.env[key] = env[key];
  const record = {};
  try {
    await handler(
      { method, body, headers: {} },
      makeRes("result", record),
    );
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return record.result;
}

// 1. GET must be rejected with 405.
const GET = await call(undefined, "GET");
assert.equal(GET.status, 405, `GET -> ${GET.status}`);
console.log(`PASS  GET /api/chat -> 405 (${GET.body?.error ?? ""})`);

// 2. garage-quote task without attachment -> 400.
const NO_ATTACH = await call({ messages: [{ role: "user", content: "hi" }], task: "garage-quote" });
assert.equal(NO_ATTACH.status, 400);
console.log("PASS  task garage-quote sans pièce jointe -> 400");

// 3. No key configured (new or legacy) -> 503 missing_api_key.
const NO_KEY = await call({ messages: [{ role: "user", content: "Bonjour" }] });
assert.equal(NO_KEY.status, 503);
assert.equal(NO_KEY.body.code, "missing_api_key");
assert.match(NO_KEY.body.error, /VEYVRO_AI_API_KEY/);
console.log(`PASS  sans clé -> 503 missing_api_key, message: "${NO_KEY.body.error}"`);

// 4. Original DRIVIA_AI_API_KEY only -> recognized (passes the config stage,
//    fails later at the unreachable provider with 502, NOT 503).
const LEGACY_DRIVIA = await call(
  { messages: [{ role: "user", content: "Bonjour" }] },
  "POST",
  { DRIVIA_AI_API_KEY: "sk-legacy-test-key" },
);
assert.equal(LEGACY_DRIVIA.status, 502, `legacy DRIVIA key -> ${LEGACY_DRIVIA.status} ${JSON.stringify(LEGACY_DRIVIA.body)}`);
assert.equal(LEGACY_DRIVIA.body.code, "provider_error");
console.log("PASS  ancienne variable DRIVIA_AI_API_KEY reconnue (atteint le fournisseur, 502 réseau attendu ici)");

// 5. Previous-generation VEYDRIVO_AI_API_KEY -> still recognized.
const LEGACY_VEYDRIVO = await call(
  { messages: [{ role: "user", content: "Bonjour" }] },
  "POST",
  { VEYDRIVO_AI_API_KEY: "sk-veydrivo-test-key" },
);
assert.equal(
  LEGACY_VEYDRIVO.status,
  502,
  `legacy VEYDRIVO key -> ${LEGACY_VEYDRIVO.status} ${JSON.stringify(LEGACY_VEYDRIVO.body)}`,
);
assert.equal(LEGACY_VEYDRIVO.body.code, "provider_error");
console.log("PASS  variable VEYDRIVO_AI_API_KEY (génération précédente) toujours reconnue");

// 6. New VEYVRO_AI_API_KEY -> same behavior through the canonical name.
const NEW = await call(
  { messages: [{ role: "user", content: "Bonjour" }] },
  "POST",
  { VEYVRO_AI_API_KEY: "sk-new-test-key" },
);
assert.equal(NEW.status, 502);
assert.equal(NEW.body.code, "provider_error");
console.log("PASS  nouvelle variable VEYVRO_AI_API_KEY reconnue");

console.log("\nTous les tests du harnais API local sont passés.");
