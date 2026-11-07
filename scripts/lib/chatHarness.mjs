/**
 * Shared harness for the `/api/chat` suites.
 *
 * Two suites drive the real handler (`api/chat.ts`): `chat-access.test.mjs`
 * checks who may call it, `chat-durable-quota.test.mjs` checks what it charges.
 * Both need the same three things stubbed — Supabase Auth, the subscriptions
 * table, and the RPC of migration 0003 — so they share them here instead of
 * drifting apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THE RPC DOUBLE DOES — AND DOES NOT — PROVE
 * ─────────────────────────────────────────────────────────────────────────────
 * `createUsageDb()` reproduces the *contract* of `ai_usage_consume` and
 * `ai_usage_refund` as written in migration 0003: one row per
 * `consumption_id`, a replay that charges nothing, a conflict when the same
 * identifier arrives for another account or another message kind, a limit
 * carried as an argument, and a refund that decrements exactly once.
 *
 * It is a model, not a proof. The atomicity of the SQL (one transaction for the
 * ledger row and the counter, the limit inside the `WHERE` clause of the
 * upsert) cannot be established in JavaScript and is out of scope here; it is
 * verified against PostgreSQL, on a preview project, by the live suite. What
 * this file *does* establish is that the route sends the right identifier, the
 * right limits and the right plan, and that it reacts to each answer the way the
 * contract requires.
 *
 * No network, no environment variable, no real project: `fetch` is replaced.
 */
export const USER_ID = "11111111-2222-4333-8444-555555555555";
export const OTHER_ID = "99999999-8888-4777-8666-555555555555";
/** Opaque to the handler: only Supabase's answer decides who it belongs to. */
export const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q";

/**
 * A token-shaped bearer for a given account.
 *
 * The handler never parses it — the stub `/auth/v1/user` does, so a test can
 * present several accounts to the same install and prove that the per-account
 * counters of P8/S4 are really per account. The signature segment is fake and
 * irrelevant: Supabase is the only authority, and it is the stub.
 */
export function tokenFor(userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId }), "utf8").toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlLXRlc3Q`;
}

/** The account the stub will vouch this bearer belongs to. */
function identityForToken(init) {
  const header = init.headers?.Authorization ?? init.headers?.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const sub = decoded?.sub;
    // Only a UUID is a usable account here: `/auth/v1/user` always answers with
    // one, and the harness must not invent an identity the server would refuse.
    return typeof sub === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)
      ? sub
      : null;
  } catch {
    return null;
  }
}

/** First day of the emulated UTC day. Every counter here lives on this day. */
import { resetRateLimits } from "../../server/rateLimits.ts";

/** Re-exported so a suite can clear the guard rails without importing server/ itself. */
export { resetRateLimits };

export const USAGE_DAY = "2026-11-07";

export const SUPABASE_URL = "https://stub-project.supabase.test";
export const ANON_KEY = "sb_publishable_stub_key";
export const SERVICE_KEY = "sb_secret_stub_key";

export const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
export const BASE_ENV = {
  SUPABASE_URL: SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  VEYVRO_AI_API_KEY: "test-provider-key",
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

/** Response helper. */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** `n` days from now, as an ISO timestamp — for subscription periods. */
export const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// A faithful enough ai_usage_consume / ai_usage_refund
// ---------------------------------------------------------------------------

/**
 * In-memory model of the durable quotas.
 *
 * Counters and events are keyed the way PostgreSQL keys them: one counter row
 * per (account, day), one ledger row per `consumption_id`.
 *
 * `rpc` records every call so a test can prove the plan limits actually left
 * the server (rather than being re-derived from something the browser sent).
 */
export function createUsageDb() {
  const counters = new Map(); // userId -> { messages, quotes }
  const events = new Map(); // consumptionId -> { userId, isQuote, state, attempts }
  const rpc = [];

  const counterOf = (userId) => {
    if (!counters.has(userId)) counters.set(userId, { messages: 0, quotes: 0 });
    return counters.get(userId);
  };

  const row = (allowed, reason, counter, replayed = false) => ({
    allowed,
    reason,
    used_messages: counter.messages,
    used_quotes: counter.quotes,
    usage_day: USAGE_DAY,
    replayed,
  });

  return {
    rpc,
    /** Pre-fill the day, as fifteen earlier messages would have. */
    seed(userId, { messages = 0, quotes = 0 } = {}) {
      counters.set(userId, { messages, quotes });
    },
    /** Today's counters, for assertions. */
    count(userId) {
      const counter = counters.get(userId);
      return counter ? { ...counter } : { messages: 0, quotes: 0 };
    },
    /** The ledger row of one identifier, or `null`. */
    event(consumptionId) {
      const event = events.get(consumptionId);
      return event ? { ...event } : null;
    },
    /** Consume calls only, without the refunds. */
    consumes() {
      return rpc.filter((call) => call.name === "consume");
    },
    refunds() {
      return rpc.filter((call) => call.name === "refund");
    },

    // ai_usage_consume(p_user_id, p_consumption_id, p_limit_messages,
    //                 p_limit_quotes, p_is_quote, p_now)
    consume(body) {
      const userId = body.p_user_id;
      const consumptionId = body.p_consumption_id;
      const isQuote = body.p_is_quote === true;
      const limitMessages = body.p_limit_messages;
      const limitQuotes = body.p_limit_quotes ?? null;
      const counter = counterOf(userId);

      const existing = events.get(consumptionId);
      if (existing) {
        // Identifier reuse across accounts or message kinds: refused, and the
        // counters returned are the caller's, never the owner's.
        if (existing.userId !== userId || existing.isQuote !== isQuote) {
          return [row(false, "consumption_conflict", counter)];
        }
        // Already charged: a replay. No increment, no second charge.
        if (existing.state === "consumed") return [row(true, null, counter, true)];
        // Refunded: re-consumable, but never more than three times in total.
        if (existing.attempts >= 3) return [row(false, "consumption_conflict", counter)];
        existing.state = "consumed";
        existing.attempts += 1;
        counter.messages += 1;
        if (isQuote) counter.quotes += 1;
        return [row(true, null, counter)];
      }

      const blocked =
        counter.messages >= limitMessages || (isQuote && limitQuotes !== null && counter.quotes >= limitQuotes);
      if (blocked) {
        const reason = isQuote && limitQuotes !== null && counter.quotes >= limitQuotes ? "daily_quotes" : "daily_messages";
        return [row(false, reason, counter)];
      }

      events.set(consumptionId, { userId, isQuote, state: "consumed", attempts: 1, usageDay: USAGE_DAY });
      counter.messages += 1;
      if (isQuote) counter.quotes += 1;
      return [row(true, null, counter)];
    },

    // ai_usage_refund(p_user_id, p_consumption_id, p_now)
    refund(body) {
      const event = events.get(body.p_consumption_id);
      // Absent and "belongs to someone else" are deliberately indistinguishable.
      if (!event || event.userId !== body.p_user_id) {
        return [{ refunded: false, reason: "not_refundable", usage_day: null }];
      }
      if (event.state === "refunded") {
        return [{ refunded: false, reason: "already_refunded", usage_day: event.usageDay }];
      }
      event.state = "refunded";
      const counter = counterOf(body.p_user_id);
      counter.messages = Math.max(0, counter.messages - 1);
      if (event.isQuote) counter.quotes = Math.max(0, counter.quotes - 1);
      return [{ refunded: true, reason: null, usage_day: event.usageDay }];
    },
  };
}

// ---------------------------------------------------------------------------
// The provider double
// ---------------------------------------------------------------------------

function sseResponse(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const deltaFrame = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

/** What the AI provider does when it is reached. */
export const PROVIDER = {
  /** Unreachable: the transport itself fails, before any byte. */
  throw_() {
    throw new Error("provider unreachable");
  },
  /** A normal answer, streamed in two chunks. */
  ok: () => sseResponse([deltaFrame("Bonjour"), deltaFrame(" ! Depuis VEYVRO."), "data: [DONE]\n\n"]),
  /** HTTP 500 with an OpenAI-shaped error payload. */
  http500: () => json({ error: { message: "upstream exploded", type: "server_error" } }, 500),
  /** A 200 with no body at all: the route cannot even open a stream. */
  no_body: () => new Response(null, { status: 200 }),
  /** The stream ends without a single token of text. */
  empty: () => sseResponse(["data: [DONE]\n\n"]),
  /** Text, then the stream stops without `[DONE]` or a finish reason. */
  truncated: () => sseResponse([deltaFrame("Une réponse à moitié")]),
  /** A complete answer that hit the model's output ceiling. */
  length: () =>
    sseResponse([deltaFrame("Réponse longue"), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`]),
};

// ---------------------------------------------------------------------------
// Installing the stubs
// ---------------------------------------------------------------------------

/**
 * Replace `fetch`.
 *
 * Options:
 *   identity    "ok" | "invalid" | "down" — what Supabase Auth answers.
 *   rows        subscription rows the REST read returns.
 *   restStatus  HTTP status of the subscriptions read (default 200).
 *   db          usage model (default: a fresh, empty one).
 *   usageStatus HTTP status of the RPC calls (default 200).
 *   refundStatus HTTP status of `ai_usage_refund` only (default: usageStatus).
 *   consumeAnswer  force the row `ai_usage_consume` returns, instead of letting
 *                  the model decide — for answers the model cannot naturally
 *                  produce (see the `conflict` case).
 *   provider    which PROVIDER behaviour answers the AI call.
 *              Default `"throw_"`: the provider must not be reached.
 */
export function installSupabase({
  identity = "ok",
  rows = [],
  restStatus = 200,
  db = createUsageDb(),
  usageStatus = 200,
  refundStatus = null,
  consumeAnswer = null,
  provider = "throw_",
  userId: requestedUserId = null,
} = {}) {
  const calls = [];
  const providerCalls = [];

  // Every install starts from a cold instance: the anti-abuse counters of
  // P8/S4 are module-level, exactly like the memory of one serverless instance,
  // so a suite that installs a fresh stub must not inherit the previous block's
  // windows. A test that *wants* accumulation loops inside a single install.
  resetRateLimits();

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers ?? {}, body: init.body });

    if (url.includes("/auth/v1/user")) {
      if (identity === "invalid") return json({ message: "invalid JWT" }, 401);
      if (identity === "down") throw new Error("auth unreachable");
      // One install can vouch for several accounts: the identity comes from the
      // bearer, exactly as a real token's `sub` would.
      const vouch = identityForToken(init) ?? requestedUserId ?? USER_ID;
      return json({
        id: vouch,
        email: "client@veyvro.test",
        email_confirmed_at: "2026-10-01T00:00:00.000Z",
      });
    }

    if (url.includes("/rest/v1/subscriptions")) {
      if (restStatus !== 200) return new Response("denied", { status: restStatus });
      return json(rows);
    }

    if (url.includes("/rest/v1/rpc/ai_usage_consume")) {
      if (usageStatus !== 200) return new Response("denied", { status: usageStatus });
      const body = JSON.parse(init.body ?? "{}");
      db.rpc.push({ name: "consume", body });
      return json(consumeAnswer ? consumeAnswer(body) : db.consume(body));
    }

    if (url.includes("/rest/v1/rpc/ai_usage_refund")) {
      const status = refundStatus ?? usageStatus;
      if (status !== 200) return new Response("denied", { status });
      const body = JSON.parse(init.body ?? "{}");
      db.rpc.push({ name: "refund", body });
      return json(db.refund(body));
    }

    if (url.includes("/chat/completions")) {
      providerCalls.push({ url, body: JSON.parse(init.body ?? "{}") });
      const behaviour = PROVIDER[provider];
      if (!behaviour) throw new Error(`unknown provider behaviour: ${provider}`);
      return behaviour();
    }

    throw new Error(`unexpected outbound call: ${url}`);
  };

  return { calls, providerCalls, db };
}

export function setEnv(overrides = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
}

export function restoreEnv() {
  process.env = { ...originalEnv };
}

export function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/** Minimal response double that records what the handler produced. */
export function makeResponse() {
  const out = { status: 0, body: null, headers: {}, events: [], text: "" };
  let cursor = 0;
  const response = {
    status(code) {
      out.status = code;
      return response;
    },
    json(body) {
      out.body = body;
      return response;
    },
    setHeader(name, value) {
      out.headers[name] = value;
    },
    flushHeaders() {},
    write(chunk) {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      out.text += text;
      // SSE frames are `event: <name>\ndata: <json>\n\n`; parse complete blocks
      // only, so a frame split across two writes is still read correctly.
      let separator = out.text.indexOf("\n\n", cursor);
      while (separator !== -1) {
        const block = out.text.slice(cursor, separator);
        cursor = separator + 2;
        let name = null;
        let data = null;
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            try {
              data = JSON.parse(raw);
            } catch {
              data = raw;
            }
          }
        }
        if (name !== null || data !== null) out.events.push({ event: name, data });
        separator = out.text.indexOf("\n\n", cursor);
      }
      return true;
    },
    end() {
      out.ended = true;
    },
  };
  return { res: response, out };
}

/** A valid chat request body: one user message. */
export function chatBody(extra = {}) {
  return { messages: [{ role: "user", content: "Bonjour VEYVRO" }], ...extra };
}

/**
 * Drive the real handler and return what it wrote.
 *
 * `handler` is imported by each suite (not by this file) so the module under
 * test is the one the suite names, and so a syntax error surfaces there.
 */
export async function callChat(handler, { headers = {}, body = chatBody(), method = "POST" } = {}) {
  const { res, out } = makeResponse();
  await handler({ method, headers, body }, res);
  return out;
}

/** The names of the SSE frames a streamed answer produced, in order. */
export function eventCodes(out) {
  return out.events.map((frame) => frame.event);
}

/** The payload of the first frame with this name, or `undefined`. */
export function eventData(out, name) {
  return out.events.find((frame) => frame.event === name)?.data;
}
