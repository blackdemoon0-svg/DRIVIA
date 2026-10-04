export type DriviaMessage = {
  role: "user" | "assistant";
  content: string;
};

type StreamPayload = {
  delta?: unknown;
  error?: unknown;
  choices?: Array<{ delta?: { content?: unknown } }>;
};

export class DriviaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DriviaApiError";
  }
}

function parseServerError(payload: unknown, status: number): DriviaApiError {
  const error =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error?: unknown }).error
      : null;
  const message = typeof error === "string" ? error : "The DRIVIA AI service returned an error.";
  return new DriviaApiError(status, message);
}

function parseSseEvent(frame: string, onDelta: (delta: string) => void): boolean {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return false;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return true;

  let payload: StreamPayload;
  try {
    payload = JSON.parse(data) as StreamPayload;
  } catch {
    throw new DriviaApiError(502, "The DRIVIA AI service returned an invalid stream.");
  }

  if (eventName === "error" || typeof payload.error === "string") {
    throw new DriviaApiError(502, "DRIVIA AI is temporarily unavailable.");
  }

  const delta =
    typeof payload.delta === "string"
      ? payload.delta
      : payload.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta.length > 0) onDelta(delta);
  return eventName === "done";
}

export async function streamDriviaResponse(
  messages: DriviaMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const history = messages
    .slice(-24)
    .map((message) => ({ ...message, content: message.content.trim().slice(0, 4_000) }))
    .filter((message) => message.content.length > 0);
  let historyCharacters = history.reduce((total, message) => total + message.content.length, 0);
  while (history.length > 1 && historyCharacters > 24_000) {
    historyCharacters -= history.shift()?.content.length ?? 0;
  }

  let response: Response;

  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ messages: history }),
      signal,
    });
  } catch {
    throw new DriviaApiError(0, "The DRIVIA AI service could not be reached.");
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw parseServerError(payload, response.status);
  }

  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new DriviaApiError(404, "The /api/chat endpoint did not return a response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  let receivedText = false;

  const emitDelta = (delta: string) => {
    receivedText = true;
    onDelta(delta);
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
        complete = parseSseEvent(frame, emitDelta);
        if (complete) break;
        separatorIndex = buffer.indexOf("\n\n");
      }

      if (done) {
        if (!complete && buffer.trim()) complete = parseSseEvent(buffer, emitDelta);
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof DriviaApiError) throw error;
    throw new DriviaApiError(0, "The DRIVIA AI stream was interrupted.");
  } finally {
    reader.releaseLock();
  }

  if (!receivedText) {
    throw new DriviaApiError(502, "The DRIVIA AI service returned an empty response.");
  }
  if (!complete) {
    throw new DriviaApiError(0, "The DRIVIA AI stream ended before the response was complete.");
  }
}