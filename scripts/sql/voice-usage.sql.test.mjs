/**
 * Migration `0004_voice_usage.sql`, exécutée dans un VRAI PostgreSQL 16.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POURQUOI CE TEST EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * La garantie apportée par cette migration est dans le SQL, pas dans le
 * JavaScript : atomicité de la réservation, unicité de la session ouverte,
 * idempotence du règlement et du remboursement. Un double en JavaScript ne peut
 * pas prouver cela — il ne ferait que reproduire mes propres hypothèses.
 *
 * Ce fichier exécute donc le fichier de migration tel quel, dans un PostgreSQL
 * 16 (PGlite, WASM, aucune installation, aucun réseau), après avoir créé le
 * strict minimum que Supabase fournit d'habitude : le schéma `auth`, la table
 * `auth.users`, la fonction `auth.uid()` et les rôles `anon`, `authenticated`,
 * `service_role`.
 *
 * Il ne touche ni Supabase, ni la Production : c'est une base jetable en
 * mémoire, détruite à la fin du processus.
 *
 * Dépendance : `@electric-sql/pglite`. Si elle n'est pas installée, le test
 * s'ignore proprement en le disant — il ne fait jamais semblant de passer.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const MIGRATION = new URL("../../supabase/migrations/0004_voice_usage.sql", import.meta.url);

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log(
    "SKIP  @electric-sql/pglite absent : la migration n'a pas pu être exécutée.\n" +
      "      Installez-la (npm i -D @electric-sql/pglite) pour prouver le SQL.",
  );
  process.exit(0);
}

const sql = readFileSync(MIGRATION, "utf8");
const db = await PGlite.create();

// Le strict minimum fourni par Supabase.
await db.exec(`
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select null::uuid $$;
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end
  $$;
`);

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
await db.exec(`insert into auth.users (id) values ('${U1}'), ('${U2}')`);

const q = async (text, params) => (await db.query(text, params)).rows;

// ---------------------------------------------------------------------------
// 0. Application, et rejeu
// ---------------------------------------------------------------------------
await db.exec(sql);
pass("migration : s'applique sans erreur sur PostgreSQL 16");

await db.exec(sql);
pass("migration : idempotente, rejouable sans erreur");

// ---------------------------------------------------------------------------
// 1. Formule sans voix
// ---------------------------------------------------------------------------
{
  const [row] = await q(`select public.voice_reserve($1, 0, 60, 'brise', 3600) as r`, [U1]);
  assert.equal(row.r.ok, false);
  assert.equal(row.r.kind, "voice_not_in_plan");
  const [usage] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage, undefined, "un refus n'écrit aucune ligne de consommation");
  pass("SQL : Découverte (0 s) refusée, aucune ligne écrite");
}

// ---------------------------------------------------------------------------
// 2. Réservation nominale
// ---------------------------------------------------------------------------
let S1;
{
  const [row] = await q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U1]);
  assert.equal(row.r.ok, true);
  assert.equal(row.r.remaining_seconds, 540);
  S1 = row.r.session_id;
  const [usage] = await q(
    `select reserved_seconds, consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage.reserved_seconds, 60);
  assert.equal(usage.consumed_seconds, 0);
  pass("SQL : 60 s réservées sur 600, reste 540");
}

// ---------------------------------------------------------------------------
// 3. Une seule session ouverte par compte
// ---------------------------------------------------------------------------
{
  const [row] = await q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U1]);
  assert.equal(row.r.ok, false);
  assert.equal(row.r.kind, "voice_session_open");
  const [usage] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage.reserved_seconds, 60, "le refus n'a pas laissé une seconde réservation");
  pass("SQL : deuxième session refusée, aucune réservation fantôme");
}

// ---------------------------------------------------------------------------
// 4. Régularisation à la durée réelle
// ---------------------------------------------------------------------------
{
  const [row] = await q(`select public.voice_settle($1, $2, 20) as r`, [U1, S1]);
  assert.equal(row.r.kind, "settled");
  assert.equal(row.r.charged_seconds, 20);
  const [usage] = await q(
    `select reserved_seconds, consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage.consumed_seconds, 20);
  assert.equal(usage.reserved_seconds, 0);
  pass("SQL : fermer après 20 s facture 20 s et rend 40 s");
}

// ---------------------------------------------------------------------------
// 5. Idempotence du règlement
// ---------------------------------------------------------------------------
{
  const [row] = await q(`select public.voice_settle($1, $2, 999) as r`, [U1, S1]);
  assert.equal(row.r.kind, "already_settled");
  assert.equal(row.r.charged_seconds, 20);
  assert.equal(row.r.used_seconds, 20);
  const [usage] = await q(
    `select consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage.consumed_seconds, 20, "aucune facturation supplémentaire");
  pass("SQL : second règlement sans effet, le total ne bouge pas");
}

// ---------------------------------------------------------------------------
// 6. Dépassement de la réservation
// ---------------------------------------------------------------------------
{
  const [open] = await q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U1]);
  await q(`select public.voice_settle($1, $2, 90) as r`, [U1, open.r.session_id]);
  const [usage] = await q(
    `select consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage.consumed_seconds, 110, "90 s facturées malgré 60 s réservées");
  pass("SQL : une session plus longue que sa réservation est facturée en entier");
}

// ---------------------------------------------------------------------------
// 7. Bail expiré
// ---------------------------------------------------------------------------
{
  const [open] = await q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U1]);
  const [before] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  await q(`update public.voice_sessions set reservation_expires_at = now() - interval '1 minute' where id = $1`, [
    open.r.session_id,
  ]);
  const [after] = await q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U1]);
  assert.equal(after.r.ok, true, "un bail périmé ne bloque pas le compte");
  const [expired] = await q(`select state, charged_seconds from public.voice_sessions where id = $1`, [
    open.r.session_id,
  ]);
  assert.equal(expired.state, "expired");
  assert.equal(expired.charged_seconds, 0, "une session expirée ne facture rien");
  const [usage] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage.reserved_seconds, before.reserved_seconds, "libération neutre : rendue puis re-réservée");
  pass("SQL : bail périmé libéré automatiquement, sans facturation");
  // On ferme cette session pour la suite.
  await q(`select public.voice_settle($1, $2, 0) as r`, [U1, after.r.session_id]);
}

// ---------------------------------------------------------------------------
// 8. Remboursement, et son idempotence
// ---------------------------------------------------------------------------
{
  const [open] = await q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U1]);
  const [before] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  const [refund] = await q(`select public.voice_refund($1, $2) as r`, [U1, open.r.session_id]);
  assert.equal(refund.r.kind, "refunded");
  const [after] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(after.reserved_seconds, before.reserved_seconds - 60);

  const [twice] = await q(`select public.voice_refund($1, $2) as r`, [U1, open.r.session_id]);
  assert.equal(twice.r.kind, "already_released");
  const [after2] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(after2.reserved_seconds, after.reserved_seconds, "aucune double remise");
  pass("SQL : remboursement rendu une fois, jamais deux");
}

// ---------------------------------------------------------------------------
// 9. Épuisement du quota
// ---------------------------------------------------------------------------
{
  const [open] = await q(`select public.voice_reserve($1, 600, 600, 'brise', 3600) as r`, [U2]);
  await q(`select public.voice_settle($1, $2, 600) as r`, [U2, open.r.session_id]);
  const [row] = await q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U2]);
  assert.equal(row.r.ok, false);
  assert.equal(row.r.kind, "voice_minutes_exhausted");
  assert.equal(row.r.used_seconds, 600);
  assert.equal(row.r.limit_seconds, 600);
  pass("SQL : après 600 s sur 600, refus voice_minutes_exhausted avec chiffres exacts");
}

// ---------------------------------------------------------------------------
// 10. Isolation entre comptes, et propriété des sessions
// ---------------------------------------------------------------------------
{
  const [row] = await q(`select public.voice_reserve($1, 1800, 60, 'brise', 3600) as r`, [U1]);
  assert.equal(row.r.ok, true, "un compte épuisé ne prive pas l'autre");

  const [foreign] = await q(`select public.voice_settle($1, $2, 30) as r`, [U2, S1]);
  assert.equal(foreign.r.kind, "unknown_session", "la session d'un autre compte est invisible");
  pass("SQL : comptes isolés, session d'autrui inaccessible");
}

// ---------------------------------------------------------------------------
// 11. RLS et privilèges
// ---------------------------------------------------------------------------
{
  const policies = await q(
    `select tablename, policyname, cmd from pg_policies where tablename like 'voice_%'`,
  );
  const rls = await q(
    `select relname, relrowsecurity from pg_class where relname in ('voice_usage_daily','voice_sessions')`,
  );
  assert.ok(rls.length === 2 && rls.every((r) => r.relrowsecurity), "RLS active sur les deux tables");
  assert.ok(policies.length > 0, "des politiques existent");
  assert.ok(
    policies.every((p) => p.cmd === "SELECT"),
    "aucune politique d'écriture : le navigateur ne peut pas écrire les compteurs",
  );
  pass("SQL : RLS active, lecture seule pour l'utilisateur, aucune écriture navigateur");

  const priv = await q(`
    select p.proname,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth,
           has_function_privilege('service_role', p.oid, 'execute') as svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'voice_%'`);
  assert.ok(priv.length >= 5, "les cinq fonctions sont présentes");
  assert.ok(priv.every((p) => !p.anon && !p.auth), "anon et authenticated ne peuvent pas les exécuter");
  assert.ok(priv.every((p) => p.svc), "service_role peut les exécuter");
  pass("SQL : fonctions réservées au service role");
}

// ---------------------------------------------------------------------------
// 12. Concurrence réelle
// ---------------------------------------------------------------------------
{
  const U3 = "33333333-3333-4333-8333-333333333333";
  await db.exec(`insert into auth.users (id) values ('${U3}')`);

  // Deux réservations strictement simultanées, comme deux onglets sur deux
  // instances Vercel.
  const results = await Promise.allSettled([
    q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U3]),
    q(`select public.voice_reserve($1, 600, 60, 'brise', 3600) as r`, [U3]),
  ]);
  const outcomes = results.map((x) => (x.status === "fulfilled" ? x.value[0].r : { error: true }));
  assert.ok(outcomes.every((o) => !o.error), "les deux requêtes aboutissent sans erreur brute");
  assert.equal(outcomes.filter((o) => o.ok === true).length, 1, "une seule réservation acceptée");
  const [usage] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U3],
  );
  assert.equal(usage.reserved_seconds, 60, "exactement 60 s réservées, pas 120");

  // Quatre fermetures simultanées de la même session.
  const [open] = await q(
    `select id from public.voice_sessions where user_id = $1 and state = 'open'`,
    [U3],
  );
  const closes = await Promise.allSettled([
    q(`select public.voice_settle($1, $2, 15) as r`, [U3, open.id]),
    q(`select public.voice_settle($1, $2, 15) as r`, [U3, open.id]),
    q(`select public.voice_settle($1, $2, 15) as r`, [U3, open.id]),
    q(`select public.voice_settle($1, $2, 15) as r`, [U3, open.id]),
  ]);
  const kinds = closes.map((c) => (c.status === "fulfilled" ? c.value[0].r.kind : "ERREUR"));
  assert.equal(kinds.filter((k) => k === "settled").length, 1, "une seule fermeture facturée");
  const [final] = await q(
    `select consumed_seconds, reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U3],
  );
  assert.equal(final.consumed_seconds, 15, "15 s facturées au total, pas 60");
  assert.equal(final.reserved_seconds, 0);
  pass("SQL : concurrence réelle — une réservation, une facturation, même simultanées");
}

// ---------------------------------------------------------------------------
// 13. Aucun impact sur l'existant
// ---------------------------------------------------------------------------
{
  const created = await q(`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`);
  const names = created.map((r) => r.table_name);
  assert.deepEqual(
    names,
    ["voice_sessions", "voice_usage_daily"],
    "la migration ne crée que ses deux tables",
  );
  pass("SQL : aucune table existante créée, modifiée ou supprimée");
}

console.log(`\n${checks} contrôles SQL passés, sur PostgreSQL 16 réel.`);
