/**
 * Migration 0003 — static audit of the durable quota SQL.
 *
 * These tests read the SQL file as TEXT. They execute nothing: no database, no
 * network, no psql. What they can prove is what matters before running it:
 *
 *   * the SHAPE the server depends on (parameter names, returned columns) has
 *     not drifted from `server/usageStore.ts`;
 *   * the security posture (SECURITY DEFINER, search_path, revokes, no table
 *     privilege for service_role, RLS without policy) is what the design says;
 *   * the atomicity and idempotence properties are expressed the way they must
 *     be — claim by primary key, counting by a single conditional upsert, a
 *     refusal that leaves no row, a refund bound to the event's day, a
 *     re-consumption bounded to 3 attempts;
 *   * nothing destructive is done to an existing object.
 *
 * What they CANNOT prove, and what P3/P4 must establish by running it:
 *   * that PostgreSQL accepts the syntax, that the transient claim+delete is
 *     invisible to other sessions, that two parallel callers cannot both take
 *     the last unit, that a refund at 00:00:05 corrects the previous day.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const SQL_PATH = new URL("../supabase/migrations/0003_ai_usage_quotas.sql", import.meta.url);
const STORE_PATH = new URL("../server/usageStore.ts", import.meta.url);

const raw = readFileSync(SQL_PATH, "utf8");
const store = readFileSync(STORE_PATH, "utf8");

/** The file without its `--` comments: assertions target statements, not prose. */
const sql = raw
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");
/** Same text with runs of whitespace collapsed, for tolerant matching. */
const flat = sql.replace(/\s+/g, " ").trim();

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

/**
 * Extract one `create or replace function` block.
 * Returns its parameter list, its RETURNS clause, its options (SECURITY
 * DEFINER, SET search_path…) and its body.
 */
function fn(name) {
  const pattern = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(([\\s\\S]*?)\\)\\s*returns\\s+([\\s\\S]*?)\\s+language\\s+plpgsql([\\s\\S]*?)\\bas\\s+\\$\\$([\\s\\S]*?)\\$\\$\\s*;`,
    "i",
  );
  const found = sql.match(pattern);
  assert.ok(found, `fonction public.${name} introuvable dans 0003`);
  return { params: found[1], returns: found[2], options: found[3], body: found[4] };
}

/** Named parameters, in declaration order: ["p_user_id uuid", …]. */
function paramList(paramsText) {
  return paramsText
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * The `do $$ … $$;` block containing `anchor`, as text.
 * Guards are asserted block by block: a pattern that merely appears somewhere
 * else in the file proves nothing about the guard being tested.
 */
function doBlock(anchor) {
  const blocks = [...sql.matchAll(/do \$\$([\s\S]*?)\n\$\$;/g)].map((match) => match[1]);
  const found = blocks.filter((body) => body.includes(anchor));
  assert.equal(found.length, 1, `blocs do contenant « ${anchor} » : ${found.length} trouvé(s), 1 attendu`);
  return found[0];
}

/** Column names of a `returns table ( … )` clause, in order. */
function returnColumns(returnsText) {
  const inner = returnsText.match(/table\s*\(([\s\S]*)\)/i);
  assert.ok(inner, "la fonction doit renvoyer une table");
  return inner[1]
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim().split(" ")[0])
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 1. Packaging: one transaction, nothing destructive
// ---------------------------------------------------------------------------
{
  assert.ok(raw.startsWith("--"), "le fichier doit commencer par son en-tête");
  assert.equal((sql.match(/\bbegin\s*;/gi) ?? []).length, 1, "une seule transaction");
  assert.equal((sql.match(/\bcommit\s*;/gi) ?? []).length, 1, "une seule validation");
  assert.ok((raw.match(/\$\$/g) ?? []).length % 2 === 0, "les délimiteurs $$ doivent être appariés");
  assert.match(raw, /NOT APPLIED/i, "l'en-tête doit dire que rien n'a été exécuté");
  pass("0003 : une transaction (begin/commit), délimiteurs appariés, en-tête « NOT APPLIED »");
}

{
  for (const forbidden of [
    /\bdrop\s+table\b/i,
    /\bdrop\s+column\b/i,
    /\bdrop\s+schema\b/i,
    /\btruncate\b/i,
    /\balter\s+table\s+[\w.]+\s+(drop|rename)\b/i,
    /\bdelete\s+from\s+public\.(subscriptions|webhook_events)\b/i,
    /\bupdate\s+public\.(subscriptions|webhook_events)\b/i,
  ]) {
    assert.doesNotMatch(sql, forbidden, `instruction interdite : ${forbidden}`);
  }
  const drops = [...sql.matchAll(/\bdrop\s+(\w+)(\s+if\s+exists)?\s+([\w."() ,]+)/gi)];
  assert.ok(drops.length > 0, "0003 doit pouvoir être réexécuté");
  for (const drop of drops) {
    assert.match(drop[1].toLowerCase(), /^(function|trigger)$/, `drop interdit : ${drop[0]}`);
  }
  pass("aucun DDL destructif : les seuls « drop » portent sur les fonctions et le trigger que le fichier recrée");
}

// ---------------------------------------------------------------------------
// 2. Tables: shape, keys, invariants
// ---------------------------------------------------------------------------
{
  assert.match(flat, /create table if not exists public\.ai_usage_daily \(/);
  assert.match(flat, /create table if not exists public\.ai_usage_events \(/);

  assert.match(
    flat,
    /constraint ai_usage_daily_pkey primary key \(user_id, usage_day\)/,
    "la clé (user_id, usage_day) est la cible du upsert de compteur",
  );
  assert.match(
    flat,
    /constraint ai_usage_events_pkey primary key \(consumption_id\)/,
    "la clé du registre sérialise les appels concurrents",
  );
  pass("tables : clés primaires (user_id, usage_day) et (consumption_id) présentes et nommées");
}

{
  assert.match(flat, /messages integer not null default 0 check \(messages >= 0\)/);
  assert.match(flat, /quotes integer not null default 0 check \(quotes >= 0\)/);
  assert.match(flat, /check \(state in \('consumed', 'refunded'\)\)/);
  assert.match(flat, /check \(attempts between 1 and 3\)/, "le plafond de 3 tentatives est structurel");
  pass("contraintes : compteurs non négatifs, états bornés, plafond de 3 tentatives inscrit dans le schéma");
}

{
  // Un référentiel par jour et par compte : sans cela la comptabilité n'aurait
  // aucune cohérence entre la journée facturée et la journée remboursée.
  const daily = raw.match(/create table if not exists public\.ai_usage_daily \(([\s\S]*?)\n\);/);
  assert.ok(daily, "définition de ai_usage_daily introuvable");
  assert.match(daily[1], /usage_day\s+date\s+not null/);
  assert.match(daily[1], /references auth\.users \(id\) on delete cascade/, "convention des migrations existantes");

  const events = raw.match(/create table if not exists public\.ai_usage_events \(([\s\S]*?)\n\);/);
  assert.ok(events, "définition de ai_usage_events introuvable");
  assert.match(events[1], /state\s+text\s+not null default 'consumed'/);
  assert.match(events[1], /refunded_at\s+timestamptz/);
  // Le défaut doit être DÉCLARÉ dans le DDL, pas seulement exigé par la garde :
  // une table créée sans défaut ferait échouer l'installation, mais un test
  // statique doit voir la dérive avant.
  assert.match(events[1], /attempts\s+integer\s+not null default 1/, "le défaut 1 des tentatives doit être déclaré");
  assert.match(events[1], /consumption_id\s+uuid\s+not null/);
  assert.match(daily[1], /created_at\s+timestamptz\s+not null default now\(\)/);
  assert.match(daily[1], /updated_at\s+timestamptz\s+not null default now\(\)/);
  pass("journée stockée sur la ligne, état initial « consumed », refunded_at présent, clé étrangère alignée sur 0001/0002");
}

// ---------------------------------------------------------------------------
// 3. Shape guard — a pre-existing table stops the migration
// ---------------------------------------------------------------------------
{
  assert.match(flat, /from information_schema\.columns/, "les colonnes réelles doivent être lues");
  assert.match(flat, /from pg_constraint c/, "les clés primaires réelles doivent être lues");
  assert.match(flat, /array_position\(c\.conkey, a\.attnum\)/, "l'ordre des colonnes de la clé doit être vérifié");
  assert.match(flat, /if pk_daily is distinct from 'user_id,usage_day'/);
  assert.match(flat, /if pk_events is distinct from 'consumption_id'/);
  const raises = (sql.match(/raise exception\s+'Migration 0003 annulée/g) ?? []).length;
  assert.ok(raises >= 3, `chaque garde doit annuler la migration (found ${raises})`);

  // Les invariants eux-mêmes : une table homonyme, bien colonnée, avec la bonne
  // clé primaire, mais privée de ses CHECK, passerait les contrôles ci-dessus.
  assert.match(flat, /c\.contype = 'c'/, "les contraintes CHECK doivent être vérifiées, pas seulement les clés");
  for (const nom of [
    "ai_usage_daily_messages_check",
    "ai_usage_daily_quotes_check",
    "ai_usage_events_state_check",
    "ai_usage_events_attempts_check",
  ]) {
    assert.ok(flat.includes(nom), `garde des invariants : ${nom} doit être exigée`);
  }
  pass("garde de forme : colonnes, types, clés primaires ET contraintes CHECK vérifiés ; écarts = migration annulée");
}

// ---------------------------------------------------------------------------
// 3b. Corrective audit — the runtime guards, asserted block by block
//
// Each assertion targets THE block that implements the guard, never the file
// as a whole: a pattern that merely appears elsewhere proves nothing. This is
// not theoretical — a mutation that replaced `pg_get_constraintdef` inside the
// invariant block went unnoticed while §2c still contained two occurrences.
// ---------------------------------------------------------------------------
{
  const daily = doBlock("n_cols <> 6");
  assert.match(daily, /from information_schema\.columns/);
  assert.match(daily, /and is_nullable <> 'NO'/, "NOT NULL doit être vérifié, pas supposé");
  assert.match(daily, /column_default = '0'/, "le défaut des compteurs doit être vérifié");
  assert.match(daily, /column_default !~ 'now\\\(\\\)'/, "les horodatages doivent avoir un défaut now()");
  assert.match(daily, /if n_cols <> 6 then/, "les colonnes surnuméraires doivent être refusées");

  const events = doBlock("n_cols <> 9");
  assert.match(events, /if n_cols <> 9 then/);
  assert.match(events, /is_nullable <> 'YES'/, "refunded_at doit rester NULLable");
  assert.match(events, /column_default = '1'/, "le défaut d'attempts doit être vérifié");
  assert.match(events, /column_default ~ 'consumed'/, "le défaut d'état doit être vérifié");
  pass("garde 3a — structure : colonnes surnuméraires, NOT NULL et valeurs par défaut vérifiés sur chaque table");
}

{
  // Point 2 — CHECK constraints: validated, no OR, exact normalised expression.
  const checks = doBlock("attendus[i][1]");
  assert.match(checks, /pg_get_constraintdef\(c\.oid\)/, "les définitions réelles doivent être relues");
  assert.match(checks, /c\.convalidated/, "convalidated doit être lu : une contrainte NOT VALID ne s'applique pas aux lignes existantes");
  assert.match(checks, /into def, valide/, "la validation doit être capturée avec la définition");
  assert.match(checks, /if not valide then/, "une contrainte non validée doit annuler la migration");
  assert.match(checks, /def ~\* '\\yor\\y'/, "un OR doit annuler la migration (\\y = frontière de mot PostgreSQL)");
  assert.match(checks, /def ~\* '\\ytrue\\y' or def ~\* '\\yfalse\\y'/, "un littéral booléen doit annuler la migration");
  assert.match(checks, /regexp_replace\(lower\(def\), '\[\[:space:\]\(\)\]', '', 'g'\)/, "la définition doit être normalisée");
  assert.match(checks, /regexp_replace\(norme, '\^check', ''\)/, "le préfixe CHECK doit être retiré avant comparaison");
  assert.match(checks, /if norme <> attendus\[i\]\[3\] then/, "la comparaison doit être EXACTE, pas un simple motif");
  for (const forme of [
    "messages>=0",
    "quotes>=0",
    "state=anyarray[''consumed''::text,''refunded''::text]",
    "attempts>=1andattempts<=3",
  ]) {
    assert.ok(checks.includes(forme), `forme normalisée attendue absente : ${forme}`);
  }
  assert.match(checks, /if n_ch <> 4 then/, "une contrainte CHECK étrangère doit annuler la migration");
  pass("garde 2 — CHECK : convalidated, aucun OR, aucun littéral booléen, forme normalisée EXACTE (4 formes verrouillées)");
}

{
  // Point 3 — foreign keys: the right table, the right COLUMN, the cascade.
  const foreign = doBlock("confdeltype");
  assert.match(foreign, /and c\.contype  = 'f'|and c\.contype = 'f'/, "les clés étrangères doivent être lues");
  assert.match(foreign, /cn\.nspname = 'auth'/, "la cible doit être auth.users");
  assert.match(foreign, /c\.confdeltype::text/, "l'action ON DELETE doit être lue dans le catalogue");
  assert.match(foreign, /fa\.attrelid = c\.confrelid and fa\.attnum = c\.confkey\[1\]/, "la colonne distante doit être résolue (confkey)");
  assert.match(foreign, /a\.attrelid  = c\.conrelid  and a\.attnum  = c\.conkey\[1\]/, "la colonne locale doit être résolue (conkey)");
  assert.match(foreign, /locale is distinct from 'user_id'/, "la colonne locale doit être user_id, pas n'importe quelle colonne");
  assert.match(foreign, /distante is distinct from 'id'/, "la colonne distante doit être id, pas n'importe quelle colonne");
  assert.match(foreign, /deltype is distinct from 'c'/, "ON DELETE CASCADE doit être vérifié par confdeltype");
  assert.match(foreign, /c\.convalidated/, "convalidated doit être vérifié pour les clés étrangères aussi",);
  assert.match(foreign, /if not valide then/, "une clé étrangère non validée doit annuler la migration");
  assert.match(foreign, /array_length\(c\.conkey, 1\)/, "les clés composites doivent être refusées");
  assert.match(foreign, /if n_cols <> 1 then/, "une clé étrangère multi-colonnes doit annuler la migration");
  assert.match(foreign, /if n_fk <> 2 then/, "une clé étrangère surnuméraire doit annuler la migration");
  pass("garde 3c — clés étrangères : user_id → auth.users.id, confdeltype = 'c', convalidated, mono-colonne, 2 exactement");
}

{
  // Point 4 — owner compatibility with RLS + SECURITY DEFINER.
  const owners = doBlock("owner_daily");
  assert.match(owners, /relforcerowsecurity/, "FORCE RLS doit être refusée : sans politique, le propriétaire ne pourrait plus écrire");
  assert.match(
    owners,
    /pg_get_userbyid\(c\.relowner\) in \('anon', 'authenticated', 'service_role'\)/,
    "une table ne doit pas appartenir à un rôle d'API",
  );
  assert.match(owners, /if owner_daily is distinct from owner_events then/, "les deux tables doivent avoir le même propriétaire");
  assert.match(owners, /if entry\.proowner <> owner_daily then/, "les fonctions doivent appartenir au propriétaire des tables");
  assert.match(owners, /elsif not entry\.prosecdef then/, "les trois RPC doivent être SECURITY DEFINER");
  assert.match(owners, /la fonction de trigger est SECURITY DEFINER sans en avoir besoin/, "le trigger ne doit pas être DEFINER");
  assert.match(owners, /<> 4 then/, "une surcharge inattendue doit annuler la migration");
  pass("garde 4 — propriétaires : même rôle pour les tables et les quatre fonctions, hors rôles d'API, FORCE RLS interdite");
}

{
  // Point 1 — search_path: pg_catalog first, pg_temp last, verified in the
  // catalogue and anchored so that nothing can be appended after it.
  const owners = doBlock("owner_daily");
  assert.match(owners, /unnest\(p2\.proconfig\)/, "le search_path doit être relu dans pg_proc.proconfig");
  assert.match(
    owners,
    /cfg ~ '\^\\s\*search_path\\s\*=\\s\*pg_catalog,\\s\*public,\\s\*pg_temp\\s\*\$'/,
    "le contrôle doit être ancré : exactement « pg_catalog, public, pg_temp », pg_temp en dernier",
  );
  pass("garde 1 — search_path relu dans proconfig et ancré sur « pg_catalog, public, pg_temp » exactement");
}

{
  // Point 1 (suite) — le schéma public lui-même.
  const acl = doBlock("has_schema_privilege");
  assert.match(acl, /from pg_roles r/, "les rôles doivent être lus, pas supposés exister");
  assert.match(acl, /where r\.rolname in \('anon', 'authenticated', 'service_role'\)/, "les trois rôles d'API doivent être testés");
  assert.match(acl, /if has_schema_privilege\(role_, 'public', 'CREATE'\) then/, "CREATE doit être testé par rôle");
  assert.match(acl, /le schéma public est inscriptible par%/, "un schéma public inscriptible doit annuler la migration");
  assert.match(acl, /select pg_get_userbyid\(n\.nspowner\)/, "le propriétaire du schéma doit être lu");
  assert.match(acl, /if proprietaire in \('anon', 'authenticated', 'service_role'\) then/, "un schéma public possédé par un rôle d'API doit être refusé");
  pass("garde 1b — schéma public : CREATE refusé aux trois rôles d'API, propriétaire hors rôles d'API");
}

{
  // Le search_path ne protège que si les objets sont qualifiés : une référence
  // nue résoudrait via le search_path, donc via un éventuel usurpateur.
  for (const name of ["ai_usage_consume", "ai_usage_refund", "ai_usage_read", "ai_usage_events_guard_fn"]) {
    assert.doesNotMatch(
      fn(name).body,
      /(from|into|update|insert into|delete from)\s+ai_usage_/i,
      `${name} : toute table doit être référencée en public.ai_usage_*`,
    );
  }
  pass("qualification : aucune référence de table non qualifiée dans les quatre fonctions");
}

// ---------------------------------------------------------------------------
// 4. Trigger — two transitions, nothing else
// ---------------------------------------------------------------------------
{
  const guard = fn("ai_usage_events_guard_fn");
  assert.doesNotMatch(guard.options, /security definer/i, "le trigger n'a pas besoin d'être DEFINER");
  // Même sans SECURITY DEFINER, la fonction de trigger est appelée dans le
  // contexte de l'appelant : un search_path figé lui évite de résoudre un objet
  // homonyme placé dans un schéma prioritaire.
  assert.match(
    guard.options,
    /set search_path = pg_catalog, public, pg_temp\b/i,
    "la fonction de trigger doit aussi figer son search_path (pg_catalog en premier, pg_temp en dernier)",
  );

  for (const column of ["consumption_id", "user_id", "is_quote", "created_at"]) {
    assert.match(guard.body, new RegExp(`new\\.${column}\\s*<>\\s*old\\.${column}`), `${column} doit être immuable`);
  }
  assert.match(guard.body, /old\.state = 'consumed' and new\.state = 'refunded'/);
  assert.match(guard.body, /old\.state = 'refunded' and new\.state = 'consumed'/);
  assert.match(guard.body, /new\.attempts <> old\.attempts \+ 1/, "une reconsommation incrémente de 1 exactement");
  assert.match(guard.body, /if new\.usage_day <> old\.usage_day then/, "un remboursement ne déplace pas la journée");
  assert.equal(
    (guard.body.match(/using errcode = '23514'/g) ?? []).length >= 5,
    true,
    "toute transition interdite doit lever 23514",
  );
  assert.match(flat, /drop trigger if exists ai_usage_events_guard on public\.ai_usage_events/);
  assert.match(flat, /before update on public\.ai_usage_events for each row execute function public\.ai_usage_events_guard_fn\(\)/);
  pass("trigger : identité et date de création immuables, seules consumed→refunded et refunded→consumed admises (23514 sinon)");
}

// ---------------------------------------------------------------------------
// 5. Signatures — the contract frozen by server/usageStore.ts
// ---------------------------------------------------------------------------
const consume = fn("ai_usage_consume");
const refund = fn("ai_usage_refund");
const read = fn("ai_usage_read");

// Assertions on the bodies use a whitespace-collapsed copy: the SQL is
// formatted for a human reader, and an assertion must not depend on where a
// line break happens to fall.
const consumeF = consume.body.replace(/\s+/g, " ");
const refundF = refund.body.replace(/\s+/g, " ");
const readF = read.body.replace(/\s+/g, " ");

{
  assert.deepEqual(paramList(consume.params), [
    "p_user_id uuid",
    "p_consumption_id uuid",
    "p_limit_messages integer",
    "p_limit_quotes integer",
    "p_is_quote boolean",
    "p_now timestamptz default null",
  ]);
  assert.deepEqual(returnColumns(consume.returns), [
    "allowed",
    "reason",
    "used_messages",
    "used_quotes",
    "usage_day",
    "replayed",
  ]);
  pass("signature ai_usage_consume : paramètres et colonnes conformes à ce que le serveur envoie et lit");
}

{
  assert.deepEqual(paramList(refund.params), [
    "p_user_id uuid",
    "p_consumption_id uuid",
    "p_now timestamptz default null",
  ]);
  assert.deepEqual(returnColumns(refund.returns), ["refunded", "reason", "usage_day"]);

  assert.deepEqual(paramList(read.params), ["p_user_id uuid", "p_now timestamptz default null"]);
  assert.deepEqual(returnColumns(read.returns), ["usage_day", "used_messages", "used_quotes"]);
  pass("signatures ai_usage_refund et ai_usage_read : conformes au magasin d'usage");
}

{
  // `p_now` est une couture de test : sans valeur par défaut, la production
  // devrait l'envoyer, et une journée pourrait être choisie par l'appelant.
  for (const [name, block] of [["consume", consume], ["refund", refund], ["read", read]]) {
    assert.match(block.params, /p_now\s+timestamptz\s+default\s+null/i, `p_now doit avoir un défaut (${name})`);
    assert.match(block.body, /coalesce\(p_now, now\(\)\)/, `la journée doit venir de now() (${name})`);
  }
  pass("p_now : valeur par défaut null partout, et toujours repliée sur now() dans le corps");
}

{
  // Verrou bidirectionnel avec le TypeScript : tout ce que le store envoie est
  // un paramètre, et tout ce qu'il lit est une colonne retournée.
  const sent = ["p_user_id", "p_consumption_id", "p_limit_messages", "p_limit_quotes", "p_is_quote", "p_now"];
  for (const key of sent) {
    assert.match(store, new RegExp(`\\b${key}\\b`), `le store doit utiliser ${key}`);
  }
  assert.match(consume.params, /p_user_id/);
  assert.match(consume.params, /p_consumption_id/);
  assert.match(consume.params, /p_limit_messages/);
  assert.match(consume.params, /p_limit_quotes/);
  assert.match(consume.params, /p_is_quote/);
  assert.match(consume.params, /p_now/);

  function storeRowFields(typeName) {
    const block = store.match(new RegExp(`type ${typeName} = \\{([\\s\\S]*?)\\};`));
    assert.ok(block, `type ${typeName} introuvable dans usageStore.ts`);
    return [...block[1].matchAll(/(\w+)\?:/g)].map((match) => match[1]);
  }

  const consumeFields = storeRowFields("ConsumeRow");
  assert.ok(consumeFields.length >= 6);
  for (const field of consumeFields) {
    assert.ok(returnColumns(consume.returns).includes(field), `ConsumeRow.${field} absent du RETURNS de 0003`);
  }
  const refundFields = storeRowFields("RefundRow");
  for (const field of refundFields) {
    assert.ok(returnColumns(refund.returns).includes(field), `RefundRow.${field} absent du RETURNS de 0003`);
  }
  const readFields = storeRowFields("UsageReadRow");
  for (const field of readFields) {
    assert.ok(returnColumns(read.returns).includes(field), `UsageReadRow.${field} absent du RETURNS de 0003`);
  }
  pass("verrou serveur ↔ SQL : chaque champ lu par usageStore.ts (ConsumeRow, RefundRow, UsageReadRow) existe dans 0003");
}

// ---------------------------------------------------------------------------
// 6. Consume — claim, atomic counting, refusal, re-consumption
// ---------------------------------------------------------------------------
{
  assert.match(
    consume.body,
    /insert into public\.ai_usage_events[\s\S]*?on conflict \(consumption_id\) do nothing/,
    "la réclamation doit passer par la clé primaire",
  );
  assert.match(consume.body, /get diagnostics v_inserted = row_count/);
  assert.match(
    consume.body,
    /select \* into v_event[\s\S]*?for update/,
    "la ligne existante doit être verrouillée avant toute décision",
  );
  pass("réclamation atomique : insertion « on conflict do nothing » puis verrou « for update » sur la ligne existante");
}

{
  assert.match(consume.body, /v_event\.user_id <> p_user_id or v_event\.is_quote <> p_is_quote/);
  assert.match(consume.body, /'consumption_conflict'::text/, "un identifiant d'autrui doit être refusé");
  // Sur un conflit, les compteurs rendus sont ceux de l'APPELANT.
  const conflictBlock = consume.body.slice(
    consume.body.indexOf("v_event.user_id <> p_user_id"),
    consume.body.indexOf("v_event.state = 'consumed'"),
  );
  assert.match(conflictBlock, /where d\.user_id = p_user_id/, "un conflit ne doit pas divulguer l'usage d'autrui");
  pass("conflits : identifiant d'un autre compte (ou autre type de message) refusé, sans divulguer les compteurs d'autrui");
}

{
  assert.match(consume.body, /if v_event\.state = 'consumed' then/, "le rejeu doit être détecté");
  assert.match(
    consumeF,
    /return query select true, null::text, coalesce\(v_messages, 0\), coalesce\(v_quotes, 0\), v_event\.usage_day, true;/,
    "le rejeu renvoie replayed = true",
  );
  const replayBlock = consume.body.slice(
    consume.body.indexOf("if v_event.state = 'consumed' then"),
    consume.body.indexOf("if v_event.attempts >= 3 then"),
  );
  assert.doesNotMatch(replayBlock, /insert into public\.ai_usage_daily|update public\.ai_usage_daily/);
  pass("rejeu : allowed = true et replayed = true, sans aucun incrément (le serveur répondra 409, sans appel IA)");
}

{
  assert.match(consume.body, /if v_event\.attempts >= 3 then/, "4e tentative = refus");
  assert.match(consumeF, /attempts = attempts \+ 1/, "une reconsommation acceptée incrémente attempts");
  assert.match(consumeF, /usage_day = v_day/, "la reconsommation se facture sur la journée courante");
  assert.match(consumeF, /refunded_at = null/);
  pass("reconsommation après remboursement : admise sous 3 tentatives, +1 attempt, journée recalculée, refunded_at remis à null");
}

{
  assert.match(
    consume.body,
    /insert into public\.ai_usage_daily as u[\s\S]*?on conflict \(user_id, usage_day\) do update/,
    "le compteur doit être incrémenté par un upsert unique",
  );
  assert.match(consume.body, /where u\.messages < p_limit_messages/);
  assert.match(consume.body, /p_limit_quotes is null or not p_is_quote or u\.quotes < p_limit_quotes/);
  assert.equal(
    (consume.body.match(/update public\.ai_usage_daily/g) ?? []).length,
    0,
    "aucune écriture de compteur hors de l'upsert conditionnel : pas de lecture-puis-écriture",
  );
  assert.match(consume.body, /if p_limit_messages < 1 or/, "une limite nulle ne peut pas être honorée par l'upsert");
  pass("atomicité du compteur : un seul upsert conditionnel, la limite dans le WHERE, aucun schéma lecture-puis-écriture");
}

{
  const deletes = [...consume.body.matchAll(/delete from public\.ai_usage_events([\s\S]*?);/g)];
  assert.equal(deletes.length, 1, "la réclamation doit être retirée à l'identique, une seule fois");
  const clause = deletes[0][1].replace(/\s+/g, " ");
  for (const guard of ["consumption_id = p_consumption_id", "user_id = p_user_id", "state = 'consumed'", "attempts = 1"]) {
    assert.ok(clause.includes(guard), `garde manquante sur le delete : ${guard}`);
  }
  assert.match(consume.body, /if v_inserted = 1 then/, "seule une réclamation neuve peut être retirée");
  assert.equal((sql.match(/delete from/gi) ?? []).length, 1, "aucun autre DELETE dans le fichier");
  pass("refus sans écriture : la réclamation neuve est supprimée dans la même transaction, jamais un événement remboursé");
}

{
  const refusedReasons = [...consume.body.matchAll(/'daily_(messages|quotes)'/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(refusedReasons)].sort(), ["'daily_messages'", "'daily_quotes'"]);
  assert.doesNotMatch(consume.body, /'consumption_refunded'/, "vocabulaire obsolète");
  assert.doesNotMatch(consume.body, /'replay'::text/, "le rejeu se signale par replayed = true, pas par un motif");
  // Le serveur ne comprend que trois motifs côté consume ; tout autre motif
  // tombe dans son « fail closed ».
  const known = new Set(["daily_messages", "daily_quotes", "consumption_conflict"]);
  const literals = [...consume.body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  for (const literal of literals) {
    if (literal.startsWith("daily_") || literal === "consumption_conflict") {
      assert.ok(known.has(literal), `motif inconnu du serveur : ${literal}`);
    }
  }
  pass("vocabulaire de refus limité à daily_messages, daily_quotes et consumption_conflict — tout le reste est un bug");
}

// ---------------------------------------------------------------------------
// 7. Refund — idempotent, on the event's day, without leaking
// ---------------------------------------------------------------------------
{
  assert.match(refund.body, /if not found or v_event\.user_id <> p_user_id then/, "absence et compte étranger = même réponse");
  assert.match(refund.body, /'not_refundable'::text/);
  assert.match(refund.body, /if v_event\.state = 'refunded' then/);
  assert.match(refund.body, /'already_refunded'::text/);
  const alreadyRefunded = refund.body.slice(
    refund.body.indexOf("if v_event.state = 'refunded' then"),
    refund.body.indexOf("update public.ai_usage_events"),
  );
  assert.doesNotMatch(alreadyRefunded, /update public\.ai_usage_daily/, "un second remboursement ne doit rien décrémenter");
  pass("remboursement idempotent : second appel ⇒ refunded = false, aucun décrément, et aucune fuite d'existence");
}

{
  assert.match(refundF, /set messages = greatest\(0, d\.messages - 1\)/);
  assert.match(refundF, /quotes = greatest\(0, d\.quotes - case when v_event\.is_quote then 1 else 0 end\)/);
  assert.match(refundF, /and d\.usage_day = v_event\.usage_day/, "le décrément porte sur la journée de l'événement");
  assert.match(refund.body, /'not found'|not found/, "la ligne doit être lue puis verrouillée");
  assert.match(refund.body, /for update/);
  pass("remboursement sur la journée facturée : usage_day de l'événement, bornage greatest(0, …), verrou de ligne");
}

// ---------------------------------------------------------------------------
// 7b. The refund vocabulary is diagnostic only — it cannot drift
// ---------------------------------------------------------------------------
{
  // usageStore.ts lit `refunded` et `usage_day`, jamais `reason`. Une divergence
  // de libellé serait donc invisible ; on verrouille l'inverse : le magasin ne
  // doit pas se mettre à interpréter le motif sans que le SQL soit rouvert.
  assert.doesNotMatch(store, /not_refundable|already_refunded/, "le magasin ne doit pas dépendre du libellé SQL");
  const refundFn = store.slice(store.indexOf("export async function refundDurableUsage"), store.indexOf("export type UsageReadOutcome"));
  assert.ok(refundFn.length > 0, "refundDurableUsage introuvable dans usageStore.ts");
  assert.match(refundFn, /row\.refunded === true/);
  assert.match(refundFn, /asString\(row\.usage_day\)/);
  assert.doesNotMatch(refundFn, /row\.reason/, "le motif de remboursement ne doit pas piloter la décision du serveur");

  // Le SQL émet bien les deux motifs, à titre d'explication dans les journaux.
  assert.equal((refundF.match(/'not_refundable'/g) ?? []).length, 1);
  assert.equal((refundF.match(/'already_refunded'/g) ?? []).length, 1);
  pass("motifs de remboursement : purement diagnostiques (une occurrence de chaque), le serveur ne lit que refunded et usage_day");
}

// ---------------------------------------------------------------------------
// 7c. Limits — null means "unlimited quotes", null messages never reaches SQL
// ---------------------------------------------------------------------------
{
  // p_limit_quotes NULL = illimité : la condition laisse passer.
  assert.match(consumeF, /\(p_limit_quotes is null or not p_is_quote or u\.quotes < p_limit_quotes\)/);
  // p_limit_messages NULL est refusé par le SQL, mais le magasin l'écarte déjà
  // avant tout appel réseau : la garde SQL est une défense en profondeur, pas
  // le seul rempart.
  assert.match(
    store,
    /if \(limits\.messagesPerDay === null\) return \{ ok: false, kind: "unsupported_limits" \}/,
    "le serveur doit refuser une limite de messages inconnue avant l'appel RPC",
  );
  assert.match(consumeF, /p_limit_messages is null or p_limit_messages < 0/, "le SQL refuse aussi NULL");
  pass("limites : quotes NULL = illimité, messages NULL refusé côté serveur ET côté SQL (défense en profondeur)");
}

// ---------------------------------------------------------------------------
// 7d. Refund must give the quota back, or fail — never report a false success
//
// The counter update used to be unchecked: a missing counter row, or a negative
// one, produced `refunded = true` while nothing was returned. The function now
// locks the counter row, verifies it, and refuses to answer true unless exactly
// one row was decremented.
// ---------------------------------------------------------------------------
{
  const body = refundF;
  // 1. La ligne de compteur est verrouillée AVANT de décider.
  assert.match(
    body,
    /select d\.messages, d\.quotes into v_messages, v_quotes from public\.ai_usage_daily d where d\.user_id = p_user_id and d\.usage_day = v_event\.usage_day for update;/,
    "le compteur doit être lu, verrouillé, avant toute décision",
  );
  // 2. Ligne absente ⇒ exception (et donc annulation de toute la transaction).
  assert.match(body, /if not found then raise exception/, "une ligne de compteur absente doit lever une exception");
  assert.match(body, /quota non rendu, remboursement annulé/, "le message doit dire que le quota n'a pas été rendu");
  // 3. Compteurs incohérents ⇒ exception.
  assert.match(
    body,
    /if v_messages < 1 or \(v_event\.is_quote and v_quotes < 1\) then/,
    "un compteur à zéro (ou une quote sans quote) doit lever une exception",
  );
  // 4. Exactement une ligne modifiée.
  assert.match(body, /get diagnostics v_rows = row_count;/, "le nombre de lignes modifiées doit être capturé");
  assert.match(body, /if v_rows <> 1 then/, "un remboursement qui ne modifie pas exactement une ligne doit échouer");
  // 5. `refunded = true` n'est renvoyé qu'APRÈS le contrôle : il doit être
  //    textuellement après `if v_rows <> 1` dans le corps.
  const successAt = body.indexOf("return query select true, null::text, v_event.usage_day");
  const checkAt = body.indexOf("if v_rows <> 1 then");
  assert.ok(checkAt > 0 && successAt > checkAt, "le succès doit être renvoyé après le contrôle du nombre de lignes");
  // 6. Les variables nécessaires sont déclarées.
  for (const variable of ["v_messages", "v_quotes", "v_rows"]) {
    assert.match(refund.body, new RegExp(`\\b${variable}\\s+integer;`), `${variable} doit être déclaré`);
  }
  pass("remboursement : compteur verrouillé puis vérifié, ligne absente ou compteurs incohérents ⇒ exception, exactement 1 ligne sinon échec");
}

// ---------------------------------------------------------------------------
// 8. Read — one row, zeros included, no write
// ---------------------------------------------------------------------------
{
  assert.match(read.body, /left join public\.ai_usage_daily d/);
  assert.match(read.body, /coalesce\(d\.messages, 0\)/);
  assert.match(read.body, /coalesce\(d\.quotes, 0\)/);
  assert.doesNotMatch(read.body, /insert into|update |delete from/i, "la lecture ne doit rien écrire");
  pass("lecture : une seule ligne renvoyée (zéros compris), aucune écriture possible");
}

// ---------------------------------------------------------------------------
// 9. Security posture
// ---------------------------------------------------------------------------
{
  // On compte sur les OPTIONS des quatre fonctions, pas sur le texte du
  // fichier : les `comment on table` et le rapport final mentionnent aussi la
  // formule, et un test qui compte des mots ne prouve rien.
  const blocks = [consume, refund, read, fn("ai_usage_events_guard_fn")];
  assert.equal(
    blocks.filter((block) => /security definer/i.test(block.options)).length,
    3,
    "exactement trois fonctions SECURITY DEFINER (les trois RPC), pas la fonction de trigger",
  );
  for (const [name, block] of [["consume", consume], ["refund", refund], ["read", read]]) {
    assert.match(block.options, /security definer/i, `${name} doit être SECURITY DEFINER`);
  }
  // Les QUATRE fonctions, y compris celle du trigger, doivent figer leur
  // search_path ; et l'ordre compte : pg_temp après public, sinon un objet
  // temporaire peut usurper une fonction ou une table.
  for (const [name, block] of [
    ["consume", consume],
    ["refund", refund],
    ["read", read],
    ["trigger", fn("ai_usage_events_guard_fn")],
  ]) {
    assert.match(
      block.options,
      /set search_path = pg_catalog, public, pg_temp\b/i,
      `${name} doit figer son search_path sur pg_catalog, public, pg_temp (pg_temp en dernier)`,
    );
    assert.doesNotMatch(block.options, /pg_temp\s*,\s*public/i, `${name} : pg_temp doit venir en dernier`);
    assert.doesNotMatch(block.options, /search_path = public,/i, `${name} : pg_catalog doit précéder public`);
  }
  assert.doesNotMatch(sql, /security invoker/i);
  pass("search_path figé sur « pg_catalog, public, pg_temp » pour les quatre fonctions (pg_temp en dernier), DEFINER sur les trois RPC seules");
}

{
  assert.equal((sql.match(/enable row level security/gi) ?? []).length, 2);
  assert.doesNotMatch(sql, /create policy/i, "aucune politique : les tables restent invisibles au navigateur");
  assert.match(flat, /revoke all on public\.ai_usage_daily from anon, authenticated, service_role/);
  assert.match(flat, /revoke all on public\.ai_usage_events from anon, authenticated, service_role/);
  assert.match(flat, /revoke all on public\.ai_usage_daily from public/);
  assert.doesNotMatch(
    sql,
    /grant\s+(all|select|insert|update|delete)[\s\S]{0,80}?on\s+public\.ai_usage_/i,
    "aucun privilège de table ne doit être accordé",
  );
  pass("RLS activée sans politique, privilèges révoqués pour anon, authenticated ET service_role, aucun GRANT de table");
}

{
  const grants = [...flat.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to (\w+)/g)];
  assert.equal(grants.length, 3, "trois grants EXECUTE, pas un de plus");
  for (const grant of grants) {
    assert.equal(grant[2], "service_role", `seul service_role peut exécuter ${grant[1]}`);
  }
  assert.match(flat, /revoke all on function public\.ai_usage_consume\([^)]*\) from public, anon, authenticated/);
  assert.match(flat, /revoke all on function public\.ai_usage_refund\([^)]*\) from public, anon, authenticated/);
  assert.match(flat, /revoke all on function public\.ai_usage_read\([^)]*\) from public, anon, authenticated/);
  assert.match(flat, /revoke all on function public\.ai_usage_events_guard_fn\(\) from public, anon, authenticated/);
  pass("EXECUTE accordé au seul service_role, après révocation explicite du droit par défaut de PUBLIC");
}

// ---------------------------------------------------------------------------
// 9b. Column privileges — the ACL that has_table_privilege never shows
//
// Table privileges and column privileges are two different ACLs:
// `pg_class.relacl` and `pg_attribute.attacl`. A `grant select (usage_day) …
// to anon` is stored in the second one, is not reported by any
// has_table_privilege() call, and a table-level REVOKE is not guaranteed to
// remove it. The migration must therefore revoke the columns BY NAME, verify
// the result in the catalogue, and still grant nothing beyond the three
// EXECUTE on functions.
// ---------------------------------------------------------------------------
{
  // 1. Les deux révocations de colonnes, pour les quatre grantees.
  assert.match(
    flat,
    /revoke all \(user_id, usage_day, messages, quotes, created_at, updated_at\) on table public\.ai_usage_daily from public, anon, authenticated, service_role/,
    "les colonnes de ai_usage_daily doivent être révoquées nommément pour PUBLIC et les trois rôles",
  );
  assert.match(
    flat,
    /revoke all \(consumption_id, user_id, usage_day, is_quote, state, attempts, created_at, refunded_at, updated_at\) on table public\.ai_usage_events from public, anon, authenticated, service_role/,
    "les colonnes de ai_usage_events doivent être révoquées nommément pour PUBLIC et les trois rôles",
  );

  // 2. Les listes doivent correspondre, nom pour nom, aux colonnes déclarées :
  //    une colonne oubliée serait une porte laissée ouverte.
  const declared = (tableName) => {
    const def = raw.match(new RegExp(`create table if not exists public\\.${tableName} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(def, `définition de ${tableName} introuvable`);
    const cols = [];
    for (const line of def[1].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--") || t.startsWith("constraint")) continue;
      const m = t.match(/^([a-z_]+)\s+(uuid|date|integer|boolean|text|timestamptz)\b/);
      if (m) cols.push(m[1]);
    }
    return cols.sort();
  };
  const revoked = (tableName) => {
    const m = flat.match(
      new RegExp(`revoke all \\(([^)]*)\\) on table public\\.${tableName} from public, anon, authenticated, service_role`),
    );
    assert.ok(m, `révocation de colonnes introuvable pour ${tableName}`);
    return m[1].split(",").map((c) => c.trim()).sort();
  };
  assert.deepEqual(revoked("ai_usage_daily"), declared("ai_usage_daily"), "liste de colonnes révoquées ≠ colonnes réelles");
  assert.deepEqual(revoked("ai_usage_events"), declared("ai_usage_events"), "liste de colonnes révoquées ≠ colonnes réelles");
  assert.equal(revoked("ai_usage_daily").length, 6);
  assert.equal(revoked("ai_usage_events").length, 9);

  // 3. Le self-check doit inspecter attacl, et voir PUBLIC comme grantee 0.
  assert.match(flat, /cross join lateral aclexplode\(a\.attacl\)/, "les ACL de colonnes doivent être inspectées");
  assert.match(flat, /a\.attrelid = 'public\.ai_usage_daily'::regclass/, "la table daily doit être inspectée");
  assert.match(flat, /a\.attrelid = 'public\.ai_usage_events'::regclass/, "la table events doit être inspectée");
  assert.match(flat, /a\.attnum > 0 and not a\.attisdropped/, "seules les colonnes réelles doivent être inspectées");
  assert.match(
    flat,
    /x\.grantee = 0 or pg_get_userbyid\(x\.grantee\) in \('anon', 'authenticated', 'service_role'\)/,
    "PUBLIC (grantee 0) et les trois rôles doivent être détectés",
  );
  assert.match(flat, /privilège de COLONNE subsistant sur ai_usage_daily/, "un résidu doit annuler la migration (daily)");
  assert.match(flat, /privilège de COLONNE subsistant sur ai_usage_events/, "un résidu doit annuler la migration (events)");
  pass("colonnes : révocations nommées (6 et 9 colonnes, quatre grantees), self-check attacl avec PUBLIC, résidu = annulation");
}

{
  // 4. Aucun privilège de table ni de colonne n'est accordé nulle part.
  const grantWords = [...sql.matchAll(/\bgrant\b/gi)];
  assert.equal(grantWords.length, 3, "exactement trois GRANT dans tout le fichier");
  for (const word of grantWords) {
    const statement = sql.slice(word.index, sql.indexOf(";", word.index));
    assert.match(statement, /^grant execute on function public\.ai_usage_/i, `GRANT inattendu : ${statement}`);
  }
  assert.doesNotMatch(
    sql,
    /grant\s+(all|select|insert|update|delete|references)\s*\(/i,
    "aucun privilège de COLONNE ne doit être accordé",
  );
  assert.doesNotMatch(
    sql,
    /grant\s+(all|select|insert|update|delete|references|truncate|trigger)\b[^;]*?\bon\s+(table\s+)?public\./i,
    "aucun privilège de TABLE ne doit être accordé",
  );

  // 5. Ordre : table, puis colonnes, puis les trois EXECUTE.
  const iTable = sql.indexOf("revoke all on public.ai_usage_daily");
  const iColumn = sql.indexOf("revoke all (user_id,");
  const iGrant = sql.indexOf("grant execute on function public.ai_usage_consume");
  assert.ok(iTable > 0 && iColumn > iTable && iGrant > iColumn, "révocation de table, puis de colonnes, puis EXECUTE");
  pass("aucun privilège accordé : trois GRANT, tous EXECUTE sur fonction, ni table ni colonne ; ordre des révocations respecté");
}

// ---------------------------------------------------------------------------
// 9c. Table ACLs, read from pg_class.relacl — the blind spot next to 9b
//
// has_table_privilege answers "what does this role effectively hold", which is
// the right question for the six critical combinations but says nothing about
// TRUNCATE, REFERENCES or TRIGGER, nor about a direct entry granted to PUBLIC.
// aclexplode(relacl) lists every entry verbatim, grantee 0 being PUBLIC. The
// guard must cover all four grantees and every verb at once, and must abort.
// ---------------------------------------------------------------------------
{
  const sec = doBlock("aclexplode(c.relacl)");

  // 1. La lecture : pg_class × pg_namespace, schéma public, les deux tables.
  assert.match(flat, /cross join lateral aclexplode\(c\.relacl\)/);
  assert.match(sec, /join pg_namespace n on n\.oid = c\.relnamespace/);
  assert.match(sec, /n\.nspname = 'public'/);
  assert.match(sec, /c\.relname in \('ai_usage_daily', 'ai_usage_events'\)/);

  // Les assertions 2 à 4 portent sur l'INSTRUCTION relacl seule : les contrôles
  // de colonnes du même bloc `do` partagent le prédicat des grantees, et une
  // assertion sur le bloc entier resterait verte si on restreignait la
  // vérification de table au seul service_role.
  const iRelaclJoin = sql.indexOf("cross join lateral aclexplode(c.relacl)");
  const relaclCheck = sql.slice(sql.lastIndexOf("for entry in", iRelaclJoin), sql.indexOf("end loop;", iRelaclJoin));

  // 2. Les quatre grantees : PUBLIC (grantee 0) et les trois rôles d'API.
  assert.match(
    relaclCheck,
    /x\.grantee = 0 or pg_get_userbyid\(x\.grantee\) in \('anon', 'authenticated', 'service_role'\)/,
    "PUBLIC (grantee 0) et les trois rôles doivent être détectés",
  );

  // 3. Aucun filtre sur le type de privilège : tout verbe compte, donc
  //    TRUNCATE, REFERENCES et TRIGGER sont couverts — et un verbe futur aussi.
  assert.doesNotMatch(relaclCheck, /privilege_type/, "aucune liste blanche de verbes : tout octroi direct doit compter");

  // 4. L'échec est réel : le message part dans `problems`, que §8 transforme en
  //    exception, donc en annulation de la transaction.
  assert.match(
    relaclCheck,
    /problems := problems \|\| format\(' privilège de TABLE subsistant \(ACL directe\) sur %s;', entry\.name\)/,
  );
  assert.match(flat, /if problems <> '' then raise exception 'Migration 0003 annulée : contrôles de sécurité échoués/);

  // 5. Ordre : après les contrôles effectifs, avant les colonnes, avant le raise.
  const iEffective = sql.indexOf("has_table_privilege('service_role', 'public.ai_usage_events', 'DELETE')");
  const iRelacl = sql.indexOf("aclexplode(c.relacl)");
  const iColumnAcl = sql.indexOf("aclexplode(a.attacl)");
  const iRaise = sql.indexOf("if problems <> '' then");
  assert.ok(iEffective > 0 && iEffective < iRelacl, "le contrôle relacl vient après les contrôles effectifs");
  assert.ok(iRelacl < iColumnAcl, "table puis colonnes");
  assert.ok(iColumnAcl < iRaise, "les contrôles précèdent l'exception");

  pass("ACL de table : aclexplode(relacl) sur les deux tables, PUBLIC (grantee 0) + trois rôles, tous verbes sans liste blanche, échec ⇒ annulation");
}

{
  // 6. A2 — le comportement attendu de aclexplode(NULL) est DOCUMENTÉ et sa
  //    vérification renvoyée à P3 ; aucune rustine SQL n'est ajoutée sur une
  //    hypothèse non vérifiée (ni coalesce, ni « is not null »).
  const start = raw.indexOf("-- The has_table_privilege calls above answer");
  assert.ok(start > 0, "le commentaire d'intention du contrôle relacl est attendu");
  const end = raw.indexOf("for entry in", start);
  assert.ok(end > start);
  const comment = raw
    .slice(start, end)
    .split("\n")
    .filter((line) => line.trim().startsWith("--"))
    .join(" ");
  assert.match(comment, /aclexplode\(NULL\)/, "le cas ACL NULL doit être documenté");
  assert.match(comment, /P3/, "la vérification doit être explicitement renvoyée à P3");
  assert.doesNotMatch(flat, /coalesce\(c\.relacl/, "aucune rustine SQL sur une hypothèse : rien à corriger ici");
  assert.doesNotMatch(flat, /relacl is not null/, "le cas NULL n'est pas contourné côté SQL");
  pass("A2 : aclexplode(NULL) documenté, vérification renvoyée à P3, aucune correction SQL fondée sur une hypothèse");
}

{
  assert.match(flat, /has_table_privilege\('service_role', 'public\.ai_usage_daily', 'INSERT'\)/);
  assert.match(flat, /has_table_privilege\('service_role', 'public\.ai_usage_daily', 'UPDATE'\)/);
  assert.match(flat, /has_table_privilege\('service_role', 'public\.ai_usage_daily', 'DELETE'\)/);
  assert.match(flat, /has_table_privilege\('service_role', 'public\.ai_usage_events', 'INSERT'\)/);
  assert.match(flat, /if not has_function_privilege\( 'service_role'/);
  assert.match(flat, /raise exception 'Migration 0003 annulée : contrôles de sécurité échoués/);
  assert.match(flat, /notify pgrst, 'reload schema'/);
  pass("auto-contrôle : toute dérive de privilège annule la migration ; le cache PostgREST est rechargé");
}

{
  // L'identité ne vient JAMAIS du JWT : elle est passée par le serveur, après
  // vérification du token. `auth.uid()` serait un contournement.
  assert.doesNotMatch(sql, /auth\.uid\(\)/i, "l'identité doit venir du serveur, jamais du JWT");
  assert.doesNotMatch(sql, /current_setting\(/i);
  assert.doesNotMatch(sql, /current_user|session_user/i);
  pass("identité : aucun auth.uid(), aucun current_setting — p_user_id ne peut venir que du serveur");
}

// ---------------------------------------------------------------------------
// 10. Idempotence of the installation
// ---------------------------------------------------------------------------
{
  assert.equal((sql.match(/create table if not exists/gi) ?? []).length, 2);
  assert.equal((sql.match(/create or replace function/gi) ?? []).length, 4, "trois RPC + la fonction de trigger");
  assert.equal((sql.match(/drop function if exists/gi) ?? []).length, 3);
  assert.equal((sql.match(/drop trigger if exists/gi) ?? []).length, 1);
  assert.match(flat, /comment on table public\.ai_usage_daily is/);
  assert.match(flat, /comment on table public\.ai_usage_events is/);
  pass("installation réexécutable : create if not exists, create or replace, drop … if exists, grants idempotents");
}

console.log(`\n${checks} vérifications statiques de la migration 0003 passées.`);
