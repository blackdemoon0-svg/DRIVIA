/**
 * Multi-model orchestration for VEYVRO.
 *
 * Takes a `RoutePlan` (which models, how many, at what effort) and executes it:
 *
 *   single mode …… the primary model streams straight to the user.
 *   collaborative … several models draft in parallel, a coordinator merges the
 *                   drafts and streams the single answer the user reads.
 *   verification … a cheaper model checks the finished answer and, if it finds a
 *                   material error, a short correction is appended.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE STREAMING CONTRACT IS UNTOUCHED
 * ─────────────────────────────────────────────────────────────────────────────
 * The browser keeps receiving `event: delta` fragments followed by
 * `event: done`, exactly as before. Internal passes (drafts, verification) are
 * never streamed as answer text; progress is reported on a separate `stage`
 * event that existing clients ignore. When a model has to be replaced mid-flight
 * the switch happens *before* the first fragment is published, so the user never
 * sees two answers spliced together.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  FAILURE POLICY
 * ─────────────────────────────────────────────────────────────────────────────
 *   • nothing published yet  → try the next model in the fallback chain;
 *   • text already published → never duplicate it; report an interruption;
 *   • auth / quota failures  → stop immediately, another model cannot help;
 *   • collaboration failing  → degrade to a single strong model, so the user
 *                              still gets an answer instead of an error.
 */

import { fallbackChain, type ModelEntry } from "./modelCatalog.js";
import {
  ProviderError,
  ProviderClient,
  type ProviderMessage,
  type TokenUsage,
} from "./provider.js";
import {
  DRAFT_INSTRUCTION,
  QUOTE_VERIFICATION_FOCUS,
  SYNTHESIS_INSTRUCTION,
  VERIFICATION_INSTRUCTION,
} from "./prompts.js";
import type { RoutePlan } from "./router.js";

export type StageName =
  | "draft"
  | "synthesise"
  | "verify"
  | "fallback"
  | "correction"
  | "degraded";

export type Publisher = {
  /** Publish an answer fragment — the only thing the user reads. */
  delta: (text: string) => Promise<void>;
  /** Publish a progress event on the `stage` channel (ignored by old clients). */
  stage?: (stage: StageName, detail: Record<string, unknown>) => Promise<void>;
};

export type OrchestrationInput = {
  client: ProviderClient;
  plan: RoutePlan;
  /** Full provider messages: system prompt, history, latest user turn. */
  messages: ProviderMessage[];
  publish: Publisher;
  /** Absolute epoch-ms deadline for the whole request. */
  deadline: number;
  /** Whether any image is present (fallback must keep vision support). */
  visionRequired: boolean;
  /** Sampling temperature for classic models. */
  temperature?: number;
  now?: () => number;
};

export type ModelCallTrace = {
  role: "primary" | "draft" | "synthesis" | "verify";
  modelId: string;
  ok: boolean;
  code?: string;
  latencyMs: number;
  usage?: TokenUsage | null;
};

export type OrchestrationResult = {
  text: string;
  finishReason: string | null;
  model: ModelEntry;
  /** Model ids that produced the streamed answer(s), in order of use. */
  modelsUsed: string[];
  /** Every model involved in the turn, drafts and verifier included. */
  modelsInvolved: string[];
  /** Models attempted and refused before the answering one. */
  failedModels: string[];
  usage: TokenUsage;
  costUsd: number;
  traces: ModelCallTrace[];
  verified: boolean;
  corrections: string[];
  /** True when the plan had to be simplified at runtime (failure, deadline). */
  degraded: boolean;
  mode: RoutePlan["mode"];
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIN_STAGE_MS = 4_000;

/** Signal bounded by both the stage budget and the global deadline. */
function stageSignal(
  deadline: number,
  budgetMs: number,
  now: () => number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const remaining = Math.max(0, deadline - now());
  const ms = Math.min(budgetMs, remaining);
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function addUsage(a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  };
}

/** Price a finished call from the tokens the provider reported. */
export function costOfUsage(usage: TokenUsage, model: ModelEntry): number {
  return (
    (usage.promptTokens / 1_000_000) * model.inputCostPerMTok +
    (usage.completionTokens / 1_000_000) * model.outputCostPerMTok
  );
}

/** Text of a message, whether it is a plain string or multimodal parts. */
function messageText(message: ProviderMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Copy of the messages with the last user turn replaced by `text`. */
function withInstruction(messages: ProviderMessage[], instruction: string): ProviderMessage[] {
  const copy = messages.map((message) => ({ ...message }));
  const lastIndex = copy.length - 1;
  if (lastIndex >= 0 && copy[lastIndex].role === "user") {
    copy[lastIndex] = {
      role: "user",
      content: `${messageText(copy[lastIndex])}\n\n${instruction}`,
    };
  }
  return copy;
}

type VerifierVerdict = { verdict: "ok" | "correction"; issues: Array<{ probleme: string; correction: string }> };

/**
 * Read the verifier's JSON.
 *
 * The verifier is asked for strict JSON, but a model may wrap it in a fenced
 * block or add a sentence. Anything unparsable is treated as "ok": a
 * verification pass must never invent a correction out of thin air, and it must
 * never break an answer that was already good.
 */
export function parseVerifierVerdict(raw: string): VerifierVerdict {
  const fallback: VerifierVerdict = { verdict: "ok", issues: [] };
  if (!raw.trim()) return fallback;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  const record = parsed as Record<string, unknown>;
  const issues = Array.isArray(record.issues)
    ? record.issues
        .filter(
          (issue): issue is Record<string, unknown> =>
            typeof issue === "object" && issue !== null,
        )
        .map((issue) => ({
          probleme: typeof issue.probleme === "string" ? issue.probleme.trim() : "",
          correction:
            typeof issue.correction === "string" ? issue.correction.trim() : "",
        }))
        .filter((issue) => issue.correction.length > 0)
        .slice(0, 3)
    : [];

  if (record.verdict === "correction" && issues.length > 0) {
    return { verdict: "correction", issues };
  }
  return fallback;
}

/** The corrective paragraph appended to an answer, if any. */
export function formatCorrections(issues: VerifierVerdict["issues"]): string {
  if (issues.length === 0) return "";
  const label =
    issues.length === 1 ? "Point de vigilance" : "Points de vigilance";
  const lines = issues.map((issue) => `- ${issue.correction}`).join("\n");
  return `\n\n---\n**${label}** — ${lines}`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function orchestrate(input: OrchestrationInput): Promise<OrchestrationResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const traces: ModelCallTrace[] = [];
  const modelsUsed: string[] = [];

  const failedModels: string[] = [];
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  let costUsd = 0;
  let degraded = false;

  const publishStage = async (stage: StageName, detail: Record<string, unknown>) => {
    if (input.publish.stage) {
      await input.publish.stage(stage, {
        ...detail,
        elapsedMs: now() - startedAt,
      });
    }
  };

  const charge = (model: ModelEntry, callUsage: TokenUsage | null) => {
    usage = addUsage(usage, callUsage);
    if (callUsage) costUsd += costOfUsage(callUsage, model);
  };

  const approach = (plan: RoutePlan, visionRequired: boolean) =>
    fallbackChain(plan.primary, { visionRequired });

  // ── Pipeline A: collaboration on a difficult request ─────────────────────
  if (input.plan.mode === "collaborative" && input.plan.collaborators.length > 0) {
    // Progress published to the client stays deliberately generic: model ids are
    // an internal routing decision, and the server log already records them.
    await publishStage("draft", { count: input.plan.collaborators.length });

    const draftMessages = withInstruction(input.messages, DRAFT_INSTRUCTION);
    const draftBudget = Math.max(
      MIN_STAGE_MS,
      Math.min(14_000, Math.floor((input.deadline - now()) * 0.35)),
    );

    const drafts = await Promise.all(
      input.plan.collaborators.map(async (model) => {
        const { signal, cleanup } = stageSignal(input.deadline, draftBudget, now);
        const draftStartedAt = now();
        try {
          const outcome = await input.client.complete(
            {
              model,
              messages: draftMessages,
              maxOutputTokens: Math.min(1_000, model.maxOutputTokens),
              effort: "medium",
            },
            signal,
          );
          traces.push({
            role: "draft",
            modelId: model.id,
            ok: true,
            latencyMs: now() - draftStartedAt,
            usage: outcome.usage,
          });
          charge(model, outcome.usage);
          return outcome.text.trim();
        } catch (error) {
          traces.push({
            role: "draft",
            modelId: model.id,
            ok: false,
            code: error instanceof ProviderError ? error.classified.code : "provider_error",
            latencyMs: now() - draftStartedAt,
          });
          failedModels.push(model.id);
          return "";
        } finally {
          cleanup();
        }
      }),
    );

    const usableDrafts = drafts.filter((draft) => draft.length > 40);

    if (usableDrafts.length === 0) {
      // Nothing to merge: fall through to a single strong model rather than
      // failing the turn. The user still gets an answer.
      degraded = true;
      await publishStage("degraded", { reason: "drafts_unavailable" });
    } else {
      const synthesisMessages: ProviderMessage[] = [
        ...withInstruction(input.messages, SYNTHESIS_INSTRUCTION),
      ];
      const draftBlock = usableDrafts
        .map((draft, index) => `--- Brouillon ${index + 1} ---\n${draft}`)
        .join("\n\n");
      synthesisMessages.push({
        role: "user",
        content: `Brouillons à fusionner (matériau interne, ne pas citer tel quel) :\n\n${draftBlock}`,
      });

      const synthesisBudget = Math.max(
        MIN_STAGE_MS,
        Math.min(26_000, Math.floor((input.deadline - now()) * 0.6)),
      );
      const candidates = approach(input.plan, input.visionRequired);

      await publishStage("synthesise", {});

      let sawText = false;
      const guardedDelta = async (delta: string) => {
        sawText = true;
        await input.publish.delta(delta);
      };

      try {
        const { outcome } = await input.client.withFallback(
          candidates,
          (model) => {
            const { signal, cleanup } = stageSignal(input.deadline, synthesisBudget, now);
            return input.client
              .stream(
                {
                  model,
                  messages: synthesisMessages,
                  maxOutputTokens: input.plan.maxOutputTokens,
                  effort: input.plan.effort,
                  temperature: input.temperature,
                },
                signal,
                guardedDelta,
              )
              .finally(cleanup);
          },
          { visionRequired: input.visionRequired },
        );

        traces.push({
          role: "synthesis",
          modelId: outcome.model.id,
          ok: true,
          latencyMs: outcome.latencyMs,
          usage: outcome.usage,
        });
        charge(outcome.model, outcome.usage);
        modelsUsed.push(outcome.model.id);

        const corrections = await verifyIfUseful({
          input,
          plan: input.plan,
          answer: outcome.text,
          now,
          traces,
          charge,
          visionRequired: input.visionRequired,
        });

        const suffix = formatCorrections(corrections.issues);
        if (suffix) {
          await publishStage("correction", { count: corrections.issues.length });
          await input.publish.delta(suffix);
        }

        return {
          text: outcome.text + suffix,
          finishReason: outcome.finishReason,
          model: outcome.model,
          modelsUsed,
          modelsInvolved: [...new Set(traces.filter((t) => t.ok).map((t) => t.modelId))],
          failedModels: [...failedModels, ...outcome.failedModels],
          usage,
          costUsd: Number(costUsd.toFixed(5)),
          traces,
          verified: corrections.verified,
          corrections: corrections.issues.map((issue) => issue.correction),
          degraded,
          mode: input.plan.mode,
          durationMs: now() - startedAt,
        };
      } catch (error) {
        if (sawText) throw error; // text is already on the user's screen
        degraded = true;
        await publishStage("degraded", { reason: "synthesis_failed" });
      }
    }
  }

  // ── Pipeline B: single model, streamed ───────────────────────────────────
  const singlePlan: RoutePlan =
    input.plan.mode === "collaborative"
      ? {
          ...input.plan,
          mode: input.plan.signals.safety ? "reasoning" : "coding",
          // Degrading to a single model keeps the cost below the collaborative
          // plan, so the cheaper-but-strong model is the right fallback.
          primary: input.plan.signals.safety
            ? input.plan.collaborators[0] ?? input.plan.primary
            : input.plan.collaborators[1] ?? input.plan.primary,
        }
      : input.plan;

  const streamBudget = Math.max(
    MIN_STAGE_MS,
    Math.min(48_000, input.deadline - now()),
  );
  const candidates = approach(singlePlan, input.visionRequired);

  const streamStartedAt = now();
  const { outcome } = await input.client.withFallback(
    candidates,
    (model) => {
      const { signal, cleanup } = stageSignal(input.deadline, streamBudget, now);
      return input.client
        .stream(
          {
            model,
            messages: input.messages,
            maxOutputTokens: singlePlan.maxOutputTokens,
            effort: singlePlan.effort,
            temperature: input.temperature,
          },
          signal,
          input.publish.delta,
        )
        .finally(cleanup);
    },
    { visionRequired: input.visionRequired },
  );

  traces.push({
    role: "primary",
    modelId: outcome.model.id,
    ok: true,
    latencyMs: now() - streamStartedAt,
    usage: outcome.usage,
  });
  charge(outcome.model, outcome.usage);
  modelsUsed.push(outcome.model.id);
  if (outcome.failedModels.length > 0) {
    degraded = true;
    await publishStage("fallback", { attempts: outcome.failedModels.length + 1 });
  }

  const corrections = await verifyIfUseful({
    input,
    plan: singlePlan,
    answer: outcome.text,
    now,
    traces,
    charge,
    visionRequired: input.visionRequired,
  });

  const suffix = formatCorrections(corrections.issues);
  if (suffix) {
    await publishStage("correction", { count: corrections.issues.length });
    await input.publish.delta(suffix);
  }

  return {
    text: outcome.text + suffix,
    finishReason: outcome.finishReason,
    model: outcome.model,
    modelsUsed,
    modelsInvolved: [...new Set(traces.filter((t) => t.ok).map((t) => t.modelId))],
    failedModels: [...failedModels, ...outcome.failedModels],
    usage,
    costUsd: Number(costUsd.toFixed(5)),
    traces,
    verified: corrections.verified,
    corrections: corrections.issues.map((issue) => issue.correction),
    degraded,
    mode: singlePlan.mode,
    durationMs: now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Verification pass
// ---------------------------------------------------------------------------

type VerifyInput = {
  input: OrchestrationInput;
  plan: RoutePlan;
  answer: string;
  now: () => number;
  traces: ModelCallTrace[];
  charge: (model: ModelEntry, usage: TokenUsage | null) => void;
  visionRequired: boolean;
};

async function verifyIfUseful({
  input,
  plan,
  answer,
  now,
  traces,
  charge,
  visionRequired,
}: VerifyInput): Promise<{ verified: boolean; issues: VerifierVerdict["issues"] }> {
  const skipped = { verified: false, issues: [] as VerifierVerdict["issues"] };
  if (!plan.verify || plan.verifiers.length === 0) return skipped;
  // Do not start a check that cannot finish before the request deadline.
  if (input.deadline - now() < MIN_STAGE_MS * 2) return skipped;
  if (answer.trim().length < 120) return skipped;

  const verifier = plan.verifiers.find((model) => !visionRequired || model.supportsVision);
  if (!verifier) return skipped;

  const isQuote = plan.signals.document;
  const messages: ProviderMessage[] = [
    ...input.messages,
    { role: "assistant", content: answer },
    {
      role: "user",
      content: `${VERIFICATION_INSTRUCTION}\n\nRéponse à contrôler ci-dessus.${isQuote ? `\n\n${QUOTE_VERIFICATION_FOCUS}` : ""}`,
    },
  ];

  const { signal, cleanup } = stageSignal(input.deadline, 12_000, now);
  const startedAt = now();
  try {
    const outcome = await input.client.complete(
      {
        model: verifier,
        messages,
        maxOutputTokens: 700,
        effort: "low",
      },
      signal,
    );
    traces.push({
      role: "verify",
      modelId: verifier.id,
      ok: true,
      latencyMs: now() - startedAt,
      usage: outcome.usage,
    });
    charge(verifier, outcome.usage);
    const verdict = parseVerifierVerdict(outcome.text);
    return { verified: true, issues: verdict.issues };
  } catch {
    // A failed verification is not a failed answer.
    traces.push({
      role: "verify",
      modelId: verifier.id,
      ok: false,
      code: "verification_skipped",
      latencyMs: now() - startedAt,
    });
    return skipped;
  } finally {
    cleanup();
  }
}
