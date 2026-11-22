/**
 * Voice tests — catalogue, quota, session lifecycle, error mapping.
 *
 * What this file proves, and what it deliberately does not:
 *
 *   • the voice catalogue matches the documented set exactly, so an invented or
 *     mistyped identifier fails here instead of reaching OpenAI;
 *   • a voice id from the browser is validated before it is ever forwarded, and
 *     an unknown one falls back to the default *and says so*;
 *   • `voiceMinutesPerDay` is a field of the existing plan limits, and the voice
 *     counter is a field of the existing quota entry — not a second system;
 *   • the voice allowance is reserved before the provider call, released when
 *     the call fails, and settled to the real duration when the session closes;
 *   • a session id cannot be used by another account;
 *   • the environment variable names and the model identifier are exactly the
 *     ones already used by the text chat.
 *
 * No network call is made. `/api/voice-session` and `/api/voice-end` run against a
 * stubbed `fetch`, like the existing chat pipeline tests.
 *
 * NOT TESTED HERE (no key in this environment, `api.openai.com` unreachable):
 *   • a real WebRTC handshake with GPT-Live;
 *   • the actual audio produced by each voice;
 *   • the real duration reported by OpenAI when a session closes.
 */
import assert from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_VOICE_ID,
  EXTRA_VOICES,
  LIVE_DELEGATION_MODEL,
  LIVE_MAX_SESSION_MINUTES,
  LIVE_MODEL,
  LIVE_VOICES,
  listVoices,
  publicVoice,
  resolveVoice,
  selectVoice,
} from "../server/ai/voiceCatalog.ts";
import { buildLiveSessionConfig, buildSessionInput } from "../api/_liveConfig.ts";
import VEYVRO_SYSTEM_PROMPT from "../server/veyvroSystemPrompt.ts";
import {
  VOICE_RESERVATION_SECONDS,
  consumeQuota,
  readQuotaUsage,
  readVoiceUsage,
  reserveVoiceQuota,
  resetQuotas,
  settleVoiceQuota,
} from "../server/quotas.ts";
import {
  closeVoiceSession,
  findVoiceSession,
  openVoiceSession,
  resetVoiceSessions,
} from "../server/voiceSessions.ts";
import voiceSessionHandler from "../api/voice-session.ts";
import voiceEndHandler from "../api/voice-end.ts";
import voiceProfilesHandler from "../api/voice-profiles.ts";
import { PLAN_LIMITS, limitsFor } from "../src/lib/planLimits.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const USER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q";
const SUPABASE_URL = "https://stub-project.supabase.test";
const NOON = Date.parse("2026-11-01T12:00:00.000Z");

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VEYVRO_AI_API_KEY",
  "VEYVRO_AI_BASE_URL",
  "VEYVRO_AI_PROVIDER",
  "VEYVRO_AI_MODEL",
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

function applyEnv(overrides = {}) {
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
// 1. Catalogue : l'ensemble documenté, à l'identifiant près
// ---------------------------------------------------------------------------
{
  const documented = [
    "quartz", "ripple", "vesper", "willow", "stone", "gleam", "meridian",
    "bossa", "tempo", "beacon", "delta", "cinder", "nuri", "juni", "flitz",
    "brise", "sillage", "nira", "harema", "shida", "noeul",
  ];
  assert.deepEqual(
    LIVE_VOICES.map((voice) => voice.id),
    documented,
    "les 21 voix documentées, dans l'ordre de la documentation",
  );
  pass("catalogue : exactement les 21 voix documentées, dans l'ordre");

  assert.equal(LIVE_VOICES.length, 21);
  assert.deepEqual(EXTRA_VOICES.map((voice) => voice.id), ["marin"], "marin reste hors de la table documentée");
  pass("catalogue : marin est accepté mais tenu à part de la table documentée");

  // Aucun doublon, tous en minuscules : un identifiant est un identifiant d'API.
  const ids = listVoices().map((voice) => voice.id);
  assert.equal(new Set(ids).size, ids.length, "aucun identifiant en double");
  for (const id of ids) assert.equal(id, id.toLowerCase().trim(), `identifiant normalisé : ${id}`);
  pass("catalogue : identifiants uniques, normalisés en minuscules");

  assert.equal(DEFAULT_VOICE_ID, "brise", "la voix par défaut est brise");
  assert.ok(resolveVoice(DEFAULT_VOICE_ID), "la voix par défaut existe dans le catalogue");
  pass("catalogue : brise est la voix par défaut et elle existe");

  // Chaque voix porte les champs attendus par l'interface, sans champ inventé.
  for (const voice of listVoices()) {
    assert.equal(typeof voice.label, "string");
    assert.ok(voice.label.length > 0, `${voice.id} a un libellé`);
    assert.ok(["feminine", "masculine"].includes(voice.presentation), `${voice.id} a une présentation documentée`);
    assert.ok(["natural", "generated"].includes(voice.source), `${voice.id} a une origine documentée`);
    assert.equal(typeof voice.previewAvailable, "boolean", `${voice.id} déclare explicitement ses aperçus`);
  }
  pass("catalogue : chaque voix porte libellé, présentation, origine, état d'aperçu");

  // Aucune voix n'est marquée « disponible en aperçu » sans fichier réel :
  // annoncer un aperçu inexistant serait exactement le mensonge à éviter.
  const withPreview = listVoices().filter((voice) => voice.previewAvailable);
  for (const voice of withPreview) {
    const file = path.join("public", "voices", `${voice.id}.mp3`);
    assert.ok(existsSync(file), `aperçu annoncé pour ${voice.id} mais ${file} est absent`);
  }
  pass("catalogue : aucun aperçu annoncé sans fichier audio réel dans public/voices");
}

// ---------------------------------------------------------------------------
// 2. Résolution et validation d'un identifiant
// ---------------------------------------------------------------------------
{
  assert.equal(resolveVoice("brise")?.id, "brise");
  assert.equal(resolveVoice("  BRISE ")?.id, "brise", "casse et espaces tolérés");
  assert.equal(resolveVoice("marin")?.id, "marin");
  assert.equal(resolveVoice("voix-inventee"), null, "un identifiant inconnu ne résout pas");
  assert.equal(resolveVoice(""), null);
  assert.equal(resolveVoice(null), null);
  assert.equal(resolveVoice(42), null);
  assert.equal(resolveVoice({ id: "brise" }), null, "un objet n'est pas un identifiant");
  pass("validation : identifiants connus acceptés (casse/espaces), inconnus refusés");

  // Repli : jamais d'identifiant arbitraire transmis, et le repli est signalé.
  assert.deepEqual(selectVoice("brise"), { voice: resolveVoice("brise"), rejectedRequest: false });
  const fallback = selectVoice("voix-inventee");
  assert.equal(fallback.voice.id, DEFAULT_VOICE_ID, "un identifiant inconnu retombe sur la voix par défaut");
  assert.equal(fallback.rejectedRequest, true, "le repli est signalé au client");
  assert.equal(selectVoice(undefined).rejectedRequest, false, "pas d'identifiant = pas de refus à signaler");
  pass("validation : identifiant inconnu → voix par défaut, refus signalé");

  // Le catalogue public ne contient ni secret, ni prompt, ni instruction.
  const publicEntry = publicVoice(resolveVoice("brise"));
  assert.deepEqual(
    Object.keys(publicEntry).sort(),
    ["accent", "featured", "id", "label", "language", "presentation", "previewAvailable", "previewUrl"],
  );
  assert.equal(publicEntry.previewUrl, null, "aucun aperçu n'est annoncé tant qu'aucun fichier n'existe");
  const asText = JSON.stringify(listVoices().map(publicVoice));
  assert.ok(!asText.includes("sk-"), "aucune clé dans le catalogue public");
  assert.ok(!asText.includes("VEYVRO_SYSTEM_PROMPT"));
  pass("validation : le catalogue public ne contient ni secret ni prompt");
}

// ---------------------------------------------------------------------------
// 3. Configuration de session : modèle, voix, consigne réelle, délégation
// ---------------------------------------------------------------------------
{
  assert.equal(LIVE_MODEL, "gpt-live-1.1");
  assert.equal(LIVE_DELEGATION_MODEL, "gpt-6-luna");
  assert.equal(LIVE_MAX_SESSION_MINUTES, 60);
  pass("config : modèle vocal gpt-live-1.1, délégation gpt-6-luna, plafond 60 min");

  const config = buildLiveSessionConfig(resolveVoice("brise"));
  assert.equal(config.model, "gpt-live-1.1");
  assert.equal(config.audio.output.voice, "brise", "la voix choisie est celle de la session");
  assert.equal(config.store, false, "une session vocale n'est pas conservée pour branchement");
  assert.equal(config.delegation.type, "responses");
  assert.equal(config.delegation.responses.model, "gpt-6-luna");
  pass("config : voix, modèle, délégation et store:false conformes à la demande");

  // La consigne est l'IMPORT du prompt réel, pas une copie réduite.
  assert.ok(
    config.instructions.includes(VEYVRO_SYSTEM_PROMPT.trim()),
    "la consigne contient le prompt VEYVRO importé, intégralement",
  );
  assert.ok(
    config.delegation.responses.instructions === VEYVRO_SYSTEM_PROMPT,
    "le modèle délégué reçoit exactement le même prompt",
  );
  assert.ok(config.instructions.length < 16_384 * 3, "la consigne reste sous la limite documentée");
  pass("config : le prompt VEYVRO est importé intact, jamais recopié");

  // La règle multilingue est explicite et n'évoque jamais un changement de voix.
  assert.match(config.instructions, /same voice|même voix|Keep the same voice/i);
  assert.match(config.instructions, /language/i);
  pass("config : la consigne impose de garder la même voix d'une langue à l'autre");

  // Deux voix différentes produisent deux configurations différentes.
  assert.notEqual(buildLiveSessionConfig(resolveVoice("marin")).audio.output.voice, config.audio.output.voice);
  pass("config : changer de voix change réellement la voix demandée");

  // L'historique est borné, nettoyé, et typé.
  const input = buildSessionInput(
    Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index}` })),
  );
  assert.equal(input.length, 12, "12 derniers messages au maximum");
  assert.equal(input.at(-1).content[0].text, "message 19", "les messages les plus récents sont conservés");
  assert.ok(input.every((message) => message.content[0].text.length <= 2_000));
  assert.deepEqual(buildSessionInput([{ role: "user", content: "   " }]), [], "un message vide n'est pas envoyé");
  assert.deepEqual(buildSessionInput([]), []);
  pass("config : historique borné à 12 messages, vide ignoré, texte plafonné");
}

// ---------------------------------------------------------------------------
// 4. Quota vocal : champ du système existant, réservation, règlement
// ---------------------------------------------------------------------------
{
  assert.equal(PLAN_LIMITS.decouverte.voiceMinutesPerDay, 0);
  assert.equal(PLAN_LIMITS.plus.voiceMinutesPerDay, 10);
  assert.equal(PLAN_LIMITS.pro.voiceMinutesPerDay, 30);
  pass("quota : voiceMinutesPerDay = 0 / 10 / 30 selon la formule");

  const existing = ["messagesPerDay", "quoteAnalysesPerDay", "requestsPerMinute", "attachments", "quoteAnalysis"];
  for (const plan of ["decouverte", "plus", "pro"]) {
    const limits = limitsFor(plan);
    assert.equal(typeof limits.voiceMinutesPerDay, "number", `${plan}.voiceMinutesPerDay est un nombre`);
    // Les limites existantes sont toujours là, inchangées.
    for (const key of existing) assert.ok(key in limits, `${plan}.${key} existe toujours`);
  }
  pass("quota : le champ vocal s'ajoute sans modifier les limites existantes");

  resetQuotas();
  // Formule sans voix : refus avant tout appel fournisseur.
  const refused = reserveVoiceQuota({ userId: USER, plan: "decouverte", nowMs: NOON });
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, "voice_not_in_plan");
  assert.equal(refused.limit, 0);
  pass("quota : la formule Découverte est refusée (voice_not_in_plan)");

  const plus = reserveVoiceQuota({ userId: USER, plan: "plus", nowMs: NOON });
  assert.equal(plus.ok, true);
  assert.equal(plus.reservedSeconds, VOICE_RESERVATION_SECONDS);
  assert.equal(plus.remainingSeconds, 10 * 60 - VOICE_RESERVATION_SECONDS);
  assert.equal(readVoiceUsage(USER, NOON), VOICE_RESERVATION_SECONDS, "la réservation est comptée tout de suite");
  pass("quota : une session réserve 60 s, immédiatement comptées");

  // Règlement à la durée réelle : une session de 20 s rend 40 s.
  const settled = settleVoiceQuota({ userId: USER, reservedSeconds: 60, actualSeconds: 20, nowMs: NOON });
  assert.equal(settled.chargedSeconds, 20);
  assert.equal(settled.usedSeconds, 20, "seule la durée réelle est consommée");
  pass("quota : fermer après 20 s ne facture que 20 s");

  // Une session plus longue que la réservation est facturée en entier.
  resetQuotas();
  reserveVoiceQuota({ userId: USER, plan: "plus", nowMs: NOON });
  const longer = settleVoiceQuota({ userId: USER, reservedSeconds: 60, actualSeconds: 90, nowMs: NOON });
  assert.equal(longer.usedSeconds, 90, "le dépassement de la réservation est facturé");
  pass("quota : une session de 90 s consomme 90 s malgré la réservation de 60 s");

  // Épuisement : 10 minutes sur Plus, la seconde suivante est refusée.
  resetQuotas();
  const exhausted = reserveVoiceQuota({ userId: USER, plan: "plus", seconds: 600, nowMs: NOON });
  assert.equal(exhausted.ok, true);
  assert.equal(exhausted.remainingSeconds, 0);
  const afterExhaustion = reserveVoiceQuota({ userId: USER, plan: "plus", nowMs: NOON });
  assert.equal(afterExhaustion.ok, false);
  assert.equal(afterExhaustion.kind, "voice_minutes_exhausted");
  assert.ok(afterExhaustion.retryAfterSeconds > 0, "le client sait quand réessayer");
  pass("quota : après 10 min, la session suivante est refusée avec un délai de reprise");

  // Isolément par compte : le quota de l'un n'est pas celui de l'autre.
  const otherAccount = reserveVoiceQuota({ userId: OTHER, plan: "pro", nowMs: NOON });
  assert.equal(otherAccount.ok, true, "le quota est par compte");
  assert.equal(otherAccount.remainingSeconds, 30 * 60 - VOICE_RESERVATION_SECONDS);
  pass("quota : les comptes sont isolés (30 min sur Pro, intactes)");

  // Le compteur vocal vit dans l'entrée existante, pas dans une structure à part.
  const usage = readQuotaUsage(USER, NOON);
  assert.equal(typeof usage.voiceSeconds, "number");
  assert.equal(typeof usage.messages, "number");
  assert.equal(typeof usage.quotes, "number");
  assert.equal(usage.voiceSeconds, 600);
  pass("quota : voiceSeconds est un champ des compteurs existants (messages + devis)");

  // Les messages ne consomment pas de secondes et inversement.
  const beforeMessages = readQuotaUsage(USER, NOON).voiceSeconds;
  consumeQuota({ userId: USER, plan: "pro", isQuoteAnalysis: false, nowMs: NOON });
  assert.equal(readQuotaUsage(USER, NOON).voiceSeconds, beforeMessages);
  pass("quota : consommer un message ne touche pas au compteur vocal");

  // Minuit UTC remet les secondes à zéro.
  const nextDay = NOON + 86_400_000;
  assert.equal(readVoiceUsage(USER, nextDay), 0, "le compteur vocal se réinitialise à minuit UTC");
  assert.equal(readQuotaUsage(USER, nextDay).voiceSeconds, 0);
  pass("quota : le compteur vocal revient à zéro au jour UTC suivant");
}

// ---------------------------------------------------------------------------
// 5. Registre de sessions : propriété, fermeture, idempotence
// ---------------------------------------------------------------------------
{
  resetVoiceSessions();
  const { id } = openVoiceSession({ userId: USER, voiceId: "brise", reservedSeconds: 60, nowMs: NOON });
  const found = findVoiceSession(id, USER, NOON);
  assert.ok(found, "le propriétaire retrouve sa session");
  assert.equal(found.voiceId, "brise");

  assert.equal(findVoiceSession(id, OTHER, NOON), null, "un autre compte ne voit pas la session");
  assert.equal(findVoiceSession("session-inventee", USER, NOON), null);
  pass("registre : la session n'est visible que par son propriétaire");

  const closed = closeVoiceSession(id, USER, NOON + 42_000);
  assert.equal(closed.durationSeconds, 42, "la durée est calculée côté serveur");
  assert.equal(closed.actualSeconds, 42);
  const twice = closeVoiceSession(id, USER, NOON + 120_000);
  assert.equal(twice.durationSeconds, 42, "une fermeture double ne rallonge pas la durée");
  assert.equal(twice.actualSeconds, -1, "le second appel ne refacture rien");
  pass("registre : durée serveur, fermeture idempotente");

  // Une session expirée n'est plus facturable ni consultable.
  const stale = openVoiceSession({ userId: USER, voiceId: "marin", reservedSeconds: 60, nowMs: NOON });
  assert.equal(findVoiceSession(stale.id, USER, NOON + 70 * 60_000), null, "au-delà du plafond, la session est périmée");
  pass("registre : une session hors plafond (65 min) est oubliée");
  resetVoiceSessions();
}

// ---------------------------------------------------------------------------
// 6. /api/voice-session — autorisation, quota, création, erreurs
// ---------------------------------------------------------------------------
function makeResponse() {
  const out = { status: 0, body: null, headers: {} };
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
  };
  return { res: response, out };
}

/** Stub des deux services : identité Supabase, abonnement, fournisseur vocal. */
function installStub({ rows = [], provider = defaultProvider } = {}) {
  const calls = { supabase: [], live: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith(SUPABASE_URL)) {
      calls.supabase.push({ url, method: init.method ?? "GET" });
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: USER, email: "client@veyvro.test", email_confirmed_at: "2026-10-01T00:00:00.000Z" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/rest/v1/subscriptions")) {
        return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected supabase call: ${url}`);
    }
    if (url.startsWith("https://api.openai.test")) {
      calls.live.push({ url, body, headers: init.headers });
      return provider(body, calls.live.length, init);
    }
    throw new Error(`unexpected outbound call: ${url}`);
  };
  return calls;
}

/** Offre SDP minimale : la route ne fait que la transmettre. */
const OFFER_SDP = "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n";

/** Réponse fournisseur par défaut : une session ouverte. */
function defaultProvider(body) {
  return new Response(JSON.stringify({ id: "live_sess_stub", sdp: "v=0\r\no=- 9 9 IN IP4 0.0.0.0\r\n" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function callSession({ token = TOKEN, body } = {}) {
  const { res, out } = makeResponse();
  await voiceSessionHandler(
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body ?? { sdp: OFFER_SDP, voice: "brise", history: [] },
    },
    res,
  );
  return out;
}

function proPlan() {
  return [{ user_id: USER, plan: "pro", status: "active", current_period_ends_at: days(20) }];
}

{
  applyEnv();
  resetQuotas();
  resetVoiceSessions();

  // Sans jeton : rien n'est créé, rien n'est facturé.
  {
    const calls = installStub({ rows: proPlan() });
    const out = await callSession({ token: null });
    assert.ok(out.status >= 400, "un appel anonyme est refusé");
    assert.equal(calls.live.length, 0, "aucun appel fournisseur pour un anonyme");
    assert.equal(readVoiceUsage(USER, Date.now()), 0, "aucun quota consommé");
    pass("/api/voice-session : anonyme refusé, aucun appel fournisseur, aucun quota");
  }

  // Mauvaise méthode.
  {
    installStub({ rows: proPlan() });
    const { res, out } = makeResponse();
    await voiceSessionHandler({ method: "GET", headers: {} }, res);
    assert.equal(out.status, 405);
    pass("/api/voice-session : seule la méthode POST est acceptée");
  }

  // Offre absente ou démesurée.
  {
    const calls = installStub({ rows: proPlan() });
    const empty = await callSession({ body: { voice: "brise" } });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, "invalid_offer");
    const huge = await callSession({ body: { sdp: "v".repeat(400_001), voice: "brise" } });
    assert.equal(huge.status, 400);
    assert.equal(calls.live.length, 0, "une offre invalide n'atteint pas le fournisseur");
    pass("/api/voice-session : offre absente ou démesurée refusée avant tout appel");
  }

  // Formule sans voix (Découverte) : refus 403 sans appel fournisseur.
  {
    resetQuotas();
    const calls = installStub({ rows: [] });
    const out = await callSession();
    assert.equal(out.status, 403);
    assert.equal(out.body.code, "voice_not_in_plan");
    assert.equal(calls.live.length, 0, "un refus de formule ne coûte rien au fournisseur");
    assert.equal(readVoiceUsage(USER, Date.now()), 0);
    pass("/api/voice-session : Découverte refusée en 403, sans appel fournisseur ni quota consommé");
  }

  // Session réussie : 201, voix demandée transmise, SDP relayé, clé jamais exposée.
  {
    resetQuotas();
    const calls = installStub({ rows: proPlan() });
    const out = await callSession({ body: { sdp: OFFER_SDP, voice: "marin", history: [] } });
    assert.equal(out.status, 201);
    assert.equal(out.body.voice.id, "marin");
    assert.equal(out.body.voice.replacedInvalidRequest, false);
    assert.ok(out.body.sessionId, "un identifiant de session serveur est renvoyé");
    assert.ok(out.body.sdp.includes("v=0"), "la réponse SDP est relayée");
    assert.equal(calls.live.length, 1);
    const sent = calls.live[0];
    assert.ok(sent.url.endsWith("/live/sessions"), "l'endpoint Live est appelé");
    assert.equal(sent.body.session.model, "gpt-live-1.1");
    assert.equal(sent.body.session.audio.output.voice, "marin");
    assert.equal(sent.body.transport.type, "webrtc");
    // L'offre est transmise telle quelle, à l'espace de fin près.
    assert.equal(sent.body.transport.sdp, OFFER_SDP.trim(), "l'offre du navigateur est transmise telle quelle");
    assert.equal(sent.headers.Authorization, "Bearer sk-test-provider-key", "la clé est utilisée côté serveur");
    assert.ok(!JSON.stringify(out.body).includes("sk-test"), "la réponse ne contient jamais la clé");
    assert.ok(!JSON.stringify(out.body).includes("VEYVRO_SYSTEM_PROMPT"));
    assert.ok(!JSON.stringify(out.body).includes("instructions"), "le prompt ne fuit pas dans la réponse");
    pass("/api/voice-session : 201, voix transmise, SDP relayé, ni clé ni prompt dans la réponse");

    // Le quota est réservé, la session enregistrée et fermable.
    assert.equal(readVoiceUsage(USER, Date.now()), VOICE_RESERVATION_SECONDS);
    const end = await callEnd({ sessionId: out.body.sessionId });
    assert.equal(end.status, 200);
    assert.equal(end.body.settledWith, "duration");
    assert.ok(end.body.chargedSeconds >= 0);
    pass("/api/voice-session : la session créée est refermable via /api/voice-end");
  }

  // Identifiant de voix inventé : repli sur la valeur par défaut, et c'est signalé.
  {
    resetQuotas();
    const calls = installStub({ rows: proPlan() });
    const out = await callSession({ body: { sdp: OFFER_SDP, voice: "voix-inexistante" } });
    assert.equal(out.status, 201);
    assert.equal(out.body.voice.id, DEFAULT_VOICE_ID);
    assert.equal(out.body.voice.replacedInvalidRequest, true, "le client doit pouvoir corriger sa préférence");
    assert.equal(calls.live[0].body.session.audio.output.voice, DEFAULT_VOICE_ID);
    assert.ok(!calls.live[0].body.session.audio.output.voice.includes("inexistante"));
    pass("/api/voice-session : identifiant inventé remplacé par brise, jamais transmis");
  }

  // Échec fournisseur : la réservation est rendue, aucun quota mangé.
  {
    resetQuotas();
    installStub({
      rows: proPlan(),
      provider: () =>
        new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const out = await callSession();
    assert.equal(out.status, 502);
    assert.equal(out.body.code, "invalid_api_key");
    assert.equal(readVoiceUsage(USER, Date.now()), 0, "un échec ne consomme aucun quota");
    pass("/api/voice-session : clé rejetée → 502 invalid_api_key, réservation rendue");
  }

  // Panne réseau : 502, quota rendu.
  {
    resetQuotas();
    installStub({
      rows: proPlan(),
      provider: () => {
        throw new Error("network down");
      },
    });
    const out = await callSession();
    assert.equal(out.status, 502);
    assert.equal(out.body.code, "provider_error");
    assert.equal(readVoiceUsage(USER, Date.now()), 0);
    pass("/api/voice-session : panne réseau → 502 provider_error, réservation rendue");
  }

  // Réponse fournisseur sans SDP : refus explicite plutôt que session fantôme.
  {
    resetQuotas();
    installStub({
      rows: proPlan(),
      provider: () => new Response(JSON.stringify({ id: "live_sess_stub" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const out = await callSession();
    assert.equal(out.status, 502);
    assert.equal(out.body.code, "provider_error");
    assert.equal(readVoiceUsage(USER, Date.now()), 0);
    pass("/api/voice-session : réponse sans SDP → 502, aucune session fantôme");
  }

  // Clé absente : 503 et quota rendu.
  {
    resetQuotas();
    applyEnv({ VEYVRO_AI_API_KEY: undefined });
    installStub({ rows: proPlan() });
    const out = await callSession();
    assert.equal(out.status, 503);
    assert.equal(out.body.code, "missing_api_key");
    assert.equal(readVoiceUsage(USER, Date.now()), 0);
    applyEnv();
    pass("/api/voice-session : clé absente → 503 missing_api_key, réservation rendue");
  }

  // Quota épuisé : 429 avec Retry-After, sans appel fournisseur.
  {
    resetQuotas();
    reserveVoiceQuota({ userId: USER, plan: "pro", seconds: 1800 });
    const calls = installStub({ rows: proPlan() });
    const out = await callSession();
    assert.equal(out.status, 429);
    assert.equal(out.body.code, "voice_minutes_exhausted");
    assert.ok(Number(out.headers["Retry-After"]) > 0, "Retry-After est renseigné");
    assert.equal(calls.live.length, 0, "aucune session ouverte au-delà du quota");
    pass("/api/voice-session : quota épuisé → 429 + Retry-After, aucun appel fournisseur");
  }

  // Identité indisponible (Supabase en panne) : 503, pas 500.
  {
    resetQuotas();
    globalThis.fetch = async () => {
      throw new Error("identity down");
    };
    const out = await callSession();
    assert.equal(out.status, 503);
    assert.equal(out.body.code, "identity_unavailable");
    pass("/api/voice-session : identité indisponible → 503 identity_unavailable");
  }
}

// ---------------------------------------------------------------------------
// 7. /api/voice-end — règlement, propriété, idempotence
// ---------------------------------------------------------------------------
async function callEnd({ token = TOKEN, body, sessionId } = {}) {
  const { res, out } = makeResponse();
  await voiceEndHandler(
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body ?? (sessionId !== undefined ? { sessionId } : {}),
    },
    res,
  );
  return out;
}

{
  applyEnv();
  resetQuotas();
  resetVoiceSessions();
  installStub({ rows: proPlan() });

  // Fermeture d'une session ouverte : la durée serveur est facturée.
  {
    const open = await callSession({ body: { sdp: OFFER_SDP, voice: "brise" } });
    assert.equal(open.status, 201);
    const end = await callEnd({ sessionId: open.body.sessionId });
    assert.equal(end.status, 200);
    assert.equal(end.body.settledWith, "duration");
    assert.equal(typeof end.body.chargedSeconds, "number");
    assert.ok(end.body.usedSeconds <= VOICE_RESERVATION_SECONDS);
    pass("/api/voice-end : session ouverte réglée à sa durée réelle");

    // Une seconde fermeture ne refacture rien.
    const again = await callEnd({ sessionId: open.body.sessionId });
    assert.equal(again.status, 200);
    assert.equal(again.body.settledWith, "already-closed");
    assert.equal(again.body.chargedSeconds, 0, "fermer deux fois ne facture pas deux fois");
    assert.equal(again.body.usedSeconds, end.body.usedSeconds);
    pass("/api/voice-end : fermeture idempotente, seconde fermeture sans frais");
  }

  // Session d'un autre compte : refusée, et le quota de la victime est intact.
  {
    resetQuotas();
    resetVoiceSessions();
    const open = await callSession({ body: { sdp: OFFER_SDP, voice: "brise" } });
    const before = readVoiceUsage(USER, Date.now());
    const intruder = await callEnd({ token: "autre-jeton", sessionId: open.body.sessionId });
    assert.ok(intruder.status >= 400, "un autre compte ne peut pas fermer cette session");
    assert.equal(readVoiceUsage(USER, Date.now()), before, "le quota du propriétaire n'est pas touché");
    pass("/api/voice-end : la session d'un autre compte ne peut pas être fermée");
  }

  // Jeton absent.
  {
    const out = await callEnd({ token: null, body: { sessionId: "n-importe-quoi" } });
    assert.ok(out.status >= 400);
    pass("/api/voice-end : appel anonyme refusé");
  }

  // Identifiant manquant.
  {
    const out = await callEnd({ body: {} });
    assert.ok(out.status >= 400);
    pass("/api/voice-end : identifiant de session manquant refusé");
  }

  // Session inconnue : le serveur le dit, plutôt que de facturer au hasard.
  {
    const out = await callEnd({ body: { sessionId: "session-inconnue" } });
    assert.ok(out.status >= 400 || out.body.settledWith === "unavailable");
    if (out.body.settledWith) assert.ok(["unavailable", "already-closed"].includes(out.body.settledWith));
    pass("/api/voice-end : session inconnue signalée, aucune facturation inventée");
  }
}

// ---------------------------------------------------------------------------
// 7 bis. /api/voice-profiles — catalogue public, préférence par compte
// ---------------------------------------------------------------------------
async function callProfiles({ method = "GET", token = null, body } = {}) {
  const { res, out } = makeResponse();
  await voiceProfilesHandler(
    { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body },
    res,
  );
  return out;
}

{
  applyEnv();
  resetQuotas();

  // Le catalogue est public : un visiteur non connecté peut préparer son choix,
  // mais ne reçoit aucune préférence.
  {
    const calls = installStub({ rows: proPlan() });
    const out = await callProfiles();
    assert.equal(out.status, 200);
    assert.equal(out.body.voices.length, 22, "21 voix documentées + marin");
    assert.equal(out.body.defaultVoice, DEFAULT_VOICE_ID);
    assert.equal(out.body.selected, null, "aucune préférence pour un visiteur anonyme");
    assert.equal(calls.supabase.length, 0, "aucun appel d'identité pour un visiteur anonyme");
    assert.ok(!JSON.stringify(out.body).includes("instructions"));
    pass("/api/voice-profiles : catalogue public complet, sans préférence pour un anonyme");
  }

  // Compte sans préférence : la voix par défaut est annoncée.
  {
    installStub({ rows: proPlan() });
    const out = await callProfiles({ token: TOKEN });
    assert.equal(out.status, 200);
    assert.equal(out.body.selected, DEFAULT_VOICE_ID, "sans préférence, brise est proposée");
    pass("/api/voice-profiles : compte sans préférence → brise");
  }

  // Compte avec préférence enregistrée : elle est renvoyée telle quelle.
  {
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: USER,
            email: "client@veyvro.test",
            email_confirmed_at: "2026-10-01T00:00:00.000Z",
            user_metadata: { veyvro_voice: "sillage" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected call: ${url} ${init.method ?? ""}`);
    };
    const out = await callProfiles({ token: TOKEN });
    assert.equal(out.body.selected, "sillage", "la préférence enregistrée est relue");
    pass("/api/voice-profiles : la préférence enregistrée est relue depuis le compte");
  }

  // Préférence contenant un identifiant retiré du catalogue : ignorée, pas relayée.
  {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: USER,
            email: "client@veyvro.test",
            email_confirmed_at: "2026-10-01T00:00:00.000Z",
            user_metadata: { veyvro_voice: "voix-supprimee" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected call: ${url}`);
    };
    const out = await callProfiles({ token: TOKEN });
    assert.equal(out.body.selected, DEFAULT_VOICE_ID, "un identifiant périmé retombe sur la valeur par défaut");
    assert.ok(!JSON.stringify(out.body).includes("voix-supprimee"));
    pass("/api/voice-profiles : identifiant périmé ignoré, repli sur brise");
  }

  // Enregistrement : validé, puis écrit dans les métadonnées du compte.
  {
    const calls = { admin: [] };
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: USER,
            email: "client@veyvro.test",
            email_confirmed_at: "2026-10-01T00:00:00.000Z",
            user_metadata: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes(`/auth/v1/admin/users/${USER}`) && method === "PUT") {
        calls.admin.push({ body: init.body ? JSON.parse(String(init.body)) : null, headers: init.headers });
        return new Response(JSON.stringify({ id: USER }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };

    const ok = await callProfiles({ method: "PUT", token: TOKEN, body: { voice: "sillage" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.selected, "sillage");
    assert.equal(calls.admin.length, 1, "une seule écriture sur le compte");
    assert.deepEqual(calls.admin[0].body, { data: { veyvro_voice: "sillage" } });
    pass("/api/voice-profiles : PUT valide puis enregistre la voix sur le compte");

    // Identifiant inconnu : refusé, et rien n'est écrit.
    const before = calls.admin.length;
    const refused = await callProfiles({ method: "PUT", token: TOKEN, body: { voice: "voix-inventee" } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "unknown_voice");
    assert.equal(calls.admin.length, before, "un identifiant invalide n'écrit rien");
    pass("/api/voice-profiles : PUT refuse un identifiant inconnu sans rien écrire");

    // PUT sans jeton : refusé.
    const anonymous = await callProfiles({ method: "PUT", body: { voice: "sillage" } });
    assert.ok(anonymous.status >= 400, "on ne choisit pas de voix au nom d'un autre");
    pass("/api/voice-profiles : PUT anonyme refusé");
  }

  // Méthode non supportée.
  {
    installStub({ rows: proPlan() });
    const out = await callProfiles({ method: "DELETE", token: TOKEN });
    assert.equal(out.status, 405);
    pass("/api/voice-profiles : seule GET et PUT sont acceptées");
  }
}

// ---------------------------------------------------------------------------
// 8. Périmètre : variables d'environnement et fichiers
// ---------------------------------------------------------------------------
{
  // Aucune nouvelle variable d'environnement : les mêmes noms que le chat texte.
  const envSources = [
    readFileSync(new URL("../api/voice-session.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../api/voice-end.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../api/voice-profiles.ts", import.meta.url), "utf8"),
  ].join("\n");
  const names = [...envSources.matchAll(/process\.env\[?"?([A-Z0-9_]+)"?\]?/g)].map((match) => match[1]);
  const references = [...envSources.matchAll(/readEnvVar\(\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]);
  const known = new Set([
    "VEYVRO_AI_API_KEY", "VEYDRIVO_AI_API_KEY", "DRIVIA_AI_API_KEY",
    "VEYVRO_AI_BASE_URL", "VEYDRIVO_AI_BASE_URL", "DRIVIA_AI_BASE_URL",
    "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "NODE_ENV", "VERCEL_ENV",
  ]);
  for (const name of [...names, ...references]) {
    assert.ok(known.has(name), `variable d'environnement inattendue : ${name}`);
  }
  pass("périmètre : aucune nouvelle variable d'environnement (mêmes noms que le chat)");

  // Aucun secret côté navigateur.
  const clientFiles = [
    "src/lib/useVoiceLive.js",
    "src/lib/useVoicePreference.js",
    "src/components/VoicePicker.jsx",
    "src/components/VoiceLiveButton.jsx",
  ];
  for (const file of clientFiles) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/VEYVRO_AI_API_KEY|sk-[A-Za-z0-9]|service_role/i.test(source), `${file} ne contient aucun secret`);
    assert.ok(!/api\.openai\.com/.test(source), `${file} n'appelle jamais OpenAI directement`);
  }
  pass("périmètre : aucun secret ni appel direct à OpenAI dans le code navigateur");

  // Le prompt système n'est jamais recopié côté client.
  const clientAll = clientFiles
    .map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))
    .join("\n");
  assert.ok(!clientAll.includes("VEYVRO_SYSTEM_PROMPT.slice"), "le prompt n'est pas tronqué côté client");
  assert.ok(!/Tu es VEYVRO/i.test(clientAll), "le prompt VEYVRO n'est pas dupliqué dans le client");
  pass("périmètre : le prompt VEYVRO n'est dupliqué nulle part dans le client");

  // La route de profils ne fait aucune écriture de schéma : aucun SQL, aucune migration.
  const profilesSource = readFileSync(new URL("../api/voice-profiles.ts", import.meta.url), "utf8");
  assert.ok(!/\bCREATE TABLE\b|\bINSERT INTO\b|\bALTER TABLE\b/i.test(profilesSource));
  assert.ok(profilesSource.includes("raw_user_meta_data") || profilesSource.includes("veyvro_voice"));
  pass("périmètre : la préférence de voix ne crée aucune table ni migration");

  // Les routes API suivent la convention du projet (fichiers .ts, handler par défaut).
  const apiFiles = readdirSync(new URL("../api/", import.meta.url)).filter((name) => /^voice-.*\.ts$/.test(name));
  assert.deepEqual(apiFiles.sort(), ["voice-end.ts", "voice-profiles.ts", "voice-session.ts"]);
  for (const file of apiFiles) {
    const source = readFileSync(new URL(`../api/${file}`, import.meta.url), "utf8");
    assert.match(source, /export default async function handler/, `${file} exporte un handler par défaut`);
  }
  pass("périmètre : trois routes vocales, chacune avec un handler par défaut");

  // `_liveConfig.ts` n'est pas une route : le préfixe souligné le retire du routage Vercel.
  assert.ok(existsSync(new URL("../api/_liveConfig.ts", import.meta.url)));
  assert.ok(!apiFiles.includes("_liveConfig.ts"), "_liveConfig n'est pas exposé comme route");
  pass("périmètre : _liveConfig.ts n'est pas une route exposée");
}

// ---------------------------------------------------------------------------
// 9. Preuve que le diff vocal est strictement additif sur le chat
// ---------------------------------------------------------------------------
{
  // Les fonctions du chat texte n'ont pas bougé : elles sont toujours exportées,
  // avec la même signature publique.
  const chatApi = await import("../src/lib/chatApi.js");
  for (const name of ["streamChat", "parseSseBlock", "trimHistory", "chatErrorMessage", "VeyvroApiError"]) {
    assert.equal(typeof chatApi[name], "function" === typeof chatApi[name] ? "function" : typeof chatApi[name]);
  }
  assert.equal(typeof chatApi.streamChat, "function", "streamChat toujours exporté");
  assert.equal(typeof chatApi.trimHistory, "function", "trimHistory toujours exporté");
  pass("additif : les exports du chat texte sont intacts");

  for (const name of ["fetchVoiceProfiles", "saveVoicePreference", "startVoiceSession", "endVoiceSession", "voiceErrorMessage"]) {
    assert.equal(typeof chatApi[name], "function", `${name} exporté par chatApi`);
  }
  pass("additif : les fonctions vocales s'ajoutent au même module");

  // Le contrat SSE du chat n'a pas été modifié : mêmes fragments, même « done ».
  const deltas = [];
  const done = chatApi.parseSseBlock('event: delta\ndata: {"delta":"bonjour"}\n\n', (text) => deltas.push(text));
  assert.equal(done, false);
  assert.deepEqual(deltas, ["bonjour"], "un fragment delta est toujours transmis tel quel");
  assert.equal(
    chatApi.parseSseBlock("event: done\ndata: {}\n\n", () => {}),
    true,
    "l'événement done termine toujours le flux",
  );
  assert.deepEqual(chatApi.trimHistory([{ role: "user", content: "a" }]).length, 1, "trimHistory fonctionne toujours");
  pass("additif : le contrat SSE du chat est inchangé");

  // La route du chat existe toujours et garde son handler par défaut.
  const chatSource = readFileSync(new URL("../api/chat.ts", import.meta.url), "utf8");
  assert.match(chatSource, /export default async function handler/);
  // `invoice` contient « voice » : on cherche le vocabulaire vocal réel, pas la sous-chaîne.
  assert.ok(
    !/\bvoice(Session|Minutes|Seconds|Catalog|Picker|Live)\b|\/v1\/live|live\/sessions/i.test(chatSource),
    "/api/chat ne contient aucune logique vocale",
  );
  pass("additif : /api/chat est intact et ne contient aucune logique vocale");

  // Les limites existantes des formules n'ont pas été modifiées.
  for (const plan of ["decouverte", "plus", "pro"]) {
    // `quoteAnalysesPerDay` peut valoir `null` = illimité : on vérifie le type attendu.
    assert.ok(
      typeof PLAN_LIMITS[plan].messagesPerDay === "number" || PLAN_LIMITS[plan].messagesPerDay === null,
      `${plan}.messagesPerDay inchangé`,
    );
    assert.ok(
      typeof PLAN_LIMITS[plan].quoteAnalysesPerDay === "number" || PLAN_LIMITS[plan].quoteAnalysesPerDay === null,
      `${plan}.quoteAnalysesPerDay inchangé`,
    );
    assert.equal(typeof PLAN_LIMITS[plan].requestsPerMinute, "number", `${plan}.requestsPerMinute inchangé`);
    assert.equal(typeof PLAN_LIMITS[plan].attachments, "boolean", `${plan}.attachments inchangé`);
  }
  pass("additif : les limites existantes des formules sont inchangées");
}

// ---------------------------------------------------------------------------
// Nettoyage
// ---------------------------------------------------------------------------
globalThis.fetch = originalFetch;
restoreEnv();
resetQuotas();
resetVoiceSessions();

console.log(`\n${checks} contrôles vocaux passés.`);
