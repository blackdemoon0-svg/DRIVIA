export type VeyvroMessage = {
  role: "user" | "assistant";
  content: string;
};

export type VeyvroAttachment =
  | {
      type: "image";
      name: string;
      mimeType: "image/jpeg" | "image/png" | "image/webp";
      dataUrl: string;
    }
  | {
      type: "text";
      name: string;
      mimeType: "application/pdf";
      text: string;
    };

type StreamOptions = {
  signal?: AbortSignal;
  attachments?: VeyvroAttachment[];
  task?: "garage-quote";
  /**
   * Supabase access token of the signed-in user.
   *
   * The server refuses any request without it: the identity, and therefore the
   * plan, is never taken from the request body. Sent as a bearer header only —
   * never in the URL, never logged.
   */
  accessToken?: string | null;
  /**
   * Identifier of this message, so a replay cannot be charged twice.
   *
   * Optional: when omitted, one is generated per call. Pass your own value when
   * the same logical message may be sent more than once (a transport retry, a
   * double submit) — the server answers 409 instead of consuming a second
   * message. It carries no identity, no plan and no quota: only "this is the
   * same request".
   */
  clientMessageId?: string;
};

/**
 * A fresh RFC 4122 v4 identifier, or `undefined` when the runtime has no
 * `crypto.randomUUID` (the server then generates one itself).
 *
 * Never derived from anything the user wrote: it must not leak content, and it
 * must be unpredictable enough not to collide with another account's message.
 */
function newClientMessageId(): string | undefined {
  const cryptoApi = globalThis.crypto;
  return cryptoApi && typeof cryptoApi.randomUUID === "function" ? cryptoApi.randomUUID() : undefined;
}

type StreamPayload = {
  delta?: unknown;
  error?: unknown;
  code?: unknown;
  truncated?: unknown;
  finishReason?: unknown;
  choices?: Array<{ delta?: { content?: unknown } }>;
};

export class VeyvroApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VeyvroApiError";
  }
}

function parseServerError(payload: unknown, status: number): VeyvroApiError {
  const error =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error?: unknown }).error
      : null;
  const code =
    typeof payload === "object" && payload !== null && "code" in payload
      ? (payload as { code?: unknown }).code
      : null;
  const message = typeof error === "string" ? error : "The VEYVRO AI service returned an error.";
  return new VeyvroApiError(status, message, typeof code === "string" ? code : undefined);
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
    throw new VeyvroApiError(502, "The VEYVRO AI service returned an invalid stream.", "provider_error");
  }

  if (eventName === "error" || typeof payload.error === "string") {
    const message =
      typeof payload.error === "string" && payload.error.trim().length > 0
        ? payload.error
        : "VEYVRO AI is temporarily unavailable.";
    const code = typeof payload.code === "string" ? payload.code : "provider_error";
    throw new VeyvroApiError(502, message, code);
  }

  const delta =
    typeof payload.delta === "string"
      ? payload.delta
      : payload.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta.length > 0) onDelta(delta);
  return eventName === "done";
}

export async function streamVeyvroResponse(
  messages: VeyvroMessage[],
  onDelta: (delta: string) => void,
  options: StreamOptions = {},
): Promise<void> {
  const { signal, attachments, accessToken } = options;
  const history = messages
    .slice(-24)
    .map((message) => ({ ...message, content: message.content.trim().slice(0, 4_000) }))
    .filter((message) => message.content.length > 0);
  let historyCharacters = history.reduce((total, message) => total + message.content.length, 0);
  while (history.length > 1 && historyCharacters > 24_000) {
    historyCharacters -= history.shift()?.content.length ?? 0;
  }

  // Without a session there is nothing the server could authorise: fail here
  // with a message the interface can turn into "sign in", instead of a 401.
  if (!accessToken) {
    throw new VeyvroApiError(401, "Sign in to VEYVRO to use the chat.", "auth_required");
  }

  // One identifier per send, decided once, right before the request is built:
  // the bytes on the wire and the identifier cannot disagree, so replaying this
  // exact request is a 409 — never a second charge.
  //
  // Deliberately not generated per retry loop higher up: a *new* attempt is a
  // new message, and must be charged as one. Only the same payload is the same
  // message.
  const clientMessageId = options.clientMessageId ?? newClientMessageId();

  let response: Response;

  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        messages: history,
        ...(attachments?.length ? { attachments } : {}),
        ...(options.task ? { task: options.task } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      }),
      signal,
    });
  } catch {
    throw new VeyvroApiError(0, "The VEYVRO AI service could not be reached.");
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw parseServerError(payload, response.status);
  }

  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new VeyvroApiError(404, "The /api/chat endpoint did not return a response stream.");
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
    if (error instanceof VeyvroApiError) throw error;
    throw new VeyvroApiError(0, "The VEYVRO AI stream was interrupted.");
  } finally {
    reader.releaseLock();
  }

  if (!receivedText) {
    throw new VeyvroApiError(502, "The VEYVRO AI service returned an empty response.", "empty_response");
  }
  if (!complete) {
    throw new VeyvroApiError(
      0,
      "La réponse IA a été interrompue avant la fin. / The VEYVRO AI stream ended before the response was complete.",
      "incomplete_stream",
    );
  }
}