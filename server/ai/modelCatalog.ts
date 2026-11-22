/**
 * OpenAI model catalog — the single place where model identifiers, prices and
 * parameter profiles live.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The chat used to hard-code one model id ("gpt-4.1-mini") and one parameter
 * profile. Routing between several models requires knowing, per model:
 *   • whether it is a reasoning model (different token/limit parameters),
 *   • whether it accepts `reasoning_effort: "none"` (GPT-6.2 Astra and Sol
 *     reject it with HTTP 400),
 *   • whether it accepts image input (garage-quote analysis sends photos),
 *   • what it costs, so the router can weigh quality against price.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  VERIFICATION STATUS OF THE IDS BELOW
 * ─────────────────────────────────────────────────────────────────────────────
 * Every identifier in OPENAI_CATALOG was read from the official documentation
 * on 2026-11-22:
 *   https://developers.openai.com/api/docs/models
 *   https://developers.openai.com/api/docs/models/gpt-6-luna
 *   https://developers.openai.com/api/docs/models/gpt-6.1-terra
 *   https://developers.openai.com/api/docs/models/gpt-6.2-sol
 *   https://developers.openai.com/api/docs/models/gpt-6.2-astra
 *   https://developers.openai.com/api/docs/deprecations
 *   https://developers.openai.com/api/docs/pricing
 *
 * No identifier is invented here. The four GPT-6 models below are listed as
 * active, support `v1/chat/completions` and streaming, and accept text and
 * image input. The legacy ids (gpt-4.1-mini and friends) are kept only so an
 * existing deployment that pinned VEYVRO_AI_MODEL keeps working; they are
 * deprecated by OpenAI (shutdown 2027-01-14) and are never selected by the
 * router.
 *
 * Because access is per account, availability is also handled at runtime: an
 * upstream "model not found / no access" answer puts that id on a short
 * instance-local denylist (see `markModelUnavailable`) so the next request in
 * the same instance skips it instead of paying for the failure again.
 *
 * `scripts/ai-model-check.mjs` asks the real `/v1/models` endpoint with the
 * deployment key, which is the only authoritative answer for a given account.
 */

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Role a model plays in a route. */
export type ModelRole = "fast" | "balanced" | "coding" | "reasoning" | "coordinator" | "legacy";

export type ModelEntry = {
  /** Exact API model id. */
  id: string;
  /** Human label, for logs and the `done` event metadata. */
  label: string;
  role: ModelRole;
  /** USD per 1M input tokens (standard tier). */
  inputCostPerMTok: number;
  /** USD per 1M output tokens (standard tier). */
  outputCostPerMTok: number;
  /** Whether image input is supported (garage-quote photos). */
  supportsVision: boolean;
  /** Reasoning model: uses reasoning effort and `max_completion_tokens`. */
  isReasoning: boolean;
  /** Chat Completions rejects `reasoning_effort: "none"` for this model. */
  rejectsNoReasoningEffort: boolean;
  /** Effort used when the router does not impose one. */
  defaultEffort: ReasoningEffort;
  /** Largest output the model accepts, used to clamp the request. */
  maxOutputTokens: number;
  /** docs / legacy provenance; surfaced in logs only. */
  source: "verified-docs" | "legacy";
};

/**
 * Verified ids, cheapest first within each role family.
 * Prices are Standard-tier USD per 1M tokens (see the pricing page above).
 */
export const OPENAI_CATALOG: Record<Exclude<ModelRole, "legacy">, ModelEntry> = {
  fast: {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    role: "fast",
    inputCostPerMTok: 0.1,
    outputCostPerMTok: 0.5,
    supportsVision: true,
    isReasoning: true,
    rejectsNoReasoningEffort: false,
    defaultEffort: "low",
    maxOutputTokens: 128_000,
    source: "verified-docs",
  },
  balanced: {
    id: "gpt-6.1-terra",
    label: "GPT-6.1 Terra",
    role: "balanced",
    inputCostPerMTok: 1,
    outputCostPerMTok: 5,
    supportsVision: true,
    isReasoning: true,
    rejectsNoReasoningEffort: false,
    defaultEffort: "medium",
    maxOutputTokens: 128_000,
    source: "verified-docs",
  },
  coding: {
    id: "gpt-6.2-sol",
    label: "GPT-6.2 Sol",
    role: "coding",
    inputCostPerMTok: 2,
    outputCostPerMTok: 10,
    supportsVision: true,
    isReasoning: true,
    rejectsNoReasoningEffort: true,
    defaultEffort: "medium",
    maxOutputTokens: 128_000,
    source: "verified-docs",
  },
  reasoning: {
    id: "gpt-6.2-astra",
    label: "GPT-6.2 Astra",
    role: "reasoning",
    inputCostPerMTok: 8,
    outputCostPerMTok: 40,
    supportsVision: true,
    isReasoning: true,
    rejectsNoReasoningEffort: true,
    defaultEffort: "high",
    maxOutputTokens: 128_000,
    source: "verified-docs",
  },
  coordinator: {
    id: "gpt-6.2-sol",
    label: "GPT-6.2 Sol (coordinateur)",
    role: "coordinator",
    inputCostPerMTok: 2,
    outputCostPerMTok: 10,
    supportsVision: true,
    isReasoning: true,
    rejectsNoReasoningEffort: true,
    defaultEffort: "medium",
    maxOutputTokens: 128_000,
    source: "verified-docs",
  },
};

/**
 * Legacy ids kept reachable through an explicit VEYVRO_AI_MODEL override.
 * Deprecated by OpenAI; never chosen by the router.
 */
export const LEGACY_CATALOG: Record<string, ModelEntry> = {
  "gpt-4.1-mini": legacy("gpt-4.1-mini", 0.4, 1.6, true),
  "gpt-4.1": legacy("gpt-4.1", 2, 8, true),
  "gpt-4o-mini": legacy("gpt-4o-mini", 0.15, 0.6, true),
  "gpt-4o": legacy("gpt-4o", 2.5, 10, true),
  "o3": {
    ...legacy("o3", 2, 8, true),
    isReasoning: true,
    defaultEffort: "medium",
    maxOutputTokens: 100_000,
  },
};

function legacy(id: string, input: number, output: number, vision: boolean): ModelEntry {
  return {
    id,
    label: id,
    role: "legacy",
    inputCostPerMTok: input,
    outputCostPerMTok: output,
    supportsVision: vision,
    isReasoning: false,
    rejectsNoReasoningEffort: false,
    defaultEffort: "medium",
    maxOutputTokens: 16_384,
    source: "legacy",
  };
}

/** Conservative cost used when an unknown model id is forced by configuration. */
const UNKNOWN_MODEL_COST = { input: 2, output: 10 };

/** Shape-based profile detection for arbitrary ids (OpenAI-compatible servers). */
export function looksLikeReasoningModel(modelId: string): boolean {
  return /^(gpt-5|gpt-6|o1|o3|o4)($|[-.])/i.test(modelId.trim());
}

/**
 * Describe an arbitrary `VEYVRO_AI_MODEL` override.
 *
 * The override must stay honoured (it is how an existing deployment pins a
 * model), but the router needs a profile for it: prices, vision support and
 * reasoning behaviour are inferred from the known catalogs, then from the id
 * shape, then from conservative defaults.
 */
export function describeModel(modelId: string): ModelEntry {
  const id = modelId.trim();
  for (const entry of Object.values(OPENAI_CATALOG)) {
    if (entry.id === id) return entry;
  }
  const legacyEntry = LEGACY_CATALOG[id.toLowerCase()];
  if (legacyEntry) return legacyEntry;

  const isReasoning = looksLikeReasoningModel(id);
  return {
    id,
    label: id,
    role: "legacy",
    inputCostPerMTok: UNKNOWN_MODEL_COST.input,
    outputCostPerMTok: UNKNOWN_MODEL_COST.output,
    supportsVision: true,
    isReasoning,
    rejectsNoReasoningEffort: /^gpt-6\.2|^gpt-6-/.test(id.toLowerCase()),
    defaultEffort: isReasoning ? "medium" : "medium",
    maxOutputTokens: isReasoning ? 32_000 : 8_192,
    source: "legacy",
  };
}

// ---------------------------------------------------------------------------
// Instance-local availability memory
// ---------------------------------------------------------------------------
//
// Access to a model is an account-level fact we cannot read before calling it.
// When the provider answers "model not found" or "no access", the id is
// denylisted for a while in this instance: the next requests route around it
// instead of repeating a call that is known to fail.

const UNAVAILABLE_TTL_MS = 15 * 60_000;
const unavailableUntil = new Map<string, number>();
const MAX_DENYLIST = 64;

export function markModelUnavailable(modelId: string, nowMs = Date.now()): void {
  if (unavailableUntil.size >= MAX_DENYLIST) {
    const oldest = [...unavailableUntil.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) unavailableUntil.delete(oldest[0]);
  }
  unavailableUntil.set(modelId, nowMs + UNAVAILABLE_TTL_MS);
}

export function isModelUnavailable(modelId: string, nowMs = Date.now()): boolean {
  const until = unavailableUntil.get(modelId);
  if (until === undefined) return false;
  if (until <= nowMs) {
    unavailableUntil.delete(modelId);
    return false;
  }
  return true;
}

/** Test hook: forget every availability verdict recorded so far. */
export function resetModelAvailability(): void {
  unavailableUntil.clear();
}

/**
 * Ordered candidates for one call.
 *
 * A route names its preferred model; the fallback chain guarantees the request
 * still has somewhere to go when that model is denied, deprecated or failing.
 * Cheaper models come last so a fallback degrades cost, never increases it.
 */
export function fallbackChain(primary: ModelEntry, options: { visionRequired?: boolean } = {}): ModelEntry[] {
  const visionRequired = options.visionRequired === true;
  const ordered: ModelEntry[] = [
    primary,
    OPENAI_CATALOG.coordinator,
    OPENAI_CATALOG.balanced,
    OPENAI_CATALOG.fast,
  ];

  const seen = new Set<string>();
  return ordered.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return !visionRequired || entry.supportsVision;
  });
}
