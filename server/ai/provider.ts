/**
 * Provider transport for VEYVRO — one place that speaks to the AI API.
 *
 * It is deliberately provider-agnostic about *which* model is asked (the router
 * decides) but strict about *how*: Chat Completions, Server-Sent Events for the
 * answer the user reads, plain JSON for the internal drafts and verifications.
 *
 * Responsibilities kept here, so `api/chat.ts` stays a request handler:
 *   • building the request body per model profile (reasoning vs classic),
 *   • classifying upstream failures into stable codes the interface already
 *     knows (`invalid_api_key`, `model_unavailable`, `insufficient_quota`,
 *     `rate_limited`, `timeout`, `provider_error`),
 *   • retrying only what is worth retrying (429 and 5xx), never an auth or
 *     quota error,
 *   • walking a fallback chain when a model is denied or unavailable,
 *   • reporting token usage so the handler can total the real cost.
 *
 * The API key never leaves this module's caller: it is passed in, used in a
 * header, and never logged or returned.
 */

import type { ModelEntry, ReasoningEffort } from "./modelCatalog.js";
import { isModelUnavailable, markModelUnavailable } from "./modelCatalog.js";

export type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

export type ProviderMessage = {
  role: "system" | "user" | "assistant";
  content: string | ProviderContentPart[];
};

export type ApiErrorCode =
  | "missing_api_key"
  | "invalid_api_key"
  | "access_denied"
  | "model_unavailable"
  | "insufficient_quota"
  | "rate_limited"
  | "busy"
  | "timeout"
  | "empty_response"
  | "incomplete_stream"
  | "provider_error";

export type ClassifiedError = {
  status: number;
  code: ApiErrorCode;
  error: string;
  /** Whether another model may still answer this request. */
  fallbackAllowed: boolean;
  /** Whether waiting and repeating the same call could work. */
  retryable: boolean;
};

export type TokenUsage = { promptTokens: number; completionTokens: number };

export type CompletionResult = {
  text: string;
  finishReason: string | null;
  usage: TokenUsage | null;
  modelId: string;
  latencyMs: number;
};

export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  /** "openai" or "gemini" — Gemini keeps two quirks handled below. */
  provider: "openai" | "gemini" | "openai-compatible";
  fetchImpl?: typeof fetch;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  readonly classified: ClassifiedError;
  /** Upstream model id that produced the failure, when known. */
  readonly modelId: string | undefined;

  constructor(classified: ClassifiedError, modelId?: string) {
    super(classified.error);
    this.name = "ProviderError";
    this.classified = classified;
    this.modelId = modelId;
  }
}

const MESSAGE_INVALID_KEY =
  "Clé API invalide ou rejetée par le fournisseur IA. Vérifiez VEYVRO_AI_API_KEY sur le serveur. / The AI provider rejected its API key. Check VEYVRO_AI_API_KEY on the server.";
const MESSAGE_NO_ACCESS =
  "Ce compte ou projet n'a pas accès au modèle IA demandé. / This account or project does not have access to the requested AI model.";
const MESSAGE_MODEL_UNAVAILABLE =
  "Le modèle IA demandé est indisponible ou introuvable. / The requested AI model is unavailable or not found.";
const MESSAGE_QUOTA =
  "Quota API insuffisant ou facturation non activée sur le compte du fournisseur IA. / Insufficient API quota or inactive billing on the AI provider account.";
const MESSAGE_RATE_LIMITED =
  "Limite de débit atteinte auprès du fournisseur IA. Réessayez dans quelques instants. / The AI provider is rate limited. Try again shortly.";
const MESSAGE_PROVIDER =
  "Le fournisseur IA n'a pas pu traiter la requête. / The AI provider could not complete the request.";

/**
 * Turn an upstream HTTP failure into a stable, user-facing classification.
 *
 * The mapping is unchanged from the previous single-model handler wherever it
 * concerned the user: same codes, same bilingual wording. The two additions are
 * the `fallbackAllowed` and `retryable` flags, which is what lets the router try
 * another model instead of failing the turn.
 */
export function classifyProviderHttpError(status: number, payload: unknown): ClassifiedError {
  const rawError =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error?: unknown }).error
      : null;
  const errorObj =
    typeof rawError === "object" && rawError !== null
      ? (rawError as Record<string, unknown>)
      : null;
  const upstreamCode = typeof errorObj?.code === "string" ? errorObj.code.toLowerCase() : "";
  const upstreamType = typeof errorObj?.type === "string" ? errorObj.type.toLowerCase() : "";
  const upstreamMessage =
    typeof errorObj?.message === "string" ? errorObj.message.toLowerCase() : "";

  if (
    status === 402 ||
    upstreamCode === "insufficient_quota" ||
    upstreamType === "insufficient_quota" ||
    upstreamCode === "billing_hard_limit_reached" ||
    (status === 429 && (upstreamMessage.includes("quota") || upstreamMessage.includes("billing")))
  ) {
    // No model can answer when the account has no credit.
    return {
      status: 429,
      code: "insufficient_quota",
      error: MESSAGE_QUOTA,
      fallbackAllowed: false,
      retryable: false,
    };
  }

  if (
    status === 429 ||
    upstreamCode === "rate_limit_exceeded" ||
    upstreamType === "rate_limit_error"
  ) {
    return {
      status: 429,
      code: "rate_limited",
      error: MESSAGE_RATE_LIMITED,
      fallbackAllowed: true,
      retryable: true,
    };
  }

  if (status === 401 || upstreamCode === "invalid_api_key") {
    return {
      status: 502,
      code: "invalid_api_key",
      error: MESSAGE_INVALID_KEY,
      fallbackAllowed: false,
      retryable: false,
    };
  }

  if (
    status === 404 ||
    upstreamCode === "model_not_found" ||
    (status === 400 && upstreamMessage.includes("model") && upstreamMessage.includes("not exist"))
  ) {
    return {
      status: 502,
      code: "model_unavailable",
      error: MESSAGE_MODEL_UNAVAILABLE,
      fallbackAllowed: true,
      retryable: false,
    };
  }

  if (
    status === 403 ||
    upstreamCode === "insufficient_permissions" ||
    upstreamCode === "access_terminated" ||
    upstreamType === "permission_error"
  ) {
    if (upstreamMessage.includes("model")) {
      return {
        status: 502,
        code: "model_unavailable",
        error: MESSAGE_NO_ACCESS,
        fallbackAllowed: true,
        retryable: false,
      };
    }
    return {
      status: 502,
      code: "access_denied",
      error: MESSAGE_NO_ACCESS,
      fallbackAllowed: false,
      retryable: false,
    };
  }

  // 5xx, network-level failures, malformed payloads: another model may work.
  if (status >= 500) {
    return {
      status: 502,
      code: "provider_error",
      error: MESSAGE_PROVIDER,
      fallbackAllowed: true,
      retryable: true,
    };
  }

  return {
    status: 502,
    code: "provider_error",
    error: MESSAGE_PROVIDER,
    fallbackAllowed: true,
    // A 400 caused by a parameter this account's model does not accept is not
    // fixed by retrying the same body, but another model may accept it.
    retryable: false,
  };
}

export function timeoutError(): ClassifiedError {
  return {
    status: 504,
    code: "timeout",
    error:
      "Le fournisseur IA a mis trop de temps à répondre. Veuillez réessayer. / The AI provider took too long to respond. Please try again.",
    fallbackAllowed: true,
    retryable: false,
  };
}

export function streamError(): ClassifiedError {
  return {
    status: 502,
    code: "incomplete_stream",
    error:
      "La réponse IA a été interrompue. Veuillez réessayer. / VEYVRO AI stream was interrupted. Please try again.",
    fallbackAllowed: true,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

export type ChatRequestOptions = {
  model: ModelEntry;
  messages: ProviderMessage[];
  stream: boolean;
  /** Output ceiling decided by the router. */
  maxOutputTokens: number;
  /** Reasoning effort decided by the router. */
  effort: ReasoningEffort;
  /** Sampling temperature for classic models only. */
  temperature?: number;
  /** Ask for a usage block (streaming only). */
  includeUsage?: boolean;
};

/**
 * Build the Chat Completions body for one model.
 *
 * The parameter profile matters: reasoning models reject `temperature`, and a
 * non-reasoning model rejects `reasoning_effort`. Sending the wrong one is an
 * HTTP 400 that looks like a configuration failure to the user, so it is
 * decided here from the catalog entry rather than guessed at the call site.
 */
export function buildChatRequestBody(
  options: ChatRequestOptions,
  provider: ProviderConfig["provider"],
): Record<string, unknown> {
  const { model } = options;
  const body: Record<string, unknown> = {
    model: model.id,
    messages: options.messages,
    stream: options.stream,
  };

  if (provider !== "gemini") {
    body.max_completion_tokens = Math.min(options.maxOutputTokens, model.maxOutputTokens);
  }

  if (model.isReasoning) {
    // GPT-6.2 Astra/Sol reject "none"; the router never produces it, but the
    // guard makes that impossible to regress.
    body.reasoning_effort =
      model.rejectsNoReasoningEffort && options.effort === "minimal" ? "low" : options.effort;
  } else if (options.temperature !== undefined && provider !== "gemini") {
    body.temperature = options.temperature;
  }

  if (options.stream && options.includeUsage !== false && provider !== "gemini") {
    body.stream_options = { include_usage: true };
  }

  return body;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

type ChatCompletionPayload = {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

function readUsage(payload: unknown): TokenUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as ChatCompletionPayload).usage;
  if (!usage) return null;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens };
}

function readMessageText(payload: unknown): string {
  const choice = (payload as ChatCompletionPayload)?.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === "string" ? content : "";
}

export type StreamChunkResult = {
  delta: string;
  complete: boolean;
  finishReason: string | null;
  usage: TokenUsage | null;
};

/**
 * Parse one SSE frame from the upstream stream.
 *
 * Unknown frames are ignored rather than fatal: providers add keep-alives and
 * metadata frames, and the previous handler was already tolerant of them.
 */
export function parseStreamFrame(frame: string): StreamChunkResult {
  const empty: StreamChunkResult = {
    delta: "",
    complete: false,
    finishReason: null,
    usage: null,
  };
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return empty;

  const data = dataLines.join("\n");
  if (data === "[DONE]") return { ...empty, complete: true };

  let chunk: {
    error?: unknown;
    choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }>;
    usage?: unknown;
  };
  try {
    chunk = JSON.parse(data);
  } catch {
    throw new Error("invalid-stream-frame");
  }

  if (chunk.error) throw new Error("stream-error-frame");

  const choice = chunk.choices?.[0];
  const delta = choice?.delta?.content;
  return {
    delta: typeof delta === "string" ? delta : "",
    complete: false,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: readUsage(chunk),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const RETRY_DELAY_MS = 350;
const MAX_ATTEMPTS_PER_MODEL = 2;

export type CompletionOutcome = CompletionResult & {
  /** Model that actually answered — may differ from the requested one. */
  model: ModelEntry;
  /** Models that were tried and failed before it. */
  failedModels: string[];
};

export type FallbackOutcome = {
  outcome: CompletionOutcome;
  /** Per-attempt trace: model id, error code, elapsed time. */
  attempts: Array<{ modelId: string; code: ApiErrorCode | "ok"; latencyMs: number }>;
};

function mergeUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  };
}

export class ProviderClient {
  private readonly config: ProviderConfig;
  private readonly now: () => number;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.now = config.now ?? Date.now;
  }

  private url(): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async send(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    return fetchImpl(this.url(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
  }

  /**
   * One non-streamed completion, with a bounded retry on 429/5xx.
   *
   * Used for internal drafts and verifications, where the user is not watching
   * the tokens arrive and a retry costs nothing but latency.
   */
  async complete(
    options: Omit<ChatRequestOptions, "stream">,
    signal: AbortSignal,
  ): Promise<CompletionOutcome> {
    const body = buildChatRequestBody(
      { ...options, stream: false, includeUsage: false },
      this.config.provider,
    );
    const startedAt = this.now();
    let lastError: ProviderError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        const response = await this.send(body, signal);
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const classified = classifyProviderHttpError(response.status, payload);
          lastError = new ProviderError(classified, options.model.id);
          if (!classified.retryable || attempt === MAX_ATTEMPTS_PER_MODEL) throw lastError;
          await delay(RETRY_DELAY_MS * attempt, signal);
          continue;
        }

        const payload: unknown = await response.json().catch(() => null);
        if (payload === null) {
          throw new ProviderError(
            classifyProviderHttpError(502, null),
            options.model.id,
          );
        }

        const usage = readUsage(payload);
        return {
          text: readMessageText(payload),
          finishReason:
            typeof (payload as ChatCompletionPayload)?.choices?.[0]?.finish_reason === "string"
              ? ((payload as ChatCompletionPayload).choices![0].finish_reason as string)
              : null,
          usage,
          modelId: options.model.id,
          model: options.model,
          failedModels: [],
          latencyMs: this.now() - startedAt,
        };
      } catch (error) {
        if (signal.aborted) throw new ProviderError(timeoutError(), options.model.id);
        if (error instanceof ProviderError) {
          lastError = error;
          if (!error.classified.retryable || attempt === MAX_ATTEMPTS_PER_MODEL) throw error;
          await delay(RETRY_DELAY_MS * attempt, signal);
          continue;
        }
        if (attempt === MAX_ATTEMPTS_PER_MODEL) {
          throw new ProviderError(
            classifyProviderHttpError(503, null),
            options.model.id,
          );
        }
        await delay(RETRY_DELAY_MS * attempt, signal);
      }
    }

    throw lastError ?? new ProviderError(classifyProviderHttpError(502, null), options.model.id);
  }

  /**
   * One streamed completion. `onDelta` is called for every text fragment.
   *
   * The upstream is fully read here; the caller decides how to publish the
   * fragments, which is what keeps the SSE contract identical to before while
   * allowing a secondary stream (collaboration, verification) to run alongside.
   */
  async stream(
    options: Omit<ChatRequestOptions, "stream">,
    signal: AbortSignal,
    onDelta: (delta: string) => Promise<void> | void,
  ): Promise<CompletionOutcome> {
    const body = buildChatRequestBody(
      { ...options, stream: true },
      this.config.provider,
    );
    const startedAt = this.now();
    let lastError: ProviderError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        return await this.runStream(body, options, signal, onDelta, startedAt);
      } catch (error) {
        if (signal.aborted) throw new ProviderError(timeoutError(), options.model.id);
        if (error instanceof ProviderError) {
          // Nothing has been published yet: retrying is safe. Once the first
          // fragment is out, `runStream` has already thrown a non-retryable
          // stream error, so the user never sees duplicated text.
          lastError = error;
          if (!error.classified.retryable || attempt === MAX_ATTEMPTS_PER_MODEL) throw error;
          await delay(RETRY_DELAY_MS * attempt, signal);
          continue;
        }
        if (attempt === MAX_ATTEMPTS_PER_MODEL) {
          throw new ProviderError(classifyProviderHttpError(503, null), options.model.id);
        }
        await delay(RETRY_DELAY_MS * attempt, signal);
      }
    }

    throw lastError ?? new ProviderError(classifyProviderHttpError(502, null), options.model.id);
  }

  private async runStream(
    body: Record<string, unknown>,
    options: Omit<ChatRequestOptions, "stream">,
    signal: AbortSignal,
    onDelta: (delta: string) => Promise<void> | void,
    startedAt: number,
  ): Promise<CompletionOutcome> {
    const response = await this.send(body, signal);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ProviderError(
        classifyProviderHttpError(response.status, payload),
        options.model.id,
      );
    }
    if (!response.body) {
      throw new ProviderError(
        {
          status: 502,
          code: "provider_error",
          error: MESSAGE_PROVIDER,
          fallbackAllowed: true,
          retryable: true,
        },
        options.model.id,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete = false;
    let text = "";
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    let publishedAny = false;

    const handleFrame = async (frame: string) => {
      let result: StreamChunkResult;
      try {
        result = parseStreamFrame(frame);
      } catch {
        // A malformed frame after text has been published cannot be retried:
        // the user already read part of the answer.
        throw new ProviderError(
          publishedAny
            ? { ...streamError(), fallbackAllowed: false, retryable: false }
            : { ...streamError(), retryable: true },
          options.model.id,
        );
      }
      if (result.usage) usage = mergeUsage(usage, result.usage);
      if (result.finishReason) finishReason = result.finishReason;
      if (result.delta) {
        text += result.delta;
        publishedAny = true;
        await onDelta(result.delta);
      }
      if (result.complete) complete = true;
    };

    try {
      while (!complete) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const frame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          await handleFrame(frame);
          if (complete) break;
          separatorIndex = buffer.indexOf("\n\n");
        }

        if (done) {
          if (!complete && buffer.trim()) await handleFrame(buffer);
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!publishedAny) {
      throw new ProviderError(
        {
          status: 502,
          code: "empty_response",
          error:
            "Le fournisseur IA a renvoyé une réponse vide. / The AI provider returned an empty response.",
          fallbackAllowed: true,
          retryable: false,
        },
        options.model.id,
      );
    }

    if (!complete && !finishReason) {
      throw new ProviderError(
        { ...streamError(), fallbackAllowed: false, retryable: false },
        options.model.id,
      );
    }

    return {
      text,
      finishReason,
      usage,
      modelId: options.model.id,
      model: options.model,
      failedModels: [],
      latencyMs: this.now() - startedAt,
    };
  }

  /**
   * Try each candidate until one answers.
   *
   * A denied or missing model is remembered for the instance so later requests
   * route around it; an auth or quota failure stops the chain immediately,
   * because no other model would fare better.
   */
  async withFallback(
    candidates: ModelEntry[],
    run: (model: ModelEntry) => Promise<CompletionOutcome>,
    options: { visionRequired?: boolean } = {},
  ): Promise<FallbackOutcome> {
    const attempts: FallbackOutcome["attempts"] = [];
    const usable = candidates.filter((candidate) => {
      if (options.visionRequired && !candidate.supportsVision) return false;
      return !isModelUnavailable(candidate.id, this.now());
    });
    const chain = usable.length > 0 ? usable : candidates;

    let lastError: ProviderError | null = null;
    for (const candidate of chain) {
      const startedAt = this.now();
      try {
        const outcome = await run(candidate);
        attempts.push({ modelId: candidate.id, code: "ok", latencyMs: this.now() - startedAt });
        return {
          outcome: {
            ...outcome,
            model: candidate,
            modelId: candidate.id,
            failedModels: attempts.filter((a) => a.code !== "ok").map((a) => a.modelId),
          },
          attempts,
        };
      } catch (error) {
        const classified =
          error instanceof ProviderError
            ? error.classified
            : classifyProviderHttpError(502, null);
        attempts.push({
          modelId: candidate.id,
          code: classified.code,
          latencyMs: this.now() - startedAt,
        });

        if (
          error instanceof ProviderError &&
          (classified.code === "model_unavailable" || classified.code === "access_denied")
        ) {
          markModelUnavailable(candidate.id, this.now());
        }

        if (!classified.fallbackAllowed) {
          throw error instanceof ProviderError ? error : new ProviderError(classified);
        }
        // Remember the failure and let the loop try the next candidate; when the
        // chain is exhausted, this is the error the caller sees.
        lastError = error instanceof ProviderError ? error : new ProviderError(classified);
      }
    }

    throw lastError ?? new ProviderError(classifyProviderHttpError(502, null));
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
