import DRIVIA_SYSTEM_PROMPT from "../server/driviaSystemPrompt";

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

type ApiRequest = {
  method?: string;
  body?: unknown;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
  flushHeaders?: () => void;
  write: (chunk: string) => boolean;
  once?: (event: "drain", listener: () => void) => void;
  end: () => void;
};

type ProviderStreamChunk = {
  error?: unknown;
  choices?: Array<{
    delta?: { content?: unknown };
  }>;
};

const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARACTERS = 24_000;
const MAX_MESSAGE_CHARACTERS = 4_000;

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: { sizeLimit: "64kb" },
  },
};

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

function getConversation(body: unknown): ConversationMessage[] {
  if (typeof body !== "object" || body === null || !("messages" in body)) return [];

  const rawMessages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages)) return [];

  const recentMessages = rawMessages.slice(-MAX_HISTORY_MESSAGES);
  if (
    recentMessages.length === 0 ||
    !recentMessages.every(
      (message) => isConversationMessage(message) && message.content.trim().length > 0,
    )
  ) {
    return [];
  }

  const history = recentMessages
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, MAX_MESSAGE_CHARACTERS),
    }));

  let totalCharacters = history.reduce((total, message) => total + message.content.length, 0);
  while (history.length > 1 && totalCharacters > MAX_HISTORY_CHARACTERS) {
    totalCharacters -= history.shift()?.content.length ?? 0;
  }

  return history;
}

async function writeEvent(response: ApiResponse, event: string, payload: unknown) {
  const accepted = response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  if (!accepted && response.once) {
    await new Promise<void>((resolve) => response.once?.("drain", resolve));
  }
}

async function consumeProviderFrame(
  frame: string,
  response: ApiResponse,
): Promise<{ complete: boolean; hasText: boolean }> {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return { complete: false, hasText: false };
  const data = dataLines.join("\n");
  if (data === "[DONE]") return { complete: true, hasText: false };

  let chunk: ProviderStreamChunk;
  try {
    chunk = JSON.parse(data) as ProviderStreamChunk;
  } catch {
    throw new Error("The AI provider returned an invalid stream.");
  }

  if (chunk.error) throw new Error("The AI provider returned a stream error.");

  const delta = chunk.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta.length > 0) {
    await writeEvent(response, "delta", { delta });
    return { complete: false, hasText: true };
  }

  return { complete: false, hasText: false };
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST requests are supported." });
  }

  let requestBody: unknown;
  try {
    requestBody = request.body;
  } catch {
    return response.status(400).json({ error: "Request body must be valid JSON." });
  }

  const messages = getConversation(requestBody);

  if (messages.length === 0 || messages[messages.length - 1]?.role !== "user") {
    return response.status(400).json({ error: "A user message is required." });
  }

  const apiKey = process.env.DRIVIA_AI_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      error: "DRIVIA's AI provider is not configured. Set DRIVIA_AI_API_KEY on the server.",
    });
  }

  const provider = (process.env.DRIVIA_AI_PROVIDER || "openai").trim().toLowerCase();
  if (provider !== "openai" && provider !== "gemini" && provider !== "openai-compatible") {
    return response.status(500).json({ error: "Unsupported DRIVIA_AI_PROVIDER configuration." });
  }

  const defaultBaseUrl =
    provider === "gemini"
      ? "https://generativelanguage.googleapis.com/v1beta/openai"
      : "https://api.openai.com/v1";
  const baseUrl = (process.env.DRIVIA_AI_BASE_URL || defaultBaseUrl).replace(/\/+$/, "");
  const defaultModel = provider === "gemini" ? "gemini-3.8-flash" : "gpt-4.1-mini";
  const model = process.env.DRIVIA_AI_MODEL || defaultModel;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  let streamStarted = false;

  try {
    const providerResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: DRIVIA_SYSTEM_PROMPT }, ...messages],
        stream: true,
        ...(provider === "gemini" ? {} : { max_completion_tokens: 1400 }),
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!providerResponse.ok) {
      if (providerResponse.status === 429) {
        return response.status(429).json({ error: "The AI provider is rate limited. Try again shortly." });
      }
      if ([401, 403].includes(providerResponse.status)) {
        return response.status(502).json({
          error: "The AI provider rejected its credentials. Check DRIVIA_AI_API_KEY and the selected model.",
        });
      }
      return response.status(502).json({
        error: "The AI provider could not complete the request. Check the provider and model configuration.",
      });
    }

    if (!providerResponse.body) {
      return response.status(502).json({ error: "The AI provider did not return a response stream." });
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    streamStarted = true;

    const reader = providerResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete = false;
    let didStreamText = false;

    try {
      while (!complete) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const frame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const result = await consumeProviderFrame(frame, response);
          complete = result.complete;
          didStreamText ||= result.hasText;
          if (complete) break;
          separatorIndex = buffer.indexOf("\n\n");
        }

        if (done) {
          if (!complete && buffer.trim()) {
            const result = await consumeProviderFrame(buffer, response);
            complete = result.complete;
            didStreamText ||= result.hasText;
          }
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!didStreamText) {
      await writeEvent(response, "error", { error: "The AI provider returned an empty response." });
      response.end();
      return;
    }

    await writeEvent(response, "done", {});
    response.end();
  } catch {
    if (streamStarted) {
      try {
        await writeEvent(response, "error", {
          error: controller.signal.aborted
            ? "DRIVIA AI took too long to respond. Please try again."
            : "DRIVIA AI is temporarily unavailable.",
        });
        response.end();
      } catch {
        // The client may have disconnected while the model was streaming.
      }
      return;
    }

    if (controller.signal.aborted) {
      return response.status(504).json({ error: "The AI provider took too long to respond. Please try again." });
    }
    return response.status(502).json({ error: "The AI provider is temporarily unavailable." });
  } finally {
    clearTimeout(timeoutId);
  }
}