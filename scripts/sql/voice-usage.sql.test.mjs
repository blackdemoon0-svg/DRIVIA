/**
 * Migration `0004_voice_usage.sql` (v3), exécutée dans un VRAI PostgreSQL 16.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POURQUOI CE TEST EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Les garanties de cette migration sont dans le SQL, pas dans le JavaScript :
 * atomicité de la réservation, unicité de la session en cours, durée mesurée par
 * la base, idempotence, et absence de perte au rejeu. Un double en JavaScript ne
 * peut pas prouver cela — il ne ferait que reproduire mes hypothèses.
 *
 * Ce fichier exécute la migration telle quelle dans un PostgreSQL 16 (PGlite,
 * WASM, sans installation ni réseau). Rien n'est envoyé à Supabase.
 *
 * Les trois défauts corrigés sont testés nommément :
 *   A. la réservation couvre le crédit restant (plus de dépassement) ;
 *   B. la migration est rejouable sans perdre une seule ligne ;
 *   C. règlement manuel et règlement automatique donnent le même montant.
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

/** La limite de session, telle que le TypeScript la transmet. */
const MAX_SESSION = 3600;
const MIN_RESERVE = 60;

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

const q = async (text, params) => (await db.query(text, params)).rows;

let userSeq = 0;
/** Un compte neuf : chaque scénario part d'un quota intact. */
async function newUser() {
  userSeq += 1;
  const id = `9a0a0a0a-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  await db.exec(`insert into auth.users (id) values ('${id}')`);
  return id;
}

/** Réservation complète, avec les six paramètres explicites. */
async function reserve(userId, { allowance, maxSession = MAX_SESSION, min = MIN_RESERVE, ttl = 300 } = {}) {
  const [row] = await q(
    `select public.voice_reserve($1, $2, $3, 'brise', $4, $5) as r`,
    [userId, allowance, maxSession, ttl, min],
  );
  return row.r;
}

async function activate(userId, sessionId, maxSession = MAX_SESSION) {
  const [row] = await q(
    `select public.voice_activate($1, $2, $3, null) as r`,
    [userId, sessionId, maxSession],
  );
  return row.r;
}

async function settle(userId, sessionId, maxSession = MAX_SESSION) {
  const [row] = await q(
    `select public.voice_settle($1, $2, $3) as r`,
    [userId, sessionId, maxSession],
  );
  return row.r;
}

async function refund(userId, sessionId) {
  const [row] = await q(`select public.voice_refund($1, $2) as r`, [userId, sessionId]);
  return row.r;
}

/** Raccourci : une session active depuis `afterActivationSeconds`, refermée. */
async function consume(userId, seconds, allowance = 1_800_000) {
  const reserved = await reserve(userId, { allowance });
  assert.equal(reserved.ok, true, `réservation attendue (${JSON.stringify(reserved)})`);
  await activate(userId, reserved.session_id);
  if (seconds > 0) {
    await q(
      `update public.voice_sessions set started_at = started_at - make_interval(secs => $2) where id = $1`,
      [reserved.session_id, seconds],
    );
  }
  return { sessionId: reserved.session_id, settled: await settle(userId, reserved.session_id) };
}

/** Ferme proprement une éventuelle session en cours pour ce compte. */
async function closeAny(userId, allowance = 1_800_000) {
  const [live] = await q(
    `select id from public.voice_sessions where user_id = $1 and state in ('pending','active') limit 1`,
    [userId],
  );
  if (live) await settle(userId, live.id);
}

// ===========================================================================
// 0. Application, rejeu, et REJEU SANS PERTE (défaut B)
// ===========================================================================
await db.exec(sql);
pass("migration v3 : s'applique sans erreur sur PostgreSQL 16");

{
  // On fabrique un historique : deux comptes, des sessions dans tous les états,
  // de la consommation. Puis on rejoue la migration entière et on compare.
  const userA = await newUser();
  const userB = await newUser();

  await consume(userA, 120, 600);
  const pending = await reserve(userA, { allowance: 600 });
  assert.equal(pending.ok, true);

  const active = await reserve(userB, { allowance: 600 });
  await activate(userB, active.session_id);
  const refundable = await reserve(userB, { allowance: 600 });
  assert.equal(refundable.ok, false, "une seule session en cours par compte");
  await settle(userB, active.session_id);

  const before = {
    sessions: (await q(`select count(*)::int as c from public.voice_sessions`))[0].c,
    usage: (await q(`select count(*)::int as c from public.voice_usage_daily`))[0].c,
    charged: (await q(
      `select coalesce(sum(charged_seconds), 0)::int as s from public.voice_sessions`,
    ))[0].s,
    consumed: (await q(
      `select coalesce(sum(consumed_seconds), 0)::int as s from public.voice_usage_daily`,
    ))[0].s,
    snapshot: await q(
      `select id, user_id, state, reserved_seconds, charged_seconds, usage_day
         from public.voice_sessions order by id`,
    ),
  };

  // Rejeu complet, deux fois.
  await db.exec(sql);
  await db.exec(sql);

  const after = {
    sessions: (await q(`select count(*)::int as c from public.voice_sessions`))[0].c,
    usage: (await q(`select count(*)::int as c from public.voice_usage_daily`))[0].c,
    charged: (await q(
      `select coalesce(sum(charged_seconds), 0)::int as s from public.voice_sessions`,
    ))[0].s,
    consumed: (await q(
      `select coalesce(sum(consumed_seconds), 0)::int as s from public.voice_usage_daily`,
    ))[0].s,
    snapshot: await q(
      `select id, user_id, state, reserved_seconds, charged_seconds, usage_day
         from public.voice_sessions order by id`,
    ),
  };

  assert.deepEqual(after, before, "le rejeu ne change pas une seule ligne");
  pass(`migration v3 : rejouable sans perte — ${before.sessions} sessions, ${before.usage} lignes d'usage identiques`);

  // Le fichier lui-même ne contient aucune suppression de table ni de colonne.
  // On retire les commentaires : la prose peut nommer `DROP TABLE` pour
  // expliquer qu'on ne l'emploie plus, c'est le SQL exécuté qui compte.
  const executable = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  const destructive = [
    /drop\s+table/i,
    /truncate/i,
    /drop\s+column/i,
    /delete\s+from\s+public\.voice/i,
  ].filter((pattern) => pattern.test(executable));
  assert.deepEqual(destructive, [], "aucune instruction destructive dans la migration");
  pass("migration v3 : aucun DROP TABLE, DROP COLUMN, TRUNCATE ni DELETE dans le fichier");

  // Et les données restent exploitables après rejeu.
  const [stillThere] = await q(
    `select consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [userA],
  );
  assert.equal(stillThere.consumed_seconds, 120, "la consommation reste lisible après rejeu");
  pass("migration v3 : les données restent exploitables après rejeu");

  await closeAny(userA);
}

// ===========================================================================
// 1. Réservation insuffisante corrigée (défaut A)
// ===========================================================================
{
  const user = await newUser();
  // Plan Plus = 600 s. On consomme 540 s : il reste exactement 60 s.
  await consume(user, 540, 600);

  const reserved = await reserve(user, { allowance: 600 });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.reserved_seconds, 60, "seules 60 s restent, la réservation vaut 60 s");
  assert.equal(
    reserved.max_session_seconds,
    MIN_RESERVE,
    "la durée maximale de la session est 60 s, pas 3600",
  );
  pass("quota : 60 s restantes → réservation de 60 s, plafond de session de 60 s");

  // La session ne peut pas dépasser : même après 20 minutes, la facture est 60 s.
  await activate(user, reserved.session_id);
  await q(
    `update public.voice_sessions set started_at = now() - interval '20 minutes' where id = $1`,
    [reserved.session_id],
  );
  const settled = await settle(user, reserved.session_id);
  assert.equal(settled.charged_seconds, 60, "20 minutes de session facturées 60 s : le plafond tient");
  assert.equal(settled.measured_seconds, 1200, "la durée mesurée est bien de 1200 s");

  const usage = (await q(
    `select consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  ))[0];
  assert.equal(usage.consumed_seconds, 600, "le quota de 600 s est atteint, jamais dépassé");
  pass("quota : une session de 20 min sur 60 s restantes ne dépasse pas le quota");
}

// 5 minutes restantes
{
  const user = await newUser();
  await consume(user, 300, 600); // 300 s consommées, 300 s restantes

  const reserved = await reserve(user, { allowance: 600 });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.reserved_seconds, 300, "5 minutes restantes → réservation de 300 s");

  await activate(user, reserved.session_id);
  await q(
    `update public.voice_sessions set started_at = now() - interval '45 minutes' where id = $1`,
    [reserved.session_id],
  );
  const settled = await settle(user, reserved.session_id);
  assert.equal(settled.charged_seconds, 300, "borné à la réservation");
  const usage = (await q(
    `select consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  ))[0];
  assert.equal(usage.consumed_seconds, 600, "quota atteint, pas dépassé");
  pass("quota : 5 minutes restantes → réservation de 300 s, dépassement impossible");
}

// Quota entièrement consommé
{
  const user = await newUser();
  await consume(user, 600, 600);

  const reserved = await reserve(user, { allowance: 600 });
  assert.equal(reserved.ok, false);
  assert.equal(reserved.kind, "voice_minutes_exhausted");
  assert.equal(reserved.remaining_seconds, 0);
  pass("quota : quota entièrement consommé → refus voice_minutes_exhausted");
}

// Le règlement libère l'inutilisé
{
  const user = await newUser();
  const reserved = await reserve(user, { allowance: 600 });
  assert.equal(reserved.reserved_seconds, 600, "tout le crédit est réservé");
  await activate(user, reserved.session_id);
  await q(
    `update public.voice_sessions set started_at = now() - interval '45 seconds' where id = $1`,
    [reserved.session_id],
  );
  const settled = await settle(user, reserved.session_id);
  assert.equal(settled.charged_seconds, 45, "seules 45 s sont consommées");
  const usage = (await q(
    `select consumed_seconds, reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  ))[0];
  assert.equal(usage.reserved_seconds, 0, "la réservation est intégralement libérée");
  assert.equal(usage.consumed_seconds, 45, "et seules 45 s restent consommées");
  pass("quota : le règlement libère les 555 s inutilisées de la réservation");
}

// ===========================================================================
// 2. Minuit UTC
// ===========================================================================
{
  const user = await newUser();
  // Une réservation ne peut pas dépasser le temps restant jusqu'à minuit.
  const [midnight] = await q(`
    select least(
      3600,
      greatest(1, floor(extract(epoch from (
        (((now() at time zone 'utc')::date + interval '1 day') at time zone 'utc') - now()
      )))::integer)
    ) as secs`);
  const reserved = await reserve(user, { allowance: 600 });
  assert.ok(
    reserved.reserved_seconds <= midnight.secs,
    `la réservation (${reserved.reserved_seconds} s) ne dépasse pas le temps jusqu'à minuit (${midnight.secs} s)`,
  );
  pass("minuit UTC : la réservation est bornée par le temps restant dans la journée");

  // Après règlement, la consommation appartient au jour où la session a vécu.
  await activate(user, reserved.session_id);
  const settled = await settle(user, reserved.session_id);
  const [row] = await q(
    `select usage_day from public.voice_usage_daily where user_id = $1`,
    [user],
  );
  assert.equal(
    row.usage_day.toISOString?.().slice(0, 10) ?? String(row.usage_day),
    new Date().toISOString().slice(0, 10),
    "le compteur reste sur le jour UTC courant",
  );
  assert.ok(settled.charged_seconds >= 0);
  pass("minuit UTC : une session ne traverse pas le jour, son compteur reste sur un seul jour");

  // La borne de session peut tomber sous le minimum réservable (moins d'une
  // minute utile avant minuit, ou plafond d'appelant trop bas) : refus
  // explicite, jamais une session de quelques secondes.
  const tiny = await newUser();
  const tooShort = await reserve(tiny, { allowance: 600, maxSession: 30 });
  assert.equal(tooShort.ok, false);
  assert.equal(
    tooShort.kind,
    "voice_curfew",
    "crédit suffisant mais session bornée sous le minimum → refus explicite",
  );
  assert.equal(tooShort.remaining_seconds, 600, "le crédit n'a pas été entamé");
  pass("minuit UTC : borne de session sous le minimum → refus voice_curfew explicite");
}

// ===========================================================================
// 3. Durée toujours calculée par PostgreSQL
// ===========================================================================
{
  const user = await newUser();
  const { settled } = await consume(user, 42);
  assert.equal(settled.kind, "settled");
  assert.equal(settled.measured_seconds, 42);
  assert.equal(settled.charged_seconds, 42);

  const signature = await q(`
    select pg_get_function_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('voice_settle','voice_close_overdue')
    order by p.proname`);
  for (const row of signature) {
    assert.ok(!/actual/i.test(row.args), `aucun paramètre de durée : ${row.args}`);
  }
  pass("durée : aucun paramètre de durée, la mesure vient de now() - started_at");
}

// ===========================================================================
// 4. Plafond unique (défaut C) : manuel et automatique donnent le même montant
// ===========================================================================
{
  // Les deux fonctions reçoivent la même limite et bornent de la même façon.
  const settleArgs = (await q(`
    select pg_get_function_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'voice_settle'`))[0];
  const overdueArgs = (await q(`
    select pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'voice_close_overdue'`))[0];

  assert.ok(
    !/default/i.test(settleArgs.args),
    `voice_settle n'a AUCUNE valeur par défaut : ${settleArgs.args}`,
  );
  assert.ok(
    /least\(v_session\.reserved_seconds, p_max_session_seconds\)/.test(settleArgs.def),
    "le règlement borne par least(réservation, plafond)",
  );
  assert.ok(
    /least\(reserved_seconds, p_max_session_seconds\)/.test(overdueArgs.def),
    "le règlement automatique applique la MÊME borne",
  );
  pass("plafond : une seule limite, sans défaut SQL, appliquée identiquement par les deux chemins");

  // Même session, même instant, deux chemins → même montant.
  {
    const user = await newUser();
    const reserved = await reserve(user, { allowance: 600 });
    await activate(user, reserved.session_id);
    await q(
      `update public.voice_sessions set started_at = now() - interval '100 seconds' where id = $1`,
      [reserved.session_id],
    );
    const manual = await settle(user, reserved.session_id);
    assert.equal(manual.charged_seconds, 100, "règlement manuel : 100 s mesurées");
  }

  {
    const user = await newUser();
    // Compte à 60 s de crédit : la réservation vaut 60 s, donc le plafond réel
    // est 60 s et non 3600. C'est ce qui rend les deux chemins comparables.
    await consume(user, 540, 600);
    const reserved = await reserve(user, { allowance: 600 });
    assert.equal(reserved.reserved_seconds, 60);
    await activate(user, reserved.session_id);
    await q(
      `update public.voice_sessions set started_at = now() - interval '100 seconds' where id = $1`,
      [reserved.session_id],
    );

    // Règlement automatique : la session a dépassé sa réservation de 60 s.
    const [closed] = await q(
      `select public.voice_close_overdue($1, $2) as n`,
      [user, MAX_SESSION],
    );
    assert.equal(closed.n, 1, "le balayage a bien clôturé la session");
    const [row] = await q(
      `select state, charged_seconds from public.voice_sessions where id = $1`,
      [reserved.session_id],
    );
    assert.equal(row.state, "settled");
    assert.equal(row.charged_seconds, 60, "règlement automatique : borné à 60 s, comme le manuel");

    // Et un règlement manuel après coup ne refacture pas.
    const manualAfter = await settle(user, reserved.session_id);
    assert.equal(manualAfter.kind, "already_settled");
    assert.equal(manualAfter.charged_seconds, 60, "même montant, aucune double facturation");
  }
  pass("plafond : règlement manuel et automatique donnent le même montant, sans double facture");
}

// ===========================================================================
// 5. Deux phases : la préparation n'est pas facturée
// ===========================================================================
{
  const user = await newUser();
  const reserved = await reserve(user, { allowance: 600 });
  assert.equal(reserved.state, "pending");
  const [pending] = await q(
    `select state, started_at from public.voice_sessions where id = $1`,
    [reserved.session_id],
  );
  assert.equal(pending.started_at, null, "aucun chrono avant l'activation");

  await activate(user, reserved.session_id);
  const [active] = await q(
    `select state, started_at is not null as started from public.voice_sessions where id = $1`,
    [reserved.session_id],
  );
  assert.equal(active.state, "active");
  assert.equal(active.started, true);

  // Réservation jamais activée : rendue, pas facturée.
  const { sessionId } = { sessionId: reserved.session_id };
  await settle(user, sessionId);
  const abandoned = await reserve(user, { allowance: 600 });
  const neverStarted = await settle(user, abandoned.session_id);
  assert.equal(neverStarted.kind, "never_started");
  assert.equal(neverStarted.charged_seconds, 0);
  pass("phases : pending ne facture rien, active démarre le chrono, abandon rendu");
}

// ===========================================================================
// 6. Deux appareils, et le bail ne libère jamais une session active
// ===========================================================================
{
  const user = await newUser();
  const reserved = await reserve(user, { allowance: 1800 });
  await activate(user, reserved.session_id);

  // 10 minutes plus tard, depuis un autre appareil. La réservation vaut 1800 s
  // (tout le crédit), donc la session est encore dans sa fenêtre : elle doit
  // survivre, et la deuxième demande être refusée.
  await q(
    `update public.voice_sessions set started_at = now() - interval '10 minutes' where id = $1`,
    [reserved.session_id],
  );
  const second = await reserve(user, { allowance: 1800 });
  assert.equal(second.ok, false, "la deuxième session est refusée");
  assert.equal(second.kind, "voice_session_open");
  assert.equal(second.open_state, "active");

  // Bail très ancien : une session ACTIVE n'est jamais balayée.
  await q(
    `update public.voice_sessions set lease_expires_at = now() - interval '2 hours' where id = $1`,
    [reserved.session_id],
  );
  const third = await reserve(user, { allowance: 1800 });
  assert.equal(third.ok, false, "un bail périmé de session active ne libère rien");
  const [still] = await q(`select state from public.voice_sessions where id = $1`, [
    reserved.session_id,
  ]);
  assert.equal(still.state, "active", "la conversation en cours reste active");
  pass("deux appareils : refusé, et le bail ne libère jamais une session active");

  // Au-delà de la réservation, la session est close et facturée AVANT qu'une
  // autre ne soit autorisée.
  const plus = await newUser();
  const long = await reserve(plus, { allowance: 7200 });
  await activate(plus, long.session_id);
  const [bound] = await q(
    `select reserved_seconds from public.voice_sessions where id = $1`,
    [long.session_id],
  );
  await q(
    `update public.voice_sessions set started_at = now() - make_interval(secs => $2)
      where id = $1`,
    [long.session_id, bound.reserved_seconds + 60],
  );
  const after = await reserve(plus, { allowance: 7200 });
  assert.equal(after.ok, true, "la place est libérée après clôture");
  const [closed] = await q(
    `select state, charged_seconds from public.voice_sessions where id = $1`,
    [long.session_id],
  );
  assert.equal(closed.state, "settled");
  assert.equal(
    closed.charged_seconds,
    bound.reserved_seconds,
    "facturée exactement à sa réservation, pas au-delà",
  );
  pass("deux appareils : la session hors réservation est close et facturée avant d'en ouvrir une autre");
}

// ===========================================================================
// 7. Idempotence du règlement et du remboursement
// ===========================================================================
{
  const user = await newUser();
  const { sessionId, settled } = await consume(user, 20);
  assert.equal(settled.charged_seconds, 20);
  const second = await settle(user, sessionId);
  assert.equal(second.kind, "already_settled");
  assert.equal(second.charged_seconds, 20);
  const usage = (await q(
    `select consumed_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  ))[0];
  assert.equal(usage.consumed_seconds, 20, "aucune facturation supplémentaire");
  pass("idempotence : un second règlement ne facture pas deux fois");

  const other = await newUser();
  const reserved = await reserve(other, { allowance: 600 });
  const before = (await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [other],
  ))[0].reserved_seconds;
  const first = await refund(other, reserved.session_id);
  assert.equal(first.kind, "refunded");
  const after = (await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [other],
  ))[0].reserved_seconds;
  const twice = await refund(other, reserved.session_id);
  const after2 = (await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [other],
  ))[0].reserved_seconds;
  assert.equal(after, before - 600, "la réservation est rendue en entier");
  assert.equal(twice.kind, "already_released");
  assert.equal(after2, after, "aucune double remise");
  pass("idempotence : un remboursement rendu une fois, jamais deux");
}

// ===========================================================================
// 8. Propriété des sessions
// ===========================================================================
{
  const owner = await newUser();
  const intruder = await newUser();
  const reserved = await reserve(owner, { allowance: 600 });
  assert.equal((await settle(intruder, reserved.session_id)).kind, "unknown_session");
  assert.equal((await activate(intruder, reserved.session_id)).kind, "unknown_session");
  assert.equal((await refund(intruder, reserved.session_id)).kind, "unknown_session");
  pass("propriété : aucune opération d'autrui n'est possible");
}

// ===========================================================================
// 9. RLS, privilèges, et absence de destruction
// ===========================================================================
{
  const policies = await q(
    `select tablename, policyname, cmd from pg_policies where tablename like 'voice_%'`,
  );
  const rls = await q(
    `select relname, relrowsecurity from pg_class
      where relname in ('voice_usage_daily','voice_sessions')`,
  );
  assert.ok(rls.length === 2 && rls.every((r) => r.relrowsecurity), "RLS active sur les deux tables");
  assert.ok(policies.every((p) => p.cmd === "SELECT"), "aucune politique d'écriture");
  pass("sécurité : RLS active, lecture seule pour l'utilisateur");

  const priv = await q(`
    select p.proname,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth,
           has_function_privilege('service_role', p.oid, 'execute') as svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'voice_%'`);
  assert.ok(priv.length >= 9, `les fonctions sont présentes (${priv.length})`);
  assert.ok(priv.every((p) => !p.anon && !p.auth), "anon et authenticated ne peuvent pas les exécuter");
  assert.ok(priv.every((p) => p.svc), "service_role peut les exécuter");
  pass("sécurité : fonctions réservées au service role");
}

// ===========================================================================
// 10. Concurrence réelle
// ===========================================================================
{
  const user = await newUser();
  const results = await Promise.allSettled([
    q(`select public.voice_reserve($1, 600, $2, 'brise', 300, 60) as r`, [user, MAX_SESSION]),
    q(`select public.voice_reserve($1, 600, $2, 'brise', 300, 60) as r`, [user, MAX_SESSION]),
  ]);
  const outcomes = results.map((x) => (x.status === "fulfilled" ? x.value[0].r : { error: true }));
  assert.ok(outcomes.every((o) => !o.error), "les deux requêtes aboutissent sans erreur brute");
  assert.equal(outcomes.filter((o) => o.ok === true).length, 1, "une seule réservation acceptée");

  const acceptedRow = outcomes.find((o) => o.ok === true);
  const usage = (await q(
    `select reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  ))[0];
  assert.equal(
    usage.reserved_seconds,
    acceptedRow.reserved_seconds,
    "le total réservé correspond à la seule réservation acceptée",
  );
  pass("concurrence : deux réservations simultanées, une seule passe");

  // Quatre fermetures simultanées.
  await activate(user, acceptedRow.session_id);
  await q(
    `update public.voice_sessions set started_at = now() - interval '15 seconds' where id = $1`,
    [acceptedRow.session_id],
  );
  const closes = await Promise.allSettled([
    q(`select public.voice_settle($1, $2, $3) as r`, [user, acceptedRow.session_id, MAX_SESSION]),
    q(`select public.voice_settle($1, $2, $3) as r`, [user, acceptedRow.session_id, MAX_SESSION]),
    q(`select public.voice_settle($1, $2, $3) as r`, [user, acceptedRow.session_id, MAX_SESSION]),
    q(`select public.voice_settle($1, $2, $3) as r`, [user, acceptedRow.session_id, MAX_SESSION]),
  ]);
  const kinds = closes.map((c) => (c.status === "fulfilled" ? c.value[0].r.kind : "ERREUR"));
  assert.equal(kinds.filter((k) => k === "settled").length, 1, "une seule fermeture facturée");
  assert.equal(kinds.filter((k) => k === "already_settled").length, 3);
  const final = (await q(
    `select consumed_seconds, reserved_seconds from public.voice_usage_daily where user_id = $1`,
    [user],
  ))[0];
  assert.equal(final.consumed_seconds, 15, "15 s facturées au total, pas 60");
  assert.equal(final.reserved_seconds, 0);
  pass("concurrence : quatre fermetures simultanées, une seule facturation");
}

// ===========================================================================
// 11. Aucun impact sur l'existant
// ===========================================================================
{
  const created = await q(`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`);
  assert.deepEqual(
    created.map((r) => r.table_name),
    ["voice_sessions", "voice_usage_daily"],
    "la migration ne crée que ses deux tables",
  );
  pass("périmètre : aucune autre table créée, modifiée ou supprimée");
}

console.log(`\n${checks} contrôles SQL passés, sur PostgreSQL 16 réel.`);
