/**
 * Static cross-check between the migration and the code.
 *
 * The first version of this integration assumed a schema that did not exist in
 * `veyvro-preview` (wrong column names, wrong primary key). The unit tests still
 * passed, because both sides were wrong in the same way. This file closes that
 * gap: it compares the SQL with the TypeScript *without* a database, so a
 * rename on one side fails the suite immediately.
 *
 * No network, no Supabase client, no environment variable: pure parsing.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { SUBSCRIPTION_COLUMNS } from "../src/lib/entitlement.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const sql = readFileSync("supabase/migrations/0002_align_subscriptions.sql", "utf8");
const webhookSource = readFileSync("api/paddle-webhook.ts", "utf8");

/** Columns declared in the migration's verification block. */
function readSqlColumns() {
  const block = sql.match(/expected constant text\[\]\[\] := array\[([\s\S]*?)\n  \];/);
  assert.ok(block, "le bloc de vérification des colonnes doit exister dans 0002");
  const columns = new Map();
  for (const m of block[1].matchAll(/\['([a-z_]+)',\s*'([^']+)'\]/g)) {
    columns.set(m[1], m[2]);
  }
  return columns;
}

/** Keys of the `SubscriptionRow` payload written by the webhook. */
function readWebhookRowColumns() {
  const block = webhookSource.match(/export type SubscriptionRow = \{([\s\S]*?)\n\};/);
  assert.ok(block, "SubscriptionRow doit être déclaré dans api/paddle-webhook.ts");
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(":")[0].trim());
}

// Same SQL with the comment lines removed: assertions must look at statements,
// never at a comment that explains why something is forbidden.
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const sqlColumns = readSqlColumns();
const webhookColumns = readWebhookRowColumns();
const entitlementColumns = SUBSCRIPTION_COLUMNS.split(",").map((c) => c.trim());
const realColumns = [...sqlColumns.keys()];

// ---------------------------------------------------------------------------
// 1. The migration describes the 19 real columns
// ---------------------------------------------------------------------------
{
  assert.equal(realColumns.length, 19, "la table réelle compte 19 colonnes");
  assert.deepEqual(
    realColumns,
    [
      "id",
      "user_id",
      "paddle_subscription_id",
      "paddle_customer_id",
      "paddle_product_id",
      "paddle_price_id",
      "plan",
      "status",
      "billing_interval",
      "currency_code",
      "current_period_started_at",
      "current_period_ends_at",
      "scheduled_change_action",
      "scheduled_change_effective_at",
      "paused_at",
      "canceled_at",
      "source_updated_at",
      "created_at",
      "updated_at",
    ],
  );
  pass("0002 vérifie bien les 19 colonnes du schéma réel, dans l'ordre");
}

// ---------------------------------------------------------------------------
// 2. Everything the code reads or writes exists in the SQL
// ---------------------------------------------------------------------------
{
  const missing = entitlementColumns.filter((c) => !sqlColumns.has(c));
  assert.deepEqual(missing, [], `entitlement.ts lit des colonnes absentes de la table : ${missing.join(", ")}`);
  assert.ok(entitlementColumns.length >= 7);
  pass(`entitlement.ts : ${entitlementColumns.length}/${entitlementColumns.length} colonnes lues existent réellement`);
}

{
  const missing = webhookColumns.filter((c) => !sqlColumns.has(c));
  assert.deepEqual(missing, [], `le webhook écrit des colonnes absentes de la table : ${missing.join(", ")}`);
  pass(`paddle-webhook.ts : ${webhookColumns.length}/${webhookColumns.length} colonnes écrites existent réellement`);
}

{
  // The webhook must never impose `id`: it is the database's primary key.
  assert.ok(!webhookColumns.includes("id"), "`id` ne doit pas être envoyé par le webhook");
  assert.ok(webhookColumns.includes("source_updated_at"), "l'horodatage Paddle va dans source_updated_at");
  pass("`id` reste à la charge de la base, `source_updated_at` porte l'horodatage Paddle");
}

// ---------------------------------------------------------------------------
// 3. Conflict target: on_conflict names a column that has a UNIQUE index
// ---------------------------------------------------------------------------
{
  const onConflict = webhookSource.match(/\?on_conflict=([a-z_]+)/)?.[1];
  assert.equal(onConflict, "paddle_subscription_id", "l'upsert doit nommer sa cible de conflit");
  assert.ok(sqlColumns.has(onConflict), "la cible de conflit doit exister dans la table");

  const indexName = `subscriptions_${onConflict}_key`;

  // `create index if not exists` only compares NAMES: an index with the right
  // name and the wrong definition would be skipped silently. The migration must
  // therefore read the real definition before trusting it.
  assert.match(sql, /select indexdef into def[\s\S]{0,200}pg_indexes/, "la définition réelle de l'index doit être lue");
  assert.ok(sql.includes(indexName), "l'index de conflit doit être nommé explicitement");
  assert.match(
    sql,
    /def ilike '%CREATE UNIQUE INDEX%' and def not ilike '%WHERE%'/,
    "l'index de conflit doit être vérifié UNIQUE et non partiel",
  );
  pass(`upsert : on_conflict=${onConflict} adossé à un index UNIQUE, défini non partiel et VÉRIFIÉ`);
}

{
  // Rebuilding is allowed, but only on an INDEX, and only conditionally.
  // Assertions run on `statements` (comments stripped): a comment explaining
  // the rule must not be mistaken for the rule being executed.
  // Only an EXECUTED drop counts ("execute 'drop index ...'"), not a mention of
  // the words inside an error message.
  const drops = statements.match(/execute 'drop index [^']*'/gi) ?? [];
  assert.equal(drops.length, 2, "exactement deux reconstructions prévues (index de conflit, index client)");
  for (const d of drops) {
    assert.match(d, /paddle_(customer|subscription)_id/, `seuls les index d'intégration peuvent être reconstruits : ${d}`);
  }
  // Rebuild must be guarded by the definition comparison, never unconditional.
  const beforeFirstDrop = statements.slice(0, statements.search(/execute 'drop index/i));
  assert.match(beforeFirstDrop, /pg_indexes/, "aucun `drop index` ne doit précéder une lecture de pg_indexes");
  assert.match(statements, /conindid/, "un index adossé à une contrainte doit être détecté avant tout drop");
  pass("index : reconstruction conditionnelle uniquement, jamais une table ni une colonne");
}

{
  // The primary key is `id`, so the default is what makes an insert possible
  // without the webhook sending it.
  assert.match(
    sql,
    /alter column id set default gen_random_uuid\(\)/,
    "`id` doit avoir un défaut, sinon chaque insertion échoue",
  );
  pass("`id` uuid : valeur par défaut garantie par la migration");
}

// ---------------------------------------------------------------------------
// 3b. RLS: the existing policy is matched by semantics, not by name
// ---------------------------------------------------------------------------
{
  // The project already has `subscriptions_select_own`. A guard that looks up
  // "read own subscription" would not find it and would create a second
  // permissive SELECT policy.
  assert.ok(
    !/policyname\s*=\s*'read own subscription'/.test(sql),
    "le garde ne doit pas chercher uniquement le nom de la politique à créer",
  );
  assert.match(sql, /select policyname into canonical[\s\S]{0,400}from pg_policies/, "la politique existante doit être lue");
  assert.match(sql, /cmd\s*=\s*'SELECT'/);
  assert.match(sql, /roles::text like '%authenticated%'/);
  assert.match(sql, /qual, ''\) ilike '%auth\.uid\(\)%'/);
  assert.match(sql, /qual, ''\) ilike '%user_id%'/);
  pass("RLS : politique existante détectée par sémantique (cmd + rôle + expression) → aucun doublon");
}

// ---------------------------------------------------------------------------
// 3c. The index guard's DECISION, replayed on the three real definitions
// ---------------------------------------------------------------------------
// `indexdef` is plain text in PostgreSQL, so the SQL compares it with `ilike`.
// The predicates are extracted from the file itself (not retyped) and applied
// to realistic `pg_indexes.indexdef` values: an absent index, the conforming
// partial index, and the unconditional unique index that broke resubscription.
{
  // Two guards read `indexdef`; the one we want is the customer index — the
  // only one that also checks the four in-force statuses.
  const guards = [...sql.matchAll(/elsif([\s\S]*?)then/g)].map((m) => m[1]);
  const guard = guards.find((g) => g.includes("past_due") && g.includes("CREATE UNIQUE INDEX"));
  assert.ok(guard, "le garde de l'index client doit comparer la définition réelle");
  const required = [...guard.matchAll(/ilike '%([^']+)%'/g)].map((m) => m[1].toLowerCase());
  assert.ok(required.length >= 6, "le garde doit vérifier l'unicité, le prédicat partiel et les 4 statuts");

  const conforms = (indexdef) => required.every((needle) => indexdef.toLowerCase().includes(needle));

  const optionB =
    "CREATE UNIQUE INDEX subscriptions_paddle_customer_id_idx ON public.subscriptions USING btree " +
    "(paddle_customer_id) WHERE ((paddle_customer_id IS NOT NULL) AND ((status)::text = ANY " +
    "((ARRAY['trialing'::character varying, 'active'::character varying, " +
    "'past_due'::character varying, 'paused'::character varying])::text[])))";

  const optionA =
    "CREATE UNIQUE INDEX subscriptions_paddle_customer_id_idx ON public.subscriptions USING btree " +
    "(paddle_customer_id) WHERE (paddle_customer_id IS NOT NULL)";

  const notUnique =
    "CREATE INDEX subscriptions_paddle_customer_id_idx ON public.subscriptions USING btree " +
    "(paddle_customer_id) WHERE (paddle_customer_id IS NOT NULL)";

  assert.equal(conforms(optionB), true, "l'index option B doit être reconnu conforme → inchangé");
  assert.equal(conforms(optionA), false, "l'index option A doit être reconnu NON conforme → reconstruit");
  assert.equal(conforms(notUnique), false, "un index non unique doit être reconstruit");

  pass("garde d'index : option B conservée, option A reconstruite, index non unique reconstruit");
}

{
  // Permissions must stay: anonymous has no access at all, authenticated reads.
  assert.match(sql, /alter table public\.subscriptions enable row level security/);
  assert.match(sql, /revoke all on public\.subscriptions from anon;/);
  assert.match(sql, /revoke insert, update, delete on public\.subscriptions from anon, authenticated;/);
  assert.match(sql, /grant select on public\.subscriptions to authenticated;/);
  pass("permissions : anon totalement exclu, authenticated en lecture seule");
}

{
  // No duplicate index on user_id: the (user_id, status) index already covers it.
  assert.match(sql, /subscriptions_user_status_idx/, "l'index couvrant existant doit être pris en compte");
  assert.ok(
    !/create index if not exists subscriptions_user_id_idx/.test(sql),
    "l'index user_id ne doit pas être recréé aveuglément",
  );
  pass("index user_id : couverture (user_id, status) détectée, aucun index redondant créé");
}

// ---------------------------------------------------------------------------
// 4. webhook_events: the columns the handler relies on
// ---------------------------------------------------------------------------
{
  const ddl = sql.match(/create table if not exists public\.webhook_events \(([\s\S]*?)\n\);/);
  assert.ok(ddl, "webhook_events doit être créée par 0002");
  const body = ddl[1];

  for (const column of ["event_id", "event_type", "occurred_at", "received_at", "status", "reason"]) {
    assert.match(body, new RegExp(`\\b${column}\\b`), `colonne manquante dans webhook_events : ${column}`);
  }
  // Idempotency depends on this primary key: a duplicate insert must return 409.
  assert.match(body, /event_id\s+text primary key/, "event_id doit être la clé primaire (déduplication)");
  assert.match(sql, /revoke all on public\.webhook_events from anon, authenticated/);
  assert.match(sql, /alter table public\.webhook_events enable row level security/);
  assert.ok(!/create policy[\s\S]{0,80}webhook_events/.test(sql), "aucune politique ne doit ouvrir webhook_events");
  pass("webhook_events : clé primaire event_id, RLS activée, aucun accès navigateur");
}

// ---------------------------------------------------------------------------
// 5. Nothing destructive, everything idempotent
// ---------------------------------------------------------------------------
{
  for (const forbidden of ["drop table", "drop column", "delete from", "truncate", "rename to", "rename column"]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`, "i").test(statements),
      `instruction destructive interdite : ${forbidden}`,
    );
  }
  assert.equal((statements.match(/\bbegin;/g) ?? []).length, 1, "une seule transaction");
  assert.equal((statements.match(/\bcommit;/g) ?? []).length, 1, "une seule validation");

  // Every created object must tolerate a re-run.
  const creates = statements.match(/^create (table|index|unique index|trigger)/gm) ?? [];
  const guarded = statements.match(/^create (table|index|unique index) if not exists/gm) ?? [];
  assert.equal(guarded.length, creates.length - 1, "seul le trigger échappe à `if not exists` (précédé d'un drop)");
  assert.match(statements, /drop trigger if exists subscriptions_touch_updated_at/);
  pass("aucune instruction destructive, une seule transaction, rejouable");
}

// ---------------------------------------------------------------------------
// 6. Constraints never reject existing rows
// ---------------------------------------------------------------------------
{
  const added = (statements.match(/add constraint/g) ?? []).length;
  const notValid = (statements.match(/not valid;/g) ?? []).length;
  const checks = (statements.match(/check \(/g) ?? []).length;

  assert.ok(added >= 5, `5 contraintes attendues sur la table existante, ${added} trouvées`);
  assert.equal(
    notValid,
    added,
    "chaque contrainte ajoutée à la table existante doit être NOT VALID",
  );
  assert.ok(checks >= 5, "les 4 CHECK + celui de webhook_events");
  assert.ok(
    !statements.includes("validate constraint"),
    "aucune validation ne doit être forcée : les lignes existantes ne sont jamais rejetées",
  );
  pass(`contraintes : ${added} ajoutées, toutes NOT VALID (aucune ligne existante rejetée)`);
}

console.log(`\n${checks} vérifications d'alignement schéma ↔ code passées.`);
