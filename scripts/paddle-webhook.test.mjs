/**
 * Webhook tests for api/paddle-webhook.ts.
 *
 * Nothing leaves the process: Supabase is replaced by an in-memory PostgREST
 * stub and signatures are computed locally with a throwaway secret. No real
 * key, token or Paddle identifier is used anywhere in this file.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import assert from "node:assert";
import handler, {
  computeSignature,
  decideReplay,
  handleSubscriptionEvent,
  isUserIdShaped,
  parseSignatureHeader,
  readRawBody,
  resolveBillingPeriod,
  resolvePlanFromPriceId,
  verifySignature,
} from "../api/paddle-webhook.ts";
import { findBlockingSubscription, resolveAccessPlan, toGrant } from "../src/lib/subscriptionAccess.ts";
import { limitsFor } from "../src/lib/planLimits.ts";
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
    writes: { webhookEvents: 0, subscriptions: 0, revocations: 0, finalize: 0, claims: 0 },
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

        // PostgREST fidelity: a filtered PATCH only touches rows the filter
        // matches, and `return=representation` echoes what was written. This is
        // what makes the replay claim a real compare-and-swap rather than an
        // unconditional overwrite: the second of two writers gets [].
        const prefer = new Headers(init.headers ?? {}).get("prefer") ?? "";
        const wantsRows = prefer.includes("return=representation");
        const statusFilter = target.searchParams.get("status");
        if (statusFilter?.startsWith("eq.") && existing.status !== statusFilter.slice(3)) {
          return wantsRows ? json([], 200) : json(null, 204);
        }

        if (statusFilter) store.writes.claims += 1;
        else store.writes.finalize += 1;

        const merged = { ...existing, ...patch };
        store.events.set(id, merged);
        return wantsRows ? json([merged], 200) : json(null, 204);
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
          // The partial customer index still applies: writing this row into an
          // in-force state fails if ANOTHER in-force row already holds the
          // same Paddle customer. This is the realistic source of a 409.
          const IN_FORCE_UPDATE = ["active", "trialing", "past_due", "paused"];
          if (existing.paddle_customer_id && IN_FORCE_UPDATE.includes(row.status)) {
            const clash = [...store.subscriptions.values()].find(
              (stored) =>
                stored.id !== existing.id &&
                stored.paddle_customer_id === existing.paddle_customer_id &&
                IN_FORCE_UPDATE.includes(stored.status),
            );
            if (clash) {
              return json(
                {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "subscriptions_paddle_customer_id_idx"',
                },
                409,
              );
            }
          }
          const updated = { ...existing, ...row, id: existing.id };
          store.subscriptions.set(existing.id, updated);
          return json(null, 201);
        }

        // Fidelity to migration 0002's partial unique index: one Paddle
        // customer may hold only ONE subscription in force at a time. A second
        // INSERT for the same customer with an in-force status answers 409,
        // exactly as PostgREST does — this is the conflict under test.
        const IN_FORCE = ["active", "trialing", "past_due", "paused"];
        if (row.paddle_customer_id && IN_FORCE.includes(row.status)) {
          const clash = [...store.subscriptions.values()].find(
            (stored) =>
              stored.paddle_customer_id === row.paddle_customer_id &&
              IN_FORCE.includes(stored.status) &&
              stored.paddle_subscription_id !== row.paddle_subscription_id,
          );
          if (clash) {
            return json(
              {
                code: "23505",
                message:
                  'duplicate key value violates unique constraint "subscriptions_paddle_customer_id_idx"',
              },
              409,
            );
          }
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

      if (method === "PATCH") {
        // A filtered PATCH, exactly as PostgREST serves it: only the row the
        // filter names is touched, and only the fields sent are replaced.
        const idFilter = target.searchParams.get("paddle_subscription_id");
        const patch = JSON.parse(init.body);
        if (!idFilter?.startsWith("eq.")) return json([], 200);
        const existing = findStoredSubscription(store, decodeURIComponent(idFilter.slice(3)));
        if (!existing) return json([], 200);
        store.writes.revocations += 1;
        store.subscriptions.set(existing.id, { ...existing, ...patch, id: existing.id });
        return json(null, 204);
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
      // The handler selects `status,event_type`: echo both, as PostgREST would.
      return new Response(
        JSON.stringify(row ? [{ status: row.status, event_type: row.event_type }] : []),
        { status: 200 },
      );
    }
    if (method === "GET" && target.pathname === "/rest/v1/subscriptions") {
      const idFilter = target.searchParams.get("paddle_subscription_id");
      const customerFilter = target.searchParams.get("paddle_customer_id");
      const statusFilter = target.searchParams.get("status");

      if (idFilter) {
        const id = decodeURIComponent(idFilter.slice(3));
        const row = findStoredSubscription(stub.store, id);
        return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
      }

      if (customerFilter) {
        const customer = decodeURIComponent(customerFilter.slice(3));
        const wanted = statusFilter?.startsWith("in.(")
          ? statusFilter.slice(4, -1).split(",")
          : null;
        const rows = [...stub.store.subscriptions.values()].filter(
          (row) =>
            row.paddle_customer_id === customer && (!wanted || wanted.includes(row.status)),
        );
        return new Response(JSON.stringify(rows), { status: 200 });
      }

      return new Response(JSON.stringify([]), { status: 200 });
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

/** A Paddle adjustment: the shape refunds and chargebacks arrive in. */
function adjustmentEvent({
  action = "refund",
  status = "approved",
  subscription_id = "sub_01testsubscription000000",
  event_type = "adjustment.created",
  occurred_at = new Date().toISOString(),
  id = `adj_${crypto.randomBytes(8).toString("hex")}`,
  event_id = `evt_${crypto.randomBytes(10).toString("hex")}`,
} = {}) {
  return {
    event_id,
    event_type,
    occurred_at,
    data: {
      id,
      action,
      status,
      subscription_id,
      customer_id: "ctm_01testcustomer000000000",
      transaction_id: "txn_01testtransaction0000000",
      currency_code: "USD",
      created_at: occurred_at,
      updated_at: occurred_at,
    },
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
  // A parsed object body is re-serialised, but the HMAC must still match those
  // exact bytes. A wrong signature is refused: nothing is ever accepted unverified.
  const saved = { ...process.env };
  Object.assign(process.env, { PADDLE_WEBHOOK_SECRET: TEST_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE });
  const { res, out } = makeResponse();
  await handler(
    { method: "POST", headers: { "paddle-signature": "ts=1;h1=abc" }, body: { event_id: "evt_x" } },
    res,
  );
  process.env = saved;
  assert.ok(out.status === 401 || out.status === 500, `refus attendu, reçu ${out.status}`);
  assert.notEqual(out.body.received, true, "jamais d'acceptation d'un corps non vérifié");
  pass("corps déjà analysé sans signature valide : refus explicite, jamais d'acceptation non vérifiée");
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
  assert.equal(out.status, 202, "un paiement qu'on ne sait pas attribuer reste ouvert");
  assert.equal(out.body.outcome, "conflict");
  assert.equal(out.body.reason, "email_mismatch");
  assert.equal(stub.store.subscriptions.size, 0, "jamais de droit sans attribution certaine");
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
  // A mismatch is indistinguishable from a rotated signing secret, so it is
  // retried rather than discarded — and it stays open, visibly, until it
  // resolves. What it can never do is grant anything.
  assert.equal(out.status, 503, "un écart de configuration est réessayé, pas acquitté");
  assert.equal(out.body.outcome, "retry");
  assert.equal(out.body.reason, "invalid_attribution_proof");
  assert.equal(stub.store.subscriptions.size, 0, "aucun droit accordé sur preuve falsifiée");
  assert.equal(
    stub.store.events.values().next().value?.status,
    "received",
    "l'événement reste ouvert : ni traité, ni définitivement refusé",
  );
  stub.restore();
  pass("falsification : user_id remplacé, preuve d'un autre compte → 503 `retry`, rien d'accordé");
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
  assert.equal(out.status, 503);
  assert.equal(out.body.outcome, "retry");
  assert.equal(out.body.reason, "invalid_attribution_proof");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("preuve signée avec un autre secret : 503 `retry` (secret tourné ?), rien d'accordé");
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
  assert.equal(out.status, 503, "une lacune de catalogue est réessayée, pas consommée");
  assert.equal(out.body.reason, "unknown_price_id");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("prix inconnu : 503 `retry`, aucun plan deviné, aucun droit accordé");
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


// ---------------------------------------------------------------------------
// 9. Corps brut : reproduction du runtime Node de Vercel
// ---------------------------------------------------------------------------
// Sur ce runtime, `request.body` est un GETTER PARESSEUX : le seul fait de le
// lire déclenche le parsing JSON et vide le flux. `for await` sur un flux déjà
// vidé ne rend rien — d'où la 500 puis la 401 observées chez Paddle. Les octets
// d'origine ne restent accessibles que par les écouteurs `data` / `end`.
//
// Ce double reproduit ces trois propriétés. Il ne touche à aucun service.
function createVercelRequest({ payload, headers = {}, method = "POST" }) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const emitter = new EventEmitter();
  const state = { drained: false, parsed: undefined, emitted: false };

  // Vercel restaure les octets d'origine sur `data` / `end`.
  const scheduleReplay = () => {
    if (state.emitted) return;
    state.emitted = true;
    setImmediate(() => {
      emitter.emit("data", bytes);
      emitter.emit("end");
    });
  };

  emitter.on("newListener", (event) => {
    if (event === "data" || event === "end") scheduleReplay();
  });

  const request = {
    method,
    headers,
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    // `for await` sur un flux déjà vidé ne rend aucun octet.
    [Symbol.asyncIterator]: async function* () {
      if (state.drained) return;
      state.drained = true;
      yield bytes;
    },
  };

  Object.defineProperty(request, "body", {
    enumerable: true,
    get() {
      if (!state.drained) {
        state.drained = true; // le parsing consomme le flux
        state.parsed = JSON.parse(bytes.toString("utf8"));
        scheduleReplay();
      }
      return state.parsed;
    },
  });

  return request;
}

{
  // Le getter ne doit jamais être touché : les octets signés sont dans le flux.
  const payload = { event_id: "evt_shape", event_type: "subscription.created" };
  const read = await readRawBody(createVercelRequest({ payload }));
  assert.equal(read.ok, true, "les octets doivent être obtenus depuis le flux");
  assert.equal(read.source, "stream", "le flux doit être lu avant le getter `body`");
  assert.deepEqual(JSON.parse(read.buffer.toString("utf8")), payload);
  pass("corps brut : le flux est lu AVANT `body`, le getter paresseux n'est pas déclenché");
}

{
  // Même si le flux a déjà été consommé, les octets restent accessibles sur
  // `data` / `end` : la vérification doit encore disposer des vraies données.
  const payload = { event_id: "evt_shape2", event_type: "subscription.created" };
  const request = createVercelRequest({ payload });
  void request.body; // quelque chose a déjà parsé le corps

  const read = await readRawBody(request);
  assert.equal(read.ok, true, "les octets doivent rester récupérables après parsing");
  assert.deepEqual(JSON.parse(read.buffer.toString("utf8")), payload);
  pass("corps brut : après parsing par la plateforme, les octets d'origine sont récupérés");
}

{
  // Chaîne complète sur une requête « forme Vercel » : signature valide,
  // événement traité, abonnement écrit ET ligne `webhook_events`.
  const users = { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } };
  const stub = createSupabaseStub({ users });
  installQueryRouting(stub);

  const event = subscriptionEvent();
  const raw = JSON.stringify(event);
  const header = sign(raw);

  const saved = { ...process.env };
  Object.assign(process.env, {
    PADDLE_WEBHOOK_SECRET: TEST_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  });

  const { res, out } = makeResponse();
  await handler(
    createVercelRequest({ payload: event, headers: { "paddle-signature": header } }),
    res,
  );
  process.env = saved;

  assert.equal(out.status, 200, `attendu 200, reçu ${out.status} ${JSON.stringify(out.body)}`);
  assert.equal(out.body.received, true);
  assert.ok(findStoredSubscription(stub.store, event.data.id), "l'abonnement doit être enregistré");
  const row = stub.store.events.get(event.event_id);
  assert.ok(row, "une ligne webhook_events doit être écrite");
  assert.equal(row.status, "processed", "l'événement doit être finalisé en `processed`");
  stub.restore();
  pass("requête forme Vercel : 200, abonnement enregistré, événement journalisé");
}

{
  // Une signature invalide reste refusée, et la réponse indique d'où venaient
  // les octets — la seule observabilité disponible sans logs serveur.
  const payload = subscriptionEvent();
  const saved = { ...process.env };
  Object.assign(process.env, { PADDLE_WEBHOOK_SECRET: TEST_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE });
  const { res, out } = makeResponse();
  await handler(
    createVercelRequest({
      payload,
      headers: {
        // Horodatage courant, HMAC faux : le refus doit venir de la signature,
        // pas de la fenêtre de fraîcheur.
        "paddle-signature": `ts=${Math.floor(Date.now() / 1000)};h1=${"deadbeef".repeat(8)}`,
      },
    }),
    res,
  );
  process.env = saved;
  assert.equal(out.status, 401);
  assert.equal(out.body.reason, "mismatch");
  assert.equal(out.body.bodySource, "stream", "les octets signés doivent venir du flux");
  pass("signature invalide : 401 `mismatch` + `bodySource: stream` (diagnostic sans logs)");
}

{
  // Rien ne doit s'échapper du handler : même un objet de réponse cassé.
  const saved = { ...process.env };
  process.env.PADDLE_WEBHOOK_SECRET = TEST_SECRET;
  const brokenResponse = {
    status() {
      throw new Error("response broken");
    },
    json() {},
    setHeader() {
      throw new Error("headers broken");
    },
  };
  const outcome = await handler(
    createVercelRequest({ payload: { event_id: "evt_broken" }, method: "POST" }),
    brokenResponse,
  );
  process.env = saved;
  assert.equal(outcome, undefined, "le handler doit se terminer sans lever, quoi qu'il arrive");
  pass("aucune exception ne peut s'échapper du handler (plus de 500 opaque)");
}


// ---------------------------------------------------------------------------
// 10. Conflits 409 : jamais un succes, jamais une perte
// ---------------------------------------------------------------------------
// Migration 0002 pose un index unique PARTIEL : un client Paddle ne peut avoir
// qu'un seul abonnement en vigueur. Une seconde souscription pour le meme
// client renvoie donc 409. Repondre 503 faisait boucler Paddle indefiniment ;
// repondre 200 « ignore » aurait fait disparaitre un paiement. La regle est :
// identifier le conflit, ne rien decider sans preuve, et conserver l'evenement.
{
  // 10a. Conflit RESOLU : le meme abonnement, meme compte, etat identique.
  // C'est une redelivrance : l'etat a deja ete applique, verifie champ par
  // champ — pas suppose.
  // Même forme que les autres tests : le stub lit `/auth/v1/admin/users/:id`
  // et attend l'utilisateur indexé par son identifiant.
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const event = subscriptionEvent();
  const incomingRow = {
    paddle_subscription_id: event.data.id,
    user_id: USER_ID,
    paddle_customer_id: event.data.customer_id,
    plan: "plus",
    status: "active",
    paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
    current_period_ends_at: event.data.current_billing_period.ends_at,
    source_updated_at: event.occurred_at,
  };

  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      { ...incomingRow, id: crypto.randomUUID() },
      // Une seconde ligne en vigueur pour le meme client Paddle : c'est elle
      // qui fait echouer l'ecriture (index partiel), pas un etat different.
      {
        id: crypto.randomUUID(),
        paddle_subscription_id: "sub_01bloquante0000000000001",
        user_id: USER_ID,
        paddle_customer_id: event.data.customer_id,
        plan: "pro",
        status: "active",
        paddle_price_id: SANDBOX_PRICE_IDS.pro.month,
        current_period_ends_at: "2027-03-01T00:00:00Z",
        source_updated_at: "2026-10-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);

  const out = await deliver(event);
  assert.equal(out.status, 200, `une redelivrance identique doit etre acceptee, recu ${out.status}`);
  assert.match(String(out.body.reason ?? ""), /conflict_already_applied/, "la resolution doit etre nommee");
  assert.equal(
    stub.store.events.get(event.event_id).status,
    "processed",
    "l'evenement est clos, et lisible comme deja applique",
  );
  stub.restore();
  pass("409 resolu : abonnement identique deja applique → 200 `conflict_already_applied`, evenement clos");
}

{
  // 10b. Conflit RESOLU mais etat divergent : le meme abonnement existe, avec
  // un autre plan. Ce n'est PAS une redelivrance : on ne peut pas l'ecrire, et
  // supposer que l'ancien etat suffit ferait perdre un changement paye.
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const event = subscriptionEvent();

  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      {
        id: crypto.randomUUID(),
        paddle_subscription_id: event.data.id,
        user_id: USER_ID,
        paddle_customer_id: event.data.customer_id,
        plan: "pro", // etat stocke different de l'evenement (plus)
        status: "active",
        paddle_price_id: SANDBOX_PRICE_IDS.pro.month,
        current_period_ends_at: event.data.current_billing_period.ends_at,
        source_updated_at: "2026-10-01T00:00:00Z",
      },
      {
        id: crypto.randomUUID(),
        paddle_subscription_id: "sub_01bloquante0000000000002",
        user_id: USER_ID,
        paddle_customer_id: event.data.customer_id,
        plan: "plus",
        status: "active",
        paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
        current_period_ends_at: "2027-03-01T00:00:00Z",
        source_updated_at: "2026-10-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);

  const out = await deliver(event);
  assert.equal(out.status, 202, "un conflit non resolu n'est ni un succes ni un refus");
  assert.equal(out.body.outcome, "conflict");
  assert.match(out.body.reason, /conflict_state_diverged/);

  const row = stub.store.events.get(event.event_id);
  assert.equal(row.status, "received", "l'evenement reste ouvert pour investigation");
  assert.match(row.reason, /conflict_state_diverged/);
  assert.ok(row.reason.includes(event.data.id), "les identifiants Paddle doivent rester lisibles");
  stub.restore();
  pass("409 non resolu (etat divergent) : 202, evenement conserve en `received` avec les identifiants Paddle");
}

{
  // 10c. Conflit non resolu : le client Paddle detient deja un AUTRE abonnement
  // en vigueur. Deux abonnements payes : seule une personne peut trancher.
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const event = subscriptionEvent();

  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      {
        paddle_subscription_id: "sub_01dejapresent00000000001",
        user_id: USER_ID,
        paddle_customer_id: event.data.customer_id, // meme client Paddle
        plan: "plus",
        status: "active",
        paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
        current_period_ends_at: "2027-01-01T00:00:00Z",
        source_updated_at: "2026-10-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);

  const out = await deliver(event);
  assert.equal(out.status, 202);
  assert.match(out.body.reason, /conflict_second_subscription/);

  const row = stub.store.events.get(event.event_id);
  assert.equal(row.status, "received");
  // Le second paiement n'a cree aucune ligne: rien n'a ete perdu en base, et
  // rien n'a ete ecrase.
  assert.equal(stub.store.subscriptions.size, 1, "aucune ligne ne doit etre ecrasee");
  stub.restore();
  pass("409 non resolu (second abonnement du meme client) : 202, rien n'est ecrase ni perdu");
}

{
  // 10d. Conflit non resolu : l'abonnement existe deja sous un AUTRE compte.
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const event = subscriptionEvent();

  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      {
        paddle_subscription_id: event.data.id,
        user_id: OTHER_USER_ID, // meme abonnement Paddle, autre proprietaire
        paddle_customer_id: event.data.customer_id,
        plan: "plus",
        status: "active",
        paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
        current_period_ends_at: event.data.current_billing_period.ends_at,
        source_updated_at: "2026-09-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);

  const out = await deliver(event);

  // Ce cas est intercepte AVANT l'ecriture par `verifyAttribution` : un
  // abonnement deja rattache a un autre compte est refuse, pas reconcilie.
  // C'est encore plus sur qu'un 409 : le paiement ne change jamais de
  // proprietaire, et la raison est journalisee avec ses identifiants.
  assert.equal(out.status, 200);
  assert.match(String(out.body.reason ?? ""), /customer_bound_to_other_user|conflict_other_account/);

  const stored = stub.store.events.get(event.event_id);
  assert.ok(stored, "l'evenement doit rester enregistre pour investigation");
  assert.equal(stored.status, "rejected");
  assert.ok(stored.reason, "la raison doit etre conservee");
  assert.equal(
    stub.store.subscriptions.get([...stub.store.subscriptions.keys()][0]).user_id,
    OTHER_USER_ID,
    "le proprietaire enregistre ne doit pas etre modifie",
  );
  stub.restore();
  pass("abonnement deja rattache a un autre compte : refuse avant ecriture, proprietaire inchange, raison journalisee");
}

{
  // 10e. Paiement potentiellement perdu : le conflit ne doit JAMAIS produire un
  // 200 « recu » sans raison, ni un 503 en boucle.
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const event = subscriptionEvent();

  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      {
        paddle_subscription_id: "sub_01autre0000000000000009",
        user_id: USER_ID,
        paddle_customer_id: event.data.customer_id,
        plan: "pro",
        status: "past_due",
        paddle_price_id: SANDBOX_PRICE_IDS.pro.month,
        current_period_ends_at: "2026-12-15T00:00:00Z",
        source_updated_at: "2026-10-15T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);

  const out = await deliver(event);

  // Ni boucle infinie (503), ni disparition (200 sans trace).
  assert.notEqual(out.status, 503, "un conflit ne doit pas faire boucler Paddle indefiniment");
  assert.equal(out.status, 202);
  assert.ok(out.body.reason, "une raison doit toujours accompagner un conflit");

  const row = stub.store.events.get(event.event_id);
  assert.ok(row, "l'evenement doit rester enregistre");
  assert.equal(row.status, "received", "ni `processed`, ni `rejected`, ni `ignored`");
  assert.ok(
    row.reason && row.reason.includes(event.data.id),
    "l'identifiant de l'abonnement Paddle doit rester disponible pour l'enquete",
  );
  stub.restore();
  pass("paiement potentiellement perdu : ni 503 en boucle ni 200 sans trace, evenement et identifiants conserves");
}

{
  // 10f. Le meme evenement rejoue apres un conflit non resolu ne cree pas de
  // doublon et reste ouvert : il sera reevalue quand la situation sera reglee.
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const event = subscriptionEvent();

  const stub = createSupabaseStub({
    users,
    seedSubscriptions: [
      {
        paddle_subscription_id: "sub_01bloquant0000000000001",
        user_id: USER_ID,
        paddle_customer_id: event.data.customer_id,
        plan: "plus",
        status: "active",
        paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
        current_period_ends_at: "2027-01-01T00:00:00Z",
        source_updated_at: "2026-10-01T00:00:00Z",
      },
    ],
  });
  installQueryRouting(stub);

  const first = await deliver(event);
  const second = await deliver(event);

  assert.equal(first.status, 202);
  assert.equal(second.status, 202, "un rejeu doit donner la meme decision, pas un doublon");
  assert.equal(stub.store.events.size, 1, "un seul evenement enregistre, quel que soit le nombre de livraisons");
  assert.equal(stub.store.subscriptions.size, 1, "aucune ligne d'abonnement ajoutee");
  assert.equal(stub.store.events.get(event.event_id).status, "received");
  stub.restore();
  pass("rejeu apres conflit : idempotent, l'evenement reste unique et ouvert");
}

{
  // Auto-réparation : la preuve a été signée avant que le secret ne change.
  // Première livraison avec le secret courant → 503, événement laissé ouvert.
  // Le secret est corrigé, Paddle livre à nouveau le MÊME événement → il est
  // repris et traité, sans intervention humaine et sans doublon.
  const secretUtiliseAuCheckout = TEST_SECRET;
  const secretTourne = crypto.randomBytes(32).toString("hex");

  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const event = subscriptionEvent();
  const bodyString = JSON.stringify(event);

  const first = await deliver(event, {
    rawBody: bodyString,
    signature: sign(bodyString, { secret: secretTourne }),
    env: { PADDLE_WEBHOOK_SECRET: secretTourne },
  });
  assert.equal(first.status, 503, "secret divergent : livraison réessayée");
  assert.equal(first.body.outcome, "retry");
  assert.equal(first.body.reason, "invalid_attribution_proof");
  assert.equal(stub.store.subscriptions.size, 0, "aucun droit tant que la preuve ne vérifie pas");
  const pending = stub.store.events.get(event.event_id);
  assert.equal(pending.status, "received", "l'événement reste ouvert, donc rejouable");

  // Le secret est corrigé côté déploiement : la même notification revient.
  const second = await deliver(event, {
    rawBody: bodyString,
    signature: sign(bodyString, { secret: secretUtiliseAuCheckout }),
    env: { PADDLE_WEBHOOK_SECRET: secretUtiliseAuCheckout },
  });
  assert.equal(second.status, 200, "après correction, la livraison aboutit");
  assert.equal(second.body.duplicate, undefined, "l'événement ouvert est repris, pas court-circuité");
  assert.equal(stub.store.subscriptions.size, 1, "l'abonnement est enfin accordé");
  assert.equal(stub.store.events.get(event.event_id).status, "processed");

  // Troisième livraison : désormais un vrai doublon, sans réécriture.
  const third = await deliver(event, {
    rawBody: bodyString,
    signature: sign(bodyString, { secret: secretUtiliseAuCheckout }),
    env: { PADDLE_WEBHOOK_SECRET: secretUtiliseAuCheckout },
  });
  assert.equal(third.status, 200);
  assert.equal(third.body.duplicate, true, "une fois traité, l'événement est un doublon");

  stub.restore();
  pass("auto-réparation : 503 tant que le secret diverge, traité dès la correction, puis doublon");
}

// ---------------------------------------------------------------------------
// 14. Renewals: the owner is the stored one, and no proof is required
// ---------------------------------------------------------------------------
// Paddle copies `custom_data` into the subscription and re-sends it with every
// renewal. That copy is frozen at checkout time, so it still carries a proof
// signed with whatever key existed then. Requiring it on renewal ties every
// future payment to the signing secret: one rotation stops every renewal,
// silently. These tests pin the opposite rule: the owner comes from the row,
// and the payload may only ever *agree* with it.
const RENEWAL_SUB_ID = "sub_01testsubscription000000";
const RENEWAL_CUSTOMER_ID = "ctm_01testcustomer000000000";

function existingRow(overrides = {}) {
  return {
    paddle_subscription_id: RENEWAL_SUB_ID,
    user_id: USER_ID,
    plan: "plus",
    status: "active",
    paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
    paddle_customer_id: RENEWAL_CUSTOMER_ID,
    current_period_ends_at: "2026-11-01T00:00:00Z",
    source_updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

{
  // A proof minted with a secret that no longer exists must not block the
  // renewal: the payment is the same subscription, the owner is already known.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: {
        status: "active",
        custom_data: {
          user_id: USER_ID,
          attribution_proof: computeAttributionProof("secret-revoque-en-phase-2", USER_ID),
        },
        current_billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
      },
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.outcome, undefined, "un renouvellement valide est traité");
  assert.equal(out.body.reason, null);
  const row = findStoredSubscription(stub.store, RENEWAL_SUB_ID);
  assert.equal(row.user_id, USER_ID, "le propriétaire reste celui de la base");
  assert.equal(row.current_period_ends_at, "2026-12-01T00:00:00Z", "la nouvelle période est appliquée");
  assert.equal(
    stub.store.requests.some((request) => request.includes("/auth/v1/admin/users/")),
    false,
    "un renouvellement ne consulte même pas le compte : rien à prouver",
  );
  stub.restore();
  pass("renouvellement : preuve signée par un ancien secret acceptée, propriétaire inchangé, période mise à jour");
}

{
  // Even a payload with no `custom_data` at all (older subscriptions, manual
  // Paddle operations) must renew: the row is the authority.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: {
        status: "active",
        custom_data: null,
        current_billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
      },
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.outcome, undefined);
  const row = findStoredSubscription(stub.store, RENEWAL_SUB_ID);
  assert.equal(row.user_id, USER_ID);
  assert.equal(row.current_period_ends_at, "2026-12-01T00:00:00Z");
  stub.restore();
  pass("renouvellement : custom_data absent accepté, propriétaire inchangé");
}

{
  // The decisive case: the claim is backed by a PERFECTLY VALID proof for
  // another account. No amount of cryptography may move an existing
  // subscription, so the refusal comes from ownership, not from the HMAC.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const event = subscriptionEvent({
    event_type: "subscription.updated",
    data: {
      status: "active",
      custom_data: {
        user_id: OTHER_USER_ID,
        attribution_proof: computeAttributionProof(TEST_SECRET, OTHER_USER_ID),
      },
    },
  });
  const out = await deliver(event);
  assert.equal(out.status, 200, "un refus est acquitté, il ne fait pas boucler Paddle");
  assert.equal(out.body.outcome, "rejected");
  assert.equal(out.body.reason, "customer_bound_to_other_user");
  assert.equal(stub.store.writes.subscriptions, 0, "aucune écriture : le propriétaire ne bouge pas");
  const row = findStoredSubscription(stub.store, RENEWAL_SUB_ID);
  assert.equal(row.user_id, USER_ID);
  assert.equal(row.plan, "plus");
  assert.equal(stub.store.events.get(event.event_id).status, "rejected");
  stub.restore();
  pass("renouvellement : preuve VALIDE d'un autre compte refusée, propriétaire et plan intacts");
}

{
  // Same attempt, but the event carries no `customer_id`. The historical guard
  // only applied when both customer ids were present; ownership is now checked
  // on its own, so this case can no longer slip through.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: {
        status: "active",
        customer_id: undefined,
        custom_data: {
          user_id: OTHER_USER_ID,
          attribution_proof: computeAttributionProof(TEST_SECRET, OTHER_USER_ID),
        },
      },
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.outcome, "rejected");
  assert.equal(out.body.reason, "subscription_owner_mismatch");
  assert.equal(stub.store.writes.subscriptions, 0);
  assert.equal(findStoredSubscription(stub.store, RENEWAL_SUB_ID).user_id, USER_ID);
  stub.restore();
  pass("renouvellement sans customer_id : revendication d'un autre compte refusée quand même");
}

{
  // And the mirror case: the row itself has no stored customer id, so the old
  // guard could not fire at all. Ownership is still enforced.
  const stub = createSupabaseStub({
    users: {},
    seedSubscriptions: [existingRow({ paddle_customer_id: null })],
  });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: {
        status: "active",
        custom_data: {
          user_id: OTHER_USER_ID,
          attribution_proof: computeAttributionProof(TEST_SECRET, OTHER_USER_ID),
        },
      },
    }),
  );
  assert.equal(out.body.reason, "subscription_owner_mismatch");
  assert.equal(stub.store.writes.subscriptions, 0);
  assert.equal(findStoredSubscription(stub.store, RENEWAL_SUB_ID).user_id, USER_ID);
  stub.restore();
  pass("renouvellement, client Paddle non stocké : revendication refusée, propriétaire intact");
}

{
  // A different Paddle customer under a known subscription is refused even when
  // the owner matches: the subscription may not be re-pointed at another payer.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: { status: "active", customer_id: "ctm_01unautrecustomer0000000" },
    }),
  );
  assert.equal(out.body.reason, "customer_id_mismatch");
  assert.equal(stub.store.writes.subscriptions, 0);
  assert.equal(findStoredSubscription(stub.store, RENEWAL_SUB_ID).paddle_customer_id, RENEWAL_CUSTOMER_ID);
  stub.restore();
  pass("renouvellement : changement de client Paddle refusé, la ligne garde son payeur");
}

{
  // A customer who edits their billing address in Paddle keeps their access:
  // the email check belongs to the binding, not to the renewals.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: {
        status: "active",
        customer: { email: "adresse-modifiee-dans-paddle@example.com" },
        current_billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
      },
    }),
  );
  assert.equal(out.status, 200, "un e-mail de facturation différent ne bloque pas un renouvellement");
  assert.equal(out.body.outcome, undefined);
  const row = findStoredSubscription(stub.store, RENEWAL_SUB_ID);
  assert.equal(row.user_id, USER_ID);
  assert.equal(row.current_period_ends_at, "2026-12-01T00:00:00Z", "l'accès est conservé");
  stub.restore();
  pass("renouvellement : adresse de facturation différente acceptée, accès conservé");
}

{
  // A corrupted `custom_data.user_id` cannot claim anything, and cannot block
  // either: it is not a claim about another account.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: { status: "active", custom_data: { user_id: "pas-un-uuid" } },
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.outcome, undefined);
  assert.equal(findStoredSubscription(stub.store, RENEWAL_SUB_ID).user_id, USER_ID);
  stub.restore();
  pass("renouvellement : custom_data illisible ignoré, propriétaire inchangé");
}

{
  // Non-regression of the binding rules: at binding time the email is still
  // blocking, and a divergent address keeps the payment for a human.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({ data: { customer: { email: "quelqu-un-dautre@example.com" } } }),
  );
  assert.equal(out.status, 202);
  assert.equal(out.body.reason, "email_mismatch");
  assert.equal(stub.store.subscriptions.size, 0);
  stub.restore();
  pass("liaison : e-mail divergent toujours bloquant (202), aucune écriture");
}

{
  // Non-regression: a first binding still requires a valid proof.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);
  const event = subscriptionEvent({
    data: { custom_data: { user_id: USER_ID, attribution_proof: `v1.${"C".repeat(43)}` } },
  });
  const out = await deliver(event);
  assert.equal(out.status, 503);
  assert.equal(out.body.reason, "invalid_attribution_proof");
  assert.equal(stub.store.subscriptions.size, 0);
  assert.equal(stub.store.events.get(event.event_id).status, "received", "rejouable après correction");
  stub.restore();
  pass("liaison : preuve invalide toujours réessayée (503), aucune écriture");
}

{
  // A cancellation is a renewal like any other: the owner is preserved.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.canceled",
      data: { status: "canceled", custom_data: null, canceled_at: new Date().toISOString() },
    }),
  );
  assert.equal(out.status, 200);
  const row = findStoredSubscription(stub.store, RENEWAL_SUB_ID);
  assert.equal(row.status, "canceled");
  assert.equal(row.user_id, USER_ID);
  stub.restore();
  pass("résiliation : statut mis à jour, propriétaire conservé");
}

{
  // An out-of-order event cannot move the owner either: the ordering guard
  // answers before attribution is even considered.
  const stub = createSupabaseStub({
    users: {},
    seedSubscriptions: [existingRow({ source_updated_at: "2027-01-01T00:00:00Z" })],
  });
  installQueryRouting(stub);
  const event = subscriptionEvent({
    occurred_at: "2026-10-01T00:00:00Z",
    event_type: "subscription.updated",
    data: {
      status: "active",
      custom_data: {
        user_id: OTHER_USER_ID,
        attribution_proof: computeAttributionProof(TEST_SECRET, OTHER_USER_ID),
      },
    },
  });
  const out = await deliver(event);
  assert.equal(out.body.outcome, "ignored");
  assert.equal(out.body.reason, "stale_event");
  assert.equal(stub.store.writes.subscriptions, 0);
  assert.equal(findStoredSubscription(stub.store, RENEWAL_SUB_ID).user_id, USER_ID);
  stub.restore();
  pass("événement plus ancien : ignoré avant toute décision d'attribution, propriétaire intact");
}

{
  // A processed event id is never re-interpreted: replaying it with a rewritten
  // `custom_data` cannot reach the write path at all.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);
  const event = subscriptionEvent();
  const first = await deliver(event);
  assert.equal(first.status, 200);
  assert.equal(stub.store.writes.subscriptions, 1);
  assert.equal(findStoredSubscription(stub.store, RENEWAL_SUB_ID).user_id, USER_ID);

  const tampered = {
    ...event,
    data: {
      ...event.data,
      custom_data: {
        user_id: OTHER_USER_ID,
        attribution_proof: computeAttributionProof(TEST_SECRET, OTHER_USER_ID),
      },
    },
  };
  const second = await deliver(tampered);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true, "l'événement déjà traité est un doublon");
  assert.equal(stub.store.writes.subscriptions, 1, "aucune seconde écriture");
  assert.equal(findStoredSubscription(stub.store, RENEWAL_SUB_ID).user_id, USER_ID);
  stub.restore();
  pass("rejeu d'un événement traité avec custom_data réécrit : doublon, propriétaire intact");
}

{
  // Neither a processing nor a refusal may echo an address, a secret or a key.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [existingRow()] });
  installQueryRouting(stub);
  const bodies = [];
  bodies.push(
    await deliver(
      subscriptionEvent({
        event_type: "subscription.updated",
        data: {
          status: "active",
          customer: { email: USER_EMAIL },
          current_billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
        },
      }),
    ),
  );
  bodies.push(
    await deliver(
      subscriptionEvent({
        event_type: "subscription.updated",
        data: {
          status: "active",
          custom_data: {
            user_id: OTHER_USER_ID,
            attribution_proof: computeAttributionProof(TEST_SECRET, OTHER_USER_ID),
          },
        },
      }),
    ),
  );
  const serialized = JSON.stringify(bodies);
  assert.equal(serialized.includes(USER_EMAIL), false, "aucune adresse e-mail dans les réponses");
  assert.equal(serialized.includes(TEST_SECRET), false, "aucun secret de signature");
  assert.equal(serialized.includes(SERVICE_ROLE), false, "aucune clé service_role");
  stub.restore();
  pass("renouvellements : ni adresse, ni secret, ni clé dans les réponses HTTP");
}

// ---------------------------------------------------------------------------
// N. Rotation du secret — trousseau borné, et le blocage observé en Preview
//
// The incident: a real `subscription.created` was stored as `rejected` with
// `invalid_attribution_proof`, and no subscription row was written. The proof is
// deterministic in (secret, user id), so a proof that does not verify means the
// secret that signed it is not the one that reads it — a rotation, or two
// deployments. These tests pin both halves of the correction: the bounded ring,
// and the fact that a proof minted before a rotation still binds during it.
// ---------------------------------------------------------------------------
{
  const { readSecretRing, ringSecrets, secretKeyId, SECRET_RING_MAX_WINDOW_MS } = await import(
    "../server/webhookSecret.ts"
  );
  const NOW = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const CURRENT = "secret-courant-pour-ce-test";
  const OLD = "secret-precedent-pour-ce-test";

  const ring = (env) => readSecretRing(env, NOW);

  // No previous secret: the ring is a single key, as before.
  {
    const r = ring({ PADDLE_WEBHOOK_SECRET: CURRENT });
    assert.equal(r.current, CURRENT);
    assert.equal(r.previous, null);
    assert.equal(r.previousDeclared, false);
    assert.deepEqual(ringSecrets(r), [CURRENT]);
  }

  // Previous present and inside its window: two keys, current first.
  {
    const r = ring({
      PADDLE_WEBHOOK_SECRET: CURRENT,
      PADDLE_WEBHOOK_SECRET_PREVIOUS: OLD,
      PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: iso(NOW + 60_000),
    });
    assert.equal(r.previous, OLD);
    assert.equal(r.previousRejection, null);
    assert.deepEqual(ringSecrets(r), [CURRENT, OLD], "le secret courant reste prioritaire");
  }

  // Every way of declaring a previous secret wrongly must close the window.
  // A grace period that cannot be bounded is not a grace period.
  const refused = [
    [{}, "missing_until"],
    [{ PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: "pas une date" }, "unreadable_until"],
    [{ PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: iso(NOW - 1_000) }, "expired"],
    [
      { PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: iso(NOW + SECRET_RING_MAX_WINDOW_MS + 3_600_000) },
      "window_too_long",
    ],
    [{ PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: iso(NOW + 60_000) }, "duplicate_of_current"],
  ];
  for (const [extra, expected] of refused) {
    const env = { PADDLE_WEBHOOK_SECRET: CURRENT, PADDLE_WEBHOOK_SECRET_PREVIOUS: OLD, ...extra };
    if (expected === "duplicate_of_current") env.PADDLE_WEBHOOK_SECRET_PREVIOUS = CURRENT;
    const r = ring(env);
    assert.equal(r.previous, null, `${expected} : ancien secret ignoré`);
    assert.equal(r.previousRejection, expected);
    assert.deepEqual(ringSecrets(r), [CURRENT], `${expected} : une seule clé essayée`);
  }

  // The boundary is exclusive: at `_UNTIL` the old secret is already gone.
  {
    const r = ring({
      PADDLE_WEBHOOK_SECRET: CURRENT,
      PADDLE_WEBHOOK_SECRET_PREVIOUS: OLD,
      PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: iso(NOW),
    });
    assert.equal(r.previous, null);
    assert.equal(r.previousRejection, "expired");
  }

  // Fail-closed on the *current* secret: a deployment that lost it must refuse
  // everything, not quietly keep accepting deliveries under the retired key.
  {
    const r = ring({
      PADDLE_WEBHOOK_SECRET_PREVIOUS: OLD,
      PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: iso(NOW + 60_000),
    });
    assert.equal(r.current, null);
    assert.deepEqual(ringSecrets(r), [], "aucune clé utilisable sans secret courant");
  }

  // Fingerprint: stable, short, different per secret, never the secret itself.
  {
    const first = secretKeyId(CURRENT);
    assert.match(first, /^[0-9a-f]{8}$/, "empreinte courte et hexadécimale");
    assert.equal(secretKeyId(CURRENT), first, "stable pour un même secret");
    assert.notEqual(secretKeyId(OLD), first, "deux secrets ont deux empreintes");
    assert.equal(secretKeyId(""), null);
    assert.equal(secretKeyId(null), null);
    assert.equal(first.includes(CURRENT) || CURRENT.includes(first), false);
  }

  pass("trousseau : fenêtre bornée à 7 jours, refus explicite de chaque déclaration invalide");
}

// End-to-end through the real handler: rotation, then the incident itself.
{
  const OLD_SECRET = crypto.randomBytes(32).toString("hex");
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };
  const openWindow = {
    PADDLE_WEBHOOK_SECRET_PREVIOUS: OLD_SECRET,
    PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const closedWindow = {
    PADDLE_WEBHOOK_SECRET_PREVIOUS: OLD_SECRET,
    PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: new Date(Date.now() - 1_000).toISOString(),
  };

  // 1. A delivery still signed with the old secret, inside the window.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent();
    const body = JSON.stringify(payload);
    const out = await deliver(payload, {
      rawBody: body,
      signature: sign(body, { secret: OLD_SECRET }),
      env: openWindow,
    });

    assert.equal(out.status, 200, "signature sous l'ancien secret acceptée dans la fenêtre");
    assert.equal(stub.store.writes.subscriptions, 1, "une seule écriture");
    assert.ok(findStoredSubscription(stub.store, payload.data.id), "l'abonnement est bien créé");
    stub.restore();
  }

  // 2. Same delivery once the window has closed: back to 401, nothing written.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent();
    const body = JSON.stringify(payload);
    const out = await deliver(payload, {
      rawBody: body,
      signature: sign(body, { secret: OLD_SECRET }),
      env: closedWindow,
    });

    assert.equal(out.status, 401);
    assert.equal(out.body.reason, "mismatch");
    assert.equal(stub.store.writes.subscriptions, 0);
    assert.equal(stub.store.writes.webhookEvents, 0, "rien n'est journalisé, comme avant");
    // The refusal must not hand back the key it expected.
    assert.equal(JSON.stringify(out.body).includes(TEST_SECRET), false);
    assert.equal(JSON.stringify(out.body).includes(OLD_SECRET), false);
    stub.restore();
  }

  // 3. The incident, reproduced then fixed: the checkout minted its proof before
  //    the rotation, Paddle signs the delivery with the new secret, and the
  //    proof must still bind during the window.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent({
      data: {
        custom_data: {
          user_id: USER_ID,
          attribution_proof: computeAttributionProof(OLD_SECRET, USER_ID),
        },
      },
    });
    const out = await deliver(payload, { env: openWindow });

    assert.equal(out.status, 200, "la preuve d'avant rotation n'est plus un refus définitif");
    assert.equal(out.body.outcome, undefined, "traité, pas rejeté");
    const row = findStoredSubscription(stub.store, payload.data.id);
    assert.ok(row, "l'abonnement payé est enfin écrit");
    assert.equal(row.user_id, USER_ID, "rattaché au bon compte");
    assert.equal(row.plan, "plus");
    assert.equal(row.status, "active");
    stub.restore();
  }

  // 4. The same proof once the window is closed: refused, and retryable —
  //    never a silent, final discard of a real payment.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent({
      data: {
        custom_data: {
          user_id: USER_ID,
          attribution_proof: computeAttributionProof(OLD_SECRET, USER_ID),
        },
      },
    });
    const out = await deliver(payload, { env: closedWindow });

    assert.equal(out.status, 503);
    assert.equal(out.body.outcome, "retry");
    assert.equal(out.body.reason, "invalid_attribution_proof");
    assert.equal(stub.store.writes.subscriptions, 0);
    stub.restore();
  }

  // 5. Without a previous secret, behaviour is exactly what it was.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent({
      data: {
        custom_data: {
          user_id: USER_ID,
          attribution_proof: computeAttributionProof(OLD_SECRET, USER_ID),
        },
      },
    });
    const out = await deliver(payload);

    assert.equal(out.status, 503);
    assert.equal(out.body.reason, "invalid_attribution_proof");
    assert.equal(stub.store.writes.subscriptions, 0);
    stub.restore();
  }

  // 6. The ring widens the *key*, never the *account*: a proof valid under the
  //    previous secret for another user is still refused.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent({
      data: {
        custom_data: {
          user_id: USER_ID,
          attribution_proof: computeAttributionProof(OLD_SECRET, OTHER_USER_ID),
        },
      },
    });
    const out = await deliver(payload, { env: openWindow });

    assert.equal(out.status, 503);
    assert.equal(out.body.reason, "invalid_attribution_proof");
    assert.equal(stub.store.writes.subscriptions, 0, "aucune ligne pour un compte non prouvé");
    stub.restore();
  }

  // 7. Losing the current secret must not be silently compensated by the old one.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent();
    const body = JSON.stringify(payload);
    const saved = process.env.PADDLE_WEBHOOK_SECRET;
    const out = await deliver(payload, {
      rawBody: body,
      signature: sign(body, { secret: OLD_SECRET }),
      env: { PADDLE_WEBHOOK_SECRET: "", ...openWindow },
    });
    if (saved !== undefined) process.env.PADDLE_WEBHOOK_SECRET = saved;

    assert.equal(out.status, 401);
    assert.equal(out.body.reason, "missing_secret", "le secret courant reste obligatoire");
    assert.equal(stub.store.writes.subscriptions, 0);
    assert.equal(stub.store.writes.webhookEvents, 0);
    stub.restore();
  }

  pass("rotation : signature et preuve acceptées sous l'ancien secret pendant la fenêtre, refusées après");
}

// ---------------------------------------------------------------------------
// O. Colonnes NOT NULL de la base réelle : ne jamais perdre un paiement dessus
//
// `paddle_customer_id` and `currency_code` are NOT NULL in the deployed
// database, while both are nullable in the migrations. Sending a literal null
// fails the whole write, so a real payment would be retried until it expired.
// ---------------------------------------------------------------------------
{
  const users = {
    [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" },
  };

  // `customer_id` absent, nested `customer.id` present: the id is found.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent();
    delete payload.data.customer_id;
    payload.data.customer = { id: "ctm_01nestedcustomervalue0000", email: USER_EMAIL };

    const out = await deliver(payload);
    assert.equal(out.status, 200);
    const row = findStoredSubscription(stub.store, payload.data.id);
    assert.ok(row);
    assert.equal(row.paddle_customer_id, "ctm_01nestedcustomervalue0000", "identifiant lu dans customer.id");
    stub.restore();
  }

  // No customer id at all: retryable, explicit, and nothing written half-way.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent();
    delete payload.data.customer_id;

    const out = await deliver(payload);
    assert.equal(out.status, 503, "jamais un 500 opaque, jamais un succès");
    assert.equal(out.body.outcome, "retry");
    assert.equal(out.body.reason, "missing_customer_id");
    assert.equal(stub.store.writes.subscriptions, 0, "aucune écriture partielle");
    stub.restore();
  }

  // Currency absent: the key is omitted so the column default applies on insert.
  {
    const stub = createSupabaseStub({ users });
    installQueryRouting(stub);
    const payload = subscriptionEvent();
    delete payload.data.currency_code;

    const out = await deliver(payload);
    assert.equal(out.status, 200, "une devise absente ne fait plus échouer l'écriture");
    const sent = stub.store.sentRows.at(-1);
    assert.equal("currency_code" in sent, false, "clé omise, pas null");
    assert.ok(findStoredSubscription(stub.store, payload.data.id));
    stub.restore();
  }

  // On a renewal the stored value must survive an event that carries no currency.
  {
    const payload = subscriptionEvent();
    const stub = createSupabaseStub({
      users,
      seedSubscriptions: [
        {
          user_id: USER_ID,
          paddle_subscription_id: payload.data.id,
          paddle_customer_id: payload.data.customer_id,
          status: "active",
          plan: "plus",
          currency_code: "USD",
        },
      ],
    });
    installQueryRouting(stub);
    const renewal = subscriptionEvent({
      event_type: "subscription.updated",
      data: { id: payload.data.id, status: "active" },
    });
    delete renewal.data.currency_code;

    const out = await deliver(renewal);
    assert.equal(out.status, 200);
    const sent = stub.store.sentRows.at(-1);
    assert.equal("currency_code" in sent, false, "la clé n'est pas renvoyée, donc pas écrasée");
    const stored = findStoredSubscription(stub.store, payload.data.id);
    assert.equal(stored?.currency_code, "USD", "la devise stockée est conservée");
    stub.restore();
  }

  pass("colonnes NOT NULL : customer.id accepté, customer manquant → retry explicite, devise omise et conservée");
}


// ---------------------------------------------------------------------------
// P. La période payée ne s'efface jamais : elle porte le droit d'accès
// ---------------------------------------------------------------------------
// `current_period_ends_at` est le seul champ qui accorde un accès (`toGrant`
// refuse une date absente ou passée). L'upsert remplace la ligne entière : un
// événement sans `current_billing_period` écrasait donc la date par `null` et
// coupait un client qui avait payé. Même famille de bug que `currency_code` et
// `paddle_customer_id`, corrigés au round précédent.
const PERIOD_SUB_ID = "sub_01testsubscription000000";
const PERIOD_CUSTOMER_ID = "ctm_01testcustomer000000000";
const PERIOD_START = "2026-11-01T00:00:00Z";
const PERIOD_END = "2026-12-01T00:00:00Z";

function periodRow(overrides = {}) {
  return {
    paddle_subscription_id: PERIOD_SUB_ID,
    user_id: USER_ID,
    plan: "plus",
    status: "active",
    paddle_price_id: SANDBOX_PRICE_IDS.plus.month,
    paddle_customer_id: PERIOD_CUSTOMER_ID,
    current_period_started_at: PERIOD_START,
    current_period_ends_at: PERIOD_END,
    source_updated_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

// The pure decision, before any I/O: four sources, each named.
{
  assert.deepEqual(
    resolveBillingPeriod(
      { starts_at: "2026-12-01T00:00:00Z", ends_at: "2027-01-01T00:00:00Z" },
      periodRow(),
    ),
    { start: "2026-12-01T00:00:00Z", end: "2027-01-01T00:00:00Z", source: "event" },
    "une période complète de l'événement est retenue telle quelle",
  );
  assert.deepEqual(
    resolveBillingPeriod(null, periodRow()),
    { start: PERIOD_START, end: PERIOD_END, source: "stored" },
    "sans période dans l'événement, la période stockée est conservée",
  );
  assert.deepEqual(
    resolveBillingPeriod({ ends_at: "2027-02-01T00:00:00Z" }, periodRow()),
    { start: PERIOD_START, end: "2027-02-01T00:00:00Z", source: "merged" },
    "une fin de période nouvelle est appliquée, le début vient du stockage",
  );
  assert.deepEqual(
    resolveBillingPeriod({ starts_at: "2027-06-01T00:00:00Z", ends_at: "2027-01-01T00:00:00Z" }, periodRow()),
    { start: null, end: "2027-01-01T00:00:00Z", source: "merged" },
    "une paire incohérente garde la date de fin et abandonne le début (jamais l'inverse)",
  );
  assert.deepEqual(
    resolveBillingPeriod({ starts_at: "2027-01-01T00:00:00Z" }, periodRow()),
    { start: null, end: PERIOD_END, source: "merged" },
    "un début postérieur à la fin stockée ne fabrique pas une période : la fin reste celle qui est connue",
  );
  assert.deepEqual(
    resolveBillingPeriod({}, null),
    { start: null, end: null, source: "absent" },
    "ni événement ni stockage : rien à inventer",
  );
  assert.deepEqual(
    resolveBillingPeriod({ starts_at: "pas une date", ends_at: "2027-01-01T00:00:00Z" }, periodRow()),
    { start: PERIOD_START, end: "2027-01-01T00:00:00Z", source: "merged" },
    "une date illisible est ignorée, jamais écrite",
  );
  pass("période : paire de l'événement prioritaire, stockage conservé, cohérence préservée");
}

{
  // Le cas réel : un renouvellement dont le payload ne porte pas la période.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [periodRow()] });
  installQueryRouting(stub);
  const event = subscriptionEvent({ event_type: "subscription.updated", data: { status: "active" } });
  delete event.data.current_billing_period;

  const out = await deliver(event);
  assert.equal(out.status, 200);
  assert.equal(out.body.outcome, undefined, "l'événement est traité, pas rejeté");

  const sent = stub.store.sentRows.at(-1);
  assert.equal(sent.current_period_ends_at, PERIOD_END, "la date de fin stockée n'est pas effacée");
  assert.equal(sent.current_period_started_at, PERIOD_START, "le début non plus");

  const stored = findStoredSubscription(stub.store, PERIOD_SUB_ID);
  assert.equal(toGrant(stored, USER_ID), "plus", "l'accès du client payant est conservé");
  stub.restore();
  pass("renouvellement sans current_billing_period : période conservée, accès intact");
}

{
  // Une résiliation n'envoie pas toujours de période : elle ne doit pas non plus
  // effacer la date jusqu'à laquelle le client a payé.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [periodRow()] });
  installQueryRouting(stub);
  const event = subscriptionEvent({ event_type: "subscription.canceled", data: { status: "canceled" } });
  delete event.data.current_billing_period;

  const out = await deliver(event);
  assert.equal(out.status, 200);
  const stored = findStoredSubscription(stub.store, PERIOD_SUB_ID);
  assert.equal(stored.status, "canceled");
  assert.equal(stored.current_period_ends_at, PERIOD_END, "l'accès court jusqu'à la fin payée");
  assert.equal(toGrant(stored, USER_ID), "plus", "résiliation ≠ perte immédiate de l'accès");
  stub.restore();
  pass("résiliation sans période : statut mis à jour, fin de droit payée conservée");
}

{
  // Une période réellement nouvelle est appliquée : la conservation n'est pas un
  // refus de mise à jour.
  const stub = createSupabaseStub({ users: {}, seedSubscriptions: [periodRow()] });
  installQueryRouting(stub);
  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.updated",
      data: {
        status: "active",
        current_billing_period: { starts_at: PERIOD_END, ends_at: "2027-01-01T00:00:00Z" },
      },
    }),
  );
  assert.equal(out.status, 200);
  const stored = findStoredSubscription(stub.store, PERIOD_SUB_ID);
  assert.equal(stored.current_period_started_at, PERIOD_END);
  assert.equal(stored.current_period_ends_at, "2027-01-01T00:00:00Z");
  stub.restore();
  pass("période complète fournie : elle remplace bien la précédente");
}

{
  // Un premier abonnement sans aucune période ne fabrique pas de droit : la
  // ligne est écrite, mais `toGrant` refuse. C'est le comportement honnête, et
  // il est vérifié ici pour qu'il ne devienne pas un accès implicite.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);
  const event = subscriptionEvent();
  delete event.data.current_billing_period;
  const out = await deliver(event);
  assert.equal(out.status, 200);
  const stored = findStoredSubscription(stub.store, PERIOD_SUB_ID);
  assert.equal(stored.current_period_ends_at, null);
  assert.equal(toGrant(stored, USER_ID), null, "aucune période ⇒ aucun droit, jamais l'inverse");
  stub.restore();
  pass("premier abonnement sans période : ligne écrite, aucun droit inventé");
}

// ---------------------------------------------------------------------------
// Q. Rejeu d'un événement rejeté : une seule porte, et elle est signée
// ---------------------------------------------------------------------------
// Un rejet n'écrit rien dans `subscriptions` : l'événement peut donc être
// réexaminé sans risque de doubler un droit. Tout le reste reste définitif.
// La seule façon de déclencher un rejeu est une livraison authentique de Paddle
// (signature du trousseau + fenêtre de 5 s) : il n'y a ni route publique, ni
// secret supplémentaire, ni bouton dans l'interface.
{
  const REJECTED_ID = "evt_01replayrejected000000000";

  const replayable = (stored, type) => decideReplay(stored, type);
  assert.deepEqual(
    replayable({ status: "rejected", event_type: "subscription.created" }, "subscription.created"),
    { kind: "replay" },
    "un rejet est rejouable",
  );
  for (const status of ["processed", "ignored"]) {
    assert.deepEqual(
      replayable({ status, event_type: "subscription.created" }, "subscription.created"),
      { kind: "duplicate", reason: null },
      `« ${status} » reste définitif : jamais rejoué`,
    );
  }
  assert.deepEqual(
    replayable({ status: "received", event_type: "subscription.created" }, "subscription.created"),
    { kind: "continue" },
    "une tentative interrompue est terminée, pas rejouée depuis zéro",
  );
  assert.deepEqual(
    replayable({ status: "rejected", event_type: "subscription.created" }, "subscription.updated"),
    { kind: "duplicate", reason: "replay_event_type_mismatch" },
    "un rejeu ne peut pas changer le sujet de l'événement",
  );
  assert.deepEqual(
    replayable(null, "subscription.created"),
    { kind: "duplicate", reason: "event_unreadable" },
    "une ligne illisible n'autorise aucun rejeu",
  );
  pass("rejeu : seuls les rejets sont rejouables, traités/ignorés définitifs, type vérifié");

  // L'état réel de la base : la ligne a été écrite par un déploiement plus
  // ancien, qui classait « preuve invalide » en `rejected`. Le code actuel la
  // classe en `retry` (503), mais la ligne existe et c'est elle qu'il faut
  // pouvoir réexaminer. Le rejeu doit écrire l'abonnement pour le bon compte.
  {
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    stub.store.events.set(REJECTED_ID, {
      event_id: REJECTED_ID,
      event_type: "subscription.created",
      status: "rejected",
      reason: "invalid_attribution_proof",
      occurred_at: "2026-11-01T00:00:00Z",
    });

    const event = subscriptionEvent({ event_id: REJECTED_ID });
    const body = JSON.stringify(event);

    const replayed = await deliver(event, { rawBody: body });
    assert.equal(replayed.status, 200, "le rejeu est accepté, pas traité comme un doublon");
    assert.equal(replayed.body.replayed, true);
    assert.equal(stub.store.writes.subscriptions, 1, "le rejeu écrit enfin l'abonnement");
    assert.equal(stub.store.writes.claims, 1, "un seul verrou de rejeu pris");
    assert.equal(stub.store.events.get(REJECTED_ID).status, "processed");
    assert.equal(stub.store.events.get(REJECTED_ID).reason, null);

    const stored = findStoredSubscription(stub.store, PERIOD_SUB_ID);
    assert.equal(stored.user_id, USER_ID, "l'abonnement revient au propriétaire de la preuve");
    assert.equal(stored.plan, "plus");

    // Une fois traité, l'événement est définitif.
    const third = await deliver(event, { rawBody: body });
    assert.equal(third.body.duplicate, true);
    assert.equal(third.body.replayed, undefined);
    assert.equal(stub.store.writes.subscriptions, 1, "aucune écriture supplémentaire");
    stub.restore();
  }
  pass("rejeu d'un rejet réel : abonnement écrit pour le bon compte, puis définitif");

  // L'incident tel qu'il se produit avec le code actuel : une preuve invalide
  // n'est PAS un rejet définitif mais un `retry` (503). L'événement reste
  // `received`, Paddle le redélivre, et l'ouverture de la fenêtre le termine —
  // sans aucune écriture manuelle en base.
  {
    const oldSecret = crypto.randomBytes(32).toString("hex");
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    const event = subscriptionEvent({
      event_id: "evt_01retrythenwindow00000000",
      data: {
        custom_data: { user_id: USER_ID, attribution_proof: computeAttributionProof(oldSecret, USER_ID) },
      },
    });
    const body = JSON.stringify(event);

    const first = await deliver(event, { rawBody: body });
    assert.equal(first.status, 503, "preuve invalide : réessayable, jamais rejetée");
    assert.equal(first.body.outcome, "retry");
    assert.equal(stub.store.writes.subscriptions, 0);
    assert.equal(stub.store.events.get("evt_01retrythenwindow00000000").status, "received");
    assert.equal(stub.store.writes.claims, 0, "un retry n'est pas un rejeu");

    const second = await deliver(event, {
      rawBody: body,
      env: {
        PADDLE_WEBHOOK_SECRET_PREVIOUS: oldSecret,
        PADDLE_WEBHOOK_SECRET_PREVIOUS_UNTIL: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    assert.equal(second.status, 200);
    assert.equal(stub.store.writes.subscriptions, 1, "la redélivrance termine l'événement");
    assert.equal(stub.store.writes.claims, 0, "chemin « tentative interrompue », pas « rejeu »");
    assert.equal(stub.store.events.get("evt_01retrythenwindow00000000").status, "processed");
    stub.restore();
  }
  pass("incident actuel : preuve invalide → 503 réessayable → fenêtre ouverte → traité, sans écriture manuelle");

  // Le rejeu ne contourne rien : si la preuve reste invalide, il redevient un
  // rejet. Le code ne « débloque » jamais un événement, il le réexamine.
  {
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    // Un statut inconnu est un rejet franc (contrairement à une preuve invalide,
    // qui est réessayable). Le rejeu le réexamine et le rejette de nouveau.
    const event = subscriptionEvent({
      event_id: "evt_01replaystillbad0000000000",
      event_type: "subscription.updated",
      data: { status: "expired" },
    });
    const body = JSON.stringify(event);

    const first = await deliver(event, { rawBody: body });
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, "rejected");
    assert.equal(first.body.reason, "unknown_status");

    const again = await deliver(event, { rawBody: body });
    assert.equal(again.status, 200);
    assert.equal(again.body.outcome, "rejected", "un rejeu qui échoue reste un rejet");
    assert.equal(again.body.reason, "unknown_status");
    assert.equal(stub.store.writes.claims, 1, "le rejeu a bien été tenté une fois");
    assert.equal(stub.store.writes.subscriptions, 0, "aucun droit créé par un rejeu infructueux");
    assert.equal(
      stub.store.events.get("evt_01replaystillbad0000000000").status,
      "rejected",
      "l'état reste honnête : toujours rejeté",
    );
    stub.restore();
  }
  pass("rejeu infructueux : rejeté de nouveau, aucune écriture, aucun droit");

  // Un événement ignoré ou déjà traité ne se rejoue jamais, même si Paddle le
  // renvoie : c'était déjà vrai, c'est vérifié explicitement après ce changement.
  {
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    const ignoredEvent = subscriptionEvent({
      event_id: "evt_01replayignored0000000000",
      event_type: "transaction.updated",
      data: { status: "completed" },
    });
    const ignoredBody = JSON.stringify(ignoredEvent);
    const firstIgnore = await deliver(ignoredEvent, { rawBody: ignoredBody });
    assert.equal(firstIgnore.body.outcome, "ignored");
    assert.equal(stub.store.events.get("evt_01replayignored0000000000").status, "ignored");

    const ignoreAgain = await deliver(ignoredEvent, { rawBody: ignoredBody });
    assert.equal(ignoreAgain.body.duplicate, true);
    assert.equal(ignoreAgain.body.replayed, undefined);
    assert.equal(stub.store.writes.claims, 0, "un événement ignoré n'est jamais verrouillé pour rejeu");
    assert.equal(stub.store.events.get("evt_01replayignored0000000000").status, "ignored");

    const processedEvent = subscriptionEvent({ event_id: "evt_01replayprocessed000000000" });
    const processedBody = JSON.stringify(processedEvent);
    await deliver(processedEvent, { rawBody: processedBody });
    assert.equal(stub.store.writes.subscriptions, 1);
    const processedAgain = await deliver(processedEvent, { rawBody: processedBody });
    assert.equal(processedAgain.body.duplicate, true);
    assert.equal(processedAgain.body.replayed, undefined);
    assert.equal(stub.store.writes.subscriptions, 1, "un événement traité ne réécrit rien");
    assert.equal(stub.store.writes.claims, 0);
    stub.restore();
  }
  pass("jamais de rejeu automatique d'un événement ignoré ou déjà traité");

  // Un rejeu ne peut pas changer le sujet : même identifiant, autre type.
  {
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    stub.store.events.set("evt_01replaymismatch0000000000", {
      event_id: "evt_01replaymismatch0000000000",
      event_type: "subscription.created",
      status: "rejected",
      occurred_at: "2026-11-01T00:00:00Z",
    });
    const out = await deliver(
      subscriptionEvent({ event_id: "evt_01replaymismatch0000000000", event_type: "subscription.updated" }),
    );
    assert.equal(out.status, 200);
    assert.equal(out.body.duplicate, true);
    assert.equal(out.body.reason, "replay_event_type_mismatch");
    assert.equal(stub.store.writes.claims, 0);
    assert.equal(stub.store.writes.subscriptions, 0);
    assert.equal(stub.store.events.get("evt_01replaymismatch0000000000").status, "rejected");
    stub.restore();
  }
  pass("rejeu avec un autre type d'événement : refusé, rien n'est touché");

  // Deux livraisons simultanées : une seule prend le verrou, l'autre répond
  // « doublon ». Le verrou est le PATCH conditionnel exécuté par PostgREST, pas
  // un drapeau en mémoire — deux instances Vercel ne partagent rien.
  {
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    stub.store.events.set("evt_01replayconcurrent00000000", {
      event_id: "evt_01replayconcurrent00000000",
      event_type: "subscription.created",
      status: "rejected",
      occurred_at: "2026-11-01T00:00:00Z",
    });

    // Une autre instance a déjà pris le verrou : le compare-and-swap ne renvoie
    // aucune ligne, ce que le handler doit interpréter comme « en cours ».
    const routed = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(String(url));
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "PATCH" && target.pathname === "/rest/v1/webhook_events") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return routed(url, init);
    };

    const out = await deliver(subscriptionEvent({ event_id: "evt_01replayconcurrent00000000" }));
    globalThis.fetch = routed;

    assert.equal(out.status, 200);
    assert.equal(out.body.duplicate, true);
    assert.equal(out.body.reason, "replay_in_progress");
    assert.equal(stub.store.writes.subscriptions, 0, "aucune double écriture");
    stub.restore();
  }
  pass("rejeu concurrent : un seul traite, l'autre répond « en cours », zéro double écriture");

  // Sans signature fraîche, aucun rejeu : la porte est la signature, pas l'id.
  {
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    stub.store.events.set("evt_01replayunsigned000000000", {
      event_id: "evt_01replayunsigned000000000",
      event_type: "subscription.created",
      status: "rejected",
      occurred_at: "2026-11-01T00:00:00Z",
    });
    const event = subscriptionEvent({ event_id: "evt_01replayunsigned000000000" });
    const body = JSON.stringify(event);
    const stale = sign(body, { ts: Math.floor(Date.now() / 1000) - 600 });

    const out = await deliver(event, { rawBody: body, signature: stale });
    assert.equal(out.status, 401, "une livraison périmée ne déclenche aucun rejeu");
    assert.equal(stub.store.writes.claims, 0);
    assert.equal(stub.store.writes.subscriptions, 0);
    assert.equal(stub.store.events.get("evt_01replayunsigned000000000").status, "rejected");
    stub.restore();
  }
  pass("rejeu refusé sans signature fraîche : un identifiant d'événement n'ouvre aucune porte");
}

// ---------------------------------------------------------------------------
// 10. La chaîne payante, prise à la jointure : la ligne écrite par le webhook
//     est celle que le contrôle d'accès lit, avec les mêmes valeurs.
// ---------------------------------------------------------------------------
// Everywhere else, the webhook is tested against rows and the access layer
// against rows: each half can be right while the pair disagrees. This block
// takes what the handler actually wrote to `subscriptions` and feeds it, as-is,
// to the rule the chat applies. It is the closest thing to "Paddle → webhook →
// Supabase → droits" that can be done without a real project — and it is not
// a substitute for one (see the S5 report, §"ce qui n'est pas vérifié").
{
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 20 * 86_400_000).toISOString();

  const created = await deliver(
    subscriptionEvent({
      event_type: "subscription.created",
      data: {
        status: "active",
        current_billing_period: { starts_at: startsAt, ends_at: endsAt },
      },
    }),
  );
  assert.equal(created.status, 200, "l'événement d'achat est accepté");

  const stored = [...stub.store.subscriptions.values()];
  assert.equal(stored.length, 1, "une seule ligne d'abonnement écrite");
  const row = stored[0];

  // Ce que le chat décidera, à partir de cette ligne et de rien d'autre.
  assert.equal(row.plan, "plus", "la formule payée est celle enregistrée");
  assert.equal(row.status, "active");
  assert.equal(toGrant(row, USER_ID), "plus", "le contrôle d'accès accorde la formule achetée");
  assert.equal(toGrant(row, OTHER_USER_ID), null, "et à personne d'autre");
  assert.equal(resolveAccessPlan([row], USER_ID), "plus");
  assert.equal(limitsFor(resolveAccessPlan([row], USER_ID)).messagesPerDay, 200, "les quotas suivent la formule accordée");

  // Résiliation : le statut suit l'événement, et le droit payant tient jusqu'à
  // la fin de la période déjà payée — c'est la promesse commerciale.
  const canceled = await deliver(
    subscriptionEvent({
      event_type: "subscription.canceled",
      data: {
        status: "canceled",
        current_billing_period: { starts_at: startsAt, ends_at: endsAt },
      },
    }),
  );
  assert.equal(canceled.status, 200);
  const afterCancel = [...stub.store.subscriptions.values()][0];
  assert.equal(afterCancel.status, "canceled", "le statut de la ligne suit l'événement");
  assert.equal(toGrant(afterCancel, USER_ID), "plus", "la période payée reste due après résiliation");

  // La même ligne, une fois la période échue : plus aucun droit payant.
  assert.equal(
    toGrant({ ...afterCancel, current_period_ends_at: new Date(Date.now() - 1_000).toISOString() }, USER_ID),
    null,
    "période échue : plus de droit payant",
  );
  assert.equal(
    resolveAccessPlan(
      [{ ...afterCancel, current_period_ends_at: new Date(Date.now() - 1_000).toISOString() }],
      USER_ID,
    ),
    "decouverte",
    "période échue : retour à la formule gratuite",
  );

  stub.restore();
  pass("chaîne payante : la ligne écrite par le webhook donne la formule achetée, tient jusqu'à la fin payée, puis s'éteint");
}

// ---------------------------------------------------------------------------
// 11. Pause et reprise : la règle de cycle de vie, testée des deux côtés
// ---------------------------------------------------------------------------
// Policy under test: paused stops access at once (billing is suspended, so the
// service is), resumed restores the status Paddle sends, and a paused row still
// occupies the customer so a second subscription cannot be sold on top of it.
{
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const startsAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 25 * 86_400_000).toISOString();

  const created = await deliver(
    subscriptionEvent({ data: { status: "active", current_billing_period: { starts_at: startsAt, ends_at: endsAt } } }),
  );
  assert.equal(created.status, 200);
  assert.equal(toGrant([...stub.store.subscriptions.values()][0], USER_ID), "plus");

  // --- pause ---------------------------------------------------------------
  const paused = await deliver(
    subscriptionEvent({
      event_type: "subscription.paused",
      data: { status: "paused", current_billing_period: { starts_at: startsAt, ends_at: endsAt } },
    }),
  );
  assert.equal(paused.status, 200, "l'événement de pause est traité, plus ignoré");
  assert.notEqual(paused.body.outcome, "ignored", "la pause n'est plus un événement non géré");
  const afterPause = [...stub.store.subscriptions.values()][0];
  assert.equal(afterPause.status, "paused", "le statut stocké suit la pause");
  assert.equal(toGrant(afterPause, USER_ID), null, "en pause : plus d'accès, immédiatement");
  assert.equal(resolveAccessPlan([afterPause], USER_ID), "decouverte");
  assert.equal(afterPause.current_period_ends_at, endsAt, "la période payée reste enregistrée, elle n'est pas effacée");
  assert.equal(
    findBlockingSubscription([afterPause], USER_ID)?.status,
    "paused",
    "une ligne en pause occupe le client : aucun second abonnement ne peut être vendu par-dessus",
  );

  // --- reprise -------------------------------------------------------------
  const resumed = await deliver(
    subscriptionEvent({
      event_type: "subscription.resumed",
      data: { status: "active", current_billing_period: { starts_at: startsAt, ends_at: endsAt } },
    }),
  );
  assert.equal(resumed.status, 200);
  const afterResume = [...stub.store.subscriptions.values()][0];
  assert.equal(afterResume.status, "active");
  assert.equal(toGrant(afterResume, USER_ID), "plus", "la reprise rend l'accès, sans nouvelle période inventée");
  assert.equal(afterResume.current_period_ends_at, endsAt);

  // --- pause sans statut dans le corps ------------------------------------
  const silent = await deliver(
    subscriptionEvent({
      event_type: "subscription.paused",
      data: { status: undefined, current_billing_period: { starts_at: startsAt, ends_at: endsAt } },
    }),
  );
  assert.equal(silent.status, 200);
  assert.equal([...stub.store.subscriptions.values()][0].status, "paused", "l'événement de pause porte son propre statut");

  stub.restore();
  pass("pause : accès coupé immédiatement, période conservée, client toujours occupé ; reprise : accès rendu");
}

// ---------------------------------------------------------------------------
// 12. Remboursements et contestations : révocation, périmètre, idempotence
// ---------------------------------------------------------------------------
{
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const startsAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 25 * 86_400_000).toISOString();
  await deliver(
    subscriptionEvent({ data: { status: "active", current_billing_period: { starts_at: startsAt, ends_at: endsAt } } }),
  );
  assert.equal(toGrant([...stub.store.subscriptions.values()][0], USER_ID), "plus");

  // --- remboursement approuvé ---------------------------------------------
  const before = Date.now();
  const refunded = await deliver(adjustmentEvent({ action: "refund", status: "approved" }));
  assert.equal(refunded.status, 200);
  // The processed path answers `reason` without an `outcome` field (the event
  // reached the end of the pipeline); the revoked state is asserted below.
  assert.equal(refunded.body.reason, "access_revoked_refund");
  const afterRefund = [...stub.store.subscriptions.values()][0];
  assert.equal(afterRefund.status, "canceled", "un remboursement met fin à l'abonnement");
  const revokedEnd = Date.parse(afterRefund.current_period_ends_at);
  assert.ok(revokedEnd >= before - 1000 && revokedEnd <= Date.now() + 1000, "la période payée est ramenée à l'instant de la révocation");
  assert.equal(toGrant(afterRefund, USER_ID), null, "plus aucun droit après un remboursement");
  assert.equal(resolveAccessPlan([afterRefund], USER_ID), "decouverte");
  assert.equal(afterRefund.plan, "plus", "la ligne garde sa formule : rien n'est effacé, seulement le droit");
  assert.equal(afterRefund.paddle_customer_id, "ctm_01testcustomer000000000", "les identifiants Paddle restent, pour retrouver le paiement");
  assert.equal(
    findBlockingSubscription([afterRefund], USER_ID),
    null,
    "après révocation, le client n'est plus occupé : il peut reprendre un abonnement",
  );

  // --- idempotence : le même événement rejoué -----------------------------
  const writesBefore = stub.store.writes.revocations;
  const replay = await deliver(adjustmentEvent({ action: "refund", status: "approved", event_id: refunded.body.event_id }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true, "le rejeu est reconnu comme doublon");
  assert.equal(stub.store.writes.revocations, writesBefore, "aucune seconde révocation");
  assert.deepEqual([...stub.store.subscriptions.values()][0], afterRefund, "l'état est inchangé");

  // --- idempotence : deux événements distincts, même adjustment -----------
  const writesAfterReplay = stub.store.writes.revocations;
  const again = await deliver(adjustmentEvent({ action: "refund", status: "approved", event_type: "adjustment.updated" }));
  assert.equal(again.body.reason, "already_revoked", "le second événement constate que le travail est fait");
  assert.equal(stub.store.writes.revocations, writesAfterReplay, "et n'écrit pas une seconde fois");
  assert.deepEqual(
    [...stub.store.subscriptions.values()][0],
    afterRefund,
    "un second événement pour le même remboursement laisse l'état strictement identique",
  );

  stub.restore();
  pass("remboursement : droits révoqués à l'instant, ligne conservée, rejeu et double événement sans effet supplémentaire");
}

{
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const startsAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 25 * 86_400_000).toISOString();
  await deliver(
    subscriptionEvent({ data: { status: "active", current_billing_period: { starts_at: startsAt, ends_at: endsAt } } }),
  );

  // --- contestation bancaire approuvée ------------------------------------
  const chargedBack = await deliver(adjustmentEvent({ action: "chargeback", status: "approved" }));
  assert.equal(chargedBack.body.reason, "access_revoked_chargeback");
  assert.equal(toGrant([...stub.store.subscriptions.values()][0], USER_ID), null, "une contestation révoque comme un remboursement");

  stub.restore();
  pass("contestation bancaire : même révocation, motif distinct dans la réponse");
}

{
  // Ce qui ne révoque pas — chaque refus a son motif, aucune écriture.
  const cases = [
    { label: "remboursement en attente d'approbation", event: { action: "refund", status: "pending_approval" }, reason: "not_approved" },
    { label: "remboursement refusé", event: { action: "refund", status: "rejected" }, reason: "not_approved" },
    { label: "contestation annulée (client débouté)", event: { action: "chargeback", status: "reversed" }, reason: "not_approved" },
    { label: "avoir commercial (crédit)", event: { action: "credit", status: "approved" }, reason: "unhandled_action" },
    { label: "avertissement de contestation", event: { action: "chargeback_warning", status: "approved" }, reason: "unhandled_action" },
    { label: "ajustement sans abonnement", event: { action: "refund", status: "approved", subscription_id: null }, reason: "no_subscription" },
    { label: "ajustement sans action", event: { action: null, status: "approved" }, reason: "invalid_data" },
  ];

  for (const testCase of cases) {
    const stub = createSupabaseStub({
      users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    });
    installQueryRouting(stub);
    const startsAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 25 * 86_400_000).toISOString();
    await deliver(
      subscriptionEvent({ data: { status: "active", current_billing_period: { starts_at: startsAt, ends_at: endsAt } } }),
    );
    const before = [...stub.store.subscriptions.values()][0];

    const out = await deliver(adjustmentEvent(testCase.event));
    assert.equal(out.status, 200, testCase.label);
    assert.equal(out.body.outcome, "ignored", testCase.label);
    assert.equal(out.body.reason, testCase.reason, testCase.label);
    assert.equal(stub.store.writes.revocations, 0, `${testCase.label} : aucune écriture`);
    assert.deepEqual([...stub.store.subscriptions.values()][0], before, `${testCase.label} : état intact`);
    assert.equal(toGrant([...stub.store.subscriptions.values()][0], USER_ID), "plus", `${testCase.label} : l'accès reste`);
    stub.restore();
  }

  pass(`remboursements sans effet : ${cases.length} cas refusés avec leur motif, zéro écriture`);
}

{
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  // Un remboursement pour un abonnement que nous n'avons jamais enregistré :
  // rien à révoquer, rien à créer non plus.
  const orphan = await deliver(adjustmentEvent({ action: "refund", status: "approved", subscription_id: "sub_01neverstored00000000000" }));
  assert.equal(orphan.status, 200);
  assert.equal(orphan.body.outcome, "ignored");
  assert.equal(orphan.body.reason, "unknown_subscription");
  assert.equal(stub.store.subscriptions.size, 0, "aucune ligne inventée");
  assert.equal(stub.store.writes.revocations, 0);

  // Un remboursement plus ancien que l'abonnement en cours ne le coupe pas.
  const startsAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 28 * 86_400_000).toISOString();
  await deliver(
    subscriptionEvent({
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      data: { status: "active", current_billing_period: { starts_at: startsAt, ends_at: endsAt } },
    }),
  );
  const stale = await deliver(
    adjustmentEvent({ action: "refund", status: "approved", occurred_at: new Date(Date.now() - 3_600_000).toISOString() }),
  );
  assert.equal(stale.body.outcome, "ignored");
  assert.equal(stale.body.reason, "stale_event");
  assert.equal(stub.store.writes.revocations, 0);
  assert.equal(toGrant([...stub.store.subscriptions.values()][0], USER_ID), "plus", "un remboursement périmé ne coupe pas un abonnement plus récent");

  stub.restore();
  pass("remboursement orphelin ou périmé : ignoré, nommé, sans écriture ni révocation");
}

{
  // Un remboursement ne RALLONGE jamais un droit déjà éteint.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const startedAt = "2026-01-01T00:00:00Z";
  const alreadyEnded = "2026-02-01T00:00:00Z";
  await deliver(
    subscriptionEvent({
      occurred_at: "2026-01-05T00:00:00Z",
      data: {
        status: "active",
        current_billing_period: { starts_at: startedAt, ends_at: alreadyEnded },
      },
    }),
  );
  const out = await deliver(adjustmentEvent({ action: "refund", status: "approved", occurred_at: "2026-03-01T00:00:00Z" }));
  assert.equal(out.body.reason, "access_revoked_refund");
  assert.equal(
    [...stub.store.subscriptions.values()][0].current_period_ends_at,
    alreadyEnded,
    "la fin de période déjà révolue est conservée telle quelle, jamais repoussée à l'instant du remboursement",
  );
  assert.equal(toGrant([...stub.store.subscriptions.values()][0], USER_ID), null);

  stub.restore();
  pass("remboursement tardif : la période reste éteinte, aucune seconde de droit rendue par accident");
}

// ---------------------------------------------------------------------------
// 13. `subscription.activated` : l'événement qui ouvre réellement les droits
// ---------------------------------------------------------------------------
// Paddle Sandbox a réellement émis `subscription.activated` et l'endpoint
// répondait 200 `ignored / unhandled_event_type` : une livraison comptée comme
// réussie, aucun abonnement écrit, aucun droit accordé. Ces blocs vérifient deux
// choses distinctes — l'événement est désormais traité, ET le statut enregistré
// est celui du payload (une conversion d'essai ne doit pas être promue `active`
// par supposition), parce que c'est ce statut que la règle d'accès lira.
{
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 25 * 86_400_000).toISOString();

  const event = subscriptionEvent({
    event_type: "subscription.activated",
    data: { status: "active", current_billing_period: { starts_at: startsAt, ends_at: endsAt } },
  });
  const out = await deliver(event);

  assert.equal(out.status, 200, `activated doit être accepté, reçu ${out.status} ${JSON.stringify(out.body)}`);
  assert.equal(out.body.received, true);
  assert.notEqual(
    out.body.reason,
    "unhandled_event_type",
    "activated n'est plus acquitté sans être traité (le défaut qui laissait un paiement sans droits)",
  );

  const row = findStoredSubscription(stub.store, event.data.id);
  assert.ok(row, "l'abonnement doit être enregistré");
  assert.equal(row.plan, "plus", "la formule suit le prix du payload");
  assert.equal(row.status, "active", "le statut enregistré est exactement celui du payload");
  assert.equal(toGrant(row, USER_ID), "plus", "les droits payants sont accordés dès l'activation");
  assert.equal(resolveAccessPlan([row], USER_ID), "plus", "le contrôle d'accès rend la formule achetée");
  assert.equal(limitsFor(resolveAccessPlan([row], USER_ID)).messagesPerDay, 200, "les quotas suivent la formule accordée");
  assert.equal(toGrant(row, OTHER_USER_ID), null, "et à aucun autre compte");

  const logged = stub.store.events.get(event.event_id);
  assert.ok(logged, "une ligne webhook_events doit être écrite");
  assert.equal(logged.status, "processed", "l'événement est finalisé en `processed`, plus en `ignored`");

  stub.restore();
  pass("activated (status `active`) : traité, abonnement enregistré, droits et quotas accordés");
}

{
  // Le statut réel, pas une promotion : un essai converti reste `trialing`.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 10 * 86_400_000).toISOString();

  const event = subscriptionEvent({
    event_type: "subscription.activated",
    data: { status: "trialing", current_billing_period: { starts_at: startsAt, ends_at: endsAt } },
  });
  const out = await deliver(event);

  assert.equal(out.status, 200);
  const row = findStoredSubscription(stub.store, event.data.id);
  assert.ok(row);
  assert.equal(row.status, "trialing", "un statut `trialing` est enregistré tel quel, jamais promu `active`");
  assert.equal(toGrant(row, USER_ID), "plus", "un essai en cours, dans sa période, ouvre bien les droits");

  stub.restore();
  pass("activated (status `trialing`) : le statut réel du payload est conservé, les droits suivent ce statut");
}

{
  // Ni fallback inventé ni écriture : un `activated` sans statut exploitable est
  // refusé. Deviner `active` ici accorderait des droits sur une supposition.
  const stub = createSupabaseStub({
    users: { [USER_ID]: { id: USER_ID, email: USER_EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" } },
  });
  installQueryRouting(stub);

  const out = await deliver(
    subscriptionEvent({
      event_type: "subscription.activated",
      data: { status: "unknown_state" },
    }),
  );

  assert.equal(out.body.outcome, "rejected", "un statut inconnu est refusé, pas deviné");
  assert.equal(out.body.reason, "unknown_status");
  assert.equal(stub.store.subscriptions.size, 0, "aucune ligne d'abonnement écrite sur un statut inconnu");

  stub.restore();
  pass("activated sans statut exploitable : refus explicite, aucune écriture, aucun statut inventé");
}

// ---------------------------------------------------------------------------
// 14. Corps illisible : 503 + motif, pour que Paddle réessaie
// ---------------------------------------------------------------------------
// C'était le seul 500 que ce code produisait, et il ne disait rien d'exploitable
// dans le journal de notification. 503 = même famille (Paddle réessaie) avec un
// motif nommé : `body_empty` (aucun octet reçu) ou `body_unreadable` (octets
// reçus, mais non récupérables).
{
  const saved = { ...process.env };
  Object.assign(process.env, {
    PADDLE_WEBHOOK_SECRET: TEST_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  });

  const { res, out } = makeResponse();
  await handler(
    { method: "POST", headers: { "paddle-signature": `ts=${Math.floor(Date.now() / 1000)};h1=${"ab".repeat(32)}` } },
    res,
  );
  process.env = saved;

  assert.equal(out.status, 503, `corps absent : 503 attendu (Paddle réessaie), reçu ${out.status}`);
  assert.notEqual(out.status, 500, "plus de 500 opaque sur ce chemin");
  assert.equal(out.body.reason, "body_empty", "le motif nomme précisément la cause");
  assert.equal(out.body.retry, true, "la réponse dit explicitement qu'une nouvelle livraison est attendue");
  assert.equal(out.body.received, undefined, "rien n'est accepté sans corps vérifiable");
  pass("corps absent : 503 `body_empty` + `retry: true`, jamais 500 et jamais une acceptation");
}

{
  const saved = { ...process.env };
  Object.assign(process.env, {
    PADDLE_WEBHOOK_SECRET: TEST_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  });

  // Un corps présent mais non ré-sérialisable : les octets signés sont perdus.
  const circular = { event_id: "evt_circular" };
  circular.self = circular;

  const { res, out } = makeResponse();
  await handler(
    {
      method: "POST",
      headers: { "paddle-signature": `ts=${Math.floor(Date.now() / 1000)};h1=${"ab".repeat(32)}` },
      body: circular,
    },
    res,
  );
  process.env = saved;

  assert.equal(out.status, 503, `corps illisible : 503 attendu, reçu ${out.status}`);
  assert.equal(out.body.reason, "body_unreadable");
  assert.equal(out.body.retry, true);
  assert.equal(out.body.received, undefined, "rien n'est accepté sans octets vérifiables");
  pass("corps illisible : 503 `body_unreadable` + `retry: true`, jamais une acceptation non vérifiée");
}


console.log(`\n${checks} vérifications du webhook passées.`);
