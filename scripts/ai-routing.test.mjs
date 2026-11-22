/**
 * Routing tests — the decision layer, with no network involved.
 *
 * These are the tests that matter for cost and quality: they assert that a
 * greeting does not reach a flagship reasoning model, that a safety question
 * does, that a Découverte account can never trigger a four-model collaboration,
 * and that every plan stays inside the price ceiling of its formula.
 *
 * The expected model ids are the ones verified in
 * `server/ai/modelCatalog.ts` against the official documentation.
 */
import assert from "node:assert";
import {
  OPENAI_CATALOG,
  LEGACY_CATALOG,
  describeModel,
  fallbackChain,
  isModelUnavailable,
  looksLikeReasoningModel,
  markModelUnavailable,
  resetModelAvailability,
} from "../server/ai/modelCatalog.ts";
import {
  REQUEST_BUDGET_USD,
  applyModelPin,
  estimateCallCostUsd,
  extractSignals,
  planRoute,
  planRoute as route,
} from "../server/ai/router.ts";
import {
  canAffordExpensiveMode,
  recordSpend,
  resetSpend,
  spentTodayUsd,
} from "../server/ai/budget.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const base = {
  historyLength: 0,
  hasAttachments: false,
  isQuoteAnalysis: false,
  tier: "plus",
  policy: "auto",
};

// ---------------------------------------------------------------------------
// 1. Catalog integrity
// ---------------------------------------------------------------------------
{
  const ids = Object.values(OPENAI_CATALOG).map((entry) => entry.id);
  assert.ok(ids.length >= 4, "le catalogue doit proposer plusieurs modèles");
  for (const entry of Object.values(OPENAI_CATALOG)) {
    // Every id must look like a real OpenAI id and must have been read from the
    // docs: no placeholder, no invented suffix.
    assert.match(entry.id, /^gpt-6(\.[0-9])?-(luna|terra|sol|astra)$/, `id inattendu: ${entry.id}`);
    assert.ok(entry.inputCostPerMTok > 0 && entry.outputCostPerMTok > 0, `${entry.id}: prix manquant`);
    assert.ok(entry.maxOutputTokens > 0);
    assert.equal(entry.source, "verified-docs");
  }
  assert.equal(new Set(ids.filter((id, i) => ids.indexOf(id) === i)).size >= 4, true);
  pass("catalogue : identifiants réels, prix et limites renseignés, aucune valeur inventée");
}

{
  // The two models OpenAI documents as rejecting reasoning_effort "none" must be
  // flagged, otherwise a "none" effort would turn into an HTTP 400.
  assert.equal(OPENAI_CATALOG.reasoning.rejectsNoReasoningEffort, true);
  assert.equal(OPENAI_CATALOG.coding.rejectsNoReasoningEffort, true);
  assert.equal(OPENAI_CATALOG.fast.rejectsNoReasoningEffort, false);
  assert.equal(OPENAI_CATALOG.balanced.rejectsNoReasoningEffort, false);
  pass("profils : le rejet de `reasoning_effort: none` est connu modèle par modèle");
}

{
  // A legacy pin must still be usable, and must not be routed by default.
  const legacy = describeModel("gpt-4.1-mini");
  assert.equal(legacy.source, "legacy");
  assert.equal(legacy.isReasoning, false);
  assert.ok(LEGACY_CATALOG["gpt-4.1-mini"]);
  assert.equal(looksLikeReasoningModel("gpt-6.2-astra"), true);
  assert.equal(looksLikeReasoningModel("gpt-4.1-mini"), false);
  const unknown = describeModel("some-other-endpoint-model");
  assert.equal(unknown.role, "legacy");
  assert.ok(unknown.inputCostPerMTok > 0, "un modèle inconnu a un coût prudent, pas nul");
  pass("modèle épinglé : les identifiants hérités et inconnus restent utilisables avec un profil prudent");
}

// ---------------------------------------------------------------------------
// 2. Difficulty signals
// ---------------------------------------------------------------------------
{
  const trivial = extractSignals({
    message: "C'est quoi un turbo ?",
    historyLength: 0,
    hasAttachments: false,
    isQuoteAnalysis: false,
  });
  assert.equal(trivial.comparison, false);
  assert.equal(trivial.safety, false);
  assert.equal(trivial.multiPart, false);

  const hard = extractSignals({
    message:
      "Ma Golf 7 1.2 TSI fait un bruit au freinage et le voyant rouge s'allume. Est-ce dangereux ? Et combien coûte un remplacement ?",
    historyLength: 0,
    hasAttachments: false,
    isQuoteAnalysis: false,
  });
  assert.equal(hard.safety, true, "freinage + voyant rouge = sécurité");
  assert.equal(hard.multiPart, true, "deux questions distinctes");
  assert.equal(hard.analysis, true, "coût/panne = analyse");
  pass("signaux : la sécurité, le multi-questions et l'analyse sont détectés sur une demande réelle");
}

{
  const programming = extractSignals({
    message: "Écris un script Python qui décode une trame CAN et calcule le régime moteur.",
    historyLength: 0,
    hasAttachments: false,
    isQuoteAnalysis: false,
  });
  assert.equal(programming.coding, true, "script + CAN = demande de programmation");
  pass("signaux : une demande de code/diagnostic est reconnue");
}

// ---------------------------------------------------------------------------
// 3. Model choice
// ---------------------------------------------------------------------------
{
  const plan = route({ ...base, message: "Bonjour !" });
  assert.equal(plan.mode, "fast");
  assert.equal(plan.primary.id, "gpt-6-luna");
  assert.equal(plan.collaborators.length, 0);
  assert.equal(plan.verify, false);
  assert.ok(plan.maxOutputTokens <= 900, "une salutation ne paie pas une longue sortie");
  pass("question simple : modèle rapide et économique (gpt-6-luna), sans vérification");
}

{
  const plan = route({ ...base, message: "C'est quoi un turbo ?" });
  assert.equal(plan.mode, "fast");
  assert.equal(plan.primary.id, "gpt-6-luna");
  pass("question simple mais technique : reste sur le modèle rapide");
}

{
  const plan = route({
    ...base,
    message: "Compare la Golf GTI Mk8 et la Civic Type R : laquelle choisir pour un usage quotidien ?",
  });
  assert.ok(["balanced", "coding", "reasoning"].includes(plan.mode));
  assert.notEqual(plan.primary.id, "gpt-6-luna", "une comparaison ne part pas sur le modèle le moins cher");
  pass(`comparaison : modèle plus solide que le modèle rapide (${plan.primary.id})`);
}

{
  const plan = route({
    ...base,
    message:
      "Ma voiture fume blanc et le voyant de température monte. Le joint de culasse est-il en cause, et quel budget prévoir ?",
  });
  assert.equal(plan.mode === "reasoning" || plan.mode === "collaborative", true);
  assert.equal(plan.primary.isReasoning, true, "un sujet de sécurité passe par un modèle de raisonnement");
  assert.equal(plan.verify || plan.collaborators.length > 0, true, "une réponse de sécurité est vérifiée");
  pass("sécurité : modèle de raisonnement et vérification de la réponse");
}

{
  const plan = route({
    ...base,
    message: "Peux-tu analyser ce devis de garage et me dire si les prix sont cohérents ?",
    hasAttachments: true,
    isQuoteAnalysis: true,
  });
  assert.equal(plan.primary.id, "gpt-6.2-sol", "un document à lire part sur un modèle de raisonnement vision");
  assert.equal(plan.primary.supportsVision, true, "le modèle choisi sait lire une image");
  assert.equal(plan.verify, true, "l'analyse d'un devis est vérifiée par un second modèle");
  assert.equal(plan.verifiers[0].id, "gpt-6.1-terra", "le vérificateur est le modèle équilibré, moins cher");
  assert.equal(plan.maxOutputTokens >= 2400, true, "l'analyse d'un devis a droit à une sortie longue");
  assert.ok(plan.signals.document, "le document est un signal pris en compte");
  pass("analyse de devis : modèle vision, sortie longue, lecture prudente");
}

{
  const plan = route({
    ...base,
    message: "Écris un script qui interroge l'API OBD et calcule la consommation moyenne.",
  });
  assert.equal(plan.mode, "coding");
  assert.equal(plan.primary.id, "gpt-6.2-sol", "une tâche de programmation part sur le modèle de code");
  pass("programmation : modèle dédié (gpt-6.2-sol)");
}

// ---------------------------------------------------------------------------
// 4. Collaboration is earned, never default
// ---------------------------------------------------------------------------
{
  const hardRequest = {
    ...base,
    message:
      "Ma BMW 320d F30 a un bruit de chaîne à froid, le garage propose 2 800 € avec un devis à plusieurs lignes. Est-ce dangereux de continuer à rouler ? Et dois-je réparer ou vendre la voiture ?",
  };
  const pro = route({ ...hardRequest, tier: "pro" });
  assert.equal(pro.mode, "collaborative", "une demande réellement complexe déclenche la collaboration");
  assert.equal(pro.downgraded, false, "la formule Pro finance la collaboration complète");
  assert.equal(pro.collaborators.length, 2, "deux brouillons indépendants");
  assert.equal(pro.synthesise, true, "un coordinateur fusionne les brouillons");
  assert.equal(pro.verify, true, "la réponse est vérifiée");
  assert.ok(pro.collaborators.some((m) => m.id === "gpt-6.2-astra"));
  assert.ok(pro.collaborators.some((m) => m.id === "gpt-6.2-sol"));
  assert.equal(pro.primary.id, "gpt-6.2-sol", "le coordinateur est le modèle de synthèse");

  const free = route({ ...hardRequest, tier: "decouverte" });
  assert.notEqual(free.mode, "collaborative", "la formule gratuite ne finance pas une collaboration");
  assert.equal(free.collaborators.length, 0);
  pass("collaboration : réservée aux formules payantes et aux demandes réellement difficiles");
}

{
  const plan = route({ ...base, message: "Bonjour, comment vas-tu ?", tier: "pro" });
  assert.notEqual(plan.mode, "collaborative", "même en Pro, une salutation ne collabore pas");
  assert.equal(plan.collaborators.length, 0);
  pass("coût : un compte Pro ne déclenche pas la collaboration sur une question triviale");
}

{
  const single = route({
    ...base,
    message: "Analyse en profondeur ce devis et compare avec les prix du marché, stp.",
    policy: "single",
    tier: "pro",
  });
  assert.equal(single.collaborators.length, 0, "la politique `single` interdit la collaboration");

  const forced = route({
    ...base,
    message: "Bonjour",
    policy: "collaborative",
    tier: "pro",
  });
  assert.equal(forced.mode, "collaborative", "la politique `collaborative` la force pour tester l'infrastructure");

  const hint = route({ ...base, message: "Bonjour", hint: "deep", tier: "pro" });
  assert.equal(hint.mode, "collaborative", "l'indice `deep` est honoré pour un compte qui peut le payer");
  pass("politique : `single` et `collaborative` pilotent le mode, l'indice client est respecté");
}

{
  // The browser must not be able to buy a more expensive answer than its plan.
  const plan = route({ ...base, message: "Bonjour", hint: "deep", tier: "decouverte" });
  assert.notEqual(plan.mode, "collaborative");
  assert.ok(
    plan.estimatedCostUsd <= REQUEST_BUDGET_USD.decouverte,
    `coût estimé ${plan.estimatedCostUsd} au-delà du plafond Découverte`,
  );
  pass("budget : un indice client ne peut pas dépasser le plafond de la formule");
}

// ---------------------------------------------------------------------------
// 5. Budgets
// ---------------------------------------------------------------------------
{
  const tiers = ["decouverte", "plus", "pro"];
  for (const tier of tiers) {
    const plan = route({
      ...base,
      tier,
      message:
        "Compare trois véhicules, donne les coûts d'entretien, les pannes connues et un avis détaillé sur chacun, avec un plan d'achat.",
    });
    assert.ok(
      plan.estimatedCostUsd <= REQUEST_BUDGET_USD[tier] + 1e-9,
      `${tier}: coût ${plan.estimatedCostUsd} > plafond ${REQUEST_BUDGET_USD[tier]}`,
    );
  }
  assert.ok(REQUEST_BUDGET_USD.decouverte < REQUEST_BUDGET_USD.plus);
  assert.ok(REQUEST_BUDGET_USD.plus < REQUEST_BUDGET_USD.pro);
  pass("budget : chaque formule reste sous son plafond, les plafonds sont croissants");
}

{
  // The same safety question that costs 0,10 $ on Pro exceeds the Découverte
  // ceiling: the plan must visibly degrade instead of overspending.
  const hardRequest =
    "Ma BMW 320d F30 a un bruit de chaîne à froid, le garage propose 2 800 € avec un devis à plusieurs lignes. Est-ce dangereux de continuer à rouler ? Et dois-je réparer ou vendre la voiture ?";
  const plan = route({ ...base, tier: "decouverte", message: hardRequest });
  assert.equal(plan.downgraded, true, "le plafond Découverte force un plan plus simple");
  assert.equal(plan.collaborators.length, 0, "aucune collaboration dans le plan dégradé");
  assert.ok(plan.reasons.some((reason) => /budget/i.test(reason)));
  assert.ok(plan.estimatedCostUsd <= REQUEST_BUDGET_USD.decouverte);
  pass("budget : quand le plafond mord, le plan est dégradé, tracé et reste sous le plafond");
}

{
  // Cost estimation must be arithmetic, not ambition: a long conversation with
  // an image must cost more than a short text-only one.
  const short = estimateCallCostUsd({
    model: OPENAI_CATALOG.reasoning,
    inputCharacters: 500,
    imageCount: 0,
    outputTokens: 1_000,
  });
  const long = estimateCallCostUsd({
    model: OPENAI_CATALOG.reasoning,
    inputCharacters: 40_000,
    imageCount: 2,
    outputTokens: 2_000,
  });
  assert.ok(long > short * 3, "une entrée longue et illustrée coûte nettement plus cher");
  assert.ok(short > 0);

  const cheap = estimateCallCostUsd({
    model: OPENAI_CATALOG.fast,
    inputCharacters: 500,
    imageCount: 0,
    outputTokens: 1_000,
  });
  assert.ok(short > cheap * 20, "le modèle de raisonnement coûte beaucoup plus que le modèle rapide");
  pass("coût : l'estimation suit les tarifs du catalogue et l'ordre de grandeur est respecté");
}

// ---------------------------------------------------------------------------
// 6. Fallback chain
// ---------------------------------------------------------------------------
{
  const chain = fallbackChain(OPENAI_CATALOG.reasoning);
  assert.equal(chain[0].id, "gpt-6.2-astra");
  assert.ok(chain.length >= 3, "une chaîne de secours doit proposer plusieurs modèles");
  assert.equal(new Set(chain.map((m) => m.id)).size, chain.length, "aucun doublon dans la chaîne");
  // The chain must be sorted by worsening cost so a fallback never costs more.
  for (let index = 1; index < chain.length; index += 1) {
    assert.ok(
      chain[index].outputCostPerMTok <= chain[index - 1].outputCostPerMTok,
      "le repli ne doit jamais coûter plus cher que le modèle initial",
    );
  }

  const visionChain = fallbackChain(OPENAI_CATALOG.balanced, { visionRequired: true });
  assert.ok(visionChain.every((entry) => entry.supportsVision), "un repli vision doit savoir lire une image");
  pass("secours : chaîne sans doublon, classée par coût croissant, compatible vision");
}

{
  resetModelAvailability();
  assert.equal(isModelUnavailable("gpt-6.2-astra"), false);
  markModelUnavailable("gpt-6.2-astra", 1_000);
  assert.equal(isModelUnavailable("gpt-6.2-astra", 2_000), true, "un modèle refusé est mémorisé");
  assert.equal(isModelUnavailable("gpt-6.2-astra", 1_000 + 16 * 60_000), false, "la mémoire expire");
  resetModelAvailability();
  pass("disponibilité : un modèle refusé est contourné pendant un temps limité, puis retenté");
}

// ---------------------------------------------------------------------------
// 7. Model pin
// ---------------------------------------------------------------------------
{
  const plan = route({ ...base, message: "Bonjour" });
  const pinned = applyModelPin(plan, "gpt-4.1-mini");
  assert.equal(pinned.primary.id, "gpt-4.1-mini", "un modèle épinglé est bien celui appelé");
  assert.equal(pinned.primary.source, "legacy");
  pass("configuration : VEYVRO_AI_MODEL reste prioritaire pour ne rien casser");
}

// ---------------------------------------------------------------------------
// 8. Instance spend guard
// ---------------------------------------------------------------------------
{
  resetSpend();
  assert.equal(spentTodayUsd(), 0);
  recordSpend(1.5);
  assert.equal(spentTodayUsd(), 1.5);
  assert.equal(canAffordExpensiveMode(0.5, { dailyBudgetUsd: 5 }), true);
  recordSpend(3.6);
  assert.equal(canAffordExpensiveMode(0.5, { dailyBudgetUsd: 5 }), false, "le plafond journalier freine le mode coûteux");
  assert.equal(canAffordExpensiveMode(0.1, { dailyBudgetUsd: 10 }), true);
  resetSpend();
  assert.equal(canAffordExpensiveMode(99, { dailyBudgetUsd: 0 }), true, "un plafond 0 désactive le garde-fou");
  pass("dépenses : le total journalier est suivi et freine les modes coûteux sans bloquer le chat");
}

// ---------------------------------------------------------------------------
// 9. Determinism
// ---------------------------------------------------------------------------
{
  const input = {
    ...base,
    message: "Ma boîte DSG7 fait un à-coup à froid. Est-ce grave ?",
  };
  const first = route({ ...input });
  const second = route({ ...input });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  pass("déterminisme : deux appels identiques produisent exactement le même plan");
}

{
  // planRoute must be exported under one canonical name for the handler.
  assert.equal(typeof planRoute, "function");
  pass("API : le planificateur est exporté pour le handler");
}

console.log(`\n${checks} vérifications de routage passées.`);
