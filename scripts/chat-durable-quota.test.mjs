/**
 * /api/chat — durable quotas, end to end through the real handler.
 *
 * P7/S3 replaced the process-local counters of `server/quotas.ts` with the RPC
 * of migration 0003. That swap is only worth anything if the route actually
 * behaves differently in the cases that matter, so each of them is exercised
 * here against the real `api/chat.ts`, with Supabase and the AI provider
 * stubbed:
 *
 *   1. a normal message is charged exactly once and streamed back;
 *   2. an exhausted allowance answers 429 and never reaches the provider;
 *   3. a malformed message identifier answers 400 and charges nothing;
 *   4. replaying the same identifier is a 409, not a second charge;
 *   5. a provider failure gives the message back;
 *   6. a refund that itself fails never breaks the answer;
 *   7. a Supabase outage means no AI request at all;
 *   8. the three plans send their own limits, and a quote analysis sends `true`.
 *
 * The RPC double of `scripts/lib/chatHarness.mjs` models migration 0003; it
 * proves the mapping and the ordering, not the transaction. Atomicity is a
 * property of PostgreSQL and is out of reach of a JavaScript test.
 */
import assert from "node:assert";
import handler from "../api/chat.ts";
import {
  callChat,
  chatBody,
  createUsageDb,
  days,
  eventCodes,
  eventData,
  installSupabase,
  OTHER_ID,
  restoreEnv,
  restoreFetch,
  setEnv,
  TOKEN,
  USER_ID,
} from "./lib/chatHarness.mjs";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const AUTH = { authorization: `Bearer ${TOKEN}` };
const clientIp = (n) => ({ ...AUTH, "x-forwarded-for": `198.18.7.${n}` });

/** A per-message identifier, as the browser sends one. */
let idCounter = 0;
function clientMessageId() {
  idCounter += 1;
  const suffix = String(idCounter).padStart(12, "0");
  return `aaaaaaaa-bbbb-4ccc-8ddd-${suffix}`;
}

const QUOTE_BODY = () =>
  chatBody({
    attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
    task: "garage-quote",
  });

// ---------------------------------------------------------------------------
// 1. Succès normal : une consommation, une réponse
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  const { providerCalls } = installSupabase({ rows: [], db, provider: "ok" });

  const id = clientMessageId();
  const out = await callChat(handler, { headers: clientIp(1), body: chatBody({ clientMessageId: id }) });

  assert.equal(out.status, 200, "un message autorisé doit être streamé");
  assert.deepEqual(eventCodes(out), ["delta", "delta", "done"], "la réponse doit être relayée jusqu'au `done`");
  assert.ok(out.text.includes("Bonjour"), "le texte du fournisseur doit atteindre le client");

  const consumes = db.consumes();
  assert.equal(consumes.length, 1, "un message = une consommation");
  const charged = consumes[0].body.p_consumption_id;
  assert.match(charged, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "l'identifiant consommé est un UUID");
  assert.notEqual(charged, id, "l'identifiant consommé est dérivé du compte et du message, pas le brut du client");
  assert.equal(consumes[0].body.p_user_id, USER_ID, "la consommation porte l'identité vérifiée, pas celle du corps");
  assert.deepEqual(db.count(USER_ID), { messages: 1, quotes: 0 }, "le compteur du jour doit être à 1");
  assert.equal(db.refunds().length, 0, "une réponse livrée n'est jamais remboursée");
  assert.equal(db.event(charged).state, "consumed", "le registre garde la trace de la consommation");
  assert.equal(providerCalls.length, 1, "le fournisseur n'est appelé qu'une fois");

  restoreEnv();
  pass("succès normal : 200 streamé, une seule consommation, compteur à 1, aucun remboursement");
}

// ---------------------------------------------------------------------------
// 2. Quota épuisé : 429, et surtout aucun appel au fournisseur
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  db.seed(USER_ID, { messages: 15, quotes: 0 });
  const { providerCalls } = installSupabase({ rows: [], db, provider: "ok" });

  const out = await callChat(handler, { headers: clientIp(2), body: chatBody({ clientMessageId: clientMessageId() }) });

  assert.equal(out.status, 429, "le 16e message du jour doit être refusé");
  assert.equal(out.body.code, "daily_messages");
  assert.equal(out.body.plan, "decouverte");
  assert.equal(out.body.limit, 15, "la limite de la formule est exposée");
  assert.equal(out.body.used, 15, "l'usage réel du jour est exposé");
  assert.ok(Number(out.headers["Retry-After"]) > 0, "`Retry-After` doit accompagner le 429");
  assert.equal(providerCalls.length, 0, "aucune requête IA ne doit partir quand la consommation échoue");
  assert.deepEqual(db.count(USER_ID), { messages: 15, quotes: 0 }, "un refus ne doit rien débiter");

  restoreEnv();
  pass("quota épuisé : 429 `daily_messages` (limite et usage exposés), aucune requête IA, aucun débit");
}

// ---------------------------------------------------------------------------
// 3. Identifiant invalide : 400, rien n'est consommé
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  const { providerCalls } = installSupabase({ rows: [], db, provider: "ok" });

  for (const malformed of ["pas-un-uuid", "", 42, {}]) {
    const out = await callChat(handler, {
      headers: clientIp(3),
      body: chatBody({ clientMessageId: malformed }),
    });
    assert.equal(out.status, 400, `un identifiant ${JSON.stringify(malformed)} doit être refusé`);
    assert.equal(out.body.code, "invalid_identifier");
  }

  assert.equal(db.rpc.length, 0, "rien ne doit être consommé pour un identifiant malformé");
  assert.equal(providerCalls.length, 0, "aucune requête IA");

  restoreEnv();
  pass("identifiant invalide : 400 `invalid_identifier` avant tout débit, aucune requête IA");
}

// ---------------------------------------------------------------------------
// 4. Rejeu du même identifiant : 409, une seule consommation
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  const { providerCalls } = installSupabase({ rows: [], db, provider: "ok" });

  const id = clientMessageId();
  const body = chatBody({ clientMessageId: id });

  const first = await callChat(handler, { headers: clientIp(4), body });
  assert.equal(first.status, 200, "le premier envoi passe");

  const replay = await callChat(handler, { headers: clientIp(5), body });
  assert.equal(replay.status, 409, "le rejeu du même identifiant doit être refusé");
  assert.equal(replay.body.code, "duplicate");
  assert.equal(db.count(USER_ID).messages, 1, "un rejeu ne consomme pas deux fois");
  assert.equal(db.consumes().length, 2, "les deux envois atteignent bien la fonction");
  assert.equal(providerCalls.length, 1, "le rejeu ne doit pas rappeler le fournisseur");

  restoreEnv();
  pass("rejeu du même identifiant : 409 `duplicate`, une seule consommation, un seul appel fournisseur");
}

// ---------------------------------------------------------------------------
// 5. Échec fournisseur : la consommation est rendue
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "http500" });

  const id = clientMessageId();
  const out = await callChat(handler, { headers: clientIp(6), body: chatBody({ clientMessageId: id }) });

  assert.equal(out.status, 502, "une panne fournisseur reste un 502");
  assert.equal(out.body.code, "provider_error");
  assert.equal(db.consumes().length, 1, "la consommation a bien eu lieu avant l'appel");
  assert.equal(db.refunds().length, 1, "elle doit être rendue");
  const charged = db.consumes()[0].body.p_consumption_id;
  assert.equal(db.refunds()[0].body.p_consumption_id, charged, "c'est bien CETTE consommation qui est rendue");
  assert.equal(db.event(charged).state, "refunded", "le registre passe la consommation en remboursée");
  assert.deepEqual(db.count(USER_ID), { messages: 0, quotes: 0 }, "le compteur revient à zéro");

  restoreEnv();
  pass("échec fournisseur : 502, remboursement enregistré, compteur rendu à zéro");
}

{
  // Le même remboursement, sur les deux autres chemins « rien n'a été livré » :
  // une réponse vide, et un flux interrompu avant sa fin.
  setEnv();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "empty" });
  const empty = await callChat(handler, { headers: clientIp(7), body: chatBody({ clientMessageId: clientMessageId() }) });
  assert.equal(empty.status, 200, "le flux a commencé : le statut est déjà parti");
  assert.equal(eventData(empty, "error").code, "empty_response");
  assert.equal(db.count(USER_ID).messages, 0, "une réponse vide est rendue");

  setEnv();
  const db2 = createUsageDb();
  installSupabase({ rows: [], db: db2, provider: "truncated" });
  const truncated = await callChat(handler, { headers: clientIp(8), body: chatBody({ clientMessageId: clientMessageId() }) });
  assert.equal(truncated.status, 200);
  assert.equal(eventData(truncated, "error").code, "incomplete_stream");
  assert.equal(db2.count(USER_ID).messages, 0, "un flux interrompu sans fin est rendu");

  // À l'inverse, une réponse tronquée par la limite de longueur EST livrée :
  // elle est facturée, et annoncée comme tronquée.
  restoreEnv();
  setEnv();
  const db3 = createUsageDb();
  installSupabase({ rows: [], db: db3, provider: "length" });
  const length = await callChat(handler, { headers: clientIp(9), body: chatBody({ clientMessageId: clientMessageId() }) });
  assert.equal(length.status, 200);
  assert.equal(eventData(length, "done").truncated, true, "la troncature doit être annoncée");
  assert.equal(db3.count(USER_ID).messages, 1, "une réponse livrée reste due, même tronquée");
  assert.equal(db3.refunds().length, 0, "aucun remboursement sur une réponse livrée");

  restoreEnv();
  pass("réponse vide et flux interrompu : remboursés ; troncature `length` : facturée, car livrée");
}

// ---------------------------------------------------------------------------
// 6. Le remboursement lui-même échoue : l'utilisateur ne doit pas le payer
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  const { providerCalls } = installSupabase({ rows: [], db, provider: "http500", refundStatus: 500 });

  const id = clientMessageId();
  const out = await callChat(handler, { headers: clientIp(10), body: chatBody({ clientMessageId: id }) });

  assert.equal(out.status, 502, "l'échec du remboursement ne doit pas changer la réponse");
  assert.equal(out.body.code, "provider_error");
  assert.equal(db.refunds().length, 0, "la fonction n'a pas répondu : aucun débit rendu");
  const charged = db.consumes()[0].body.p_consumption_id;
  assert.equal(db.event(charged).state, "consumed", "la consommation reste ouverte, elle n'est pas effacée");
  assert.deepEqual(db.count(USER_ID), { messages: 1, quotes: 0 }, "l'état réel (débité) est conservé, sans invention");
  assert.equal(providerCalls.length, 1, "aucun second appel fournisseur");

  restoreEnv();
  pass("échec du remboursement : réponse inchangée (502), aucun masquage de l'état, aucune exception");
}

// ---------------------------------------------------------------------------
// 7. Panne Supabase : aucune requête IA
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  const { providerCalls } = installSupabase({ rows: [], db, usageStatus: 500, provider: "ok" });

  const out = await callChat(handler, { headers: clientIp(11), body: chatBody({ clientMessageId: clientMessageId() }) });

  assert.equal(out.status, 503, "un quota invérifiable est une indisponibilité, pas une autorisation");
  assert.equal(out.body.code, "unavailable");
  assert.equal(providerCalls.length, 0, "aucune requête IA quand le compteur est injoignable");
  assert.deepEqual(db.count(USER_ID), { messages: 0, quotes: 0 }, "aucun compteur mémoire ne prend le relais");

  restoreEnv();
  pass("panne Supabase : 503 `unavailable`, aucune requête IA, aucun repli mémoire");
}

{
  // Configuration de la base absente : même conclusion, sans même un appel.
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined });
  const out = await callChat(handler, { headers: clientIp(12), body: chatBody({ clientMessageId: clientMessageId() }) });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "not_configured");
  restoreEnv();
  pass("store non configuré : 503 `not_configured`, pas de message offert");
}

// ---------------------------------------------------------------------------
// 8. Trois formules, et l'analyse de devis marquée comme telle
// ---------------------------------------------------------------------------
{
  const plans = [
    { plan: "decouverte", rows: [], limitMessages: 15, limitQuotes: 1 },
    {
      plan: "plus",
      rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
      limitMessages: 200,
      limitQuotes: null,
    },
    {
      plan: "pro",
      rows: [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }],
      limitMessages: 600,
      limitQuotes: null,
    },
  ];

  for (const { plan, rows, limitMessages, limitQuotes } of plans) {
    setEnv();
    const db = createUsageDb();
    installSupabase({ rows, db, provider: "ok" });

    const out = await callChat(handler, { headers: clientIp(13), body: chatBody({ clientMessageId: clientMessageId() }) });
    assert.equal(out.status, 200, `${plan} : un message normal doit passer`);

    const body = db.consumes()[0].body;
    assert.equal(body.p_limit_messages, limitMessages, `${plan} : la limite de messages envoyée est celle de la formule`);
    assert.equal(body.p_limit_quotes, limitQuotes, `${plan} : la limite d'analyses envoyée est celle de la formule`);
    assert.equal(body.p_is_quote, false, `${plan} : un message normal n'est pas une analyse de devis`);

    restoreEnv();
  }

  pass("trois formules : les limites transmises sont celles de Découverte, Plus et Pro");
}

{
  // Analyse de devis : `p_is_quote` vrai, le compteur d'analyses bouge, et le
  // plafond d'une analyse par jour de la Découverte s'applique.
  setEnv();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  const first = await callChat(handler, { headers: clientIp(14), body: QUOTE_BODY() });
  assert.equal(first.status, 200, "la Découverte a droit à son analyse de devis");

  const consume = db.consumes()[0].body;
  assert.equal(consume.p_is_quote, true, "l'analyse doit être annoncée comme telle");
  assert.equal(consume.p_limit_quotes, 1, "le plafond d'analyses de la Découverte est transmis");
  assert.deepEqual(db.count(USER_ID), { messages: 1, quotes: 1 }, "une analyse coûte un message et une analyse");

  const second = await callChat(handler, { headers: clientIp(15), body: QUOTE_BODY() });
  assert.equal(second.status, 429, "la deuxième analyse du jour est refusée");
  assert.equal(second.body.code, "daily_quotes");

  restoreEnv();
  pass("analyse de devis : `p_is_quote` vrai, une analyse par jour pour Découverte, 429 `daily_quotes` ensuite");
}

{
  // Plus n'a pas de plafond d'analyses : la limite part à `null` et le compteur
  // ne refuse jamais. La consommation reste décomptée, elle.
  setEnv();
  const db = createUsageDb();
  db.seed(USER_ID, { messages: 120, quotes: 40 });
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
    db,
    provider: "ok",
  });

  const out = await callChat(handler, { headers: clientIp(16), body: QUOTE_BODY() });
  assert.equal(out.status, 200, "Plus : les analyses restent disponibles");
  assert.equal(db.consumes()[0].body.p_limit_quotes, null, "aucun plafond ne doit être inventé pour Plus");
  assert.deepEqual(db.count(USER_ID), { messages: 121, quotes: 41 }, "l'analyse est tout de même décomptée");

  restoreEnv();
  pass("analyse de devis Plus : plafond `null` transmis, consommation décomptée sans refus");
}

// ---------------------------------------------------------------------------
// 9. L'identifiant consommé est dérivé du compte, jamais le brut du client
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  // Deux envois distincts, deux identifiants distincts : la dérivation ne
  // fusionne pas deux messages différents.
  const first = clientMessageId();
  const second = clientMessageId();
  await callChat(handler, { headers: clientIp(17), body: chatBody({ clientMessageId: first }) });
  await callChat(handler, { headers: clientIp(18), body: chatBody({ clientMessageId: second }) });

  const ids = db.consumes().map((call) => call.body.p_consumption_id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "deux messages distincts doivent être deux consommations distinctes");
  assert.ok(!ids.includes(first) && !ids.includes(second), "l'identifiant brut du navigateur n'est jamais persisté tel quel");
  assert.deepEqual(db.count(USER_ID), { messages: 2, quotes: 0 });

  // Sans identifiant client, le serveur en génère un : le message est facturé
  // normalement, et deux envois non tagués ne se confondent pas.
  await callChat(handler, { headers: clientIp(19), body: chatBody() });
  await callChat(handler, { headers: clientIp(20), body: chatBody() });
  const generated = db.consumes().slice(2).map((call) => call.body.p_consumption_id);
  assert.equal(generated.length, 2);
  assert.notEqual(generated[0], generated[1], "deux messages non tagués sont deux consommations");

  restoreEnv();
  pass("identifiant dérivé : stable pour un même message, distinct entre messages, jamais le brut du navigateur");
}

// ---------------------------------------------------------------------------
// 10. La branche `conflict` du contrat reste fermée
// ---------------------------------------------------------------------------
{
  // La dérivation rend cette réponse inatteignable par la route (l'identifiant
  // dépend du compte), donc on l'injecte : ce qui est vérifié ici est le
  // comportement de la route face à une réponse que le contrat autorise.
  setEnv();
  const db = createUsageDb();
  const { providerCalls } = installSupabase({
    rows: [],
    db,
    provider: "ok",
    consumeAnswer: () => [
      { allowed: false, reason: "consumption_conflict", used_messages: 3, used_quotes: 0, usage_day: "2026-11-07", replayed: false },
    ],
  });

  const out = await callChat(handler, { headers: clientIp(21), body: chatBody({ clientMessageId: clientMessageId() }) });
  assert.equal(out.status, 409, "un conflit d'identifiant n'est ni un quota épuisé ni une panne");
  assert.equal(out.body.code, "conflict");
  assert.equal(providerCalls.length, 0, "aucune requête IA sur un conflit");

  restoreEnv();
  pass("conflit d'identifiant : 409 `conflict`, aucune requête IA");
}

restoreFetch();
console.log(`\n${checks} vérifications de quotas durables passées.`);
