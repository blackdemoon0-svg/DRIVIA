/**
 * `POST /api/paddle-plan-change` — move an existing subscription from Plus to
 * Pro, in place, through the Paddle API.
 *
 * This file is only the HTTP skin. Everything that decides is in
 * `server/planChange.ts`, and everything that talks to Paddle is in
 * `server/paddleApi.ts`, so the whole decision path can be tested without a
 * deployment and without a real key.
 *
 * Three guarantees this route must never lose:
 * - the plan is **not** announced as changed. Success means "Paddle accepted the
 *   request"; the subscription row is written by the webhook, and only then does
 *   the plan change. The answer is 202, not 200.
 * - nothing from the request body names a user, a subscription or a price. The
 *   identity comes from the token, the subscription from the database, the price
 *   from the shared catalogue.
 * - the API key never appears in a response, a log line or an error message.
 */

import { readBearerToken } from "../server/access.js";
import { handlePlanChangeRequest, readPlanChangeBody } from "../server/planChange.js";

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Lazy getter on Vercel; reading it can throw on malformed JSON. */
  body?: unknown;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

function readHeader(request: ApiRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value ? value : null;
}

/**
 * Caller address, when the platform supplies one.
 *
 * Vercel sets `x-forwarded-for` (left-most entry is the client). It is used only
 * for throttling, never for identity: the account always comes from the token.
 * A missing or unparsable header yields `null`, and the per-address budget is
 * simply not applied — refusing the request instead would lock out callers
 * behind a proxy that strips the header.
 */
function readClientIp(request: ApiRequest): string | null {
  const forwarded = readHeader(request, "x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && first.length <= 64) return first;
  }
  const real = readHeader(request, "x-real-ip");
  return real && real.length <= 64 ? real.trim() : null;
}

/** Vercel may hand back an already parsed object or the raw string. */
function parseBody(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST requests are supported.", code: "method_not_allowed" });
  }

  try {
    let raw: unknown;
    try {
      raw = request.body;
    } catch {
      return response.status(400).json({ error: "Request body must be valid JSON.", code: "invalid_body" });
    }

    const input = readPlanChangeBody(parseBody(raw));
    const accessToken = readBearerToken(readHeader(request, "authorization"));

    const outcome = await handlePlanChangeRequest({
      accessToken,
      clientIp: readClientIp(request),
      ...input,
    });

    // Every throttled answer carries the delay the caller must honour, so a
    // browser or a script can back off instead of retrying blindly.
    if ("retryAfterSeconds" in outcome && outcome.retryAfterSeconds) {
      response.setHeader("Retry-After", String(outcome.retryAfterSeconds));
    }

    return response.status(outcome.status).json(outcome.body);
  } catch {
    // No internal detail is echoed: the reason belongs in the logs, not in the
    // answer to an unauthenticated caller.
    return response
      .status(503)
      .json({ error: "Temporary failure, retry later.", code: "unexpected_error" });
  }
}
