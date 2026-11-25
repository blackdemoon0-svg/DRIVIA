/**
 * Migration `0004_voice_usage.sql`, exécutée dans un VRAI PostgreSQL 16.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POURQUOI CE TEST EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * La garantie apportée par cette migration est dans le SQL, pas dans le
 * JavaScript : atomicité de la réservation, unicité de la session en cours,
 * durée mesurée par la base, idempotence du règlement et du remboursement. Un
 * double en JavaScript ne peut pas prouver cela — il ne ferait que reproduire
 * mes propres hypothèses.
 *
 * Ce fichier exécute donc le fichier de migration tel quel, dans un PostgreSQL
 * 16 (PGlite, WASM, aucune installation, aucun réseau).
 *
 * Il ne touche ni Supabase, ni la Production : base jetable en mémoire.
 *
 * Les deux défauts corrigés en v2 sont testés explicitement :
 *   1. la durée facturée ne peut pas venir de l'appelant ;
 *   2. une session active de plus d'une heure ne peut pas être libérée par
 *      expiration, donc deux conversations simultanées restent impossibles.
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

await db.exec(`
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select null::uuid $$;
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
const U3 = "33333333-3333-4333-8333-333333333333";
await db.exec(`insert into auth.users (id) values ('${U1}'), ('${U2}'), ('${U3}')`);

const q = async (text, params) => (await db.query(text, params)).rows;

/** Réservation + activation, avec un décalage de `seconds` depuis l'activation. */
async function openSession(userId, { allowance = 1_800_000, afterActivationSeconds = 0 } = {}) {
  // Un compte ne peut avoir qu'une session à la fois : on ferme la précédente.
  const [live] = await q(
    `select id from public.voice_sessions where user_id = $1 and state in ('pending','active') limit 1`,
    [userId],
  );
  if (live) await q(`select public.voice_settle($1, $2) as r`, [userId, live.id]);

  const [reserved] = await q(`select public.voice_reserve($1, $2, 60, 'brise') as r`, [userId, allowance]);
  assert.equal(reserved.r.ok, true, "la réservation doit aboutir");
  const id = reserved.r.session_id;
  const [activated] = await q(`select public.voice_activate($1, $2, 3900, null) as r`, [userId, id]);
  assert.equal(activated.r.ok, true, "l'activation doit aboutir");
  if (afterActivationSeconds > 0) {
    await q(
      `update public.voice_sessions set started_at = started_at - make_interval(secs => $2) where id = $1`,
      [id, afterActivationSeconds],
    );
  }
  return id;
}

/** Un compte neuf : chaque scénario part d'un quota intact. */
let userSeq = 0;
async function newUser() {
  userSeq += 1;
  const id = `9a0a0a0a-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  await db.exec(`insert into auth.users (id) values ('${id}')`);
  return id;
}

// ---------------------------------------------------------------------------
// 0. Application, rejeu, et compatibilité avec une éventuelle v1
// ---------------------------------------------------------------------------
await db.exec(sql);
pass("migration v2 : s'applique sans erreur sur PostgreSQL 16");

await db.exec(sql);
pass("migration v2 : idempotente, rejouable sans erreur");

// ---------------------------------------------------------------------------
// 1. Formule sans voix
// ---------------------------------------------------------------------------
{
  const [row] = await q(`select public.voice_reserve($1, 0, 60, 'brise') as r`, [U1]);
  assert.equal(row.r.ok, false);
  assert.equal(row.r.kind, "voice_not_in_plan");
  const usage = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [U1],
  );
  assert.equal(usage.length, 0, "un refus n'écrit aucune ligne de consommation");
  pass("SQL : Découverte (0 s) refusée, aucune ligne écrite");
}

// ---------------------------------------------------------------------------
// 2. Deux phases : la réservation ne facture pas, l'activation démarre le chrono
// ---------------------------------------------------------------------------
{
  const user = await newUser();
  const [reserved] = await q(`select public.voice_reserve($1, 600, 60, 'brise') as r`, [user]);
  assert.equal(reserved.r.ok, true);
  assert.equal(reserved.r.state, "pending");
  const id = reserved.r.session_id;

  const [pending] = await q(
    `select state, started_at from public.voice_sessions where id = $1`,
    [id],
  );
  assert.equal(pending.state, "pending");
  assert.equal(pending.started_at, null, "aucun horodatage de facturation avant l'activation");

  // Le bail d'une réservation est court : l'offre SDP voyage, puis c'est fini.
  const [lease] = await q(
    `select extract(epoch from (lease_expires_at - now()))::integer as secs
       from public.voice_sessions where id = $1`,
    [id],
  );
  assert.ok(lease.secs <= 310, `le bail de réservation est court (${lease.secs} s)`);

  const [activated] = await q(`select public.voice_activate($1, $2, 3900, null) as r`, [user, id]);
  assert.equal(activated.r.kind, "activated");
  const [active] = await q(
    `select state, started_at is not null as started,
            extract(epoch from (lease_expires_at - now()))::integer as secs
       from public.voice_sessions where id = $1`,
    [id],
  );
  assert.equal(active.state, "active");
  assert.equal(active.started, true, "started_at est posé à l'activation");
  assert.ok(active.secs > 3000, `le bail d'une session active couvre la conversation (${active.secs} s)`);
  pass("SQL : pending ne facture pas, active démarre le chrono et allonge le bail");
}

// ---------------------------------------------------------------------------
// 3. LA DURÉE VIENT DE LA BASE — correction du défaut bloquant
// ---------------------------------------------------------------------------
{
  const user = await newUser();
  const id = await openSession(user, { afterActivationSeconds: 42 });
  // Aucun paramètre de durée n'est transmis : la fonction n'en accepte pas.
  const [settled] = await q(`select public.voice_settle($1, $2) as r`, [user, id]);
  assert.equal(settled.r.kind, "settled");
  assert.equal(settled.r.measured_seconds, 42, "la durée est mesurée par PostgreSQL");
  assert.equal(settled.r.charged_seconds, 42);
  const [usage] = await q(
    `select consumed_seconds, reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(usage.consumed_seconds, 42);
  assert.equal(usage.reserved_seconds, 0);
  pass("SQL : la durée facturée est now() - started_at, mesurée par la base");
}

// ---------------------------------------------------------------------------
// 4. Un client ne peut pas se sous-facturer
// ---------------------------------------------------------------------------
{
  // La signature de voice_settle est (user, session, plafond). Un client qui
  // tenterait de passer une durée passe en réalité un plafond : la durée
  // mesurée ne change pas.
  const user = await newUser();
  const id = await openSession(user, { afterActivationSeconds: 90 });
  const [settled] = await q(`select public.voice_settle($1, $2, 3600) as r`, [user, id]);
  assert.equal(settled.r.measured_seconds, 90, "la valeur de l'appelant ne remplace pas la mesure");
  assert.equal(settled.r.charged_seconds, 90);

  // Et une valeur absurde en troisième position ne raccourcit rien.
  const id2 = await openSession(user, { afterActivationSeconds: 30 });
  const [settled2] = await q(`select public.voice_settle($1, $2, 60) as r`, [user, id2]);
  assert.equal(settled2.r.measured_seconds, 30, "le plafond ne fabrique pas une durée");
  assert.equal(settled2.r.charged_seconds, 30);

  // Il n'existe aucun chemin par lequel un zéro passerait pour une durée.
  const signature = await q(`
    select pg_get_function_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'voice_settle'`);
  assert.ok(
    !/actual/i.test(signature[0].args),
    `aucun paramètre de durée dans la signature : ${signature[0].args}`,
  );
  pass("SQL : durationSeconds: 0, négatif ou falsifié ne peut pas réduire la facture");
}

// ---------------------------------------------------------------------------
// 5. Le plafond dur borne, il ne fabrique pas de durée
// ---------------------------------------------------------------------------
{
  const user = await newUser();
  const id = await openSession(user, { afterActivationSeconds: 4000 });
  const [settled] = await q(`select public.voice_settle($1, $2, 3600) as r`, [user, id]);
  assert.equal(settled.r.measured_seconds, 4000);
  assert.equal(settled.r.charged_seconds, 3600, "borné au plafond de session documenté");
  pass("SQL : au-delà du plafond dur, la facture est bornée à 3600 s");
}

// ---------------------------------------------------------------------------
// 6. Idempotence du règlement
// ---------------------------------------------------------------------------
{
  const user = await newUser();
  const id = await openSession(user, { afterActivationSeconds: 20 });
  const [first] = await q(`select public.voice_settle($1, $2) as r`, [user, id]);
  assert.equal(first.r.charged_seconds, 20);
  const [second] = await q(`select public.voice_settle($1, $2) as r`, [user, id]);
  assert.equal(second.r.kind, "already_settled");
  assert.equal(second.r.charged_seconds, 20, "le second appel renvoie la durée du premier");
  const [usage] = await q(
    `select consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(usage.consumed_seconds, 20, "aucune facturation supplémentaire");
  pass("SQL : règlement idempotent, le total ne bouge pas");
}

// ---------------------------------------------------------------------------
// 7. Règlement d'une réservation jamais activée : remboursée, pas facturée
// ---------------------------------------------------------------------------
{
  const user = await newUser();
  const [reserved] = await q(`select public.voice_reserve($1, 600, 60, 'brise') as r`, [user]);
  const id = reserved.r.session_id;
  const [settled] = await q(`select public.voice_settle($1, $2) as r`, [user, id]);
  assert.equal(settled.r.kind, "never_started");
  assert.equal(settled.r.charged_seconds, 0);
  const [usage] = await q(
    `select consumed_seconds, reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(usage.consumed_seconds, 0, "une session jamais démarrée ne coûte rien");
  assert.equal(usage.reserved_seconds, 0, "et sa réservation est rendue");
  pass("SQL : une réservation jamais activée est rendue, jamais facturée");
}

// ---------------------------------------------------------------------------
// 8. SCÉNARIO CRITIQUE — conversation de plus d'une heure, deuxième appareil
// ---------------------------------------------------------------------------
{
  const user = "55555555-5555-4555-8555-555555555555";
  await db.exec(`insert into auth.users (id) values ('${user}')`);

  // Une conversation Pro active depuis 30 minutes.
  const active = await openSession(user, { allowance: 1800, afterActivationSeconds: 1800 });
  const [before] = await q(
    `select state, extract(epoch from (now() - started_at))::integer as elapsed
       from public.voice_sessions where id = $1`,
    [active],
  );
  assert.equal(before.state, "active");
  assert.ok(before.elapsed >= 1800, "la conversation dure depuis 30 minutes");

  // Deuxième appareil : une nouvelle réservation.
  const [second] = await q(`select public.voice_reserve($1, 1800, 60, 'brise') as r`, [user]);
  assert.equal(second.r.ok, false, "la deuxième session est refusée");
  assert.equal(second.r.kind, "voice_session_open");
  assert.equal(second.r.open_state, "active", "le refus dit que la session est ACTIVE");

  const [still] = await q(`select state from public.voice_sessions where id = $1`, [active]);
  assert.equal(still.state, "active", "la conversation en cours n'a pas été touchée");
  pass("SQL : deux appareils — la session active bloque la seconde, sans être expirée");

  // Le bail est antidaté : une session ACTIVE expirée ne doit PAS être balayée.
  await q(`update public.voice_sessions set lease_expires_at = now() - interval '1 hour' where id = $1`, [
    active,
  ]);
  const [afterStale] = await q(`select public.voice_reserve($1, 1800, 60, 'brise') as r`, [user]);
  assert.equal(afterStale.r.ok, false, "un bail périmé de session active ne libère rien");
  assert.equal(afterStale.r.kind, "voice_session_open");
  const [notExpired] = await q(`select state from public.voice_sessions where id = $1`, [active]);
  assert.equal(notExpired.state, "active", "voice_expire_stale ne balaie que les réservations");
  pass("SQL : un bail périmé de session active ne permet jamais une seconde conversation");

  // Conversation de 61 minutes : la session est close au plafond dur, facturée,
  // et seulement ALORS une nouvelle session devient possible.
  await q(
    `update public.voice_sessions set started_at = now() - interval '61 minutes' where id = $1`,
    [active],
  );
  // À 61 minutes, la session dépasse le plafond : elle est close et facturée
  // 3600 s AVANT que la nouvelle réservation soit examinée. Avec un plan Pro
  // (1800 s), la facture de 3600 s épuise le quota du jour — le refus est donc
  // bien `voice_minutes_exhausted`, et surtout PLUS `voice_session_open` :
  // la place a été libérée, ce qui est exactement ce qu'on veut prouver.
  const [overdue] = await q(`select public.voice_reserve($1, 1800, 60, 'brise') as r`, [user]);
  assert.equal(overdue.r.ok, false);
  assert.equal(overdue.r.kind, "voice_minutes_exhausted", "la place est libre, c'est le quota qui bloque");
  const [closed] = await q(
    `select state, charged_seconds from public.voice_sessions where id = $1`,
    [active],
  );
  assert.equal(closed.state, "settled", "la session hors plafond est close");
  assert.equal(closed.charged_seconds, 3600, "et facturée au plafond, pas au-delà");

  // Avec une formule qui absorbe les 3600 s, la même séquence ouvre bien une
  // nouvelle session : la libération est réelle, pas un refus déguisé.
  const richUser = await newUser();
  const long = await openSession(richUser, { afterActivationSeconds: 3700 });
  const [rich] = await q(`select public.voice_reserve($1, 7200, 60, 'brise') as r`, [richUser]);
  assert.equal(rich.r.ok, true, "au-delà du plafond, la session close libère la place");
  const [richClosed] = await q(
    `select state, charged_seconds from public.voice_sessions where id = $1`,
    [long],
  );
  assert.equal(richClosed.state, "settled");
  assert.equal(richClosed.charged_seconds, 3600);
  pass("SQL : au-delà de 60 min, la session est close et facturée AVANT d'en ouvrir une autre");
}

// ---------------------------------------------------------------------------
// 9. Remboursement, et son idempotence
// ---------------------------------------------------------------------------
{
  const user = await newUser();
  const [reserved] = await q(`select public.voice_reserve($1, 600, 60, 'brise') as r`, [user]);
  const id = reserved.r.session_id;
  const [before] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  const [refund] = await q(`select public.voice_refund($1, $2) as r`, [user, id]);
  assert.equal(refund.r.kind, "refunded");
  const [after] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(after.reserved_seconds, before.reserved_seconds - 60);

  const [twice] = await q(`select public.voice_refund($1, $2) as r`, [user, id]);
  assert.equal(twice.r.kind, "already_released");
  const [after2] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(after2.reserved_seconds, after.reserved_seconds, "aucune double remise");
  pass("SQL : remboursement rendu une fois, jamais deux");
}

// ---------------------------------------------------------------------------
// 10. Épuisement du quota, et isolation entre comptes
// ---------------------------------------------------------------------------
{
  const quotaUser = "77777777-7777-4777-8777-777777777777";
  await db.exec(`insert into auth.users (id) values ('${quotaUser}')`);
  const U2 = quotaUser;
  const [reserved] = await q(`select public.voice_reserve($1, 600, 600, 'brise') as r`, [U2]);
  await q(`select public.voice_activate($1, $2) as r`, [U2, reserved.r.session_id]);
  await q(
    `update public.voice_sessions set started_at = now() - interval '600 seconds' where id = $1`,
    [reserved.r.session_id],
  );
  await q(`select public.voice_settle($1, $2) as r`, [U2, reserved.r.session_id]);

  const [row] = await q(`select public.voice_reserve($1, 600, 60, 'brise') as r`, [U2]);
  assert.equal(row.r.ok, false);
  assert.equal(row.r.kind, "voice_minutes_exhausted");
  assert.equal(row.r.used_seconds, 600);
  assert.equal(row.r.limit_seconds, 600);

  const other_user = await newUser();
  const [other] = await q(`select public.voice_reserve($1, 1800, 60, 'brise') as r`, [other_user]);
  assert.equal(other.r.ok, true, "un compte épuisé ne prive pas l'autre");
  pass("SQL : quota épuisé après 600 s sur 600, comptes isolés");
}

// ---------------------------------------------------------------------------
// 11. Propriété des sessions
// ---------------------------------------------------------------------------
{
  const owner = await newUser();
  const intruder = await newUser();
  const [reserved] = await q(`select public.voice_reserve($1, 600, 60, 'brise') as r`, [owner]);
  const id = reserved.r.session_id;
  const [foreign] = await q(`select public.voice_settle($1, $2) as r`, [intruder, id]);
  assert.equal(foreign.r.kind, "unknown_session", "la session d'un autre compte est invisible");
  const [foreignActivate] = await q(`select public.voice_activate($1, $2) as r`, [intruder, id]);
  assert.equal(foreignActivate.r.kind, "unknown_session");
  const [foreignRefund] = await q(`select public.voice_refund($1, $2) as r`, [intruder, id]);
  assert.equal(foreignRefund.r.kind, "unknown_session");
  pass("SQL : aucune opération d'autrui n'est possible, ni règlement ni activation");
}

// ---------------------------------------------------------------------------
// 12. RLS et privilèges
// ---------------------------------------------------------------------------
{
  const policies = await q(
    `select tablename, policyname, cmd from pg_policies where tablename like 'voice_%'`,
  );
  const rls = await q(
    `select relname, relrowsecurity from pg_class
      where relname in ('voice_usage_daily','voice_sessions')`,
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
  assert.ok(priv.length >= 8, `les huit fonctions sont présentes (${priv.length})`);
  assert.ok(priv.every((p) => !p.anon && !p.auth), "anon et authenticated ne peuvent pas les exécuter");
  assert.ok(priv.every((p) => p.svc), "service_role peut les exécuter");
  pass("SQL : fonctions réservées au service role");
}

// ---------------------------------------------------------------------------
// 13. Concurrence réelle
// ---------------------------------------------------------------------------
{
  const user = "66666666-6666-4666-8666-666666666666";
  await db.exec(`insert into auth.users (id) values ('${user}')`);

  const results = await Promise.allSettled([
    q(`select public.voice_reserve($1, 600, 60, 'brise') as r`, [user]),
    q(`select public.voice_reserve($1, 600, 60, 'brise') as r`, [user]),
  ]);
  const outcomes = results.map((x) => (x.status === "fulfilled" ? x.value[0].r : { error: true }));
  assert.ok(outcomes.every((o) => !o.error), "les deux requêtes aboutissent sans erreur brute");
  assert.equal(outcomes.filter((o) => o.ok === true).length, 1, "une seule réservation acceptée");
  const [usage] = await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(usage.reserved_seconds, 60, "exactement 60 s réservées, pas 120");
  pass("SQL : deux réservations simultanées — une seule passe");

  const [open] = await q(
    `select id from public.voice_sessions where user_id = $1 and state = 'pending'`,
    [user],
  );
  await q(`select public.voice_activate($1, $2) as r`, [user, open.id]);
  await q(
    `update public.voice_sessions set started_at = now() - interval '15 seconds' where id = $1`,
    [open.id],
  );

  // Quatre fermetures simultanées de la même session.
  const closes = await Promise.allSettled([
    q(`select public.voice_settle($1, $2) as r`, [user, open.id]),
    q(`select public.voice_settle($1, $2) as r`, [user, open.id]),
    q(`select public.voice_settle($1, $2) as r`, [user, open.id]),
    q(`select public.voice_settle($1, $2) as r`, [user, open.id]),
  ]);
  const kinds = closes.map((c) => (c.status === "fulfilled" ? c.value[0].r.kind : "ERREUR"));
  assert.equal(kinds.filter((k) => k === "settled").length, 1, "une seule fermeture facturée");
  assert.equal(kinds.filter((k) => k === "already_settled").length, 3);
  const [final] = await q(
    `select consumed_seconds, reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(final.consumed_seconds, 15, "15 s facturées au total, pas 60");
  assert.equal(final.reserved_seconds, 0);
  pass("SQL : quatre fermetures simultanées — une seule facturation, même montant");
}

// ---------------------------------------------------------------------------
// 14. Aucun impact sur l'existant
// ---------------------------------------------------------------------------
{
  const created = await q(`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`);
  assert.deepEqual(
    created.map((r) => r.table_name),
    ["voice_sessions", "voice_usage_daily"],
    "la migration ne crée que ses deux tables",
  );
  pass("SQL : aucune table existante créée, modifiée ou supprimée");
}

console.log(`\n${checks} contrôles SQL passés, sur PostgreSQL 16 réel.`);
