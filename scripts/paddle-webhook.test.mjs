/**
 * Webhook tests for api/paddle-webhook.ts.
 *
 * Nothing leaves the process: Supabase is replaced by an in-memory PostgREST
 * stub and signatures are computed locally with a throwaway secret. No real
 * key, token or Paddle identifier is used anywhere in this file.
 */
import crypto from "node:crypto";
import assert from "node:assert";
import handler, {
  computeSignature,
  handleSubscriptionEvent,
  isUserIdShaped,
  parseSignatureHeader,
  resolvePlanFromPriceId,
  verifySignature,
} from "../api/paddle-webhook.ts";
import { SANDBOX_PRICE_IDS } from "../src/lib/paddleCore";
import {
  computeAttributionProof,
  deriveAttributionKey,
  verifyAttributionProof,
} from "../server/attribution";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

// Throwaway values, generated for this run only.
const TEST_SECRET = crypto.randomBytes(32).toString("hex");
const SERVICE_ROLE = `sb_secret_${crypto.randomBytes(12).toString("hex")}`;
const SUPABASE_URL = "https://stub-project.supabase.co";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_USER_ID = "99999999-8888-7777-6666-555555555555";
const USER_EMAIL = "client@veyvro.test";

// ---------------------------------------------------------------------------
// In-memory Supabase stub (PostgREST + auth admin)
// ---------------------------------------------------------------------------
function createSupabaseStub({ users = {}, seedSubscriptions = [] } = {}) {
  const store = {
    events: new Map(),
    subscriptions: new Map(),
    writes: { webhookEvents: 0, subscriptions: 0, finalize: 0 },
    users: { ...users },
    // Every request issued by the handler: "METHOD /path?query".
    requests: [],
    // Raw bodies received on the subscriptions endpoint, to assert the payload.
    sentRows: [],
  };
  for (const row of seedSubscriptions) {
    const id = row.id ?? crypto.randomUUID();
    store.subscriptions.set(id, {
      id,
      created_at: row.created_at ?? new Date().toISOString(),
      ...row,
    });
  }

  const original = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    const path = target.pathname;
    store.requests.push(`${method} ${target.pathname}${target.search}`);
    const json = (body, status = 200) =>
      // 204 and 205 must not carry a body, and `Response` rejects one.
      status === 204 || status === 205
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          });

    // --- auth admin ---
    if (path.startsWith("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(path.split("/").pop());
      const user = store.users[id];
      return user ? json(user) : json({ message: "not found" }, 404);
    }

    // --- rest: webhook_events ---
    if (path === "/rest/v1/webhook_events") {
      if (method === "POST") {
        const row = JSON.parse(init.body);
        if (store.events.has(row.event_id)) return json({ message: "duplicate" }, 409);
        store.writes.webhookEvents += 1;
        store.events.set(row.event_id, { ...row });
        return json(null, 201);
      }
      if (method === "PATCH") {
        const id = decodeURIComponent(target.searchParams.get("event_id").slice(3));
        const patch = JSON.parse(init.body);
        const existing = store.events.get(id);
        if (!existing) return json({ message: "not found" }, 404);
        store.writes.finalize += 1;
        store.events.set(id, { ...existing, ...patch });
        return json(null, 204);
      }
      return json({ message: "method not allowed" }, 405);
    }

    if (path === "/rest/v1/webhook_events" && method === "GET") {
      return json([]);
    }

    // --- rest: subscriptions ---
    if (path === "/rest/v1/subscriptions") {
      if (method === "POST") {
        const row = JSON.parse(init.body);
        store.sentRows.push(row);
        store.writes.subscriptions += 1;

        // PostgREST fidelity: `resolution=merge-duplicates` conflicts on the
        // column named by `on_conflict`, and on the PRIMARY KEY otherwise.
        // The real table's primary key is `id` (uuid, generated), which this
        // payload never carries — so without `on_conflict` every attempt is an
        // INSERT and retried events would pile up duplicate rows. The stub
        // reproduces exactly that, so the tests fail if the parameter is lost.
        const onConflict = target.searchParams.get("on_conflict");
        const key = onConflict === "paddle_subscription_id" ? row.paddle_subscription_id : null;

        const existing = key === null ? null : findStoredSubscription(store, key);
        if (existing) {
          // UPDATE: the row keeps its own `id` and `created_at`.
          const updated = { ...existing, ...row, id: existing.id };
          store.subscriptions.set(existing.id, updated);
          return json(null, 201);
        }

        // Insert: the database supplies `id` and `created_at` on its own.
        const generatedId = crypto.randomUUID();
        store.subscriptions.set(generatedId, {
          id: generatedId,
          created_at: new Date().toISOString(),
          ...row,
        });
        return json(null, 201);
      }
      return json({ message: "method not allowed" }, 405);
    }

    return json({ message: `unexpected ${method} ${path}` }, 500);
  };

  return {
    store,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Rows are stored by uuid `id`, exactly like the real table. */
function findStoredSubscription(store, paddleSubscriptionId) {
  for (const row of store.subscriptions.values()) {
    if (row.paddle_subscription_id === paddleSubscriptionId) return row;
  }
  return undefined;
}

// The handler issues a GET for an existing subscription and for the event
// status; both go through fetch with query strings on the same paths.
function installQueryRouting(stub) {
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && target.pathname === "/rest/v1/webhook_events") {
      const id = decodeURIComponent((target.searchParams.get("event_id") ?? "").slice(3));
      const row = stub.store.events.get(id);
      return new Response(JSON.stringify(row ? [{ status: row.status }] : []), { status: 200 });
    }
    if (method === "GET" && target.pathname === "/rest/v1/subscriptions") {
      const id = decodeURIComponent(
        (target.searchParams.get("paddle_subscription_id") ?? "").slice(3),
      );
      const row = findStoredSubscription(stub.store, id);
      return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    }
    return base(url, init);
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
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

function sign(bodyString, { ts = Math.floor(Date.now() / 1000), secret = TEST_SECRET } = {}) {
  const signature = computeSignature(Buffer.from(bodyString, "utf8"), String(ts), secret);
  return `ts=${ts};h1=${signature}`;
}

function subscriptionEvent(overrides = {}) {
  return {
    event_id: `evt_${crypto.randomBytes(10).toString("hex")}`,
    event_type: "subscription.created",
    occurred_at: new Date().toISOString(),
    data: {
      id: "sub_01testsubscription000000",
      status: "active",
      customer_id: "ctm_01testcustomer000000000",
      currency_code: "EUR",
      // A valid proof is required now: a bare user_id is refused.
      custom_data: {
        user_id: USER_ID,
        attribution_proof: computeAttributionProof(TEST_SECRET, USER_ID),
      },
      items: [
        {
          price: {
            id: SANDBOX_PRICE_IDS.plus.month,
            product_id: "pro_01testproduct000000000",
          },
        },
      ],
      current_billing_period: {
        starts_at: "2026-10-01T00:00:00Z",
        ends_at: "2026-11-01T00:00:00Z",
      },
      ...(overrides.data ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "data")),
  };
}

async function deliver(payload, { signature, rawBody, method = "POST", env = {} } = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    PADDLE_WEBHOOK_SECRET: TEST_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    ...env,
  });

  const bodyString = rawBody ?? JSON.stringify(payload);
  const { res, out } = makeResponse();
  await handler(
    {
      method,
      headers: { "paddle-signature": signature ?? sign(bodyString) },
      rawBody: Buffer.from(bodyString, "utf8"),
    },
    res,
  );

  process.env = saved;
  return out;
}

// ---------------------------------------------------------------------------
// 1. Signature parsing and verification
// ---------------------------------------------------------------------------
{
  assert.deepEqual(parseSignatureHeader("ts=1671552777;h1=abc"), { ts: "1671552777", h1: ["abc"] });
  assert.deepEqual(parseSignatureHeader("ts=1;h1=a;h1=b").h1, ["a", "b"]);
  assert.equal(parseSignatureHeader("garbage"), null);
  assert.equal(parseSignatureHeader(""), null);
  assert.equal(parseSignatureHeader(null), null);
  pass("en-tête Paddle-Signature : ts + un ou plusieurs h1, formes invalides rejetées");
}

{
  const body = Buffer.from('{"a":1}', "utf8");
  const now = 1_700_000_000;
  const good = sign('{"a":1}', { ts: now });

  assert.deepEqual(verifySignature({ rawBody: body, header: good, secret: TEST_SECRET, nowSeconds: now }), { ok: true });
  assert.deepEqual(
    verifySignature({ rawBody: body, header: good, secret: TEST_SECRET, nowSeconds: now + 3 }),
    { ok: true },
  );
  assert.equal(
    verifySignature({ rawBody: body, header: good, secret: TEST_SECRET, nowSeconds: now + 60 }).reason,
    "stale",
  );
  assert.equal(
    verifySignature({ rawBody: body, header: good, secret: "autre-secret", nowSeconds: now }).reason,
    "mismatch",
  );
  assert.equal(
    verifySignature({ rawBody: Buffer.from('{"a": 1}'), header: good, secret: TEST_SECRET, nowSeconds: now }).reason,
    "mismatch",
  );
  assert.equal(verifySignature({ rawBody: body, header: null, secret: TEST_SECRET, nowSeconds: now }).reason, "missing_header");
  assert.equal(verifySignature({ rawBody: body, header: "h1=abc", secret: TEST_SECRET, nowSeconds: now }).reason, "malformed_header");
  assert.equal(verifySignature({ rawBody: body, header: good, secret: "", nowSeconds: now }).reason, "missing_secret");
  pass("signature : HMAC valide accepté, corps modifié/secret erroné/horodatage périmé refusés");
}

// ---------------------------------------------------------------------------
// 2. Handler-level guards
// ---------------------------------------------------------------------------
{
  const out = await deliver(subscriptionEvent(), { method: "GET" });
  assert.equal(out.status, 405);
  pass("méthode autre que POST : 405");
}

{
  const out = await deliver(subscriptionEvent(), { signature: "" });
  assert.equal(out.status, 401);
  assert.equal(out.body.reason, "missing_header");
  pass("signature absente : 401");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);
  // Fresh timestamp, wrong signature: the reason must be "mismatch", not "stale".
  const now = Math.floor(Date.now() / 1000);
  const out = await deliver(subscriptionEvent(), { signature: `ts=${now};h1=${"0".repeat(64)}` });
  assert.equal(out.status, 401);
  assert.equal(out.body.reason, "mismatch");
  assert.equal(stub.store.writes.webhookEvents, 0, "aucune écriture sur signature invalide");
  assert.equal(stub.store.writes.subscriptions, 0);
  stub.restore();
  pass("signature invalide : 401, aucune écriture, aucune fuite du corps");
}

{
  const stub = createSupabaseStub({ users: {} });
  installQueryRouting(stub);
  const staleTs = Math.floor(Date.now() / 1000) - 3600;
  const body = JSON.stringify(subscriptionEvent());
  const out = await deliver(null, { signature: sign(body, { ts: staleTs }), rawBody: body });
  assert.equal(out.status, 401);
  assert.equal(out.body.reason, "stale");
  assert.equal(stub.store.writes.webhookEvents, 0, "un rejeu tardif n'écrit rien");
  stub.restore();
  pass("horodatage périmé : 401 (anti-rejeu), aucune écriture");
}

{
  // A parsed object body cannot be verified: refuse loudly instead of trusting it.
  const saved = { ...process.env };
  Object.assign(process.env, { PADDLE_WEBHOOK_SECRET: TEST_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE });
  const { res, out } = makeResponse();
  await handler(
    { method: "POST", headers: { "paddle-signature": "ts=1;h1=abc" }, body: { event_id: "evt_x" } },
    res,
  );
  process.env = saved;
  assert.equal(out.status, 500);
  assert.match(out.body.error, /Raw request body unavailable/);
  pass("corps déjà analysé : 500 explicite, jamais d'acceptation non vérifiée");
}

{
  const out = await deliver(subscriptionEvent(), { env: { SUPABASE_SERVICE_ROLE_KEY: "" } });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /not configured/);
  pass("Supabase non configuré : 503, aucun détail interne exposé");
}

// ---------------------------------------------------------------------------
// 3. Happy path + idempotency
// ---------------------------------------------------------------------------
{
  const users = { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } };
  const stub = createSupabaseStub({ users });
  installQueryRouting(stub);

  const event = subscriptionEvent();
  const first = await deliver(event);
  assert.equal(first.status, 200);
  assert.equal(first.body.received, true);

  const row = findStoredSubscription(stub.store, event.data.id);
  assert.ok(row, "une ligne d'abonnement doit être créée");
  assert.equal(row.user_id, USER_ID);
  assert.equal(row.plan, "plus");
  assert.equal(row.status, "active");
  assert.equal(row.paddle_price_id, SANDBOX_PRICE_IDS.plus.month);
  assert.equal(row.current_period_ends_at, "2026-11-01T00:00:00Z");
  assert.equal(stub.store.events.get(event.event_id).status, "processed");

  // Same event delivered again: acknowledged, but nothing is written twice.
  const beforeWrites = stub.store.writes.subscriptions;
  const second = await deliver(event);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(stub.store.writes.subscriptions, beforeWrites, "aucune réécriture sur doublon");
  pass("événement valide : abonnement créé (plan/statut/prix/période) puis doublon ignoré");
}

// ---------------------------------------------------------------------------
// 3b. Column names and conflict target must match the EXISTING table
// ---------------------------------------------------------------------------
{
  // `public.subscriptions` already exists with its own names (`paddle_price_id`,
  // `current_period_ends_at`, `source_updated_at`, …) and a uuid primary key
  // `id`. Two things must therefore hold, or the integration silently breaks.
  const users = { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } };
  const stub = createSupabaseStub({ users });
  installQueryRouting(stub);

  const event = subscriptionEvent();
  const out = await deliver(event);
  assert.equal(out.status, 200);

  // 1. The conflict target is named: the primary key is `id`, not the Paddle id.
  const posts = stub.store.requests.filter((r) => r.startsWith("POST /rest/v1/subscriptions"));
  assert.equal(posts.length, 1);
  assert.equal(
    posts[0],
    "POST /rest/v1/subscriptions?on_conflict=paddle_subscription_id",
    "sans on_conflict, PostgREST arbitre sur la clé primaire `id` et duplique",
  );

  // 2. The payload names real columns only, and never invents `id`.
  const row = stub.store.sentRows[0];
  assert.equal(row.id, undefined, "`id` vient de la base, le webhook ne l'impose pas");
  for (const legacy of ["price_id", "product_id", "current_period_end", "scheduled_change_at", "occurred_at"]) {
    assert.equal(row[legacy], undefined, `colonne inexistante envoyée : ${legacy}`);
  }
  for (const real of [
    "paddle_subscription_id",
    "user_id",
    "plan",
    "status",
    "paddle_price_id",
    "paddle_product_id",
    "paddle_customer_id",
    "current_period_ends_at",
    "source_updated_at",
  ]) {
    assert.ok(real in row, `colonne réelle manquante dans l'upsert : ${real}`);
  }

  // 3. The real table's extra columns are filled when Paddle provides them.
  assert.equal(row.billing_interval, "month");
  assert.equal(row.current_period_started_at, "2026-10-01T00:00:00Z");
  assert.equal(row.currency_code, "EUR");
  assert.equal(row.source_updated_at, event.occurred_at);

  stub.restore();
  pass("schéma réel : upsert sur on_conflict=paddle_subscription_id, colonnes réelles, `id` laissé à la base");
}

{
  const users = { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } };
  const stub = createSupabaseStub({ users });
  installQueryRouting(stub);

  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: {
        scheduled_change: { action: "cancel", effective_at: "2026-11-30T00:00:00Z" },
        currency_code: "USD",
      },
    }),
  );
  assert.equal(out.status, 200);

  const row = stub.store.sentRows[0];
  assert.equal(row.scheduled_change_action, "cancel");
  assert.equal(row.scheduled_change_effective_at, "2026-11-30T00:00:00Z");
  assert.equal(row.currency_code, "USD");

  // Anything Paddle could not schedule is refused rather than stored.
  const other = await deliver(subscriptionEvent({ data: { scheduled_change: { action: "explode" } } }));
  assert.equal(other.status, 200);
  assert.equal(stub.store.sentRows.at(-1).scheduled_change_action, null);

  stub.restore();
  pass("changement programmé : action `cancel` et date enregistrées, action inconnue neutralisée");
}

// ---------------------------------------------------------------------------
// 3c. Retried / repeated events must never create a second row
// ---------------------------------------------------------------------------
{
  const users = { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } };
  const stub = createSupabaseStub({ users });
  installQueryRouting(stub);

  // Two DIFFERENT events (different event_id, different occurred_at) about the
  // same subscription: this is the normal Paddle sequence (created, then
  // updated). They must converge on ONE row.
  const created = subscriptionEvent({ occurred_at: "2026-10-01T00:00:00Z" });
  const updated = subscriptionEvent({
    event_type: "subscription.updated",
    occurred_at: "2026-10-02T00:00:00Z",
    data: { status: "past_due" },
  });

  assert.equal((await deliver(created)).status, 200);
  const firstId = findStoredSubscription(stub.store, created.data.id).id;

  assert.equal((await deliver(updated)).status, 200);
  const after = findStoredSubscription(stub.store, created.data.id);

  assert.equal(stub.store.subscriptions.size, 1, "un abonnement = une seule ligne");
  assert.equal(after.status, "past_due", "le second événement met à jour, il ne duplique pas");
  assert.equal(after.id, firstId, "la ligne garde son identité (clé primaire stable)");
  assert.equal(stub.store.events.size, 2, "les deux événements restent journalisés");

  // Replaying the second event identically: acknowledged, nothing written.
  const before = stub.store.writes.subscriptions;
  const replay = await deliver(updated);
  assert.equal(replay.body.duplicate, true);
  assert.equal(stub.store.writes.subscriptions, before);
  assert.equal(stub.store.subscriptions.size, 1);

  stub.restore();
  pass("événements répétés : deux event_id distincts → une seule ligne mise à jour, rejeu acquitté sans écriture");
}

// ---------------------------------------------------------------------------
// 3d. Resubscription: cancellation history is preserved
// ---------------------------------------------------------------------------
{
  const users = { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } };
  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      {
        paddle_subscription_id: "sub_01oldcancelledsub00000",
        user_id: USER_ID,
        plan: "plus",
        status: "canceled",
        paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
        paddle_customer_id: "ctm_01testcustomer000000000",
        source_updated_at: "2026-09-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);

  // Same Paddle customer, brand new subscription id — what Paddle actually does.
  const renewed = subscriptionEvent({
    occurred_at: "2026-10-01T00:00:00Z",
    data: { id: "sub_01newactivesub000000000", status: "active" },
  });
  const out = await deliver(renewed);
  assert.equal(out.status, 200, "un réabonnement ne doit jamais être refusé");
  assert.equal(out.body.outcome, undefined);

  assert.equal(stub.store.subscriptions.size, 2, "l'ancien abonnement résilié est conservé");
  const old = findStoredSubscription(stub.store, "sub_01oldcancelledsub00000");
  const fresh = findStoredSubscription(stub.store, "sub_01newactivesub000000000");
  assert.equal(old.status, "canceled", "l'historique n'est jamais réécrit");
  assert.equal(fresh.status, "active");
  assert.equal(fresh.paddle_customer_id, old.paddle_customer_id);

  stub.restore();
  pass("réabonnement : nouvelle ligne active, ancien abonnement résilié préservé (aucune donnée perdue)");
}

// ---------------------------------------------------------------------------
// 4. Attribution refusals
// ---------------------------------------------------------------------------
{
  const stub = createSupabaseStub({ users: {} }); // user does not exist
  installQueryRouting(stub);
  const event = subscriptionEvent();
  const out = await deliver(event);
  assert.equal(out.status, 200, "un refus est acquitté pour arrêter les tentatives");
  assert.equal(out.body.outcome, "rejected");
  assert.equal(out.body.reason, "unknown_user");
  assert.equal(stub.store.subscriptions.size, 0, "aucun droit accordé à un compte inconnu");
  assert.equal(stub.store.events.get(event.event_id).status, "rejected");
  stub.restore();
  pass("attribution : compte inconnu refusé, aucune ligne, refus journalisé");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);
  const out = await deliver(subscriptionEvent({ data: { custom_data: null } }));
  assert.equal(out.body.reason, "missing_custom_data_user_id");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("attribution : custom_data.user_id absent refusé");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);
  const out = await deliver(subscriptionEvent({ data: { custom_data: { user_id: "pas-un-uuid" } } }));
  assert.equal(out.body.reason, "missing_custom_data_user_id");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("attribution : user_id mal formé refusé (jamais d'identifiant inventé)");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: null } } });
  installQueryRouting(stub);
  const out = await deliver(subscriptionEvent());
  assert.equal(out.body.reason, "unconfirmed_email");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("attribution : adresse non confirmée refusée");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({ data: { customer: { email: "quelqu-un-dautre@example.com" } } }),
  );
  assert.equal(out.body.reason, "email_mismatch");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();

  // Same payload, matching email: accepted.
  const stub2 = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub2);
  const ok = await deliver(subscriptionEvent({ data: { customer: { email: "CLIENT@VEYVRO.TEST" } } }));
  assert.equal(ok.status, 200);
  assert.equal(stub2.store.subscriptions.size, 1, "la casse ne doit pas bloquer un e-mail identique");
  stub2.restore();
  pass("attribution : e-mail divergent refusé, e-mail identique (casse ignorée) accepté");
}

{
  // A Paddle customer already bound to user A cannot be re-bound to user B.
  const users = {
    [OTHER_USER_ID]: { id: OTHER_USER_ID, email: "autre@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      {
        paddle_subscription_id: "sub_01testsubscription000000",
        user_id: OTHER_USER_ID,
        paddle_customer_id: "ctm_01testcustomer000000000",
        occurred_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);
  const out = await deliver(subscriptionEvent({ data: { custom_data: { user_id: OTHER_USER_ID } } }));
  // Same user: allowed (this is the legitimate owner).
  assert.equal(out.status, 200);

  stub.restore();

  const stub2 = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    seedSubscriptions: [
      {
        paddle_subscription_id: "sub_01testsubscription000000",
        user_id: OTHER_USER_ID,
        paddle_customer_id: "ctm_01testcustomer000000000",
        occurred_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub2);
  const refused = await deliver(subscriptionEvent());
  assert.equal(refused.body.reason, "customer_bound_to_other_user");
  assert.equal(findStoredSubscription(stub2.store, "sub_01testsubscription000000").user_id, OTHER_USER_ID);
  stub2.restore();
  pass("attribution : client Paddle déjà lié à un autre compte refusé (pas de re-liaison)");
}

// ---------------------------------------------------------------------------
// 4bis. Attribution proof: a bare or rewritten user_id must never be accepted
// ---------------------------------------------------------------------------
{
  // Sanity: the proof is deterministic, bound to one id, and secret-dependent.
  const proofA = computeAttributionProof(TEST_SECRET, USER_ID);
  assert.equal(proofA, computeAttributionProof(TEST_SECRET, USER_ID), "preuve déterministe");
  assert.notEqual(proofA, computeAttributionProof(TEST_SECRET, OTHER_USER_ID), "preuve liée à l'id");
  assert.notEqual(proofA, computeAttributionProof("un-autre-secret", USER_ID), "preuve liée au secret");
  assert.equal(verifyAttributionProof(TEST_SECRET, USER_ID, proofA), true);
  assert.equal(verifyAttributionProof(TEST_SECRET, OTHER_USER_ID, proofA), false);
  assert.equal(verifyAttributionProof(TEST_SECRET, USER_ID, null), false);
  assert.equal(verifyAttributionProof(TEST_SECRET, USER_ID, "v9.inconnu"), false);
  assert.equal(verifyAttributionProof(null, USER_ID, proofA), false, "sans secret : échec fermé");
  assert.ok(deriveAttributionKey(TEST_SECRET).length === 32);
  assert.throws(() => deriveAttributionKey(""), /without a secret/);
  pass("preuve : déterministe, liée à l'id et au secret, échec fermé sans secret");
}

{
  // user_id rewritten to another account, proof left untouched.
  const users = {
    [OTHER_USER_ID]: { id: OTHER_USER_ID, email: "autre@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const stub = createSupabaseStub({ users });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      data: {
        custom_data: {
          user_id: OTHER_USER_ID,
          attribution_proof: computeAttributionProof(TEST_SECRET, USER_ID),
        },
      },
    }),
  );
  assert.equal(out.status, 200, "le refus est acquitté");
  assert.equal(out.body.outcome, "rejected");
  assert.equal(out.body.reason, "invalid_attribution_proof");
  assert.equal(stub.store.subscriptions.size, 0, "aucun droit accordé sur preuve falsifiée");
  stub.restore();
  pass("falsification : user_id remplacé, preuve d'un autre compte → refusé");
}

{
  // Bare user_id, no proof at all (the pre-option-B shape).
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);
  const out = await deliver(subscriptionEvent({ data: { custom_data: { user_id: USER_ID } } }));
  assert.equal(out.body.reason, "missing_attribution_proof");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("falsification : user_id sans preuve → refusé (jamais de confiance au navigateur)");
}

{
  // Proof minted with a different secret (e.g. someone else's deployment key).
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      data: {
        custom_data: {
          user_id: USER_ID,
          attribution_proof: computeAttributionProof("secret-voisin", USER_ID),
        },
      },
    }),
  );
  assert.equal(out.body.reason, "invalid_attribution_proof");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("falsification : preuve forgée avec un autre secret → refusée");
}

{
  // Truncated / tampered proof of the right account.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);
  const good = computeAttributionProof(TEST_SECRET, USER_ID);
  for (const tampered of [good.slice(0, -1), good + "0", good.replace("v1.", "v2."), "v1.", ""]) {
    const out = await deliver(
      subscriptionEvent({ data: { custom_data: { user_id: USER_ID, attribution_proof: tampered } } }),
    );
    assert.ok(
      ["invalid_attribution_proof", "missing_attribution_proof"].includes(out.body.reason),
      `preuve altérée ${JSON.stringify(tampered)} doit être refusée (reçu ${out.body.reason})`,
    );
  }
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("falsification : preuve tronquée, suffixée ou versionnée autrement → refusée");
}

// ---------------------------------------------------------------------------
// 5. Plan mapping, statuses, ordering
// ---------------------------------------------------------------------------
{
  assert.deepEqual(resolvePlanFromPriceId(SANDBOX_PRICE_IDS.pro.year), { plan: "pro", interval: "year" });
  assert.deepEqual(
    resolvePlanFromPriceId("pri_prod_plus_m", { VITE_PADDLE_PRICE_PLUS_MONTH: "pri_prod_plus_m" }),
    { plan: "plus", interval: "month" },
  );
  assert.equal(resolvePlanFromPriceId("pri_inconnu"), null);
  assert.equal(resolvePlanFromPriceId(null), null);
  pass("prix → plan : IDs Sandbox, IDs de production via variables, prix inconnu rejeté");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({ data: { items: [{ price: { id: "pri_01inconnu" } }] } }),
  );
  assert.equal(out.body.reason, "unknown_price_id");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("prix inconnu : refusé, aucun plan deviné");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);

  const canceled = await deliver(
    subscriptionEvent({ event_type: "subscription.canceled", data: { status: "canceled" } }),
  );
  assert.equal(canceled.status, 200);
  assert.equal(findStoredSubscription(stub.store, "sub_01testsubscription000000").status, "canceled");

  const pastDue = await deliver(
    subscriptionEvent({
      event_type: "subscription.past_due",
      data: { status: "past_due" },
      occurred_at: new Date().toISOString(),
    }),
  );
  assert.equal(pastDue.status, 200);
  assert.equal(findStoredSubscription(stub.store, "sub_01testsubscription000000").status, "past_due");

  const updated = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: { status: "active", items: [{ price: { id: SANDBOX_PRICE_IDS.pro.year } }] },
      occurred_at: new Date().toISOString(),
    }),
  );
  assert.equal(updated.status, 200);
  const row = findStoredSubscription(stub.store, "sub_01testsubscription000000");
  assert.equal(row.status, "active");
  assert.equal(row.plan, "pro", "un changement de prix met à jour le plan");
  stub.restore();
  pass("événements canceled / past_due / updated : statut et plan suivis");
}

{
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    seedSubscriptions: [
      {
        paddle_subscription_id: "sub_01testsubscription000000",
        user_id: USER_ID,
        plan: "plus",
        status: "active",
        paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
        paddle_customer_id: "ctm_01testcustomer000000000",
        source_updated_at: "2026-10-20T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({ occurred_at: "2026-10-01T00:00:00Z", data: { status: "canceled" } }),
  );
  assert.equal(out.body.outcome, "ignored");
  assert.equal(out.body.reason, "stale_event");
  assert.equal(findStoredSubscription(stub.store, "sub_01testsubscription000000").status, "active", "un événement plus ancien n'écrase pas l'état courant");
  stub.restore();
  pass("désordre : un événement plus ancien est ignoré, l'état courant est préservé");
}

{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);
  const out = await deliver(subscriptionEvent({ event_type: "transaction.completed" }));
  assert.equal(out.status, 200);
  assert.equal(out.body.outcome, "ignored");
  assert.equal(out.body.reason, "unhandled_event_type");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("événement non traité : acquitté, ignoré, aucune écriture");
}

// ---------------------------------------------------------------------------
// 6. Direct event-handling contract
// ---------------------------------------------------------------------------
{
  const stub = createSupabaseStub({ users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } } });
  installQueryRouting(stub);
  const outcome = await handleSubscriptionEvent(
    {
      event_id: "evt_direct",
      event_type: "subscription.created",
      occurred_at: new Date().toISOString(),
      data: subscriptionEvent().data,
    },
    {
      supabase: { url: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE },
      // The proof key is derived from the webhook secret; pass it explicitly so
      // the direct contract does not depend on ambient process state.
      attributionSecret: TEST_SECRET,
    },
  );
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.status, "active");
  stub.restore();
  pass("handleSubscriptionEvent : contrat direct testable sans HTTP");
}

// ---------------------------------------------------------------------------
// 7. No secret ever leaves the handler
// ---------------------------------------------------------------------------
{
  const users = { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } };
  const stub = createSupabaseStub({ users });
  installQueryRouting(stub);

  const bodies = [];
  bodies.push(await deliver(subscriptionEvent(), { signature: "ts=1;h1=nope" }));
  bodies.push(await deliver(subscriptionEvent()));
  bodies.push(await deliver(subscriptionEvent(), { env: { SUPABASE_SERVICE_ROLE_KEY: "" } }));

  const serialized = JSON.stringify(bodies);
  assert.equal(serialized.includes(TEST_SECRET), false, "le secret de signature ne doit jamais apparaître");
  assert.equal(serialized.includes(SERVICE_ROLE), false, "la clé service_role ne doit jamais apparaître");
  assert.equal(serialized.includes(USER_EMAIL), false, "aucune adresse e-mail dans les réponses");
  stub.restore();
  pass("réponses HTTP : ni secret de signature, ni clé service_role, ni e-mail");
}

{
  // The browser bundle must never contain the server-only identifiers.
  assert.equal(typeof isUserIdShaped, "function");
  assert.equal(isUserIdShaped(USER_ID), true);
  assert.equal(isUserIdShaped("ctm_01abc"), false);
  pass("garde de forme : seuls des UUID sont acceptés comme identifiant utilisateur");
}

console.log(`\n${checks} vérifications du webhook passées.`);
