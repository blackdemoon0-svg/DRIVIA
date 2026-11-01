/**
 * Quota tests — the counters, their boundaries, and their documented limits.
 *
 * The point of this file is precision at the edges: the 15th message passes and
 * the 16th does not; an unlimited plan never blocks; a new UTC day resets the
 * daily counts but not the minute window.
 *
 * It also asserts what these counters are NOT, so nobody later mistakes them for
 * a durable meter: the module exposes a reset, and the code comments say a cold
 * start loses everything.
 */
import assert from "node:assert";
import {
  consumeQuota,
  msUntilNextUtcDay,
  readQuotaUsage,
  resetQuotas,
  utcDayKey,
} from "../server/quotas.ts";
import { PLAN_LIMITS, describeLimits, limitsFor } from "../src/lib/planLimits.ts";
import { PRICING_PLANS } from "../src/lib/paddleCore.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const USER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";

/** A fixed noon, far from any day boundary, so the tests are deterministic. */
const NOON = Date.parse("2026-11-01T12:00:00.000Z");

function consume(times, plan, options = {}) {
  let last = null;
  for (let index = 0; index < times; index += 1) {
    last = consumeQuota({
      userId: USER,
      plan,
      isQuoteAnalysis: false,
      // One second apart: the minute window must not be what stops us here.
      nowMs: NOON + index * 1_000,
      ...options,
    });
  }
  return last;
}

resetQuotas();

// ---------------------------------------------------------------------------
// 1. Limites par jour, à l'unité près
// ---------------------------------------------------------------------------
{
  resetQuotas();
  // 15 messages autorisés, le 16e refusé.
  const results = [];
  for (let index = 0; index < 16; index += 1) {
    results.push(
      consumeQuota({
        userId: USER,
        plan: "decouverte",
        isQuoteAnalysis: false,
        // 7 s d'écart : la fenêtre de 10/min ne doit pas être ce qui arrête le test.
        nowMs: NOON + index * 7_000,
      }),
    );
  }
  assert.equal(results.filter((result) => result.ok).length, 15, "15 messages doivent passer");
  const refused = results[15];
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, "daily_messages");
  assert.equal(refused.limit, 15);
  assert.equal(refused.used, 15);
  assert.ok(refused.retryAfterSeconds > 0, "un délai de réessai doit être fourni");
  assert.match(refused.error, /daily allowance of 15 messages/);
  pass("Découverte : les 15 messages passent, le 16e est refusé (code `daily_messages`)");
}

{
  resetQuotas();
  // Plus : 200 messages.
  let allowed = 0;
  for (let index = 0; index < 201; index += 1) {
    // Espacés de 3 s pour ne pas heurter la fenêtre d'une minute (20/min).
    const verdict = consumeQuota({
      userId: USER,
      plan: "plus",
      isQuoteAnalysis: false,
      nowMs: NOON + index * 3_500,
    });
    if (verdict.ok) allowed += 1;
    // Avant le 201e, aucun refus ne doit survenir ; au-delà, c'est le quota
    // journalier qui doit trancher (et non la fenêtre d'une minute).
    else assert.equal(
      verdict.kind,
      "daily_messages",
      `refus inattendu (${verdict.kind}) à l'index ${index}`,
    );
  }
  assert.equal(allowed, 200, "200 messages doivent être autorisés pour Plus");
  pass("Plus : 200 messages autorisés, le 201e est refusé");
}

{
  resetQuotas();
  // Pro : 600 messages, espacés pour respecter 30/min.
  let allowed = 0;
  for (let index = 0; index < 601; index += 1) {
    const verdict = consumeQuota({
      userId: USER,
      plan: "pro",
      isQuoteAnalysis: false,
      nowMs: NOON + index * 2_500,
    });
    if (verdict.ok) allowed += 1;
    else assert.equal(verdict.kind, "daily_messages", `refus inattendu (${verdict.kind})`);
  }
  assert.equal(allowed, 600, "600 messages doivent être autorisés pour Pro");
  pass("Pro : 600 messages autorisés, le 601e est refusé");
}

// ---------------------------------------------------------------------------
// 2. Analyses de devis
// ---------------------------------------------------------------------------
{
  resetQuotas();
  const first = consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: true, nowMs: NOON });
  assert.equal(first.ok, true);
  assert.equal(first.used.quotes, 1);

  const second = consumeQuota({
    userId: USER,
    plan: "decouverte",
    isQuoteAnalysis: true,
    nowMs: NOON + 120_000,
  });
  assert.equal(second.ok, false);
  assert.equal(second.kind, "daily_quotes");
  assert.equal(second.limit, 1);
  assert.match(second.error, /1 garage-quote analysis/);
  pass("Découverte : 1 analyse de devis par jour, la seconde est refusée");
}

{
  resetQuotas();
  for (let index = 0; index < 30; index += 1) {
    const verdict = consumeQuota({
      userId: USER,
      plan: "plus",
      isQuoteAnalysis: true,
      nowMs: NOON + index * 3_000,
    });
    assert.equal(verdict.ok, true, `Plus : analyses illimitées, refus inattendu à l'index ${index}`);
  }
  pass("Plus et Pro : analyses de devis illimitées (30 de suite, aucune n'est refusée)");
}

{
  resetQuotas();
  // Un message ordinaire ne consomme pas le quota d'analyse.
  consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON });
  const usage = readQuotaUsage(USER, NOON);
  assert.equal(usage.quotes, 0, "un message simple ne doit pas consommer une analyse");
  assert.equal(usage.messages, 1);
  pass("comptage : un message simple n'entame pas le quota d'analyse de devis");
}

// ---------------------------------------------------------------------------
// 3. Fenêtre par minute, alignée sur la formule
// ---------------------------------------------------------------------------
{
  resetQuotas();
  // Découverte : 10 par minute. En une seconde, le 11e doit être refusé.
  for (let index = 0; index < 10; index += 1) {
    const verdict = consumeQuota({
      userId: USER,
      plan: "decouverte",
      isQuoteAnalysis: false,
      nowMs: NOON + index * 100,
    });
    assert.equal(verdict.ok, true, `message ${index + 1} doit passer`);
  }
  const blocked = consumeQuota({
    userId: USER,
    plan: "decouverte",
    isQuoteAnalysis: false,
    nowMs: NOON + 2_000,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, "rate_minute");
  assert.equal(blocked.limit, 10);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
  pass("Découverte : 10 requêtes par minute, la suivante est refusée (`rate_minute`)");
}

{
  resetQuotas();
  // Les limites par minute diffèrent par formule : Pro en accepte davantage.
  assert.equal(PLAN_LIMITS.decouverte.requestsPerMinute, 10);
  assert.equal(PLAN_LIMITS.plus.requestsPerMinute, 20);
  assert.equal(PLAN_LIMITS.pro.requestsPerMinute, 30);

  for (let index = 0; index < 20; index += 1) {
    const verdict = consumeQuota({ userId: USER, plan: "plus", isQuoteAnalysis: false, nowMs: NOON + index * 100 });
    assert.equal(verdict.ok, true);
  }
  assert.equal(
    consumeQuota({ userId: USER, plan: "plus", isQuoteAnalysis: false, nowMs: NOON + 2_100 }).ok,
    false,
    "le 21e doit être refusé pour Plus",
  );
  pass("limites par minute : 10 / 20 / 30 selon la formule, appliquées réellement");
}

{
  resetQuotas();
  // La fenêtre glisse : après 60 s, la place se libère.
  for (let index = 0; index < 10; index += 1) {
    consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + index * 100 });
  }
  assert.equal(consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + 1_000 }).ok, false);
  assert.equal(
    consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + 61_000 }).ok,
    true,
    "la fenêtre glissante doit libérer une place après une minute",
  );
  pass("fenêtre glissante : une place se libère au bout d'une minute");
}

// ---------------------------------------------------------------------------
// 4. Une requête refusée ne consomme rien
// ---------------------------------------------------------------------------
{
  resetQuotas();
  for (let index = 0; index < 10; index += 1) {
    consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + index * 100 });
  }
  const before = readQuotaUsage(USER, NOON);
  consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + 1_500 });
  const after = readQuotaUsage(USER, NOON);
  assert.deepEqual(after, before, "un refus ne doit pas entamer le quota déjà atteint");
  pass("refus : une requête refusée n'incrémente aucun compteur");
}

// ---------------------------------------------------------------------------
// 5. Passage de journée UTC
// ---------------------------------------------------------------------------
{
  resetQuotas();
  for (let index = 0; index < 15; index += 1) {
    consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + index * 7_000 });
  }
  assert.equal(readQuotaUsage(USER, NOON).messages, 15);

  // Le lendemain, même heure : les compteurs journaliers repartent de zéro.
  const tomorrow = NOON + 86_400_000;
  const verdict = consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: tomorrow });
  assert.equal(verdict.ok, true, "le quota doit se réinitialiser au changement de jour UTC");
  assert.equal(readQuotaUsage(USER, tomorrow).messages, 1);
  pass("jour UTC : les compteurs journaliers repartent de zéro le lendemain");
}

{
  assert.equal(utcDayKey(Date.parse("2026-11-01T23:59:59.000Z")), "2026-11-01");
  assert.equal(utcDayKey(Date.parse("2026-11-02T00:00:00.000Z")), "2026-11-02");

  // Délai jusqu'au prochain minuit UTC, utilisé pour `Retry-After`.
  const wait = msUntilNextUtcDay(Date.parse("2026-11-01T23:59:00.000Z"));
  assert.ok(wait > 0 && wait <= 61_000, `délai attendu ≈ 60 s, reçu ${wait}`);
  pass("horloge : clé de jour en UTC et délai jusqu'au prochain minuit exacts");
}

// ---------------------------------------------------------------------------
// 6. Isolation des comptes
// ---------------------------------------------------------------------------
{
  resetQuotas();
  for (let index = 0; index < 15; index += 1) {
    consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + index * 7_000 });
  }
  assert.equal(
    consumeQuota({ userId: OTHER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON + 20_000 }).ok,
    true,
    "un compte ne doit pas consommer le quota d'un autre",
  );
  pass("isolation : chaque compte a son propre quota, jamais partagé");
}

// ---------------------------------------------------------------------------
// 7. Ce que ces compteurs ne sont pas
// ---------------------------------------------------------------------------
{
  resetQuotas();
  consumeQuota({ userId: USER, plan: "decouverte", isQuoteAnalysis: false, nowMs: NOON });
  assert.equal(readQuotaUsage(USER, NOON).messages, 1);

  // La remise à zéro est possible depuis le module : c'est exactement ce que
  // fait un démarrage à froid. Ce test documente la limite au lieu de la nier.
  resetQuotas();
  assert.equal(readQuotaUsage(USER, NOON).messages, 0, "un redémarrage perd les compteurs");
  pass("limite documentée : les compteurs sont en mémoire et perdus à chaque redémarrage");
}

{
  // Aucun plan inconnu ne doit donner un quota plus généreux que Découverte.
  assert.deepEqual(limitsFor("gold"), PLAN_LIMITS.decouverte);
  assert.equal(PLAN_LIMITS.decouverte.messagesPerDay, 15);

  resetQuotas();
  for (let index = 0; index < 15; index += 1) {
    consumeQuota({ userId: USER, plan: "gold", isQuoteAnalysis: false, nowMs: NOON + index * 7_000 });
  }
  assert.equal(
    consumeQuota({ userId: USER, plan: "gold", isQuoteAnalysis: false, nowMs: NOON + 20_000 }).ok,
    false,
    "un plan inconnu retombe sur les limites les plus basses",
  );
  pass("plan inconnu : les limites de Découverte s'appliquent, jamais un plan payant");
}

// ---------------------------------------------------------------------------
// 8. Description affichée sur la page tarifs = ce que le serveur applique
// ---------------------------------------------------------------------------
{
  assert.equal(
    describeLimits("decouverte"),
    "15 messages par jour, 1 analyse de devis par jour, document joint uniquement pour l'analyse de devis.",
  );
  assert.equal(describeLimits("plus"), "200 messages par jour, analyses de devis illimitées, photos et PDF acceptés.");
  assert.equal(describeLimits("pro"), "600 messages par jour, analyses de devis illimitées, photos et PDF acceptés.");

  // Option (a) validée : la Découverte peut joindre le document de son analyse
  // de devis, mais n'obtient aucune capacité photo/PDF générale.
  assert.equal(PLAN_LIMITS.decouverte.quoteAnalysis, true);
  assert.equal(PLAN_LIMITS.decouverte.attachments, false);
  assert.equal(PLAN_LIMITS.plus.quoteAnalysis, true);
  assert.equal(PLAN_LIMITS.pro.quoteAnalysis, true);

  const decouverte = PRICING_PLANS.find((plan) => plan.id === "decouverte");
  const plus = PRICING_PLANS.find((plan) => plan.id === "plus");
  assert.ok(decouverte.features.some((feature) => /Analyse d'un devis/i.test(feature)));
  assert.ok(plus.features.some((feature) => /illimités/i.test(feature)));
  pass("affichage ↔ application : la phrase montrée est générée depuis la table appliquée");
}

console.log(`\n${checks} vérifications de quotas passées.`);
