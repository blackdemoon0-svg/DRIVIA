/**
 * Consumption identifier tests — determinism, account scoping and strict input
 * validation.
 *
 * The point of this file is that the browser's request identifier can never
 * become the primary key of a row: it is validated, then derived with the
 * *verified* account id. Two properties are load-bearing and are asserted here:
 *
 *   • the same (account, request id) always yields the same identifier, so a
 *     network retry lands on the same ledger row instead of a second one;
 *   • the same request id used by another account yields a different
 *     identifier, so one account can never address another account's row.
 */
import assert from "node:assert";
import {
  CLIENT_MESSAGE_ID_PATTERN,
  CONSUMPTION_ID_DOMAIN,
  CONSUMPTION_ID_PATTERN,
  checkClientMessageId,
  consumptionIdFor,
  newConsumptionId,
  resolveConsumptionId,
} from "../server/consumptionId.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const USER_A = "11111111-2222-4333-8444-555555555555";
const USER_B = "99999999-8888-4777-8666-555555555555";
const REQUEST = "a3f1c9d2-4b6e-4c1a-9f3d-8e2b7c5d1a04";

// ---------------------------------------------------------------------------
// 1. The domain separator is frozen
// ---------------------------------------------------------------------------
{
  // Changing this value re-keys every derivation: retries in flight would stop
  // being idempotent. It is asserted literally so a careless edit fails here.
  assert.equal(CONSUMPTION_ID_DOMAIN, "veyvro:ai-usage:v1:");
  pass("le séparateur de domaine v1 est figé (toute modification casserait l'idempotence)");
}

// ---------------------------------------------------------------------------
// 2. Determinism — the retry guarantee
// ---------------------------------------------------------------------------
{
  const first = consumptionIdFor(USER_A, REQUEST);
  const second = consumptionIdFor(USER_A, REQUEST);
  assert.equal(first, second);

  // Case and surrounding whitespace are normalised: the same request typed by
  // the same account must never produce two identifiers.
  assert.equal(consumptionIdFor(USER_A, REQUEST.toUpperCase()), first);
  assert.equal(consumptionIdFor(USER_A, `  ${REQUEST}  `), first);
  assert.equal(consumptionIdFor(`  ${USER_A}  `, REQUEST), first);
  pass("(compte, identifiant de requête) identiques ⇒ identifiant identique, casse et espaces normalisés");
}

// ---------------------------------------------------------------------------
// 3. Account scoping — the isolation guarantee
// ---------------------------------------------------------------------------
{
  const a = consumptionIdFor(USER_A, REQUEST);
  const b = consumptionIdFor(USER_B, REQUEST);
  assert.notEqual(a, b, "le même identifiant de requête sur deux comptes doit produire deux identifiants");
  assert.notEqual(consumptionIdFor("a1", REQUEST), consumptionIdFor("a2", REQUEST));
  pass("même identifiant de requête, comptes différents ⇒ identifiants différents (pas de préemption possible)");
}

// ---------------------------------------------------------------------------
// 4. Shape — a real RFC 4122 UUID, version 8
// ---------------------------------------------------------------------------
{
  const id = consumptionIdFor(USER_A, REQUEST);
  assert.match(id, CONSUMPTION_ID_PATTERN);
  const segments = id.split("-");
  assert.deepEqual(segments.map((segment) => segment.length), [8, 4, 4, 4, 12]);
  assert.equal(id.length, 36);
  assert.equal(segments[2][0], "8", "les identifiants dérivés portent la version 8 (personnalisée)");
  assert.ok(["8", "9", "a", "b"].includes(segments[3][0]), "le variant doit être conforme RFC 4122");
  pass("identifiant dérivé : UUID 8-4-4-4-12, version 8, variant RFC 4122");
}

// ---------------------------------------------------------------------------
// 5. Random identifiers — version 4, never repeated
// ---------------------------------------------------------------------------
{
  const seen = new Set();
  for (let index = 0; index < 1_000; index += 1) {
    const id = newConsumptionId();
    assert.match(id, CONSUMPTION_ID_PATTERN);
    assert.equal(id.split("-")[2][0], "4");
    assert.ok(!seen.has(id), "un identifiant aléatoire ne doit jamais être réutilisé");
    seen.add(id);
  }
  assert.equal(seen.size, 1_000);
  pass("1 000 identifiants aléatoires : tous valides, tous distincts, version 4");
}

// ---------------------------------------------------------------------------
// 6. Strict validation of the client value
// ---------------------------------------------------------------------------
{
  // Seul `undefined` est « absent ». Un `null` ou une chaîne vide est une valeur
  // PRÉSENTE et fausse : la refuser explicitement empêche qu'un rejeu ayant
  // perdu son identifiant soit facturé comme un second message.
  assert.deepEqual(checkClientMessageId(undefined), { ok: false, reason: "missing" });
  assert.deepEqual(checkClientMessageId(null), { ok: false, reason: "not_a_string" });
  assert.deepEqual(checkClientMessageId(""), { ok: false, reason: "invalid_format" });
  assert.deepEqual(checkClientMessageId("   "), { ok: false, reason: "invalid_format" });
  assert.deepEqual(checkClientMessageId(42), { ok: false, reason: "not_a_string" });
  assert.deepEqual(checkClientMessageId({}), { ok: false, reason: "not_a_string" });

  for (const invalid of [
    "abc",
    "a3f1c9d2-4b6e-1c1a-9f3d-8e2b7c5d1a04", // version 1
    "a3f1c9d2-4b6e-4c1a-cf3d-8e2b7c5d1a04", // variant invalide
    "a3f1c9d2-4b6e-4c1a-9f3d-8e2b7c5d1a0", // un caractère manquant
    "a3f1c9d2-4b6e-4c1a-9f3d-8e2b7c5d1a044", // un caractère de trop
    "not-a-uuid",
    "a3f1c9d2_4b6e_4c1a_9f3d_8e2b7c5d1a04",
  ]) {
    assert.deepEqual(checkClientMessageId(invalid), { ok: false, reason: "invalid_format" }, invalid);
    assert.equal(CLIENT_MESSAGE_ID_PATTERN.test(invalid), false);
  }

  assert.deepEqual(checkClientMessageId(REQUEST), { ok: true, value: REQUEST });
  assert.deepEqual(checkClientMessageId(REQUEST.toUpperCase()), { ok: true, value: REQUEST });
  pass("validation stricte : seul undefined est « absent » ; null, chaînes vides, non-chaîne et UUID v1/variant/format refusés");
}

// ---------------------------------------------------------------------------
// 7. Derivation refuses to work on unverified input
// ---------------------------------------------------------------------------
{
  assert.throws(() => consumptionIdFor("", REQUEST), /verified user id/i);
  assert.throws(() => consumptionIdFor("   ", REQUEST), /verified user id/i);
  assert.throws(() => consumptionIdFor(USER_A, "not-a-uuid"), /v4 UUID/i);
  assert.throws(() => consumptionIdFor(USER_A, REQUEST.replace("4c1a", "1c1a")), /v4 UUID/i);
  pass("la dérivation refuse un compte vide et un identifiant de requête non conforme");
}

// ---------------------------------------------------------------------------
// 8. resolveConsumptionId — the single entry point the route will use
// ---------------------------------------------------------------------------
{
  const derived = resolveConsumptionId(USER_A, REQUEST);
  assert.equal(derived.ok, true);
  assert.equal(derived.derived, true);
  assert.equal(derived.consumptionId, consumptionIdFor(USER_A, REQUEST));

  const random = resolveConsumptionId(USER_A, undefined);
  assert.equal(random.ok, true);
  assert.equal(random.derived, false, "sans identifiant client, la consommation n'est pas reprise-able");
  assert.match(random.consumptionId, CONSUMPTION_ID_PATTERN);

  const randomSecond = resolveConsumptionId(USER_A, undefined);
  assert.notEqual(random.consumptionId, randomSecond.consumptionId);

  const invalid = resolveConsumptionId(USER_A, "not-a-uuid");
  assert.deepEqual(invalid, { ok: false, reason: "invalid_client_message_id" });

  const numeric = resolveConsumptionId(USER_A, 42);
  assert.deepEqual(numeric, { ok: false, reason: "invalid_client_message_id" });

  // Une valeur présente mais inutilisable n'est JAMAIS remplacée par un
  // identifiant aléatoire : elle est refusée (400 côté route).
  for (const present of [null, "", "   "]) {
    assert.deepEqual(
      resolveConsumptionId(USER_A, present),
      { ok: false, reason: "invalid_client_message_id" },
      `valeur présente et fausse : ${JSON.stringify(present)}`,
    );
  }

  const noUser = resolveConsumptionId("", REQUEST);
  assert.deepEqual(noUser, { ok: false, reason: "missing_user_id" });

  const noUserRandom = resolveConsumptionId(undefined, undefined);
  assert.deepEqual(noUserRandom, { ok: false, reason: "missing_user_id" });
  pass("resolveConsumptionId : dérive, aléatoire, refus explicite — jamais de remplacement silencieux");
}

console.log(`\n${checks} vérifications d'identifiant de consommation passées.`);
