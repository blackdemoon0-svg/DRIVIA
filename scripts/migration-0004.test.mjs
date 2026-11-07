/**
 * Migration 0004 — static audit of the P4-01 fix.
 *
 * These tests read two SQL files as TEXT and compare them. They execute
 * nothing: no database, no network, no psql.
 *
 * What they prove:
 *   * 0003 has not moved — its SHA-256 is pinned below, so any future edit to
 *     0003 breaks this suite loudly instead of silently;
 *   * 0004 replaces exactly ONE function and changes exactly ONE line inside
 *     it: the ON CONFLICT target;
 *   * everything the quota relies on (parameter contract, returned columns,
 *     SECURITY DEFINER, search_path, the atomic claim, the conditional upsert,
 *     the refusal that deletes its own claim, the refund bound to the event's
 *     day, the 3-attempt ceiling, the row locks) is carried over verbatim, so
 *     idempotence, refunds, counters and concurrency cannot change by
 *     construction;
 *   * 0004 grants nothing, revokes nothing, creates no other object, and
 *     writes no data;
 *   * the migration fails closed: guards run before the replacement, the ACL
 *     is captured before and compared after, and a probe exercises the named
 *     conflict target before it is installed.
 *
 * What they CANNOT prove, and what the P4 re-run must establish:
 *   * that PostgreSQL accepts the new body, that a real consumption now
 *     succeeds, that two parallel callers still cannot both take the last unit.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const M3 = new URL("../supabase/migrations/0003_ai_usage_quotas.sql", import.meta.url);
const M4 = new URL("../supabase/migrations/0004_ai_usage_consume_conflict_target.sql", import.meta.url);

const raw3 = readFileSync(M3, "utf8");
const raw4 = readFileSync(M4, "utf8");

/** 0003 as applied on Preview on 2026-11-07. Pinned: it must never change. */
const SHA3_ATTENDU = "2364b23de2daa8af31b96b4b9ca0a579a5fccd91dc2ecc5cfac5753e11134db0";

const sha3 = createHash("sha256").update(raw3).digest("hex");

/** The file without its `--` comments: assertions target statements, not prose. */
const strip = (s) =>
  s
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
const sql3 = strip(raw3);
const sql4 = strip(raw4);
/** Code seul : ni commentaires, ni littéraux de chaîne ('' échappés compris). */
const code = (s) => strip(s).replace(/'(?:[^']|'')*'/g, "''");

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

/** One `create or replace function public.<name> … $$;` block, as text. */
function fnBlock(text, name) {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
    "i",
  );
  const found = text.match(re);
  assert.ok(found, `fonction public.${name} introuvable`);
  return found[0];
}

/** Everything in the file that is NOT the ai_usage_consume block. */
function outsideConsume(text) {
  return text.replace(fnBlock(text, "ai_usage_consume"), "\n");
}

const fn3 = fnBlock(sql3, "ai_usage_consume");
const fn4 = fnBlock(sql4, "ai_usage_consume");

// ---------------------------------------------------------------------------
// 1. 0003 is frozen
// ---------------------------------------------------------------------------
{
  assert.equal(sha3, SHA3_ATTENDU, "0003 a changé : le fichier appliqué en Preview ne doit plus bouger");
  pass(`0003 intact : SHA-256 ${sha3.slice(0, 12)}… (${Buffer.byteLength(raw3)} octets)`);
}

// ---------------------------------------------------------------------------
// 2. 0004 exists, is a migration, and says it has not been applied
// ---------------------------------------------------------------------------
{
  assert.ok(raw4.startsWith("--"), "0004 doit commencer par son en-tête");
  assert.match(raw4, /NOT APPLIED/i, "l'en-tête doit dire que rien n'a été exécuté");
  assert.match(raw4, /P4-01/, "l'en-tête doit référencer le défaut corrigé");
  assert.equal((sql4.match(/\bbegin\s*;/gi) ?? []).length, 1, "une seule transaction");
  assert.equal((sql4.match(/\bcommit\s*;/gi) ?? []).length, 1, "une seule validation");
  assert.ok((raw4.match(/\$\$/g) ?? []).length % 2 === 0, "les délimiteurs $$ doivent être appariés");
  pass("0004 : en-tête, mention NOT APPLIED, une transaction, délimiteurs appariés");
}

// ---------------------------------------------------------------------------
// 3. Exactly one function, and it is ai_usage_consume
// ---------------------------------------------------------------------------
{
  const created = sql4.match(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi) ?? [];
  assert.equal(created.length, 1, `fonctions créées : ${created.length}, 1 attendue`);
  assert.match(created[0], /ai_usage_consume/i);
  pass("0004 remplace une seule fonction : public.ai_usage_consume");
}

// ---------------------------------------------------------------------------
// 4. The difference is exactly one line, and it is the conflict target
// ---------------------------------------------------------------------------
{
  const a = fn3.split("\n");
  const b = fn4.split("\n");
  assert.equal(a.length, b.length, "le nombre de lignes du corps doit être identique");

  const differing = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) differing.push([i + 1, a[i], b[i]]);
  }

  assert.equal(differing.length, 1, `lignes modifiées : ${differing.length}, 1 attendue`);

  const [, avant, apres] = differing[0];
  assert.match(avant.trim(), /^on conflict \(user_id, usage_day\) do update$/);
  assert.match(apres.trim(), /^on conflict on constraint ai_usage_daily_pkey do update$/);

  pass("une seule ligne change : « on conflict (user_id, usage_day) » → « on conflict on constraint ai_usage_daily_pkey »");
}

// ---------------------------------------------------------------------------
// 5. The contract the server depends on has not moved
// ---------------------------------------------------------------------------
{
  const params = (block) =>
    block
      .slice(block.indexOf("(") + 1, block.indexOf(")\nreturns"))
      .split(",")
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);

  assert.deepEqual(params(fn4), params(fn3), "paramètres (noms, types, défauts) modifiés");

  const names = params(fn4).map((p) => p.split(" ")[0]);
  assert.deepEqual(
    names,
    ["p_user_id", "p_consumption_id", "p_limit_messages", "p_limit_quotes", "p_is_quote", "p_now"],
    "les clés JSON reçues par PostgREST ont changé",
  );
  assert.match(params(fn4).at(-1), /default null$/, "p_now doit rester optionnel");

  const returns = (block) => block.match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i)[1].replace(/\s+/g, " ").trim();
  assert.equal(returns(fn4), returns(fn3), "colonnes retournées modifiées");
  for (const col of ["allowed", "reason", "used_messages", "used_quotes", "usage_day", "replayed"]) {
    assert.ok(returns(fn4).includes(col), `colonne ${col} absente du retour`);
  }

  pass("contrat intact : mêmes paramètres (défauts compris) et mêmes colonnes retournées");
}

// ---------------------------------------------------------------------------
// 6. Security posture carried over
// ---------------------------------------------------------------------------
{
  const posture = (block) => ({
    definer: /security\s+definer/i.test(block),
    searchPath: /set\s+search_path\s*=\s*pg_catalog,\s*public,\s*pg_temp/i.test(block),
    language: /language\s+plpgsql/i.test(block),
  });
  assert.deepEqual(posture(fn4), posture(fn3), "posture de sécurité modifiée");
  assert.equal(posture(fn4).definer, true);
  assert.equal(posture(fn4).searchPath, true);
  pass("posture intacte : SECURITY DEFINER, search_path ancré, plpgsql");
}

// ---------------------------------------------------------------------------
// 7. No privilege is touched
// ---------------------------------------------------------------------------
{
  const rest = outsideConsume(sql4);
  assert.doesNotMatch(sql4, /^\s*grant\s/gi, "0004 ne doit contenir aucun GRANT");
  assert.doesNotMatch(sql4, /^\s*revoke\s/gi, "0004 ne doit contenir aucun REVOKE");
  assert.doesNotMatch(sql4, /alter\s+role|alter\s+default\s+privileges/i, "aucun changement de rôle ou d'ACL par défaut");
  assert.doesNotMatch(rest, /alter\s+table/i, "aucun DDL sur une table");
  assert.doesNotMatch(rest, /alter\s+function|alter\s+policy|alter\s+schema/i, "aucun ALTER hors du corps");
  pass("aucun privilège touché : ni GRANT, ni REVOKE, ni ALTER ROLE, ni ALTER TABLE");
}

// ---------------------------------------------------------------------------
// 8. No other object is created or dropped
// ---------------------------------------------------------------------------
{
  const rest = outsideConsume(sql4);
  assert.doesNotMatch(rest, /create\s+table\s+(?!a4_probe)/i, "aucune table permanente");
  assert.doesNotMatch(rest, /create\s+(unique\s+)?index|create\s+trigger|create\s+policy|create\s+type|create\s+schema/i);
  assert.doesNotMatch(rest, /drop\s+function|drop\s+trigger|drop\s+policy/i);
  assert.doesNotMatch(rest, /truncate|drop\s+table\s+(?!if\s+exists\s+a4_probe|a4_probe)/i, "aucune suppression");

  // La seule table temporaire tolérée est la sonde, et elle est supprimée.
  const tempTables = sql4.match(/create\s+temp\s+table\s+(\w+)/gi) ?? [];
  for (const t of tempTables) assert.match(t, /a4_/i, `table temporaire inattendue : ${t}`);
  assert.match(sql4, /drop\s+table\s+a4_probe\s*;/i, "la sonde doit être supprimée");
  pass("aucun autre objet : une fonction, deux tables temporaires de travail, rien de persistant");
}

// ---------------------------------------------------------------------------
// 9. Idempotence, refusal, refund and 3-attempt ceiling carried over
// ---------------------------------------------------------------------------
{
  const required = [
    [/on conflict \(consumption_id\) do nothing/i, "réclamation atomique par la clé primaire du ledger"],
    [/get diagnostics v_inserted = row_count/i, "détection du doublon (rejeu)"],
    [/'consumption_conflict'::text/i, "verdict de conflit"],
    [/return query select\s+true,\s+null::text/i, "rejeu accepté sans second décompte"],
    [/delete from public\.ai_usage_events/i, "refus qui supprime sa propre réclamation"],
    [/v_event\.attempts >= 3/i, "plafond de 3 tentatives"],
    [/where u\.messages < p_limit_messages/i, "limite portée par le WHERE de l'upsert"],
    [/and \(p_limit_quotes is null or not p_is_quote or u\.quotes < p_limit_quotes\)/i, "limite de devis dans le même WHERE"],
    [/for update/i, "verrouillage de ligne (concurrence)"],
    [/return query select true, null::text, v_messages, v_quotes, v_day, false/i, "verdict d'acceptation"],
  ];
  for (const [re, label] of required) {
    assert.match(fn4, re, `propriété perdue : ${label}`);
    assert.match(fn3, re, `propriété absente de 0003 : ${label}`);
  }

  // Preuve d'égalité : en neutralisant la seule ligne qui doit changer, les
  // deux corps deviennent identiques au caractère près.
  const neutralise = (block, from) => block.replace(from, "<<CIBLE>>");
  assert.equal(
    neutralise(fn4, "on conflict on constraint ai_usage_daily_pkey do update"),
    neutralise(fn3, "on conflict (user_id, usage_day) do update"),
    "hors la cible de conflit, les deux corps doivent être identiques au caractère près",
  );

  pass(`propriétés reportées : ${required.length} motifs critiques identiques, et égalité au caractère près hors la ligne corrigée`);
}

// ---------------------------------------------------------------------------
// 10. The conflict target exists in 0003
// ---------------------------------------------------------------------------
{
  assert.match(
    sql3,
    /constraint\s+ai_usage_daily_pkey\s+primary\s+key\s*\(\s*user_id\s*,\s*usage_day\s*\)/i,
    "0003 doit déclarer ai_usage_daily_pkey (user_id, usage_day)",
  );
  assert.match(fn4, /on conflict on constraint ai_usage_daily_pkey do update/i);
  pass("cible nommée résoluble : ai_usage_daily_pkey est bien la PK (user_id, usage_day) déclarée par 0003");
}

// ---------------------------------------------------------------------------
// 11. Ambiguous target survives only in the probe's witness, never in the body
// ---------------------------------------------------------------------------
{
  assert.doesNotMatch(fn4, /on conflict \(user_id, usage_day\)/i, "la cible ambiguë ne doit plus figurer dans la fonction");
  const code4 = code(raw4);
  const occurrences = (code4.match(/on conflict \(user_id, usage_day\) do update/gi) ?? []).length;
  assert.equal(occurrences, 1, `cible ambiguë dans le code exécutable : ${occurrences}, 1 attendue (le témoin de la sonde)`);
  assert.match(sql4, /when sqlstate '42702'/i, "la sonde doit constater l'ambiguïté");
  pass("la cible ambiguë n'existe plus que comme témoin dans la sonde (42702 attendu)");
}

// ---------------------------------------------------------------------------
// 12. Fail-closed: guards before, checks after
// ---------------------------------------------------------------------------
{
  const guards = [
    [/0004 annulée : % fonction\(s\) nommée\(s\) ai_usage_consume/i, "garde : unicité de la fonction"],
    [/n''est pas SECURITY DEFINER/i, "garde : SECURITY DEFINER attendu"],
    [/search_path de ai_usage_consume non ancré/i, "garde : search_path"],
    [/appartient à un rôle d''API/i, "garde : propriétaire"],
    [/porte déjà une cible de conflit nommée/i, "garde : correctif déjà présent"],
    [/la cible défectueuse « on conflict \(user_id, usage_day\) » n''apparaît pas exactement une fois/i, "garde : corps issu de 0003"],
    [/la contrainte ai_usage_daily_pkey est absente/i, "garde : contrainte cible"],
    [/ai_usage_daily_pkey porte sur « % » au lieu de \(user_id, usage_day\)/i, "garde : forme de la contrainte"],
  ];
  for (const [re, label] of guards) assert.match(raw4, re, `garde manquante : ${label}`);

  const indexGuard = raw4.indexOf("Guard — the function this migration replaces");
  const indexReplace = raw4.indexOf("create or replace function public.ai_usage_consume");
  const indexPost = raw4.indexOf("Post-checks — nothing but the body may have changed");
  assert.ok(indexGuard > -1 && indexReplace > indexGuard, "les gardes doivent précéder le remplacement");
  assert.ok(indexPost > indexReplace, "les contrôles doivent suivre le remplacement");
  pass(`failsafe : ${guards.length} gardes avant le remplacement, contrôles après`);
}

// ---------------------------------------------------------------------------
// 13. The ACL is compared, not re-granted
// ---------------------------------------------------------------------------
{
  assert.match(raw4, /create temp table a4_avant[\s\S]{0,400}proacl::text\s+as acl/i, "l'ACL doit être capturée avant");
  assert.match(raw4, /acl_apres is distinct from acl_avant/i, "l'ACL doit être comparée après");
  assert.match(raw4, /Cette migration ne doit modifier aucun privilège/i);
  assert.match(raw4, /res_apres is distinct from res_avant/i, "les colonnes retournées doivent être comparées");
  pass("ACL, propriétaire et colonnes retournées : capturés avant, comparés après, jamais re-accordés");
}

// ---------------------------------------------------------------------------
// 14. The probe exercises the three properties of the named target
// ---------------------------------------------------------------------------
{
  const probe = raw4.slice(raw4.indexOf("create temp table a4_probe"), raw4.indexOf("drop table a4_probe;"));
  assert.match(probe, /on conflict on constraint a4_probe_pkey do update/i);
  assert.match(probe, /where u\.messages < 10/i, "la sonde doit vérifier la limite");
  assert.match(probe, /where u\.messages < 2/i, "la sonde doit vérifier le refus de la dernière unité");
  assert.match(probe, /v_msg is distinct from 1/i, "la sonde doit vérifier l'insertion");
  assert.match(probe, /v_msg is distinct from 2/i, "la sonde doit vérifier l'incrément");
  assert.match(probe, /v_msg is not null/i, "la sonde doit vérifier le refus");
  pass("sonde : insertion, incrément sur conflit et respect du WHERE, sur une table temporaire");
}

// ---------------------------------------------------------------------------
// 15. No data is written by the migration itself
// ---------------------------------------------------------------------------
{
  const rest = outsideConsume(sql4);
  assert.doesNotMatch(rest, /insert\s+into\s+public\./i, "0004 ne doit écrire aucune donnée métier");
  assert.doesNotMatch(rest, /update\s+public\.|delete\s+from\s+public\./i);
  assert.doesNotMatch(rest, /auth\.users/i, "0004 ne doit pas toucher aux comptes");
  pass("aucune écriture métier : ni INSERT/UPDATE/DELETE sur public.*, ni accès à auth.users");
}


// ---------------------------------------------------------------------------
// 16. The refund and the read function are not redefined at all
// ---------------------------------------------------------------------------
{
  assert.doesNotMatch(sql4, /function\s+public\.ai_usage_refund/i, "0004 ne doit pas redéfinir ai_usage_refund");
  assert.doesNotMatch(sql4, /function\s+public\.ai_usage_read/i, "0004 ne doit pas redéfinir ai_usage_read");

  // Leurs propriétés, mesurées en P4, restent celles de 0003 — que 0004 ne touche pas.
  const refund3 = fnBlock(sql3, "ai_usage_refund");
  assert.match(refund3, /d\.usage_day = v_event\.usage_day/i, "le remboursement reste lié à la journée de l'évènement");
  assert.match(refund3, /greatest\(0, d\.messages - 1\)/i, "garde de décrément présente dans 0003");
  assert.match(refund3, /for update/i);
  pass("remboursement et lecture non redéfinis : 0004 ne peut pas les modifier");
}

console.log(`\n${checks} vérifications statiques de la migration 0004 passées.`);
