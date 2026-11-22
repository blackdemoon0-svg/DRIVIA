/**
 * Request routing for VEYVRO — which model answers, and at what price.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────
 * "Which gearbox is in a Golf GTI?" and "my 2015 1.2 PureTech rattles cold, the
 * garage wants 1,400 € for a timing belt, is that fair, and should I buy the car
 * anyway?" are not the same request. Sending both to a flagship reasoning model
 * wastes money on the first and, conversely, sending both to the cheapest model
 * gives the second a shallow, unconvincing answer.
 *
 * This module reads the request — not the browser's claims about it — and
 * decides:
 *   • which class of model should answer (fast / balanced / coding / reasoning),
 *   • whether one model is enough or several should work together,
 *   • whether the answer must be checked before it is shown,
 *   • how much output is worth paying for,
 *   • and whether the plan's cost budget even allows that.
 *
 * It is a pure function of its input: no network, no clock, no randomness. That
 * makes it fully testable, which is the point — routing bugs are expensive in
 * both directions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRINCIPLE: CHEAP BY DEFAULT, EXPENSIVE ON EVIDENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every route starts cheap. Signals must *accumulate* to justify a costlier
 * model, and a costlier route is only taken when the account paying for it can
 * afford it. A Découverte request never triggers a four-model collaboration.
 */

import {
  OPENAI_CATALOG,
  describeModel,
  type ModelEntry,
  type ReasoningEffort,
} from "./modelCatalog.js";

export type RouteMode = "fast" | "balanced" | "coding" | "reasoning" | "collaborative";

export type RoutingTier = "decouverte" | "plus" | "pro";

export type RouteSignals = {
  /** Words in the latest user message. */
  length: number;
  questionMarks: number;
  /** Explicit comparison ("vs", "compare", "différence entre"). */
  comparison: boolean;
  /** Diagnostic / reliability / cost / purchase reasoning. */
  analysis: boolean;
  /** Safety-critical automotive system named. */
  safety: boolean;
  /** Code, diagnostics protocol, log or calculation request. */
  coding: boolean;
  /** Several distinct asks in one message. */
  multiPart: boolean;
  /** Conversation already carries context (follow-up question). */
  followUp: boolean;
  /** A document was attached (garage quote / invoice). */
  document: boolean;
  /** Open-ended opinion request ("what would you pick"). */
  openEnded: boolean;
};

export type RouteInput = {
  /** Latest user message, already trimmed and length-capped by the caller. */
  message: string;
  /** Number of earlier messages kept in the conversation. */
  historyLength: number;
  /** Whether the request carries attachments. */
  hasAttachments: boolean;
  /** Whether the request is a garage-quote analysis task. */
  isQuoteAnalysis: boolean;
  /** Plan of the authenticated caller — decides the cost budget. */
  tier: RoutingTier;
  /** Optional caller hint: "fast" | "balanced" | "deep" (already validated). */
  hint?: "fast" | "balanced" | "deep";
  /** Operator override: VEYVRO_AI_ROUTING. */
  policy?: RoutingPolicy;
};

/** Operator-level switch, from VEYVRO_AI_ROUTING. */
export type RoutingPolicy = "auto" | "single" | "collaborative";

export type RoutePlan = {
  mode: RouteMode;
  /** Model asked to answer first. */
  primary: ModelEntry;
  /** Models used in parallel, in order (collaborative mode only). */
  collaborators: ModelEntry[];
  /** Models used to check the answer, if any. */
  verifiers: ModelEntry[];
  /** Reasoning effort requested from the primary model. */
  effort: ReasoningEffort;
  /** Output token ceiling for the primary answer. */
  maxOutputTokens: number;
  /** Whether the coordinator rewrites the collaborators into one answer. */
  synthesise: boolean;
  /** Whether a verification pass runs and may append a correction. */
  verify: boolean;
  /** Price ceiling for this request, in USD. */
  budgetUsd: number;
  /** Rough pre-flight cost estimate for the whole plan, in USD. */
  estimatedCostUsd: number;
  /** True when the budget forced a cheaper plan than the signals suggested. */
  downgraded: boolean;
  /** Human-readable justification, surfaced in logs and the `done` event. */
  reasons: string[];
  signals: RouteSignals;
};

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Price ceilings per request, by plan.
 *
 * They are deliberately generous enough for a full collaboration on Pro and
 * tight enough that a Découverte account cannot spend like a Pro one. Values
 * are USD, estimated from the catalog prices: no billing call is made.
 */
export const REQUEST_BUDGET_USD: Record<RoutingTier, number> = {
  decouverte: 0.03,
  plus: 0.12,
  pro: 0.3,
};

/**
 * Output ceilings. A chat answer longer than ~1,200 tokens is almost always
 * padded; documents and deep analyses get room.
 */
const OUTPUT_TOKENS: Record<string, number> = {
  fast: 700,
  balanced: 1_200,
  coding: 1_600,
  reasoning: 2_000,
  collaborative: 2_400,
  quote: 2_400,
};

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

const COMPARISON_PATTERNS = [
  /\bvs\b\.?/i,
  /\bversus\b/i,
  /\bcompar(?:e|er|aison|atif)\b/i,
  /\bdiff[ée]rence/i,
  /\bquel(?:le)?\s+(?:est|es)\s+(?:le|la|les)\s+(?:meilleur|mieux)/i,
  /\bmieux\s+que\b/i,
  /\b(?:plut[oô]t|ou bien)\b/i,
  /\bchoisir\s+entre\b/i,
  /\bwhich\s+(?:one|is better|would you)\b/i,
  /\bbetter\s+than\b/i,
];

const ANALYSIS_PATTERNS = [
  /\bpourquoi\b/i,
  /\bexplique[rz]?\b/i,
  /\banaly[sz]/i,
  /\bdiagnostic\b/i,
  /\bpanne\b/i,
  /\bbruit\b/i,
  /\bsympt[oô]me/i,
  /\bfiabilit[ée]\b/i,
  /\bentretien\b/i,
  /\bco[uû]t\b/i,
  /\bprix\b/i,
  /\bbudget\b/i,
  /\bdevis\b/i,
  /\bfacture\b/i,
  /\bacheter\b/i,
  /\boccasion\b/i,
  /\b(?:vaut|valent)\s+(?:le|la)\s+peine\b/i,
  /\bwhy\b/i,
  /\bexplain\b/i,
  /\bdiagnos/i,
  /\breliab/i,
  /\bmaintenance\b/i,
  /\bcost\b/i,
  /\bworth\b/i,
];

const SAFETY_PATTERNS = [
  /\bfrein/i,
  /\bdirection\b/i,
  /\bairbag/i,
  /\bbatterie\s+(?:haute|ht)\b/i,
  /\bhaute\s+tension\b/i,
  /\bsurchauff/i,
  /\boverheat/i,
  /\bfuite\b/i,
  /\bleak\b/i,
  // « fume blanc », « ça fume », « fumée » : un symptôme d'échappement ou de
  // refroidissement, jamais un détail cosmétique.
  /\bfum(?:e|é|ée|er|ant|age)\b/i,
  /\bsmoke\b/i,
  // « elle chauffe », « il chauffe » : surchauffe probable à froid ou en charge.
  /\bchauffe\b/i,
  /\boverheating\b/i,
  /\bincendie\b/i,
  /\bfire\b/i,
  /\b[ée]clat/i,
  /\bbloqu/i,
  /\bperte\s+de\s+contr[oô]le\b/i,
  /\bdangereu/i,
  /\bdangerous\b/i,
  /\bunsafe\b/i,
  /\bvoyant\s+rouge\b/i,
];

const CODING_PATTERNS = [
  /\bcode\b/i,
  /\bscript\b/i,
  /\bpython\b/i,
  /\bjavascript\b/i,
  /\btypescript\b/i,
  /\bregex\b/i,
  /\bjson\b/i,
  /\bsql\b/i,
  /\bapi\b/i,
  /\balgorithm/i,
  /\bobd\b/i,
  /\bdtc\b/i,
  /\bcan\s*bus\b/i,
  /\becu\b/i,
  /\bmapping\b/i,
  /\bformule\b/i,
  /\bcalcul(?:e|er|s)?\b/i,
  /\blog(?:s)?\b/i,
  /\bpython|excel\b/i,
];

const OPEN_ENDED_PATTERNS = [
  /\bque\s+(?:me\s+)?conseille/i,
  /\bwhat\s+would\s+you\b/i,
  /\bton\s+avis\b/i,
  /\byour\s+opinion\b/i,
  /\bwhat\s+should\s+i\b/i,
  /\bqu'est-ce\s+que\s+tu\s+choisirais/i,
  /\bwhat\s+do\s+you\s+recommend\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Count independent asks: several question marks or an enumeration. */
function looksMultiPart(text: string): boolean {
  const questionMarks = (text.match(/\?/g) ?? []).length;
  if (questionMarks >= 2) return true;
  if (/^\s*(?:[-*•]|\d+[.)])\s+/m.test(text)) return true;
  if (/\b(?:et\s+aussi|and also|en\s+plus|de\s+plus)\b/i.test(text)) return true;
  return false;
}

export function extractSignals(input: {
  message: string;
  historyLength: number;
  hasAttachments: boolean;
  isQuoteAnalysis: boolean;
}): RouteSignals {
  const text = input.message;
  return {
    length: text.length,
    questionMarks: (text.match(/\?/g) ?? []).length,
    comparison: matchesAny(text, COMPARISON_PATTERNS),
    analysis: matchesAny(text, ANALYSIS_PATTERNS),
    safety: matchesAny(text, SAFETY_PATTERNS),
    coding: matchesAny(text, CODING_PATTERNS),
    multiPart: looksMultiPart(text),
    followUp: input.historyLength > 0 && /\b(?:il|elle|celui|celle|ça|it|that|those|them)\b/i.test(text),
    document: input.hasAttachments || input.isQuoteAnalysis,
    openEnded: matchesAny(text, OPEN_ENDED_PATTERNS),
  };
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** Rough token count used for budgeting only: ~4 characters per token. */
export function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

/** Fixed overhead of a chat call: system prompt plus image detail tiles. */
const SYSTEM_PROMPT_TOKENS = 1_450;
const IMAGE_INPUT_TOKENS = 1_200;

export type CostEstimateInput = {
  model: ModelEntry;
  /** Characters of the conversation sent as input. */
  inputCharacters: number;
  imageCount: number;
  /** Output tokens the answer may use. */
  outputTokens: number;
};

export function estimateCallCostUsd(input: CostEstimateInput): number {
  const promptTokens =
    SYSTEM_PROMPT_TOKENS +
    estimateTokens(input.inputCharacters) +
    input.imageCount * IMAGE_INPUT_TOKENS;
  const inputCost = (promptTokens / 1_000_000) * input.model.inputCostPerMTok;
  const outputCost = (input.outputTokens / 1_000_000) * input.model.outputCostPerMTok;
  return inputCost + outputCost;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** How much each signal says "this is hard". */
function difficultyScore(signals: RouteSignals): number {
  let score = 0;
  if (signals.length > 400) score += 1;
  if (signals.length > 900) score += 1;
  if (signals.multiPart) score += 2;
  if (signals.comparison) score += 1;
  if (signals.analysis) score += 1;
  if (signals.safety) score += 2;
  if (signals.coding) score += 1;
  if (signals.document) score += 1;
  if (signals.openEnded) score += 1;
  if (signals.followUp) score += 0;
  return score;
}

/** A short greeting or a single factual question: no sophistication needed. */
function isTrivial(signals: RouteSignals): boolean {
  return (
    signals.length <= 160 &&
    !signals.comparison &&
    !signals.safety &&
    !signals.coding &&
    !signals.multiPart &&
    !signals.document &&
    !(signals.analysis && signals.length > 90)
  );
}

function pickPrimary(mode: RouteMode): ModelEntry {
  // Every catalog model accepts image input, so the mode alone decides the
  // model; the fallback chain still filters on vision support.
  switch (mode) {
    case "fast":
      return OPENAI_CATALOG.fast;
    case "balanced":
      return OPENAI_CATALOG.balanced;
    case "coding":
      return OPENAI_CATALOG.coding;
    case "reasoning":
      return OPENAI_CATALOG.reasoning;
    case "collaborative":
      return OPENAI_CATALOG.reasoning;
  }
}

function effortFor(mode: RouteMode, model: ModelEntry): ReasoningEffort {
  if (!model.isReasoning) return model.defaultEffort;
  switch (mode) {
    case "fast":
      return model.rejectsNoReasoningEffort ? "low" : "low";
    case "balanced":
      return model.rejectsNoReasoningEffort ? "low" : "low";
    case "coding":
      return "medium";
    case "reasoning":
      return "high";
    case "collaborative":
      return "high";
  }
}

/**
 * Decide the route.
 *
 * The function is deterministic, so the collaboration tests can assert exact
 * plans for representative automotive requests.
 */
export function planRoute(input: RouteInput): RoutePlan {
  const signals = extractSignals(input);
  const budgetUsd = REQUEST_BUDGET_USD[input.tier] ?? REQUEST_BUDGET_USD.decouverte;
  const difficulty = difficultyScore(signals);
  const reasons: string[] = [];

  // ── Collaborative mode is opt-in and expensive: it needs real evidence ────
  const policy = input.policy ?? "auto";
  const collaborationAllowed = policy !== "single" && input.tier !== "decouverte";
  // A document analysis is expensive to read once, so it is deliberately *not*
  // a collaboration trigger: it gets one strong vision model plus a
  // verification pass instead of three full drafts.
  const wantsCollaboration =
    policy === "collaborative" ||
    input.hint === "deep" ||
    (difficulty >= 5 && collaborationAllowed);

  let mode: RouteMode;
  if (wantsCollaboration && collaborationAllowed) {
    mode = "collaborative";
    reasons.push("plusieurs signaux de difficulté : collaboration de modèles");
  } else if (signals.safety) {
    mode = "reasoning";
    reasons.push("sujet de sécurité : modèle de raisonnement");
  } else if (signals.coding) {
    mode = "coding";
    reasons.push("demande de calcul, de code ou de diagnostic technique");
  } else if (isTrivial(signals) || input.hint === "fast") {
    mode = "fast";
    reasons.push("question simple : réponse rapide et économique");
  } else if (difficulty >= 3) {
    mode = "reasoning";
    reasons.push("analyse détaillée demandée");
  } else {
    mode = "balanced";
    reasons.push("question standard : modèle équilibré");
  }

  if (input.isQuoteAnalysis) {
    // A garage quote is a document read for money: never the cheap path, and
    // always double-checked when the plan can pay for it.
    if (mode !== "collaborative") mode = "coding";
    reasons.push("analyse de devis : lecture prudente par un modèle de raisonnement");
  }

  let primary = pickPrimary(mode);
  let effort = effortFor(mode, primary);
  let outputTokens =
    input.isQuoteAnalysis ? OUTPUT_TOKENS.quote : OUTPUT_TOKENS[mode];

  let collaborators: ModelEntry[] = [];
  let verifiers: ModelEntry[] = [];
  let synthesise = false;
  let verify = false;

  if (mode === "collaborative") {
    // Two different models draft independently, a coordinator merges them.
    // Astra + Sol disagree in useful ways; the coordinator is Sol, which is
    // strong at synthesis and 4x cheaper than Astra on output.
    collaborators = [OPENAI_CATALOG.reasoning, OPENAI_CATALOG.coding];
    synthesise = true;
    verify = true;
    verifiers = [OPENAI_CATALOG.balanced];
    primary = OPENAI_CATALOG.coordinator;
    effort = "medium";
    outputTokens = OUTPUT_TOKENS.collaborative;
  } else if (mode === "reasoning") {
    verify = signals.safety || signals.document;
    if (verify) verifiers = [OPENAI_CATALOG.balanced];
  } else if (mode === "coding") {
    verify = signals.coding && (signals.multiPart || signals.safety);
    if (verify) verifiers = [OPENAI_CATALOG.fast];
  }

  if (input.isQuoteAnalysis && mode !== "collaborative" && verifiers.length === 0) {
    // Second pair of eyes on a document read for money — but only when the plan
    // can pay for it; the budget stages below remove it otherwise.
    verify = true;
    verifiers = [OPENAI_CATALOG.balanced];
  }

  // ── Budget check ─────────────────────────────────────────────────────────
  const inputCharacters =
    input.message.length + Math.max(0, input.historyLength) * 400;
  const imageCount = input.hasAttachments ? 1 : 0;

  const estimateFor = (
    primaryModel: ModelEntry,
    draftModels: ModelEntry[],
    verifyModel: ModelEntry | undefined,
    tokens: number,
  ) => {
    let total = estimateCallCostUsd({
      model: primaryModel,
      inputCharacters,
      imageCount,
      outputTokens: tokens,
    });
    for (const draft of draftModels) {
      total += estimateCallCostUsd({
        model: draft,
        inputCharacters,
        imageCount,
        outputTokens: Math.round(tokens * 0.6),
      });
    }
    if (verifyModel) {
      total += estimateCallCostUsd({
        model: verifyModel,
        // The verifier reads the finished answer as well as the request, so the
        // draft length is part of its input — ignored estimates understate cost.
        inputCharacters: inputCharacters + Math.round(tokens * 4),
        imageCount,
        outputTokens: 600,
      });
    }
    return total;
  };

  let estimatedCostUsd = estimateFor(
    primary,
    collaborators,
    verifiers.length > 0 ? verifiers[0] : undefined,
    outputTokens,
  );
  let downgraded = false;

  if (estimatedCostUsd > budgetUsd) {
    downgraded = true;
    reasons.push("budget de la formule atteint : repli sur un plan plus économique");
    const visionNeeded = input.hasAttachments || input.isQuoteAnalysis;

    // Stage 1: keep the answer, drop the collaboration. Safety still gets the
    // reasoning model; everything else falls to the coding model — or to the
    // vision-balanced one when a document has to be read.
    if (collaborators.length > 0) {
      collaborators = [];
      synthesise = false;
      mode = signals.safety ? "reasoning" : "coding";
      primary = visionNeeded ? OPENAI_CATALOG.balanced : pickPrimary(mode);
      effort = effortFor(mode, primary);
      outputTokens = input.isQuoteAnalysis ? OUTPUT_TOKENS.quote : OUTPUT_TOKENS[mode];
      estimatedCostUsd = estimateFor(primary, [], verifiers[0], outputTokens);
    }
    // Stage 2: keep the model class, drop verification.
    if (estimatedCostUsd > budgetUsd && verifiers.length > 0) {
      verifiers = [];
      verify = false;
      estimatedCostUsd = estimateFor(primary, [], undefined, outputTokens);
    }
    // Stage 3: drop to the balanced model at a lower output ceiling.
    if (estimatedCostUsd > budgetUsd) {
      primary = OPENAI_CATALOG.balanced;
      mode = "balanced";
      effort = effortFor(mode, primary);
      outputTokens = Math.min(outputTokens, OUTPUT_TOKENS.balanced);
      estimatedCostUsd = estimateFor(primary, [], undefined, outputTokens);
    }
    // Stage 4: the cheapest model, shortest output.
    if (estimatedCostUsd > budgetUsd) {
      primary = OPENAI_CATALOG.fast;
      mode = "fast";
      effort = effortFor(mode, primary);
      outputTokens = Math.min(outputTokens, OUTPUT_TOKENS.fast);
      estimatedCostUsd = estimateFor(primary, [], undefined, outputTokens);
    }
  }

  // The provider caps output per model; respect it.
  outputTokens = Math.max(256, Math.min(outputTokens, primary.maxOutputTokens));

  return {
    mode,
    primary,
    collaborators,
    verifiers,
    effort,
    maxOutputTokens: outputTokens,
    synthesise,
    verify,
    budgetUsd,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(5)),
    downgraded,
    reasons,
    signals,
  };
}

/**
 * Resolve an explicit VEYVRO_AI_MODEL pin.
 *
 * An operator who pins a model gets that model — the routing still decides
 * effort, output ceiling and whether a second model checks the answer, because
 * those never change which model is called first.
 */
export function applyModelPin(plan: RoutePlan, pinnedModelId: string): RoutePlan {
  const pinned = describeModel(pinnedModelId);
  return {
    ...plan,
    primary: pinned,
    collaborators: plan.collaborators.map(() => pinned),
    effort: pinned.isReasoning ? plan.effort : pinned.defaultEffort,
  };
}
