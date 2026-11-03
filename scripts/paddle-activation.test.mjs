/**
 * Full activation path: checkout → attribution → Paddle → webhook → Supabase → access.
 *
 * What this file is for
 * ---------------------
 * The existing suites test each link with the other links stubbed. That is how a
 * real incident slipped through: the attribution endpoint and the webhook each
 * behaved correctly, and the chain still activated nobody, because the key used
 * to *mint* the proof and the key used to *verify* it had drifted apart.
 *
 * So this file wires the **real** `api/paddle-attribution` handler to the **real**
 * `api/paddle-webhook` handler, with one stubbed `fetch` for Supabase and no
 * Paddle call at all, and walks the whole path:
 *
 *   1. a proof is minted by the endpoint the browser calls;
 *   2. it travels inside `subscription.created`, exactly as Paddle would carry it;
 *   3. the webhook verifies signature, attribution and price;
 *   4. a row is written, and `resolveAccessPlan` — the function the chat obeys —
 *      returns the paid plan.
 *
 * Every failure case is then replayed against the same wall, and one invariant is
 * asserted each time: **no validated proof, no row, no access**. A payment that
 * fails validation is never simulated as an activation.
 */
import assert from "node:assert";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import attributionHandler from "../api/paddle-attribution.ts";
import webhookHandler from "../api/paddle-webhook.ts";
import { computeAttributionProof } from "../server/attribution.ts";
import { resolveAccessPlan } from "../src/lib/subscriptionAccess.ts";
import { SANDBOX_PRICE_IDS } from "../src/lib/paddleCore.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const SUPABASE_URL = "https://stub-project.supabase.test";
const ANON_KEY = "sb_publishable_stub_key";
const SERVICE_KEY = "sb_secret_stub_key";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555";
const USER_EMAIL = "client@veyvro.test";
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q";
const SUBSCRIPTION_ID = "sub_01hv8y5ehszzq0yv20ttx3166y";
const PERIOD_END = new Date(Date.now() + 25 * 24 * 3_600_000).toISOString();
const PERIOD_START = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString();

const ENV_KEYS = ["PADDLE_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function setEnv(secret, overrides = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    PADDLE_WEBHOOK_SECRET: secret,
    SUPABASE_URL,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// One stub for Supabase; Paddle is never contacted by this path
// ---------------------------------------------------------------------------

function installSupabaseStub({ users = {}, emailConfirmed = true, log = [] } = {}) {
  const store = {
    events: new Map(),
    subscriptions: new Map(),
    writes: 0,
  };

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const target = new URL(url);
    const path = target.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    log.push(`${method} ${path}`);

    if (url.includes("paddle.com")) throw new Error("Paddle must not be called from this path");

    // --- Supabase auth: who owns this token (attribution route) -------------
    if (path === "/auth/v1/user") {
      const user = users[USER_ID] ?? { id: USER_ID, email: USER_EMAIL };
      return json({
        id: user.id,
        email: user.email,
        email_confirmed_at: emailConfirmed ? "2026-10-01T00:00:00Z" : null,
      });
    }

    // --- Supabase admin: the account behind `custom_data.user_id` -----------
    if (path.startsWith("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(path.split("/").pop());
      const user = users[id];
      if (!user) return json({ message: "not found" }, 404);
      return json({
        id: user.id,
        email: user.email,
        email_confirmed_at: emailConfirmed ? "2026-10-01T00:00:00Z" : null,
      });
    }

    // --- webhook_events -----------------------------------------------------
    if (path === "/rest/v1/webhook_events") {
      if (method === "POST") {
        if (store.events.has(body.event_id)) return json({ message: "duplicate" }, 409);
        store.events.set(body.event_id, { ...body });
        return new Response(null, { status: 201 });
      }
      if (method === "GET") {
        const id = decodeURIComponent(target.searchParams.get("event_id")?.replace("eq.", "") ?? "");
        const row = store.events.get(id);
        return json(row ? [{ status: row.status }] : []);
      }
      if (method === "PATCH") {
        const id = decodeURIComponent(target.searchParams.get("event_id")?.replace("eq.", "") ?? "");
        const row = store.events.get(id);
        if (row && body) Object.assign(row, body);
        return new Response(null, { status: 204 });
      }
    }

    // --- subscriptions ------------------------------------------------------
    if (path === "/rest/v1/subscriptions") {
      if (method === "GET") {
        const wanted = target.searchParams.get("paddle_subscription_id")?.replace("eq.", "");
        const rows = [...store.subscriptions.values()].filter(
          (row) => !wanted || row.paddle_subscription_id === wanted,
        );
        return json(rows);
      }
      if (method === "POST") {
        store.writes += 1;
        store.subscriptions.set(body.paddle_subscription_id, { ...body });
        return new Response(null, { status: 201 });
      }
    }

    throw new Error(`unexpected outbound call: ${method} ${url}`);
  };

  return {
    store,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function makeResponse() {
  const out = { status: 0, body: null };
  const response = {
    status(code) {
      out.status = code;
      return response;
    },
    json(body) {
      out.body = body;
      return response;
    },
    setHeader() {
      return response;
    },
  };
  return { response, out };
}

/** Mint a proof exactly as the browser does: POST /api/paddle-attribution. */
async function mintProof(secret) {
  setEnv(secret);
  const { response, out } = makeResponse();
  await attributionHandler(
    { method: "POST", headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
    response,
  );
  return out;
}

/** Deliver one signed Paddle event to the real webhook. */
async function deliver(event, secret) {
  setEnv(secret);
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const h1 = crypto.createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
  const { response, out } = makeResponse();
  await webhookHandler(
    {
      method: "POST",
      headers: { "paddle-signature": `ts=${ts};h1=${h1}` },
      rawBody: Buffer.from(raw, "utf8"),
    },
    response,
  );
  return out;
}

function subscriptionCreated({ customData, email = USER_EMAIL, priceId = SANDBOX_PRICE_IDS.plus.month }) {
  return {
    event_id: `evt_${crypto.randomBytes(8).toString("hex")}`,
    event_type: "subscription.created",
    occurred_at: new Date().toISOString(),
    data: {
      id: SUBSCRIPTION_ID,
      status: "active",
      customer_id: "ctm_01grnn4zta5a1mf02jjze7y2ys",
      customer: { email },
      currency_code: "USD",
      items: [{ price: { id: priceId, product_id: "pro_01k2abcdefghijklmnopqrstu" }, quantity: 1 }],
      current_billing_period: { starts_at: PERIOD_START, ends_at: PERIOD_END },
      ...(customData === undefined ? {} : { custom_data: customData }),
      updated_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The nominal path, end to end, with no stub on the links that matter
// ---------------------------------------------------------------------------

{
  const SECRET = crypto.randomBytes(32).toString("hex");
  const stub = installSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL } } });

  // 1a. The proof the browser gets, from the route it actually calls.
  const minted = await mintProof(SECRET);
  assert.equal(minted.status, 200, "l'endpoint d'attribution répond");
  assert.equal(minted.body.userId, USER_ID, "l'identité vient du jeton, pas du corps");
  assert.ok(minted.body.proof.startsWith("v1."), "preuve versionnée");
  assert.equal(minted.body.email, undefined, "aucun e-mail renvoyé au navigateur");

  // 1b. Paddle stores it in `custom_data` and copies it to the subscription.
  const event = subscriptionCreated({
    customData: { user_id: minted.body.userId, attribution_proof: minted.body.proof },
  });

  // 1c. The webhook, with the very same secret, accepts it.
  const outcome = await deliver(event, SECRET);
  assert.equal(outcome.status, 200, `la livraison doit aboutir (reçu ${outcome.status} ${outcome.body?.reason ?? ""})`);
  assert.equal(outcome.body.reason, undefined, "aucun refus");

  // 1d. The row, its columns, and the access decision the chat obeys.
  const row = stub.store.subscriptions.get(SUBSCRIPTION_ID);
  assert.ok(row, "une ligne est écrite");
  assert.equal(row.user_id, USER_ID, "rattachée à l'utilisateur qui a payé");
  assert.equal(row.plan, "plus", "formule Plus");
  assert.equal(row.status, "active");
  assert.equal(row.billing_interval, "month", "périodicité mensuelle");
  assert.equal(row.paddle_price_id, SANDBOX_PRICE_IDS.plus.month);
  assert.equal(row.current_period_ends_at, PERIOD_END, "fin de période conservée telle quelle");
  assert.equal(row.current_period_started_at, PERIOD_START);
  assert.equal(resolveAccessPlan([row], USER_ID), "plus", "l'accès Plus est effectif");
  assert.equal(resolveAccessPlan([row], OTHER_USER_ID), "decouverte", "et pour personne d'autre");
  assert.equal(stub.store.events.get(event.event_id).status, "processed");

  stub.restore();
  pass("parcours complet : preuve émise par /api/paddle-attribution → webhook → ligne → accès Plus");
}

// ---------------------------------------------------------------------------
// 2. The incident, replayed: the secret changed between minting and delivery
// ---------------------------------------------------------------------------

{
  const SECRET_AT_CHECKOUT = crypto.randomBytes(32).toString("hex");
  const SECRET_AFTER_FIX = crypto.randomBytes(32).toString("hex");

  const stub = installSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL } } });

  const minted = await mintProof(SECRET_AT_CHECKOUT);
  const event = subscriptionCreated({
    customData: { user_id: minted.body.userId, attribution_proof: minted.body.proof },
  });

  const broken = await deliver(event, SECRET_AFTER_FIX);
  assert.equal(broken.status, 503, "un secret divergent n'est pas acquitté comme un succès");
  assert.equal(broken.body.outcome, "retry");
  assert.equal(broken.body.reason, "invalid_attribution_proof");
  assert.equal(stub.store.writes, 0, "aucune ligne écrite");
  assert.equal(resolveAccessPlan([], USER_ID), "decouverte", "aucun accès accordé");
  assert.equal(stub.store.events.get(event.event_id).status, "received", "l'événement reste rejouable");

  // Paddle retries; by then the verifier is corrected. Same event, same proof.
  const healed = await deliver(event, SECRET_AT_CHECKOUT);
  assert.equal(healed.status, 200, "la nouvelle tentative aboutit");
  assert.equal(stub.store.writes, 1, "l'abonnement est enfin accordé");
  assert.equal(resolveAccessPlan([...stub.store.subscriptions.values()], USER_ID), "plus");

  stub.restore();
  pass("incident rejoué : 503 tant que le secret diffère, activation à la correction, sans humain");
}

// ---------------------------------------------------------------------------
// 3. No validation, no access — every failure mode, one invariant
// ---------------------------------------------------------------------------

{
  const SECRET = crypto.randomBytes(32).toString("hex");
  const cases = [
    {
      label: "preuve forgée (mauvais secret)",
      make: () => subscriptionCreated({ customData: { user_id: USER_ID, attribution_proof: `v1.${"A".repeat(43)}` } }),
      expect: ["503", "invalid_attribution_proof"],
    },
    {
      label: "user_id d'un autre compte, preuve du premier",
      make: () =>
        subscriptionCreated({ customData: { user_id: OTHER_USER_ID, attribution_proof: `v1.${"B".repeat(43)}` } }),
      expect: ["503", "invalid_attribution_proof"],
    },
    {
      label: "user_id sans preuve",
      make: () => subscriptionCreated({ customData: { user_id: USER_ID } }),
      expect: ["200", "missing_attribution_proof"],
    },
    {
      label: "achat hors de notre checkout (aucun custom_data)",
      make: () => subscriptionCreated({}),
      expect: ["200", "missing_custom_data_user_id"],
    },
  ];

  const stub = installSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL } } });
  const genuine = await mintProof(SECRET);

  // A real payment whose billing email contradicts the account: a plausible
  // customer mistake, so it is kept open for a human rather than thrown away.
  cases.push({
    label: "e-mail de facturation différent du compte",
    make: () =>
      subscriptionCreated({
        customData: { user_id: genuine.body.userId, attribution_proof: genuine.body.proof },
        email: "quelqu-un-dautre@example.com",
      }),
    expect: ["202", "email_mismatch"],
  });

  for (const testCase of cases) {
    const out = await deliver(testCase.make(), SECRET);
    assert.equal(String(out.status), testCase.expect[0], `${testCase.label} : code HTTP`);
    assert.equal(out.body.reason, testCase.expect[1], `${testCase.label} : raison`);
    assert.equal(
      resolveAccessPlan([...stub.store.subscriptions.values()], USER_ID),
      "decouverte",
      `${testCase.label} : aucun droit ne doit être accordé`,
    );
  }

  assert.equal(stub.store.writes, 0, "aucune écriture sur tous les cas refusés");
  stub.restore();
  pass("aucune validation, aucun droit : les 5 échecs n'écrivent rien et ne donnent aucun accès");
}

// ---------------------------------------------------------------------------
// 4. A proof cannot even be minted for an unconfirmed account
// ---------------------------------------------------------------------------

{
  const SECRET = crypto.randomBytes(32).toString("hex");
  const stub = installSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL } },
    emailConfirmed: false,
  });

  const minted = await mintProof(SECRET);
  assert.equal(minted.status, 403, "une preuve n'est pas délivrée à une adresse non confirmée");
  assert.equal(minted.body.proof, undefined);

  const withoutSecret = await (async () => {
    setEnv(SECRET);
    // `process.env.X = undefined` stores the *string* "undefined": delete it.
    delete process.env.PADDLE_WEBHOOK_SECRET;
    const { response, out } = makeResponse();
    await attributionHandler(
      { method: "POST", headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
      response,
    );
    return out;
  })();
  assert.equal(withoutSecret.status, 503, "sans secret, aucune preuve n'est émise");
  assert.equal(withoutSecret.body.proof, undefined, "jamais de preuve non signée");

  stub.restore();
  pass("attribution : 403 si l'adresse n'est pas confirmée, 503 sans secret, jamais de preuve nue");
}

// ---------------------------------------------------------------------------
// 5. The chain reads one variable, and writes the keys the webhook reads
// ---------------------------------------------------------------------------

{
  const attribution = readFileSync(new URL("../api/paddle-attribution.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../api/paddle-webhook.ts", import.meta.url), "utf8");
  const checkout = readFileSync(new URL("../src/lib/paddleCheckout.ts", import.meta.url), "utf8");
  const proofModule = readFileSync(new URL("../server/attribution.ts", import.meta.url), "utf8");
  const ringModule = readFileSync(new URL("../server/webhookSecret.ts", import.meta.url), "utf8");

  // The bug class that caused the incident: two sides signing/verifying with
  // keys that were allowed to diverge. One name, both sides, or nothing.
  const variableIn = (source) => [...source.matchAll(/"PADDLE_WEBHOOK_SECRET"/g)].length;
  assert.ok(variableIn(attribution) >= 1, "l'endpoint d'attribution lit PADDLE_WEBHOOK_SECRET");
  assert.ok(variableIn(webhook) >= 1, "le webhook lit PADDLE_WEBHOOK_SECRET");

  // Exactly one additional secret name exists, and it is the bounded rotation
  // ring — not a second, permanent key. It is declared once, in the ring
  // module, and the two callers only go through `readSecretRing`.
  assert.ok(
    !/PADDLE_WEBHOOK_SECRET_[A-Z]/.test(attribution + webhook),
    "ni l'endpoint ni le webhook ne nomment un second secret directement",
  );
  const previousNames = [...ringModule.matchAll(/"PADDLE_WEBHOOK_SECRET_[A-Z_]+"/g)].map((m) => m[0]);
  assert.deepEqual(
    [...new Set(previousNames)].sort(),
    ['"PADDLE_WEBHOOK_SECRET_PREVIOUS"', '"PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL"'],
    "le trousseau ne connaît que le secret précédent et sa date de fin",
  );
  // The window is bounded in the code too, not only in the documentation.
  assert.match(ringModule, /SECRET_RING_MAX_WINDOW_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(webhook, /readSecretRing\(process\.env\)/, "le webhook lit le trousseau");
  assert.match(attribution, /computeAttributionProof\(secret/, "la preuve est calculée par le module partagé");
  // One verification path, and it tries the ring rather than a single key.
  assert.match(webhook, /verifyAttributionProofWithRing\(secrets/, "et vérifiée par le même module");
  assert.ok(
    !/verifyAttributionProof\(secret,/.test(webhook),
    "le webhook ne vérifie plus contre une seule clé",
  );

  // custom_data keys: written by the checkout, read by the webhook.
  assert.match(checkout, /PADDLE_CUSTOM_DATA_USER_KEY = "user_id"/);
  assert.match(checkout, /PADDLE_CUSTOM_DATA_PROOF_KEY = "attribution_proof"/);
  assert.match(webhook, /PADDLE_CUSTOM_DATA_USER_ID = "user_id"/);
  assert.match(webhook, /PADDLE_CUSTOM_DATA_PROOF_KEY = "attribution_proof"/);

  pass("chaîne : un seul secret, une seule dérivation, les mêmes clés custom_data des deux côtés");
}

// ---------------------------------------------------------------------------
// 6. The four events the activation depends on are the four handled
// ---------------------------------------------------------------------------

{
  const webhook = readFileSync(new URL("../api/paddle-webhook.ts", import.meta.url), "utf8");
  const block = /export const HANDLED_EVENT_TYPES = \[([\s\S]*?)\] as const;/.exec(webhook);
  assert.ok(block, "la liste des événements traités doit être explicite");

  const handled = [...block[1].matchAll(/"([a-z_.]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    handled.sort(),
    ["subscription.canceled", "subscription.created", "subscription.past_due", "subscription.updated"],
    "exactement les quatre événements du cycle de vie d'un abonnement",
  );
  assert.ok(
    !handled.includes("transaction.completed"),
    "transaction.completed reste acquitté sans écriture : ce n'est pas lui qui active",
  );

  pass("événements : created / updated / canceled / past_due traités, transaction.completed sans effet");
}

// ---------------------------------------------------------------------------
// 7. Renewal keeps the access without needing the checkout's proof
// ---------------------------------------------------------------------------

{
  const SECRET = crypto.randomBytes(32).toString("hex");
  const stub = installSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL } } });

  const minted = await mintProof(SECRET);
  const created = subscriptionCreated({
    customData: { user_id: minted.body.userId, attribution_proof: minted.body.proof },
  });
  const bound = await deliver(created, SECRET);
  assert.equal(bound.status, 200);
  assert.equal(resolveAccessPlan([...stub.store.subscriptions.values()], USER_ID), "plus");

  // Paddle re-sends the `custom_data` frozen at checkout time, proof included.
  // Here the proof was signed with a key that no longer exists: the renewal
  // must still be applied, because the owner is the stored one.
  const renewedEnd = new Date(Date.now() + 55 * 24 * 3_600_000).toISOString();
  const renewal = subscriptionCreated({
    customData: {
      user_id: USER_ID,
      attribution_proof: computeAttributionProof("secret-revoque", USER_ID),
    },
  });
  renewal.event_type = "subscription.updated";
  renewal.data.current_billing_period = { starts_at: PERIOD_END, ends_at: renewedEnd };

  const out = await deliver(renewal, SECRET);
  assert.equal(out.status, 200, `un renouvellement ne doit jamais être bloqué (reçu ${out.status})`);
  assert.equal(out.body.reason, null, "aucun refus");

  const row = stub.store.subscriptions.get(SUBSCRIPTION_ID);
  assert.equal(row.user_id, USER_ID, "le propriétaire est celui de la base");
  assert.equal(row.current_period_ends_at, renewedEnd, "la nouvelle période est enregistrée");
  assert.equal(resolveAccessPlan([row], USER_ID), "plus", "l'accès est conservé");
  assert.equal(stub.store.writes, 2, "deux écritures : liaison puis renouvellement");

  stub.restore();
  pass("renouvellement : preuve figée d'un ancien secret ignorée, propriétaire et accès conservés");
}

// ---------------------------------------------------------------------------
// 8. Ownership cannot be moved, even with a cryptographically valid proof
// ---------------------------------------------------------------------------

{
  const SECRET = crypto.randomBytes(32).toString("hex");
  const stub = installSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL } } });

  const minted = await mintProof(SECRET);
  const created = subscriptionCreated({
    customData: { user_id: minted.body.userId, attribution_proof: minted.body.proof },
  });
  assert.equal((await deliver(created, SECRET)).status, 200);

  // The strongest possible attempt: a genuine HMAC for the other account.
  const hijack = subscriptionCreated({
    customData: {
      user_id: OTHER_USER_ID,
      attribution_proof: computeAttributionProof(SECRET, OTHER_USER_ID),
    },
  });
  hijack.event_type = "subscription.updated";

  const out = await deliver(hijack, SECRET);
  assert.equal(out.status, 200, "refus acquitté, pas de boucle Paddle");
  assert.equal(out.body.outcome, "rejected");
  assert.equal(out.body.reason, "customer_bound_to_other_user");

  const row = stub.store.subscriptions.get(SUBSCRIPTION_ID);
  assert.equal(row.user_id, USER_ID, "le propriétaire n'a pas bougé");
  assert.equal(stub.store.writes, 1, "aucune écriture supplémentaire");
  assert.equal(resolveAccessPlan([row], USER_ID), "plus", "l'accès reste à son titulaire");
  assert.equal(resolveAccessPlan([row], OTHER_USER_ID), "decouverte", "l'autre compte n'obtient rien");

  stub.restore();
  pass("chaîne réelle : preuve valide d'un autre compte refusée, propriétaire et accès intacts");
}

// ---------------------------------------------------------------------------
// 9. The proof still guards the binding: no proof, no first activation
// ---------------------------------------------------------------------------

{
  const SECRET = crypto.randomBytes(32).toString("hex");
  const stub = installSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL } } });

  const minted = await mintProof(SECRET);
  assert.equal(
    (
      await deliver(
        subscriptionCreated({
          customData: { user_id: minted.body.userId, attribution_proof: minted.body.proof },
        }),
        SECRET,
      )
    ).status,
    200,
  );

  // Renewal without any `custom_data`: accepted, the owner is known.
  const renewal = subscriptionCreated({});
  renewal.event_type = "subscription.updated";
  const renewed = await deliver(renewal, SECRET);
  assert.equal(renewed.status, 200, "un renouvellement sans custom_data aboutit");
  assert.equal(stub.store.writes, 2);

  // A brand-new Paddle subscription without any `custom_data`: refused, because
  // nothing would prove which account is paying.
  const unknown = subscriptionCreated({});
  unknown.data.id = "sub_01hv8y5ehszzq0yv20ttx9999";
  const refused = await deliver(unknown, SECRET);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.outcome, "rejected");
  assert.equal(refused.body.reason, "missing_custom_data_user_id");
  assert.equal(stub.store.subscriptions.has("sub_01hv8y5ehszzq0yv20ttx9999"), false);
  assert.equal(stub.store.writes, 2, "aucune écriture pour une liaison non prouvée");

  stub.restore();
  pass("contraste : renouvellement sans preuve accepté, liaison sans preuve refusée sans écriture");
}

setEnv(crypto.randomBytes(32).toString("hex"));
process.env = { ...originalEnv };
globalThis.fetch = originalFetch;

console.log(`\n${checks} vérifications du parcours d'activation passées.`);
