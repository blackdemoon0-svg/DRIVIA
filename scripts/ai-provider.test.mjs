/**
 * Transport tests — the provider client, with `fetch` replaced by a stub.
 *
 * These cover what a request body must contain for each model profile, how
 * upstream failures are classified, when a retry is worth it, and how a
 * fallback chain behaves. They are the layer where a mistake costs money or
 * turns a recoverable failure into a user-facing error.
 */
import assert from "node:assert";
import {
  OPENAI_CATALOG,
  describeModel,
  resetModelAvailability,
  isModelUnavailable,
} from "../server/ai/modelCatalog.ts";
import {
  ProviderClient,
  ProviderError,
  buildChatRequestBody,
  classifyProviderHttpError,
  parseStreamFrame,
} from "../server/ai/provider.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const messages = [
  { role: "system", content: "You are VEYVRO." },
  { role: "user", content: "Bonjour" },
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function framesFor(text, { usage = true, finish = "stop" } = {}) {
  const frames = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`];
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  if (usage) {
    frames.push(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`,
    );
  }
  frames.push("data: [DONE]\n\n");
  return frames;
}

// ---------------------------------------------------------------------------
// 1. Request bodies per model profile
// ---------------------------------------------------------------------------
{
  const reasoning = buildChatRequestBody(
    {
      model: OPENAI_CATALOG.reasoning,
      messages,
      stream: true,
      maxOutputTokens: 2000,
      effort: "high",
      temperature: 0.7,
    },
    "openai",
  );
  assert.equal(reasoning.model, "gpt-6.2-astra");
  assert.equal(reasoning.reasoning_effort, "high");
  assert.equal(reasoning.temperature, undefined, "un modèle de raisonnement ne reçoit pas temperature");
  assert.equal(reasoning.stream, true);
  assert.equal(reasoning.max_completion_tokens, 2000);
  assert.deepEqual(reasoning.stream_options, { include_usage: true });

  const classic = buildChatRequestBody(
    {
      model: describeModel("gpt-4.1-mini"),
      messages,
      stream: true,
      maxOutputTokens: 1200,
      effort: "medium",
      temperature: 0.7,
    },
    "openai",
  );
  assert.equal(classic.temperature, 0.7, "un modèle classique garde sa température");
  assert.equal(classic.reasoning_effort, undefined, "un modèle classique ne reçoit pas reasoning_effort");

  // GPT-6.2 models reject "none": the guard must map it to a supported effort.
  const guarded = buildChatRequestBody(
    {
      model: OPENAI_CATALOG.coding,
      messages,
      stream: false,
      maxOutputTokens: 500,
      effort: "minimal",
    },
    "openai",
  );
  assert.equal(guarded.reasoning_effort, "low", "`none`/`minimal` est converti pour les modèles qui le refusent");

  const clamped = buildChatRequestBody(
    {
      model: describeModel("gpt-4.1-mini"),
      messages,
      stream: true,
      maxOutputTokens: 999_999,
      effort: "medium",
    },
    "openai",
  );
  assert.ok(clamped.max_completion_tokens <= describeModel("gpt-4.1-mini").maxOutputTokens, "la limite de sortie est bornée par le modèle");

  const gemini = buildChatRequestBody(
    {
      model: describeModel("gemini-3.8-flash"),
      messages,
      stream: true,
      maxOutputTokens: 800,
      effort: "medium",
    },
    "gemini",
  );
  assert.equal(gemini.max_completion_tokens, undefined, "Gemini ne reçoit pas max_completion_tokens");
  assert.equal(gemini.stream_options, undefined);
  pass("requêtes : chaque profil de modèle reçoit exactement les paramètres qu'il accepte");
}

// ---------------------------------------------------------------------------
// 2. Error classification
// ---------------------------------------------------------------------------
{
  const cases = [
    [401, { error: { code: "invalid_api_key" } }, "invalid_api_key", false],
    [404, { error: { code: "model_not_found" } }, "model_unavailable", true],
    [403, { error: { message: "You do not have access to model gpt-6.2-astra" } }, "model_unavailable", true],
    [429, { error: { code: "insufficient_quota" } }, "insufficient_quota", false],
    [429, { error: { code: "rate_limit_exceeded" } }, "rate_limited", true],
    [500, null, "provider_error", true],
    [400, { error: { message: "Unsupported parameter" } }, "provider_error", true],
  ];
  for (const [status, payload, code, fallback] of cases) {
    const classified = classifyProviderHttpError(status, payload);
    assert.equal(classified.code, code, `${status} → ${code}`);
    assert.equal(classified.fallbackAllowed, fallback, `${code}: repli autorisé = ${fallback}`);
    assert.ok(classified.error.length > 20, "un message actionnable est fourni");
  }
  pass("erreurs : chaque panne amont a un code stable et une politique de repli explicite");
}

// ---------------------------------------------------------------------------
// 3. Stream parsing
// ---------------------------------------------------------------------------
{
  const delta = parseStreamFrame(`data: ${JSON.stringify({ choices: [{ delta: { content: "Bon" } }] })}`);
  assert.equal(delta.delta, "Bon");
  assert.equal(delta.complete, false);

  const finished = parseStreamFrame(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}`,
  );
  assert.equal(finished.finishReason, "stop");
  assert.deepEqual(finished.usage, { promptTokens: 10, completionTokens: 2 }, "l'usage est lu pour le coût réel");

  assert.equal(parseStreamFrame("data: [DONE]").complete, true);
  assert.equal(parseStreamFrame(": keep-alive").delta, "", "un commentaire SSE est ignoré, pas fatal");
  assert.throws(() => parseStreamFrame("data: {not json"), /invalid-stream-frame/);
  assert.throws(() => parseStreamFrame('data: {"error":{"message":"boom"}}'), /stream-error-frame/);
  pass("flux : texte, fin, usage, keep-alive et erreurs de trame sont traités correctement");
}

// ---------------------------------------------------------------------------
// 4. Real stream through the client
// ---------------------------------------------------------------------------
{
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    provider: "openai",
    fetchImpl: async () => streamResponse(framesFor("Bonjour depuis le flux.")),
  });

  const deltas = [];
  const outcome = await client.stream(
    { model: OPENAI_CATALOG.fast, messages, maxOutputTokens: 500, effort: "low" },
    new AbortController().signal,
    (delta) => deltas.push(delta),
  );

  assert.deepEqual(deltas, ["Bonjour depuis le flux."]);
  assert.equal(outcome.text, "Bonjour depuis le flux.");
  assert.equal(outcome.finishReason, "stop");
  assert.deepEqual(outcome.usage, { promptTokens: 120, completionTokens: 40 });
  pass("client : le flux est lu, assemblé, et l'usage réel remonte pour le calcul du coût");
}

// ---------------------------------------------------------------------------
// 5. Retry policy
// ---------------------------------------------------------------------------
{
  let attempts = 0;
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    provider: "openai",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ error: { code: "rate_limit_exceeded" } }, 429);
      return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    },
  });
  const outcome = await client.complete(
    { model: OPENAI_CATALOG.fast, messages, maxOutputTokens: 200, effort: "low" },
    new AbortController().signal,
  );
  assert.equal(attempts, 2, "un 429 est retenté une fois");
  assert.equal(outcome.text, "ok");
  pass("reprise : une limite de débit est retentée, puis réussit");
}

{
  // A key error and a quota error must not be retried: they will not heal.
  for (const [status, payload, expected] of [
    [401, { error: { code: "invalid_api_key" } }, "invalid_api_key"],
    [429, { error: { code: "insufficient_quota" } }, "insufficient_quota"],
  ]) {
    let attempts = 0;
    const client = new ProviderClient({
      baseUrl: "https://api.test/v1",
      apiKey: "sk-test",
      provider: "openai",
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse(payload, status);
      },
    });
    await assert.rejects(
      () =>
        client.complete(
          { model: OPENAI_CATALOG.fast, messages, maxOutputTokens: 200, effort: "low" },
          new AbortController().signal,
        ),
      (error) => error instanceof ProviderError && error.classified.code === expected,
    );
    assert.equal(attempts, 1, `${expected} ne doit pas être retenté`);
  }
  pass("reprise : une clé invalide ou un quota épuisé échoue immédiatement, sans frais supplémentaires");
}

// ---------------------------------------------------------------------------
// 6. Fallback chain behaviour
// ---------------------------------------------------------------------------
{
  resetModelAvailability();
  const called = [];
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    provider: "openai",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      called.push(body.model);
      if (body.model === "gpt-6.2-astra") {
        return jsonResponse({ error: { code: "model_not_found" } }, 404);
      }
      return streamResponse(framesFor(`Réponse de ${body.model}`));
    },
  });

  const { outcome } = await client.withFallback(
    [OPENAI_CATALOG.reasoning, OPENAI_CATALOG.coding, OPENAI_CATALOG.balanced],
    (model) =>
      client.stream(
        { model, messages, maxOutputTokens: 300, effort: "medium" },
        new AbortController().signal,
        () => {},
      ),
  );

  assert.deepEqual(called, ["gpt-6.2-astra", "gpt-6.2-sol"], "le modèle refusé est remplacé par le suivant");
  assert.equal(outcome.model.id, "gpt-6.2-sol");
  assert.deepEqual(outcome.failedModels, ["gpt-6.2-astra"]);
  assert.equal(isModelUnavailable("gpt-6.2-astra"), true, "le refus est mémorisé pour l'instance");

  // The next request must skip the refused model entirely.
  const before = called.length;
  const second = await client.withFallback(
    [OPENAI_CATALOG.reasoning, OPENAI_CATALOG.coding],
    (model) =>
      client.stream(
        { model, messages, maxOutputTokens: 300, effort: "medium" },
        new AbortController().signal,
        () => {},
      ),
  );
  assert.equal(called[before], "gpt-6.2-sol", "un modèle refusé est contourné directement");
  assert.equal(second.outcome.model.id, "gpt-6.2-sol");

  resetModelAvailability();
  pass("secours : le modèle refusé est remplacé, mémorisé, puis contourné sans nouvel échec payé");
}

{
  // A refusal that no model can fix must stop the chain at once.
  resetModelAvailability();
  let attempts = 0;
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    provider: "openai",
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse({ error: { code: "insufficient_quota" } }, 429);
    },
  });

  await assert.rejects(
    () =>
      client.withFallback(
        [OPENAI_CATALOG.reasoning, OPENAI_CATALOG.coding, OPENAI_CATALOG.fast],
        (model) =>
          client.stream(
            { model, messages, maxOutputTokens: 300, effort: "medium" },
            new AbortController().signal,
            () => {},
          ),
      ),
    (error) => error instanceof ProviderError && error.classified.code === "insufficient_quota",
  );
  assert.equal(attempts, 1, "un quota épuisé arrête la chaîne au premier essai");
  pass("secours : une panne non réparable par un autre modèle arrête immédiatement la chaîne");
}

{
  // Vision-only constraint: a fallback must still be able to read the image.
  resetModelAvailability();
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    provider: "openai",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.model === "gpt-6.2-sol") {
        return jsonResponse({ error: { code: "model_not_found" } }, 404);
      }
      return streamResponse(framesFor("ok"));
    },
  });

  const { outcome } = await client.withFallback(
    [OPENAI_CATALOG.coding, OPENAI_CATALOG.balanced],
    (model) =>
      client.stream(
        { model, messages, maxOutputTokens: 200, effort: "low" },
        new AbortController().signal,
        () => {},
      ),
    { visionRequired: true },
  );
  assert.equal(outcome.model.supportsVision, true, "un repli sur une image doit garder la vision");
  resetModelAvailability();
  pass("secours : une demande avec photo ne bascule que vers un modèle capable de la lire");
}

// ---------------------------------------------------------------------------
// 7. Timeout
// ---------------------------------------------------------------------------
{
  const controller = new AbortController();
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    provider: "openai",
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => controller.abort(), 20);
      }),
  });

  await assert.rejects(
    () =>
      client.stream(
        { model: OPENAI_CATALOG.fast, messages, maxOutputTokens: 200, effort: "low" },
        controller.signal,
        () => {},
      ),
    (error) => error instanceof ProviderError && error.classified.code === "timeout",
  );
  pass("délai : une réponse trop lente produit un `timeout` typé, pas une exception brute");
}

// ---------------------------------------------------------------------------
// 8. A stream error after text is published cannot be retried
// ---------------------------------------------------------------------------
{
  let attempts = 0;
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    provider: "openai",
    fetchImpl: async () => {
      attempts += 1;
      return streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Début de réponse" } }] })}\n\n`,
        'data: {"error":{"message":"boom"}}\n\n',
      ]);
    },
  });

  await assert.rejects(
    () =>
      client.stream(
        { model: OPENAI_CATALOG.fast, messages, maxOutputTokens: 200, effort: "low" },
        new AbortController().signal,
        () => {},
      ),
    (error) => error instanceof ProviderError && error.classified.fallbackAllowed === false,
  );
  assert.equal(attempts, 1, "un flux déjà commencé n'est jamais rejoué : l'utilisateur ne verrait pas deux réponses");
  pass("flux interrompu : aucune reprise après publication, l'utilisateur ne voit jamais de doublon");
}

// ---------------------------------------------------------------------------
// 9. The key never appears in an error
// ---------------------------------------------------------------------------
{
  const client = new ProviderClient({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-super-secret",
    provider: "openai",
    fetchImpl: async () => jsonResponse({ error: { message: "bad key sk-super-secret" } }, 401),
  });
  const error = await client
    .complete(
      { model: OPENAI_CATALOG.fast, messages, maxOutputTokens: 100, effort: "low" },
      new AbortController().signal,
    )
    .catch((caught) => caught);
  assert.ok(error instanceof ProviderError);
  assert.doesNotMatch(JSON.stringify(error.classified), /sk-super-secret/, "la clé ne doit jamais être recopiée dans l'erreur");
  pass("sécurité : la clé d'API n'est jamais recopiée dans un message d'erreur");
}

console.log(`\n${checks} vérifications de transport passées.`);
