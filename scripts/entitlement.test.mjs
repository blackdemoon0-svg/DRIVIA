/**
 * Tests for src/lib/entitlement.ts — how the account page reads a plan.
 *
 * Supabase is replaced by a stub that behaves like PostgREST *plus RLS*: it only
 * ever returns rows the caller is allowed to see. The tests then check both the
 * happy path and the cases where a row must be refused (another account, an
 * unknown plan, a malformed status, a missing table).
 */
import assert from "node:assert";
import {
  SUBSCRIPTION_COLUMNS,
  SUBSCRIPTION_TABLE,
  formatDate,
  parseSubscriptionRow,
  planLabel,
  readEntitlement,
  selectSubscription,
  summarizeSubscription,
} from "../src/lib/entitlement.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const USER_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_USER_ID = "99999999-8888-7777-6666-555555555555";

function row(overrides = {}) {
  return {
    user_id: USER_ID,
    plan: "plus",
    status: "active",
    current_period_ends_at: "2026-11-12T00:00:00Z",
    scheduled_change_effective_at: null,
    canceled_at: null,
    source_updated_at: "2026-10-12T00:00:00Z",
    ...overrides,
  };
}

/**
 * PostgREST stub. `visibleRows` is what RLS lets through; `calls` records the
 * query so we can assert the filter is applied.
 */
function createClient({ visibleRows = [], error = null, throws = false } = {}) {
  const calls = { table: null, columns: null, filters: [] };

  const client = {
    from(table) {
      calls.table = table;
      return {
        select(columns) {
          calls.columns = columns;
          return {
            // eslint-disable-next-line no-unused-vars
            eq(column, value) {
              calls.filters.push([column, value]);
              if (throws) throw new Error("network down");
              if (error) return Promise.resolve({ data: null, error });
              return Promise.resolve({ data: visibleRows, error: null });
            },
          };
        },
      };
    },
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// 1. Row validation — an account can only be shown its own plan
// ---------------------------------------------------------------------------
{
  const parsed = parseSubscriptionRow(row(), USER_ID);
  assert.ok(parsed);
  assert.equal(parsed.userId, USER_ID);
  assert.equal(parsed.plan, "plus");
  assert.equal(parsed.status, "active");
  assert.equal(parsed.currentPeriodEnd, "2026-11-12T00:00:00Z");
  pass("ligne valide du bon compte : acceptée et normalisée");
}

{
  assert.equal(parseSubscriptionRow(row({ user_id: OTHER_USER_ID }), USER_ID), null);
  assert.equal(parseSubscriptionRow(row({ user_id: undefined }), USER_ID), null);
  assert.equal(parseSubscriptionRow(row(), ""), null);
  assert.equal(parseSubscriptionRow(null, USER_ID), null);
  pass("ligne d'un autre compte ou sans propriétaire : refusée");
}

{
  assert.equal(parseSubscriptionRow(row({ plan: "gratuit" }), USER_ID), null);
  assert.equal(parseSubscriptionRow(row({ plan: "PRO" }), USER_ID), null);
  assert.equal(parseSubscriptionRow(row({ status: "inconnu" }), USER_ID), null);
  assert.equal(parseSubscriptionRow(row({ plan: "admin" }), USER_ID), null, "aucun plan hors plus/pro");
  pass("plan ou statut inconnu : refusé, aucun plan deviné");
}

{
  const parsed = parseSubscriptionRow(
    row({ current_period_ends_at: "pas-une-date", scheduled_change_effective_at: 42, canceled_at: null }),
    USER_ID,
  );
  assert.ok(parsed);
  assert.equal(parsed.currentPeriodEnd, null, "une date invalide devient null, jamais une valeur inventée");
  assert.equal(parsed.scheduledChangeAt, null);
  pass("dates malformées : neutralisées, la ligne reste exploitable");
}

// ---------------------------------------------------------------------------
// 2. Selection when several rows exist
// ---------------------------------------------------------------------------
{
  const rows = [
    row({ plan: "plus", status: "canceled", source_updated_at: "2026-01-01T00:00:00Z" }),
    row({ plan: "pro", status: "active", source_updated_at: "2026-10-01T00:00:00Z" }),
  ];
  assert.equal(selectSubscription(rows, USER_ID).plan, "pro", "l'abonnement actif prime sur un ancien résilié");
  pass("plusieurs lignes : l'état actif est retenu, pas le plus ancien");
}

{
  const rows = [
    row({ plan: "plus", status: "canceled", source_updated_at: "2026-09-01T00:00:00Z" }),
    row({ plan: "pro", status: "canceled", source_updated_at: "2026-10-01T00:00:00Z" }),
  ];
  assert.equal(selectSubscription(rows, USER_ID).plan, "pro", "à statut égal, l'événement le plus récent gagne");
  pass("plusieurs lignes à statut égal : l'événement Paddle le plus récent gagne");
}

{
  assert.equal(selectSubscription([], USER_ID), null);
  assert.equal(selectSubscription([row({ user_id: OTHER_USER_ID })], USER_ID), null, "aucune fuite inter-comptes");
  pass("aucune ligne exploitable : null (jamais de formule par défaut)");
}

// ---------------------------------------------------------------------------
// 3. Reading through the client (filter + RLS)
// ---------------------------------------------------------------------------
{
  const { client, calls } = createClient({ visibleRows: [row()] });
  const result = await readEntitlement(client, USER_ID);

  assert.equal(calls.table, SUBSCRIPTION_TABLE);
  assert.equal(calls.columns, SUBSCRIPTION_COLUMNS);
  assert.deepEqual(calls.filters, [["user_id", USER_ID]], "la requête doit filtrer sur le compte connecté");
  assert.equal(result.kind, "subscription");
  assert.equal(result.subscription.plan, "plus");
  pass("lecture : table subscriptions, filtre user_id = compte connecté, une seule requête");
}

{
  // Guard against schema drift: the SELECT must name the columns that actually
  // exist in `public.subscriptions` (deviation from the first draft of 0001).
  assert.deepEqual(
    SUBSCRIPTION_COLUMNS.split(",").map((c) => c.trim()),
    [
      "user_id",
      "plan",
      "status",
      "current_period_ends_at",
      "scheduled_change_effective_at",
      "canceled_at",
      "source_updated_at",
    ],
    "les colonnes lues doivent être celles du schéma réel",
  );
  for (const absent of ["current_period_end", "scheduled_change_at", "occurred_at"]) {
    assert.ok(
      !SUBSCRIPTION_COLUMNS.split(",").map((c) => c.trim()).includes(absent),
      `la colonne inexistante ${absent} ne doit jamais être demandée`,
    );
  }
  pass("colonnes lues = schéma réel (aucune colonne inventée, aucun ancien nom)");
}

{
  // The row is stored with the real names, but the parsed object keeps the
  // stable camelCase shape the view already uses: only the SQL layer changed.
  const parsed = parseSubscriptionRow(
    row({ scheduled_change_effective_at: "2026-11-30T00:00:00Z", source_updated_at: "2026-10-05T00:00:00Z" }),
    USER_ID,
  );
  assert.equal(parsed.currentPeriodEnd, "2026-11-12T00:00:00Z");
  assert.equal(parsed.scheduledChangeAt, "2026-11-30T00:00:00Z");
  assert.equal(parsed.occurredAt, "2026-10-05T00:00:00Z");
  pass("mapping des noms réels vers la forme attendue par la vue");
}

{
  const { client } = createClient({ visibleRows: [] });
  const result = await readEntitlement(client, USER_ID);
  assert.deepEqual(result, { kind: "none" });
  pass("aucun abonnement : état « none » explicite");
}

{
  // RLS misconfiguration: the database returns another account's row.
  const { client } = createClient({ visibleRows: [row({ user_id: OTHER_USER_ID })] });
  const result = await readEntitlement(client, USER_ID);
  assert.deepEqual(result, { kind: "none" }, "une ligne étrangère ne doit jamais être affichée");
  pass("RLS contournée : la ligne d'un autre compte est ignorée côté client");
}

{
  const { client } = createClient({ error: { message: "relation does not exist" } });
  const result = await readEntitlement(client, USER_ID);
  assert.equal(result.kind, "error");
  assert.match(result.message, /momentanément illisible/);
  pass("table absente ou refus RLS : erreur affichée, aucune formule inventée");
}

{
  const { client } = createClient({ throws: true });
  const result = await readEntitlement(client, USER_ID);
  assert.equal(result.kind, "error");
  pass("réseau en échec : erreur, pas de plantage");
}

{
  const { client, calls } = createClient({ visibleRows: [row()] });
  const result = await readEntitlement(client, "   ");
  assert.deepEqual(result, { kind: "none" });
  assert.equal(calls.table, null, "aucune requête sans identifiant de compte");
  pass("identifiant vide : aucune requête lancée");
}

// ---------------------------------------------------------------------------
// 4. Presentation of each state
// ---------------------------------------------------------------------------
{
  const active = summarizeSubscription(parseSubscriptionRow(row(), USER_ID));
  assert.equal(active.plan, "VEYVRO Plus");
  assert.equal(active.statusLabel, "Active");
  assert.equal(active.tone, "ok");
  assert.match(active.detail, /12 novembre 2026/);

  const pastDue = summarizeSubscription(parseSubscriptionRow(row({ status: "past_due" }), USER_ID));
  assert.equal(pastDue.statusLabel, "Paiement en retard");
  assert.equal(pastDue.tone, "warning");
  assert.match(pastDue.detail, /portail Paddle/);

  const canceled = summarizeSubscription(
    parseSubscriptionRow(row({ status: "canceled", scheduled_change_effective_at: "2026-11-30T00:00:00Z" }), USER_ID),
  );
  assert.equal(canceled.statusLabel, "Résilié");
  assert.equal(canceled.tone, "inactive");
  assert.match(canceled.detail, /30 novembre 2026/);

  const paused = summarizeSubscription(parseSubscriptionRow(row({ status: "paused" }), USER_ID));
  assert.equal(paused.statusLabel, "En pause");
  assert.equal(paused.tone, "inactive");

  const trialing = summarizeSubscription(parseSubscriptionRow(row({ status: "trialing" }), USER_ID));
  assert.equal(trialing.statusLabel, "Période d'essai");
  assert.equal(trialing.tone, "ok");

  pass("états : active / past_due / canceled / paused / trialing chacun avec son libellé et sa tonalité");
}

{
  assert.equal(planLabel("plus"), "VEYVRO Plus");
  assert.equal(planLabel("pro"), "VEYVRO Pro");
  assert.equal(formatDate("pas-une-date"), null);
  assert.equal(formatDate(null), null);
  assert.equal(formatDate("2026-01-05T00:00:00Z"), "5 janvier 2026");
  pass("libellés et dates : déterministes, entrées invalides neutralisées");
}

// ---------------------------------------------------------------------------
// 5. No trust in browser-provided plan information
// ---------------------------------------------------------------------------
{
  // The module exposes no setter and reads no storage: a plan can only come from
  // a row the database returned for this account.
  const moduleKeys = Object.keys(
    await import("../src/lib/entitlement.ts"),
  ).sort();
  const forbidden = moduleKeys.filter((key) => /localStorage|setPlan|overridePlan/i.test(key));
  assert.deepEqual(forbidden, [], "aucun utilitaire de plan fourni par le client");

  const manipulated = parseSubscriptionRow(
    { ...row(), plan: "pro", user_id: OTHER_USER_ID, isAdmin: true, role: "owner" },
    USER_ID,
  );
  assert.equal(manipulated, null, "des champs supplémentaires ne changent pas le propriétaire");
  pass("aucun plan fourni par le navigateur : seuls les champs en base comptent");
}

console.log(`\n${checks} vérifications de la formule en compte passées.`);
