/**
 * End-to-end pipeline tests for /api/chat — the real handler, a stubbed
 * Supabase and a stubbed OpenAI.
 *
 * What is asserted here is exactly what an operator would check after deploying:
 *   • a simple question calls one cheap model and streams the answer;
 *   • a difficult request makes several models work together and one coordinator
 *     write the single answer the user reads;
 *   • a model that is refused is replaced transparently, and an authentication
 *     failure is not retried pointlessly;
 *   • the SSE contract (`delta` fragments, then `done`) is unchanged, and no key,
 *     token or provider payload leaks into the response;
 *   • the conversation context sent to the provider is the real conversation.
 *
 * No network call is made: the stub inspects every request body and answers with
 * a hand-built OpenAI stream, so the assertions can be strict about parameters.
 */
import assert from "node:assert";
import handler from "../api/chat.ts";
import { resetQuotas } from "../server/quotas.ts";
import { resetModelAvailability } from "../server/ai/modelCatalog.ts";
import { resetSpend } from "../server/ai/budget.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const SUPABASE_URL = "https://stub-project.supabase.test";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q";
const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VEYVRO_AI_API_KEY",
  "VEYVRO_AI_PROVIDER",
  "VEYVRO_AI_BASE_URL",
  "VEYVRO_AI_MODEL",
  "VEYVRO_AI_ROUTING",
  "VEYVRO_AI_DAILY_BUDGET_USD",
  "VEYVRO_AI_REQUEST_DEADLINE_MS",
];
const BASE_ENV = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: "sb_publishable_stub_key",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_stub_key",
  VEYVRO_AI_API_KEY: "sk-test-provider-key",
  VEYVRO_AI_BASE_URL: "https://api.openai.test/v1",
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let ipCounter = 0;

function setEnv(overrides = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
}

function restoreEnv() {
  process.env = { ...originalEnv };
}

const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Response double
// ---------------------------------------------------------------------------
function makeResponse() {
  const out = { status: 0, body: null, headers: {}, events: [], raw: "" };
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
      out.raw += chunk;
      for (const frame of chunk.split("\n\n")) {
        if (!frame.trim()) continue;
        let event = "message";
        const dataLines = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        let payload = null;
        try {
          payload = JSON.parse(dataLines.join("\n"));
        } catch {
          payload = null;
        }
        out.events.push({ event, payload });
      }
      return true;
    },
    end() {},
  };
  return { res: response, out };
}

const textOf = (out) =>
  out.events
    .filter((entry) => entry.event === "delta")
    .map((entry) => entry.payload?.delta ?? "")
    .join("");

// ---------------------------------------------------------------------------
// OpenAI stub
// ---------------------------------------------------------------------------
function sseStream(frames) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function textFrames(text, finishReason = "stop") {
  const frames = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`];
  frames.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
  );
  frames.push(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 220 } })}\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return frames;
}

/**
 * Install the stub for both services.
 *
 * `openai(body, call)` decides what the provider answers for one request;
 * everything is recorded so tests can assert on the exact bodies sent.
 */
function installStub({ rows = [], openai = defaultOpenAI } = {}) {
  const calls = { supabase: [], openai: [] };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : null;

    if (url.startsWith(SUPABASE_URL)) {
      calls.supabase.push({ url, method: init.method ?? "GET", body });
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: USER_ID, email: "client@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00.000Z" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/rest/v1/subscriptions")) {
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected supabase call: ${url}`);
    }

    if (url.startsWith("https://api.openai.test")) {
      calls.openai.push({ url, body, headers: init.headers });
      return openai(body, calls.openai.length, init);
    }

    throw new Error(`unexpected outbound call: ${url}`);
  };

  return calls;
}

/** Default provider behaviour: stream a plausible answer for any model. */
function defaultOpenAI(body) {
  if (body.stream === false) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: '{"verdict":"ok","issues":[]}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 700, completion_tokens: 200 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(sseStream(textFrames(`Réponse de ${body.model}.`)), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function callChat({ headers = {}, body, method = "POST" } = {}) {
  const { res, out } = makeResponse();
  ipCounter += 1;
  await handler(
    {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": `198.18.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`, ...headers },
      body: body ?? { messages: [{ role: "user", content: "Bonjour VEYVRO" }] },
    },
    res,
  );
  return out;
}

function proPlan() {
  return [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }];
}

// ---------------------------------------------------------------------------
// 1. Question simple : un seul modèle, rapide, streamé
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  resetSpend();
  setEnv();
  const calls = installStub({ rows: proPlan() });

  const out = await callChat();

  assert.equal(out.status, 200, "le flux SSE s'ouvre en 200 dès le premier fragment");
  assert.ok(out.headers["Content-Type"].includes("text/event-stream"));
  assert.equal(calls.openai.length, 1, "une question simple ne doit appeler qu'un seul modèle");
  assert.equal(calls.openai[0].body.model, "gpt-6-luna", "la question simple part sur le modèle rapide");
  assert.equal(calls.openai[0].body.stream, true, "le streaming est conservé");
  assert.equal(calls.openai[0].body.reasoning_effort, "low");
  assert.ok(calls.openai[0].body.max_completion_tokens > 0);
  assert.equal(calls.openai[0].body.temperature, undefined, "un modèle de raisonnement ne reçoit pas temperature");
  assert.match(textOf(out), /Réponse de gpt-6-luna/);
  assert.equal(out.events.at(-1).event, "done", "le flux se termine par `done`");

  restoreEnv();
  pass("question simple : un modèle rapide, streaming intact, `done` final, aucun appel superflu");
}

// ---------------------------------------------------------------------------
// 2. Le contrat SSE est inchangé
// ---------------------------------------------------------------------------
{
  resetQuotas();
  setEnv();
  installStub({ rows: proPlan() });
  const out = await callChat();
  const deltaEvents = out.events.filter((entry) => entry.event === "delta");
  assert.ok(deltaEvents.length >= 1);
  for (const entry of deltaEvents) {
    assert.equal(typeof entry.payload.delta, "string");
    assert.deepEqual(Object.keys(entry.payload), ["delta"], "un delta ne contient que son texte");
  }
  assert.deepEqual(out.events.at(-1), { event: "done", payload: out.events.at(-1).payload });
  assert.equal(typeof out.events.at(-1).payload, "object");
  restoreEnv();
  pass("contrat SSE : `event: delta` + `{delta}` puis `event: done`, comme avant la refonte");
}

// ---------------------------------------------------------------------------
// 3. Le contexte conversationnel est transmis
// ---------------------------------------------------------------------------
{
  resetQuotas();
  setEnv();
  const calls = installStub({ rows: proPlan() });
  await callChat({
    body: {
      messages: [
        { role: "user", content: "Je cherche une berline familiale." },
        { role: "assistant", content: "Quel budget ?" },
        { role: "user", content: "Autour de 25 000 euros." },
      ],
    },
  });
  const sent = calls.openai[0].body.messages;
  assert.equal(sent[0].role, "system", "le prompt système VEYVRO est toujours en tête");
  assert.match(sent[0].content, /You are VEYVRO/);
  assert.deepEqual(
    sent.slice(1).map((message) => message.role),
    ["user", "assistant", "user"],
    "l'historique complet est transmis dans l'ordre",
  );
  assert.equal(sent.at(-1).content, "Autour de 25 000 euros.");
  restoreEnv();
  pass("contexte : le prompt système et l'historique sont transmis intégralement, dans l'ordre");
}

// ---------------------------------------------------------------------------
// 4. Collaboration multi-modèles sur une demande difficile
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  resetSpend();
  setEnv({ VEYVRO_AI_ROUTING: "collaborative" });
  const calls = installStub({
    rows: proPlan(),
    openai: (body) => {
      if (body.stream === false && /CONTRÔLE QUALITÉ/.test(JSON.stringify(body.messages))) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: "correction",
                    issues: [
                      {
                        probleme: "Le couple de serrage annoncé dépend de la version.",
                        correction: "Le couple de serrage varie selon la version du moteur : à confirmer en concession.",
                      },
                    ],
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 800, completion_tokens: 90 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.stream === false) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: "Brouillon technique indépendant et détaillé sur le bruit de chaîne, les intervalles d'entretien et le coût réel d'un remplacement, avec les points à vérifier avant d'accepter le devis du garage." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 900, completion_tokens: 300 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(sseStream(textFrames("Réponse fusionnée par le coordinateur : le bruit de chaîne sur ce moteur est un point connu, il faut faire vérifier le tendeur, et le devis mérite une seconde lecture ligne par ligne avant de signer quoi que ce soit.")), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const out = await callChat({
    body: {
      messages: [
        {
          role: "user",
          content:
            "Ma BMW 320d F30 a un bruit de chaîne à froid, le garage propose 2 800 € avec un devis à plusieurs lignes. Est-ce dangereux de continuer à rouler ? Et dois-je réparer ou vendre la voiture ?",
        },
      ],
    },
  });

  const draftCalls = calls.openai.filter((call) => call.body.stream === false && !/CONTRÔLE QUALITÉ/.test(JSON.stringify(call.body.messages)));
  const synthesisCalls = calls.openai.filter((call) => call.body.stream === true);
  const verifyCalls = calls.openai.filter((call) => /CONTRÔLE QUALITÉ/.test(JSON.stringify(call.body.messages)));

  assert.equal(draftCalls.length, 2, "deux modèles rédigent un brouillon indépendant");
  const draftModels = draftCalls.map((call) => call.body.model).sort();
  assert.deepEqual(draftModels, ["gpt-6.2-astra", "gpt-6.2-sol"], "les brouillons viennent de deux modèles différents");
  for (const call of draftCalls) {
    assert.match(JSON.stringify(call.body.messages), /MODE COLLABORATIF/, "chaque brouillon reçoit sa consigne");
  }

  assert.equal(synthesisCalls.length, 1, "un seul modèle écrit la réponse finale");
  assert.equal(synthesisCalls[0].body.model, "gpt-6.2-sol", "le coordinateur est le modèle de synthèse");
  const synthesisPrompt = JSON.stringify(synthesisCalls[0].body.messages);
  assert.match(synthesisPrompt, /PASSE DE SYNTHÈSE/);
  assert.equal((synthesisPrompt.match(/Brouillon \d/g) ?? []).length, 2, "les deux brouillons sont fournis au coordinateur");

  assert.equal(verifyCalls.length, 1, "la réponse est vérifiée par un modèle distinct");
  assert.equal(verifyCalls[0].body.model, "gpt-6.1-terra", "le vérificateur est le modèle équilibré, moins cher");

  // The user reads one answer, then the corrections — never the drafts.
  const visible = textOf(out);
  assert.match(visible, /Réponse fusionnée par le coordinateur/);
  assert.doesNotMatch(visible, /Brouillon technique indépendant/, "les brouillons ne sont jamais montrés");
  assert.doesNotMatch(visible, /MODE COLLABORATIF/, "les consignes internes ne fuitent pas dans la réponse");
  assert.match(visible, /Points? de vigilance/, "les corrections vérifiées sont ajoutées");
  assert.match(visible, /à confirmer en concession/);

  const done = out.events.at(-1);
  assert.equal(done.payload.routing.models, 3, "le décompte public reflète les 3 modèles réellement impliqués");
  assert.equal(done.payload.routing.mode, "collaborative");

  const stages = out.events.filter((entry) => entry.event === "stage").map((entry) => entry.payload.stage);
  assert.deepEqual(stages, ["draft", "synthesise", "correction"], "la progression est publiée sur un canal séparé");
  assert.equal(out.events.at(-1).event, "done");

  restoreEnv();
  pass("collaboration : deux brouillons en parallèle, un coordinateur, une vérification, une seule réponse visible");
}

// ---------------------------------------------------------------------------
// 5. Échec d'un modèle : repli transparent
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  setEnv({ VEYVRO_AI_ROUTING: "single" });
  const tried = [];
  const calls = installStub({
    rows: proPlan(),
    openai: (body) => {
      tried.push(body.model);
      if (body.model === "gpt-6-luna") {
        return new Response(
          JSON.stringify({ error: { code: "model_not_found", message: "The model does not exist" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(sseStream(textFrames(`Réponse de secours par ${body.model}.`)), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const out = await callChat();

  assert.equal(tried[0], "gpt-6-luna", "le modèle rapide est tenté d'abord");
  assert.equal(tried.length, 2, "un seul repli suffit");
  assert.notEqual(tried[1], "gpt-6-luna");
  assert.equal(out.status, 200);
  assert.match(textOf(out), /Réponse de secours par /, "l'utilisateur reçoit une réponse malgré l'échec");
  assert.equal(out.events.at(-1).event, "done");
  assert.ok(
    out.events.some((entry) => entry.event === "stage" && entry.payload.stage === "fallback"),
    "le repli est signalé sur le canal de progression",
  );
  assert.ok(calls.openai.length === 2);

  // The refused model is remembered: the next request must not try it again.
  const before = calls.openai.length;
  await callChat();
  assert.equal(calls.openai[before].body.model !== "gpt-6-luna", true, "un modèle refusé n'est pas retenté aussitôt");

  restoreEnv();
  resetModelAvailability();
  pass("échec d'un modèle : repli transparent vers un autre modèle, refus mémorisé, réponse livrée");
}

// ---------------------------------------------------------------------------
// 6. Erreur d'authentification : pas de repli inutile
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  setEnv({ VEYVRO_AI_ROUTING: "single" });
  let attempts = 0;
  installStub({
    rows: proPlan(),
    openai: () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: { code: "invalid_api_key", message: "Incorrect API key provided" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const out = await callChat();
  assert.equal(out.status, 502);
  assert.equal(out.body.code, "invalid_api_key");
  assert.match(out.body.error, /VEYVRO_AI_API_KEY/);
  assert.equal(attempts, 1, "une clé invalide ne doit pas être retentée sur chaque modèle");
  assert.doesNotMatch(JSON.stringify(out), /sk-test-provider-key/, "la clé ne doit jamais apparaître");
  restoreEnv();
  pass("clé invalide : 502 `invalid_api_key` après un seul appel, message actionnable, aucun secret exposé");
}

// ---------------------------------------------------------------------------
// 7. Quota du fournisseur : arrêt immédiat, code attendu par l'interface
// ---------------------------------------------------------------------------
{
  resetQuotas();
  setEnv({ VEYVRO_AI_ROUTING: "single" });
  let attempts = 0;
  installStub({
    rows: proPlan(),
    openai: () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your quota" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const out = await callChat();
  assert.equal(out.status, 429);
  assert.equal(out.body.code, "insufficient_quota");
  assert.equal(attempts, 1, "un quota épuisé n'est pas contourné en changeant de modèle");
  restoreEnv();
  pass("quota épuisé : 429 `insufficient_quota`, un seul appel, pas de repli coûteux");
}

// ---------------------------------------------------------------------------
// 8. Réponse vide et réponse tronquée
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  setEnv({ VEYVRO_AI_ROUTING: "single" });
  installStub({
    rows: proPlan(),
    openai: () =>
      new Response(sseStream([`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });
  const out = await callChat();
  assert.ok(
    out.body?.code === "empty_response" ||
      out.events.some((entry) => entry.event === "error" && entry.payload.code === "empty_response"),
    "une réponse vide est signalée, jamais présentée comme un succès",
  );
  restoreEnv();
  pass("réponse vide : erreur `empty_response` explicite");
}

{
  resetQuotas();
  resetModelAvailability();
  setEnv({ VEYVRO_AI_ROUTING: "single" });
  installStub({
    rows: proPlan(),
    openai: () =>
      new Response(sseStream(textFrames("Réponse longue mais coupée", "length")), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });
  const out = await callChat();
  assert.match(textOf(out), /tronquée/);
  const done = out.events.at(-1);
  assert.equal(done.event, "done");
  assert.equal(done.payload.truncated, true);
  assert.equal(done.payload.finishReason, "length");
  restoreEnv();
  pass("réponse tronquée : note visible et `done {truncated:true}`, comportement inchangé");
}

// ---------------------------------------------------------------------------
// 9. Délai dépassé
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  // Short deadline so the test proves the behaviour without waiting 54 s.
  setEnv({ VEYVRO_AI_ROUTING: "single", VEYVRO_AI_REQUEST_DEADLINE_MS: "5000" });
  installStub({
    rows: proPlan(),
    openai: (_body, _index, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });

  const startedAt = Date.now();
  const out = await callChat();
  const elapsed = Date.now() - startedAt;
  assert.equal(out.status, 504);
  assert.equal(out.body.code, "timeout");
  assert.ok(elapsed < 12_000, `le handler doit rendre la main avant l'échéance configurée (${elapsed} ms)`);
  restoreEnv();
  pass("délai : 504 `timeout` avant la limite de la fonction, la requête ne reste jamais suspendue");
}

// ---------------------------------------------------------------------------
// 10. Pièce jointe : vision et coût
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  resetSpend();
  setEnv();
  const calls = installStub({ rows: proPlan() });

  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const out = await callChat({
    body: {
      messages: [{ role: "user", content: "Analyse ce devis de garage." }],
      attachments: [{ type: "image", name: "devis.png", mimeType: "image/png", dataUrl: pixel }],
      task: "garage-quote",
    },
  });

  assert.equal(calls.openai.length >= 1, true);
  // The primary call is the last one: collaboration/verification may follow it.
  const primaryCall = calls.openai.filter((call) => call.body.stream === true).at(-1);
  assert.ok(primaryCall, "un appel principal est envoyé");
  const finalUser = primaryCall.body.messages.at(-1);
  assert.equal(Array.isArray(finalUser.content), true, "l'image est envoyée comme contenu multimodal");
  assert.ok(finalUser.content.some((part) => part.type === "image_url"), "la photo du devis est bien transmise");
  assert.equal(primaryCall.body.model, "gpt-6.2-sol", "un document à lire part sur un modèle de raisonnement vision");
  assert.equal(primaryCall.body.reasoning_effort !== undefined, true, "le modèle de raisonnement reçoit son effort");
  assert.ok(
    calls.openai.every((call) => call.body.stream === true || /CONTRÔLE QUALITÉ/.test(JSON.stringify(call.body.messages))),
    "même en mode collaboratif, la photo n'est jamais envoyée à un modèle sans vision",
  );
  assert.match(textOf(out), /Réponse de gpt-6.2-sol/);

  restoreEnv();
  pass("pièce jointe : contenu multimodal transmis au modèle vision, analyse de devis préservée");
}

// ---------------------------------------------------------------------------
// 11. Le mode coûteux est freiné par le budget de l'instance
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  resetSpend();
  // An exhausted instance budget: collaboration must degrade, not fail.
  setEnv({ VEYVRO_AI_ROUTING: "collaborative", VEYVRO_AI_DAILY_BUDGET_USD: "0.0001" });
  const calls = installStub({ rows: proPlan() });

  const out = await callChat({
    body: {
      messages: [
        {
          role: "user",
          content:
            "Ma BMW 320d F30 a un bruit de chaîne à froid, le garage propose 2 800 € avec un devis à plusieurs lignes. Est-ce dangereux de continuer à rouler ?",
        },
      ],
    },
  });

  const streamedCalls = calls.openai.filter((call) => call.body.stream === true);
  assert.equal(streamedCalls.length, 1, "le budget épuisé ramène à un seul modèle");
  assert.equal(calls.openai.filter((call) => call.body.stream === false).length, 0, "aucun brouillon n'est payé");
  assert.equal(out.events.at(-1).event, "done", "la réponse est quand même livrée");
  assert.match(textOf(out), /Réponse de /);

  restoreEnv();
  resetSpend();
  pass("budget : un plafond journalier atteint désactive la collaboration sans bloquer le chat");
}

// ---------------------------------------------------------------------------
// 12. Un modèle épinglé reste prioritaire (rétrocompatibilité)
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  setEnv({ VEYVRO_AI_MODEL: "gpt-4.1-mini", VEYVRO_AI_ROUTING: "single" });
  const calls = installStub({ rows: proPlan() });

  const out = await callChat();
  assert.equal(calls.openai[0].body.model, "gpt-4.1-mini", "VEYVRO_AI_MODEL reste prioritaire");
  assert.equal(calls.openai[0].body.temperature, 0.7, "un modèle classique reçoit toujours sa température");
  assert.equal(calls.openai[0].body.reasoning_effort, undefined);
  assert.match(textOf(out), /Réponse de gpt-4.1-mini/);
  restoreEnv();
  pass("rétrocompatibilité : un modèle épinglé est honoré avec le bon profil de paramètres");
}

// ---------------------------------------------------------------------------
// 12 bis. Fournisseur non-OpenAI : comportement mono-modèle préservé
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  setEnv({ VEYVRO_AI_PROVIDER: "openai-compatible", VEYVRO_AI_ROUTING: "auto" });
  const calls = installStub({ rows: proPlan() });

  const out = await callChat();
  assert.equal(calls.openai.length, 1, "un endpoint non-OpenAI ne reçoit qu'un seul appel");
  assert.equal(calls.openai[0].body.model, "gpt-4.1-mini", "le modèle par défaut historique est conservé");
  assert.equal(out.events.at(-1).event, "done");
  restoreEnv();
  pass("fournisseur non-OpenAI : mono-modèle et modèle par défaut inchangés, routage multi-modèles réservé à OpenAI");
}

// ---------------------------------------------------------------------------
// 13. Rien de sensible ne sort, même en cas d'erreur
// ---------------------------------------------------------------------------
{
  resetQuotas();
  resetModelAvailability();
  setEnv({ VEYVRO_AI_ROUTING: "single" });
  installStub({
    rows: proPlan(),
    openai: () =>
      new Response(JSON.stringify({ error: { message: "internal detail sk-test-provider-key" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
  });

  const out = await callChat();
  const serialised = JSON.stringify(out);
  assert.doesNotMatch(serialised, /sk-test-provider-key/, "la clé du fournisseur ne fuit jamais");
  assert.doesNotMatch(serialised, /sb_secret|sb_publishable/, "les clés Supabase ne fuient jamais");
  assert.doesNotMatch(serialised, new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialised, /internal detail/, "le message brut du fournisseur n'est pas relayé");
  restoreEnv();
  pass("sécurité : ni clé, ni jeton, ni message interne du fournisseur dans la réponse d'erreur");
}

// ---------------------------------------------------------------------------
// 14. Les garde-fous existants sont intacts
// ---------------------------------------------------------------------------
{
  resetQuotas();
  setEnv();
  installStub({ rows: proPlan() });
  const unauth = await callChat({ headers: { authorization: "" } });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.code, "auth_required");

  const badMethod = await callChat({ method: "GET" });
  assert.equal(badMethod.status, 405);

  resetQuotas();
  const missingKey = await (async () => {
    setEnv({ VEYVRO_AI_API_KEY: undefined });
    return callChat();
  })();
  assert.equal(missingKey.status, 503);
  assert.equal(missingKey.body.code, "missing_api_key");

  restoreEnv();
  pass("garde-fous : authentification, méthode et configuration manquante se comportent comme avant");
}

globalThis.fetch = originalFetch;
resetModelAvailability();
resetSpend();
resetQuotas();
console.log(`\n${checks} vérifications de pipeline IA passées.`);
