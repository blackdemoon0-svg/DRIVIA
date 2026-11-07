/**
 * Static cross-check between the migration and the code.
 *
 * The first version of this integration assumed a schema that did not exist in
 * `veyvro-preview` (wrong column names, wrong primary key). The unit tests still
 * passed, because both sides were wrong in the same way. This file closes that
 * gap: it compares the SQL with the TypeScript *without* a database, so a
 * rename on one side fails the suite immediately.
 *
 * Since P9/S5 the file also cross-checks the two quota migrations (0003, 0004)
 * against the code that calls them, and the two directions of the billing
 * contract: what the Paddle webhook writes must be what the access layer reads.
 *
 * Division of labour, so nothing is claimed twice:
 *   • `ai-usage-schema.test.mjs` and `migration-0004.test.mjs` verify the SQL
 *     *by itself* — 41 and 16 static checks about guards, ACLs, transactions;
 *   • this file verifies that the SQL and the TypeScript **agree**: names,
 *     parameters, returned columns, refused vocabulary, privileges vs the key
 *     actually used, statuses the code knows vs statuses the table accepts.
 * A rename on either side fails here even when both suites above stay green.
 *
 * No network, no Supabase client, no environment variable: pure parsing.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { SUBSCRIPTION_COLUMNS } from "../src/lib/entitlement.ts";
import {
  ACCESS_COLUMNS,
  ENTITLED_STATUSES,
  resolveAccessPlan,
} from "../server/access.ts";
import { BLOCKING_STATUSES } from "../src/lib/subscriptionAccess.ts";
import { PLAN_LIMITS } from "../src/lib/planLimits.ts";
import { USAGE_ENV_KEYS, USAGE_RPC } from "../server/usageStore.ts";

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


// ===========================================================================
// 7. Migrations 0003 / 0004 ↔ server/usageStore.ts
// ===========================================================================
const usageSql = readFileSync("supabase/migrations/0003_ai_usage_quotas.sql", "utf8");
const usageFix = readFileSync("supabase/migrations/0004_ai_usage_consume_conflict_target.sql", "utf8");
const usageStoreSource = readFileSync("server/usageStore.ts", "utf8");

/** Statements only: a comment explaining a rule is never the rule. */
const stripComments = (source) =>
  source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const usageStatements = stripComments(usageSql);
const usageFixStatements = stripComments(usageFix);

{
  // 7a. Tables and primary keys — the two objects every RPC writes.
  for (const table of ["ai_usage_daily", "ai_usage_events"]) {
    assert.match(
      usageStatements,
      new RegExp(`create table if not exists public\\.${table} \\(`),
      `0003 doit créer public.${table}`,
    );
    assert.match(
      usageStatements,
      new RegExp(`alter table public\\.${table}\\s+enable row level security`),
      `RLS doit être active sur ${table}`,
    );
  }
  assert.match(usageStatements, /primary key \(user_id, usage_day\)/, "le compteur est clé par (compte, journée)");
  assert.match(usageStatements, /primary key \(consumption_id\)/, "le registre est clé par consommation");
  pass("0003 ↔ code : les deux tables existent, avec les clés primaires que les RPC utilisent");
}

{
  // 7b. The RPC names the client calls are exactly the functions the SQL creates:
  // a name that drifts on one side would be a 404 at runtime, on the one path
  // that decides whether a message is paid for.
  // A trigger function is not a route: it is invoked by the trigger, never over
  // HTTP, and must not be granted to the API. Both facts are checked here so
  // the distinction cannot quietly disappear.
  const declared = [...usageStatements.matchAll(/create or replace function public\.([a-z_]+)\(([\s\S]*?)language/g)]
    .map((match) => ({ name: match[1], isTrigger: /returns trigger/i.test(match[2]) }));

  const rpcFunctions = declared.filter((entry) => !entry.isTrigger).map((entry) => entry.name).sort();
  const triggerFunctions = declared.filter((entry) => entry.isTrigger).map((entry) => entry.name).sort();
  const called = Object.values(USAGE_RPC).sort();

  assert.deepEqual(rpcFunctions, called, `fonctions appelables (${rpcFunctions.join(", ")}) ≠ RPC appelées (${called.join(", ")})`);
  assert.deepEqual(triggerFunctions, ["ai_usage_events_guard_fn"], "une seule fonction de trigger, interne");
  assert.ok(
    !usageStatements.includes("grant execute on function public.ai_usage_events_guard_fn"),
    "la fonction de trigger ne doit jamais être exécutable par l'API",
  );
  pass(`0003 ↔ usageStore : les ${called.length} RPC appelées (${called.join(", ")}) sont exactement les fonctions exposées`);
}

{
  // 7c. Signatures. PostgREST matches named arguments, so what matters is the
  // *set of names*: a name the client sends but the SQL does not declare is a
  // 404 with no obvious cause, and a declared parameter nobody sends takes its
  // default — silently charging the wrong day.
  const signature = (functionName) => {
    const start = usageStatements.indexOf(`create or replace function public.${functionName}(`);
    assert.ok(start !== -1, `signature introuvable pour ${functionName}`);
    return usageStatements.slice(start, usageStatements.indexOf("\nreturns table", start));
  };
  const parametersOf = (functionName) =>
    [...signature(functionName).matchAll(/\b(p_[a-z_]+)\s+[a-z]/g)].map((match) => match[1]).sort();

  const consumedKeys = [...new Set([...usageStoreSource.matchAll(/\bp_(?:user_id|consumption_id|limit_messages|limit_quotes|is_quote|now)\b/g)]
    .map((match) => match[0]))].sort();

  const consumeParams = parametersOf("ai_usage_consume");
  assert.deepEqual(consumeParams, ["p_consumption_id", "p_is_quote", "p_limit_messages", "p_limit_quotes", "p_now", "p_user_id"]);
  const unknownConsume = consumedKeys.filter((key) => !consumeParams.includes(key));
  assert.deepEqual(unknownConsume, [], `usageStore envoie des paramètres absents de la signature : ${unknownConsume.join(", ")}`);

  const refundParams = parametersOf("ai_usage_refund");
  assert.deepEqual(refundParams, ["p_consumption_id", "p_now", "p_user_id"]);
  const readParams = parametersOf("ai_usage_read");
  assert.deepEqual(readParams, ["p_now", "p_user_id"]);

  // `p_now` must stay optional everywhere: production never sends it, so the
  // day is always derived by PostgreSQL from `now()`.
  for (const name of Object.values(USAGE_RPC)) {
    assert.match(signature(name), /p_now\s+timestamptz default null/, `${name} : p_now doit rester optionnel`);
  }
  pass("signatures : paramètres nommés conformes, p_now optionnel partout (jamais fourni en production)");
}

{
  // 7d. Returned columns ↔ the fields the client parses. Reading a column that
  // does not exist yields `undefined`, which the client reports as an unusable
  // answer — but only after a real request. Caught here instead.
  const returnedColumns = (functionName) => {
    const start = usageSql.indexOf(`create or replace function public.${functionName}(`);
    const block = usageSql.slice(start, usageSql.indexOf("language plpgsql", start));
    const table = block.slice(block.indexOf("returns table ("));
    return [...table.matchAll(/^\s{2}([a-z_]+)\s+[a-z]/gm)].map((match) => match[1]).sort();
  };

  assert.deepEqual(returnedColumns("ai_usage_consume"), [
    "allowed",
    "reason",
    "replayed",
    "usage_day",
    "used_messages",
    "used_quotes",
  ]);
  assert.deepEqual(returnedColumns("ai_usage_refund"), ["reason", "refunded", "usage_day"]);
  assert.deepEqual(returnedColumns("ai_usage_read"), ["usage_day", "used_messages", "used_quotes"]);

  for (const field of ["allowed", "reason", "used_messages", "used_quotes", "usage_day", "replayed"]) {
    assert.ok(usageStoreSource.includes(`${field}?:`), `usageStore doit lire ${field}`);
  }
  assert.ok(usageStoreSource.includes("refunded?:"), "usageStore doit lire refunded");
  pass("colonnes retournées : les 6 du consume, les 3 du refund et les 3 de la lecture sont toutes lues par le client");
}

{
  // 7e. ACL ↔ the key actually used. Only service_role may execute the RPC;
  // a client that authenticated with the anonymous key would be refused at
  // runtime, on every message, with a 404 that looks like a missing function.
  for (const name of Object.values(USAGE_RPC)) {
    const grant = new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*to service_role`, "i");
    assert.match(usageStatements, grant, `${name} : EXECUTE doit être accordé au seul service_role`);
    assert.ok(
      !new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)[^;]*\\b(anon|authenticated|public)\\b`, "i").test(
        usageStatements,
      ),
      `${name} : aucun droit ne doit être accordé à anon/authenticated/PUBLIC`,
    );
  }
  // Tables: nothing is granted to anyone, and the client never touches them.
  assert.ok(!/grant .* on (table )?public\.ai_usage_(daily|events)/i.test(usageStatements), "aucun GRANT de table");
  assert.ok(!/\/rest\/v1\/ai_usage_/i.test(usageStoreSource), "le client ne contacte jamais une table, seulement les RPC");
  assert.equal(USAGE_ENV_KEYS.serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
  assert.match(
    usageStoreSource,
    /apikey:\s*env\.serviceRoleKey/,
    "l'en-tête apikey des RPC doit porter la clé de service (la seule autorisée par l'ACL)",
  );
  assert.ok(!/anonKey/.test(usageStoreSource), "la clé anonyme n'a aucun rôle dans le magasin d'usage");
  pass("ACL : EXECUTE réservé au service_role, aucun privilège de table, et le client emploie bien cette clé");
}

{
  // 7f. Vocabulary. Every `reason` the SQL can return must be understood by the
  // client; a new reason added to the SQL and forgotten here would be treated as
  // an outage — safe, but wrong, and invisible.
  const emitSql = usageStatements.slice(
    usageStatements.indexOf("create or replace function public.ai_usage_consume"),
    usageStatements.indexOf("create or replace function public.ai_usage_refund"),
  );
  // Two ways the SQL writes a reason: cast in the returned row, or assigned to
  // `v_refuse` and returned later. Both must be seen, otherwise the check would
  // pass while the most common refusal (a quota reached) went unnoticed.
  const emitted = new Set([...emitSql.matchAll(/'(daily_messages|daily_quotes|consumption_conflict|consumption_refunded)'/g)].map((match) => match[1]));
  for (const reason of ["daily_messages", "daily_quotes", "consumption_conflict"]) {
    assert.ok(emitted.has(reason), `0003 doit pouvoir émettre ${reason}`);
    assert.ok(usageStoreSource.includes(`"${reason}"`), `usageStore doit mapper ${reason}`);
  }
  // The reverse direction is a superset on purpose: `consumption_refunded` is a
  // legacy value kept mapped for an older deployment, which the corrected SQL
  // no longer emits. It must stay documented as such rather than silently used.
  assert.ok(usageStoreSource.includes("consumption_refunded"), "la valeur héritée reste mappée");
  assert.ok(
    !emitted.has("consumption_refunded"),
    "la valeur héritée ne doit pas être émise par le SQL corrigé",
  );
  pass("vocabulaire : chaque motif que le SQL peut renvoyer est mappé (et l'hérité reste reconnu, jamais émis)");
}

{
  // 7g. Constraints the client relies on: the state machine of the ledger, and
  // the non-negative counters. Both are read as facts by the code (a refund is
  // only recorded once; counters never go below zero).
  assert.match(usageStatements, /check \(state in \('consumed', 'refunded'\)\)/, "états du registre bornés");
  assert.match(usageStatements, /check \(messages >= 0\)/, "compteur de messages non négatif");
  assert.match(usageStatements, /check \(quotes >= 0\)/, "compteur d'analyses non négatif");
  assert.match(usageStatements, /check \(attempts between 1 and 3\)/, "plafond de trois tentatives inscrit dans le schéma");
  pass("contraintes : machine à états du registre et compteurs non négatifs présents dans 0003");
}

{
  // 7h. 0004 replaces exactly one function, by name, and its named conflict
  // target is the primary key 0003 declares. The client maps the same answers
  // before and after: nothing it reads is allowed to change.
  const replaced = [...usageFixStatements.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(replaced, ["ai_usage_consume"], "0004 ne remplace qu'ai_usage_consume");
  assert.match(usageFixStatements, /on conflict on constraint ai_usage_daily_pkey do update/, "cible de conflit nommée");
  assert.match(usageStatements, /constraint ai_usage_daily_pkey primary key \(user_id, usage_day\)/, "la contrainte nommée est bien la PK de 0003");

  const fixParameters = [...usageFix.matchAll(/\b(p_[a-z_]+)\s+[a-z]/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(fixParameters)].sort(),
    ["p_consumption_id", "p_is_quote", "p_limit_messages", "p_limit_quotes", "p_now", "p_user_id"],
    "0004 conserve exactement la signature de 0003",
  );
  assert.match(usageFix, /returns table \(\s*\n?\s*allowed/, "0004 conserve les colonnes retournées");
  pass("0004 ↔ 0003 : une seule fonction remplacée, même signature, cible de conflit = la PK déclarée");
}

// ===========================================================================
// 8. Statuts : ce que Paddle écrit doit être représentable, lisible, et borné
// ===========================================================================
{
  // 0001 declares the CHECK; 0002 re-declares it for the existing table. Every
  // status the code knows must be accepted by one of them, otherwise a real
  // Paddle event would be rejected on write and the customer would keep nothing.
  const one = stripComments(readFileSync("supabase/migrations/0001_subscriptions.sql", "utf8"));
  const two = stripComments(sql);
  const accepted = new Set();
  for (const statement of `${one}\n${two}`.matchAll(/status in \(([^)]*)\)/g)) {
    for (const literal of statement[1].matchAll(/'([a-z_]+)'/g)) accepted.add(literal[1]);
  }
  for (const status of ["trialing", "active", "past_due", "paused", "canceled"]) {
    assert.ok(accepted.has(status), `le statut ${status} doit être accepté par le CHECK de la table`);
  }
  for (const status of [...ENTITLED_STATUSES, ...BLOCKING_STATUSES]) {
    assert.ok(accepted.has(status), `${status} est connu du code mais refusé par la table`);
  }
  // What the webhook may write must be representable too: a status it accepts
  // but the table refuses would make the upsert fail, and the event would be
  // retried forever against a constraint it can never satisfy.
  const webhookStatuses = [
    ...webhookSource
      .slice(webhookSource.indexOf("const SUBSCRIPTION_STATUSES"))
      .match(/^\s{2}"([a-z_]+)",/gm)
      .map((line) => line.replace(/[\s",]/g, "")),
  ];
  assert.deepEqual(
    webhookStatuses.sort(),
    ["active", "canceled", "past_due", "paused", "trialing"],
    "le webhook doit accepter exactement les cinq statuts du schéma",
  );
  for (const status of webhookStatuses) {
    assert.ok(accepted.has(status), `le webhook accepte ${status}, que la table doit accepter aussi`);
  }

  // The two lists must stay distinct: an entitled status that blocks would
  // forbid the renewal of a customer we still serve.
  assert.notDeepEqual([...BLOCKING_STATUSES].sort(), [...ENTITLED_STATUSES].sort());

  // And the index predicate that really refuses a second subscription must
  // name exactly the blocking statuses.
  const indexBlock = one.slice(one.indexOf("subscriptions_paddle_customer_id_idx"));
  const predicate = indexBlock.slice(0, indexBlock.indexOf(";"));
  const indexStatuses = [...predicate.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(indexStatuses, [...BLOCKING_STATUSES].sort(), "BLOCKING_STATUSES doit égaler le prédicat de l'index unique");
  pass("statuts : les cinq statuts acceptés par la table couvrent les listes du code, index partiel aligné");
}

// ===========================================================================
// 9. Paiement : ce que le webhook écrit est ce que le contrôle d'accès lit
// ===========================================================================
{
  const readColumns = ACCESS_COLUMNS.split(",").map((column) => column.trim());
  const readByClient = SUBSCRIPTION_COLUMNS.split(",").map((column) => column.trim());
  const written = readWebhookRowColumns();

  // Server side: every column read to decide a plan is written by the webhook.
  const notWritten = readColumns.filter((column) => !written.includes(column) && column !== "id");
  assert.deepEqual(notWritten, [], `le contrôle d'accès lit des colonnes que le webhook n'écrit jamais : ${notWritten.join(", ")}`);

  // Browser side: the same, plus the columns the UI shows. `id`, `created_at`
  // and `updated_at` are database defaults, never written by the handler.
  const databaseOwned = ["id", "created_at", "updated_at"];
  const notWrittenForClient = readByClient.filter(
    (column) => !written.includes(column) && !databaseOwned.includes(column),
  );
  assert.deepEqual(
    notWrittenForClient,
    [],
    `la vue lit des colonnes que le webhook n'écrit jamais : ${notWrittenForClient.join(", ")}`,
  );

  // Runtime agreement on values: a row shaped like the webhook's payload, with
  // the values the webhook writes, must produce the plan the customer bought.
  const paidRow = {
    user_id: "11111111-2222-4333-8444-555555555555",
    plan: "plus",
    status: "active",
    current_period_ends_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
  };
  assert.equal(resolveAccessPlan([paidRow], paidRow.user_id), "plus", "une ligne payée donne la formule payée");
  assert.equal(
    resolveAccessPlan([{ ...paidRow, current_period_ends_at: new Date(Date.now() - 1_000).toISOString() }], paidRow.user_id),
    "decouverte",
    "la période échue retire le droit payant",
  );
  assert.equal(resolveAccessPlan([paidRow], "99999999-8888-4777-8666-555555555555"), "decouverte", "la ligne d'autrui ne donne rien");
  assert.ok(PLAN_LIMITS.plus.messagesPerDay > PLAN_LIMITS.decouverte.messagesPerDay);
  pass("chaîne payante : les colonnes écrites par le webhook suffisent au contrôle d'accès, valeurs comprises");
}

console.log(`\n${checks} vérifications d'alignement schéma ↔ code passées.`);
