/**
 * TEMPORARY diagnostic endpoint — remove once the Paddle chain is verified.
 *
 * Why it exists: the Paddle handler can only be exercised by a real POST, and
 * the only network path available to the maintainer's tooling is a GET against
 * the deployment. This route performs that POST from inside the deployment
 * itself, so the request goes through the real Vercel Node runtime — the one
 * whose lazy `request.body` getter originally swallowed the signed bytes.
 *
 * Call it with `?run=1`. It is idempotent: the probe event always uses the same
 * `event_id`, so `webhook_events` gains at most one row, however often it runs.
 *
 * It never returns a secret. Environment variables are reported as booleans, and
 * Paddle's signing secret is used in-process only, to sign the probe payload.
 */
import { computeSignature } from "./paddle-webhook.js";

type ProbeRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
};

type ProbeResponse = {
  status: (code: number) => ProbeResponse;
  json: (body: unknown) => ProbeResponse;
  setHeader: (name: string, value: string) => void;
};

/** Fixed so every run targets the same row: at most one insert, ever. */
const PROBE_EVENT_ID = "evt_selfcheck_veyvro_0001";

/** A well-formed UUID that is not an account: the handler must reject it. */
const PROBE_USER_ID = "11111111-1111-4111-8111-111111111111";


/**
 * Describe a key WITHOUT revealing it: shape, JWT claims, and red flags only.
 * Used to find out why PostgREST answers 401 without ever printing the secret.
 */
function describeKey(raw: string | undefined) {
  const value = raw ?? "";
  const trimmed = value.trim();
  const info: Record<string, unknown> = {
    present: trimmed.length > 0,
    length: trimmed.length,
    untrimmedLength: value.length,
    hadSurroundingWhitespace: value !== trimmed,
    hasQuotes: /^["'`]|["'`]$/.test(trimmed),
    shape: trimmed.startsWith("eyJ")
      ? "jwt"
      : trimmed.startsWith("sb_secret_")
        ? "new-style-secret"
        : trimmed.startsWith("sb_publishable_")
          ? "publishable"
          : "unknown",
  };

  if (info.shape === "jwt") {
    try {
      const payload = JSON.parse(
        Buffer.from(trimmed.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as { ref?: string; role?: string; exp?: number; iss?: string };
      info.jwtRole = payload.role ?? null;
      info.jwtRef = payload.ref ?? null;
      info.jwtExp = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
      info.jwtExpired = payload.exp ? payload.exp * 1000 < Date.now() : null;
      info.jwtIssuer = payload.iss ?? null;
    } catch {
      info.jwtDecode = "failed";
    }
  }
  return info;
}

/** Project ref encoded in the Supabase URL (the subdomain). */
function projectRef(url: string): string | null {
  try {
    return new URL(url).hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

/** One read against PostgREST, reported as status + short message only. */
async function probeRest(url: string, key: string | undefined, table: string) {
  if (!url || !key) return { skipped: "missing url or key" };
  try {
    const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const text = await response.text();
    let message: unknown = text.slice(0, 160);
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: string; hint?: string };
      message = parsed.message ?? parsed.code ?? text.slice(0, 160);
    } catch {
      /* plain text body */
    }
    return { status: response.status, message };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "request failed" };
  }
}


/** Enumerate candidate variable NAMES (never values) and their key shape. */
function describeEnvNames() {
  const interesting = /SUPABASE|PADDLE|SERVICE|SECRET|KEY/i;
  return Object.keys(process.env)
    .filter((name) => interesting.test(name) && !/^VERCEL/.test(name))
    .sort()
    .map((name) => {
      const value = process.env[name] ?? "";
      const trimmed = value.trim();
      return {
        name,
        shape: trimmed.startsWith("eyJ")
          ? "jwt"
          : trimmed.startsWith("sb_secret_")
            ? "new-style-secret"
            : trimmed.startsWith("sb_publishable_")
              ? "publishable"
              : trimmed.length === 0
                ? "empty"
                : "other",
      };
    });
}

const jsonHeaders = { "Content-Type": "application/json" };

function readHeader(request: ProbeRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/** Host this function is served from, as seen through the Vercel proxy. */
function resolveOrigin(request: ProbeRequest): string {
  const forwarded = readHeader(request, "x-forwarded-host");
  const host = forwarded ?? readHeader(request, "host") ?? "";
  const proto = readHeader(request, "x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

async function postWebhook(
  url: string,
  body: string,
  paddleSignature: string | null,
  bypass: string | null,
): Promise<{ status: number; contentType: string; payload: unknown }> {
  const headers: Record<string, string> = {
    ...jsonHeaders,
    ...(paddleSignature ? { "paddle-signature": paddleSignature } : {}),
    // Lets the call through Preview deployment protection when configured.
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
  };

  const response = await fetch(url, { method: "POST", headers, body });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  let payload: unknown = text.slice(0, 300);
  if (contentType.includes("application/json")) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text.slice(0, 300);
    }
  }
  return { status: response.status, contentType, payload };
}

export default async function handler(request: ProbeRequest, response: ProbeResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Only GET requests are supported." });
  }

  const run = request.query?.run;
  const requested = Array.isArray(run) ? run[0] : run;
  if (requested !== "1") {
    return response.status(400).json({ error: "Pass ?run=1 to execute the probe." });
  }

  const secret = process.env.PADDLE_WEBHOOK_SECRET?.trim() ?? "";
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? "";

  const url = `${resolveOrigin(request)}/api/paddle-webhook`;

  // The probe event: deliberately for an account that does not exist. The
  // handler writes `received` BEFORE resolving the user, so a `rejected` row
  // proves the write path end to end.
  const payload = JSON.stringify({
    event_id: PROBE_EVENT_ID,
    event_type: "subscription.created",
    occurred_at: new Date().toISOString(),
    data: {
      id: "sub_selfcheck000000000001",
      status: "active",
      customer_id: "ctm_selfcheck000000000001",
      currency_code: "EUR",
      custom_data: { user_id: PROBE_USER_ID },
      items: [
        {
          price: {
            id: "pri_01m57n587d0qj874fk6hynqbg3",
            product_id: "pro_selfcheck00000000001",
          },
        },
      ],
      current_billing_period: {
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    },
  });

  // 1. Wrong signature: proves the signed bytes are readable, and which path
  //    produced them ("stream" = the lazy getter was never triggered).
  const ts = String(Math.floor(Date.now() / 1000));
  const badSignature = `ts=${ts};h1=${"deadbeef".repeat(8)}`;
  const invalidSignature = await postWebhook(url, payload, badSignature, bypass || null);

  // 2. Correctly signed delivery. The secret never leaves this process.
  let signedDelivery: unknown = { skipped: "PADDLE_WEBHOOK_SECRET is absent" };
  if (secret) {
    const signature = `ts=${ts};h1=${computeSignature(Buffer.from(payload, "utf8"), ts, secret)}`;
    signedDelivery = await postWebhook(url, payload, signature, bypass || null);
  }

  // 3. Read the row back, so the answer comes from Postgres rather than from us.
  let supabaseRow: unknown = { skipped: "Supabase is not configured" };
  if (supabaseUrl && serviceKey) {
    try {
      const query = `${supabaseUrl}/rest/v1/webhook_events?event_id=eq.${encodeURIComponent(
        PROBE_EVENT_ID,
      )}&select=event_id,status,reason&limit=1`;
      const read = await fetch(query, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      const rows = (await read.json()) as Array<Record<string, unknown>>;
      supabaseRow = Array.isArray(rows) && rows.length > 0
        ? { found: true, status: rows[0].status, reason: rows[0].reason }
        : { found: false, responseStatus: read.status };
    } catch (error) {
      supabaseRow = { error: error instanceof Error ? error.message : "read failed" };
    }
  }

  const anonKey = process.env.SUPABASE_ANON_KEY?.trim() ?? "";
  const restWithService = await probeRest(supabaseUrl, serviceKey, "webhook_events");
  const restWithAnon = await probeRest(supabaseUrl, anonKey, "webhook_events");
  const serviceInfo = describeKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const urlRef = projectRef(supabaseUrl);

  return response.status(200).json({
    probe: "webhook-selfcheck",
    // Which deployment actually answered: proves whether a rebuild picked up a
    // changed variable, or whether the branch alias is still serving an older one.
    deployment: {
      id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      url: process.env.VERCEL_URL ?? null,
      env: process.env.VERCEL_ENV ?? null,
      gitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      gitRef: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    },
    keyDiagnostics: {
      supabaseUrlHost: supabaseUrl ? new URL(supabaseUrl).hostname : null,
      urlProjectRef: urlRef,
      serviceKey: serviceInfo,
      serviceKeyRefMatchesUrl: serviceInfo.jwtRef ? serviceInfo.jwtRef === urlRef : null,
      anonKeyPresent: anonKey.length > 0,
      serviceKeyEqualsAnonKey: serviceKey.length > 0 && serviceKey === anonKey,
      candidateEnvNames: describeEnvNames(),
      restWithService,
      restWithAnon,
    },
    eventId: PROBE_EVENT_ID,
    envPresent: {
      PADDLE_WEBHOOK_SECRET: secret.length > 0,
      SUPABASE_URL: supabaseUrl.length > 0,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey.length > 0,
      VERCEL_AUTOMATION_BYPASS_SECRET: bypass.length > 0,
    },
    invalidSignature,
    signedDelivery,
    supabaseRow,
  });
}
