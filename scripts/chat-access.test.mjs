/**
 * /api/chat access tests — the real handler, with Supabase stubbed.
 *
 * The point of this file is that authentication cannot be satisfied by anything
 * the browser sends in the body: only a token Supabase vouches for decides who
 * is calling, and only the database decides which plan applies.
 *
 * Since P7/S3 the allowance comes from the durable store of migration 0003, so
 * the stub answers the `ai_usage_consume` / `ai_usage_refund` RPC as well — see
 * `scripts/lib/chatHarness.mjs`. Preparing "fifteen messages already sent"
 * therefore means seeding the counters of the day, exactly as PostgreSQL would
 * hold them, instead of filling a process-local Map.
 */
import assert from "node:assert";
import handler from "../api/chat.ts";
import {
  callChat,
  chatBody,
  createUsageDb,
  days,
  installSupabase,
  OTHER_ID,
  restoreEnv,
  resetRateLimits,
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

/** A distinct request identifier per send, as the browser sends one. */
let idCounter = 0;
function clientMessageId() {
  idCounter += 1;
  return `bbbbbbbb-cccc-4ddd-8eee-${String(idCounter).padStart(12, "0")}`;
}

const send = (ip, extra = {}) =>
  callChat(handler, {
    headers: { ...AUTH, "x-forwarded-for": ip },
    body: chatBody({ clientMessageId: clientMessageId(), ...extra }),
  });

// ---------------------------------------------------------------------------
// 1. Aucune confiance au navigateur : sans jeton, rien ne passe
// ---------------------------------------------------------------------------
{
  setEnv();
  const { calls } = installSupabase();
  const out = await callChat(handler);

  assert.equal(out.status, 401, "une requête anonyme doit être refusée");
  assert.equal(out.body.code, "auth_required");
  assert.equal(calls.length, 0, "aucun appel sortant pour un visiteur non connecté");
  restoreEnv();
  pass("requête anonyme : 401 `auth_required`, aucun appel à Supabase ni au fournisseur IA");
}

{
  // Le corps ne doit jamais servir de preuve : même avec un plan et un id
  // parfaitement formés, sans jeton la réponse reste 401.
  setEnv();
  const { calls } = installSupabase();
  const out = await callChat(handler, {
    body: chatBody({ plan: "pro", user_id: USER_ID, userId: USER_ID, subscription: "pro" }),
  });
  assert.equal(out.status, 401, "un plan envoyé par le navigateur n'ouvre aucun droit");
  assert.equal(out.body.code, "auth_required");
  assert.equal(calls.length, 0, "aucune consommation n'est tentée sans identité");
  restoreEnv();
  pass("plan ou identifiant fournis dans le corps : ignorés, la réponse reste 401");
}

// ---------------------------------------------------------------------------
// 2. Jeton et identité
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase();
  const out = await callChat(handler, { headers: { authorization: "Bearer pas-un-jwt" } });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "auth_required");
  restoreEnv();
  pass("en-tête mal formé : 401 avant tout appel réseau");
}

{
  setEnv();
  installSupabase({ identity: "invalid" });
  const out = await callChat(handler, { headers: AUTH });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "invalid_token");
  restoreEnv();
  pass("jeton refusé par Supabase : 401 `invalid_token`");
}

{
  setEnv();
  installSupabase({ identity: "down" });
  const out = await callChat(handler, { headers: AUTH });
  assert.equal(out.status, 503, "une panne d'identité n'est pas un refus d'identité");
  assert.equal(out.body.code, "identity_unavailable");
  restoreEnv();
  pass("Supabase Auth injoignable : 503, distinct d'un jeton invalide");
}

// ---------------------------------------------------------------------------
// 3. Configuration manquante : fermé par défaut
// ---------------------------------------------------------------------------
{
  // Rien n'est configuré : aucun appel ne doit sortir, surtout pas une
  // consommation sur une base dont on ne connaît pas l'adresse.
  setEnv({
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
  });

  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };

  const out = await callChat(handler, { headers: AUTH });
  assert.equal(out.status, 503, "une configuration absente doit bloquer, pas autoriser");
  assert.equal(out.body.code, "not_configured");
  assert.equal(called, false, "aucun appel sortant sans configuration");

  restoreEnv();
  restoreFetch();
  pass("configuration incomplète (URL, clé anonyme, clé de service) : 503 et aucun appel sortant");
}

// ---------------------------------------------------------------------------
// 4. Le plan vient de la base, jamais du jeton ni du corps
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase({ rows: [], provider: "ok" });
  const out = await send("192.0.2.18");
  assert.equal(out.status, 200, "le gratuit a droit au chat");
  restoreEnv();
  pass("compte sans abonnement : le chat reste accessible (formule Découverte gratuite)");
}

{
  // Période échue : plus aucun droit payant, même si le statut dit « active ».
  //
  // Le révélateur est le quota : un compte retombé en Découverte plafonne à 15
  // messages par jour. On remplit la journée avec les limites Découverte —
  // c'est exactement ce que ferait la base s'il était encore en Pro — puis on
  // vérifie que le 16e est refusé.
  setEnv();
  const db = createUsageDb();
  db.seed(USER_ID, { messages: 15, quotes: 0 });
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(-1) }],
    db,
    provider: "ok",
  });

  const out = await send("192.0.2.20");
  assert.equal(out.status, 429, "un abonnement expiré ne donne plus le quota Pro");
  assert.equal(out.body.code, "daily_messages");
  assert.equal(out.body.plan, "decouverte", "le plan appliqué est bien retombé en Découverte");

  restoreEnv();
  pass("abonnement expiré : les droits payants sont retirés, le quota appliqué est celui de Découverte");
}

{
  // Abonnement valide : droit payant accordé.
  setEnv();
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }],
    provider: "ok",
  });
  const out = await send("192.0.2.22", {
    attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
    task: "garage-quote",
  });
  assert.equal(out.status, 200, "un abonnement valide doit ouvrir l'analyse de document");
  restoreEnv();
  pass("abonnement en cours : l'analyse de document est autorisée");
}

{
  // Ligne appartenant à un autre compte : aucun droit.
  //
  // Le révélateur est le quota : si la ligne d'un autre compte accordait un
  // plan Pro, 15 messages déjà consommés ne bloqueraient pas. Le refus prouve
  // que le plan appliqué est bien Découverte.
  setEnv();
  const db = createUsageDb();
  db.seed(USER_ID, { messages: 15, quotes: 0 });
  installSupabase({
    rows: [{ user_id: OTHER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }],
    db,
    provider: "ok",
  });

  const out = await send("192.0.2.21");
  assert.equal(out.status, 429, "la ligne d'un autre compte ne doit accorder aucun quota payant");
  assert.equal(out.body.plan, "decouverte");

  restoreEnv();
  pass("ligne appartenant à un autre compte : aucun droit payant accordé (quota Découverte appliqué)");
}

// ---------------------------------------------------------------------------
// 6. Lecture des abonnements en échec : 503, jamais un repli
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase({ restStatus: 500 });
  const out = await callChat(handler, { headers: AUTH });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "identity_unavailable");
  restoreEnv();
  pass("table des abonnements illisible : 503, aucun repli silencieux");
}

// ---------------------------------------------------------------------------
// 7. Rien de sensible ne sort
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase({ provider: "ok" });
  const out = await send("192.0.2.23");
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes(TOKEN), "le jeton ne doit jamais revenir");
  assert.doesNotMatch(serialised, /sb_secret|sb_publishable/);
  assert.ok(!serialised.includes("client@veyvro.test"), "l'e-mail du compte ne doit pas fuiter");
  restoreEnv();
  pass("réponses : ni jeton, ni clé, ni adresse e-mail");
}

// ---------------------------------------------------------------------------
// 8. Le reste du contrat du handler est intact
// ---------------------------------------------------------------------------
{
  setEnv();
  installSupabase();
  const out = await callChat(handler, { method: "GET" });
  assert.equal(out.status, 405, "la méthode reste vérifiée");
  restoreEnv();
  pass("méthode GET : 405 inchangé");
}

{
  // P8/S4 : la limite qui tranche pour un compte authentifié est désormais la
  // rafale **contractuelle de sa formule** (10/min en Découverte), et non plus
  // un plafond d'adresse indifférencié. Le net par IP existe toujours, mais il
  // est au-dessus de la plus large des formules (voir `rate-limit-layers`).
  setEnv();
  installSupabase({ rows: [], provider: "ok" });
  let out = null;
  for (let index = 0; index < 11; index += 1) {
    out = await send("203.0.113.42");
  }
  assert.equal(out.status, 429, "la 11e requête de la minute doit être refusée");
  assert.equal(out.body.code, "rate_minute", "c'est la rafale de la formule qui tranche, pas l'adresse");
  assert.equal(out.body.limit, 10, "la limite annoncée est celle de la formule Découverte");
  assert.equal(out.body.plan, "decouverte");
  assert.ok(Number(out.headers["Retry-After"]) > 0, "`Retry-After` doit accompagner le refus");
  restoreEnv();
  pass("rafale Découverte : 10 requêtes par minute, la 11e en 429 `rate_minute` avec la limite de la formule");
}

// ---------------------------------------------------------------------------
// 9. Quotas opposées par le handler : 429, `Retry-After`, codes explicites
// ---------------------------------------------------------------------------
{
  setEnv();
  const db = createUsageDb();
  db.seed(USER_ID, { messages: 15, quotes: 0 }); // Découverte : 15 messages par jour
  installSupabase({ rows: [], db, provider: "ok" });

  const out = await send("192.0.2.11");

  assert.equal(out.status, 429, "le 16e message du jour doit être refusé");
  assert.equal(out.body.code, "daily_messages");
  assert.equal(out.body.plan, "decouverte");
  assert.equal(out.body.limit, 15);
  assert.equal(out.body.used, 15);
  assert.ok(Number(out.headers["Retry-After"]) > 0, "`Retry-After` doit accompagner le 429");
  assert.deepEqual(db.count(USER_ID), { messages: 15, quotes: 0 }, "un refus ne débite rien de plus");

  restoreEnv();
  pass("quota journalier Découverte : 429 `daily_messages`, `Retry-After` présent, limite et usage exposés");
}

{
  // Plus : 15 messages consommés ne bloquent pas, la limite est de 200.
  setEnv();
  const db = createUsageDb();
  db.seed(USER_ID, { messages: 15, quotes: 0 });
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
    db,
    provider: "ok",
  });

  const out = await send("192.0.2.12");
  assert.equal(out.status, 200, "15 messages ne doivent pas suffire à bloquer un compte Plus");
  assert.deepEqual(db.count(USER_ID), { messages: 16, quotes: 0 }, "le 16e message est bien décompté");

  restoreEnv();
  pass("quota journalier Plus : 15 messages consommés ne bloquent pas un abonné Plus");
}

{
  // Le plafond du jour borne toujours une rafale : quinze messages d'affilée
  // passent, le seizième est refusé. C'est le compteur durable qui tranche, et
  // non un compteur de processus — la fenêtre de débit par minute relève de S4.
  setEnv();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  const statuses = [];
  for (let index = 0; index < 16; index += 1) {
    // Les garde-fous de débit sont remis à zéro entre deux envois : ce cas
    // mesure le plafond **du jour**, pas la rafale. Sans cela, la 11e requête
    // serait refusée par la couche B et le test ne dirait plus rien du quota.
    resetRateLimits();
    const out = await send(`10.7.0.${index}`);
    statuses.push(out.status);
  }

  assert.deepEqual(statuses.slice(0, 15), Array(15).fill(200), "les 15 premiers messages passent");
  assert.equal(statuses[15], 429, "le plafond journalier borne la rafale");
  assert.deepEqual(db.count(USER_ID), { messages: 15, quotes: 0 }, "exactement 15 messages facturés");

  restoreEnv();
  pass("rafale : les 15 messages du jour passent, le 16e est refusé par le compteur durable");
}

{
  // Plus n'a pas de plafond d'analyses : le compteur ne refuse jamais.
  setEnv();
  const db = createUsageDb();
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
    db,
    provider: "ok",
  });

  for (let index = 0; index < 5; index += 1) {
    const out = await send(`10.8.0.${index}`, {
      attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
      task: "garage-quote",
    });
    assert.equal(out.status, 200, "Plus : analyses illimitées");
  }
  assert.deepEqual(db.count(USER_ID), { messages: 5, quotes: 5 }, "chaque analyse est décomptée une fois");

  restoreEnv();
  pass("analyses de devis : illimitées pour Plus, le compteur ne refuse jamais");
}

{
  // Option (a), validée : la Découverte peut joindre le document de son analyse
  // de devis — c'est la promesse du catalogue — une fois par jour.
  setEnv();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  const quote = (ip) =>
    send(ip, {
      attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
      task: "garage-quote",
    });

  const first = await quote("192.0.2.13");
  assert.equal(first.status, 200, "la Découverte doit pouvoir joindre le document de son analyse de devis");

  // Deuxième analyse le même jour : c'est le quota de 1 qui tranche, plus le droit.
  const second = await quote("192.0.2.14");
  assert.equal(second.status, 429, "le quota d'une analyse par jour doit s'appliquer");
  assert.equal(second.body.code, "daily_quotes");

  restoreEnv();
  pass("Découverte : le document joint est accepté pour l'analyse de devis, puis bloqué à 1 par jour (429 `daily_quotes`)");
}

{
  // Et la capacité photo/PDF générale reste bien réservée aux offres payantes :
  // une pièce jointe hors analyse de devis est refusée côté validation du corps,
  // quel que soit le plan, parce qu'aucun autre cas d'usage n'existe.
  setEnv();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  const out = await send("192.0.2.15", {
    attachments: [{ type: "text", name: "facture.pdf", mimeType: "application/pdf", text: "Facture" }],
    // Pas de tâche : la pièce jointe n'a aucun usage hors analyse de devis.
  });

  assert.equal(out.status, 400, "une pièce jointe sans analyse de devis reste refusée");
  assert.match(out.body.error, /only supported for garage quote analysis/i);
  assert.equal(db.rpc.length, 0, "un corps invalide ne doit rien consommer");

  restoreEnv();
  pass("hors analyse de devis : aucune pièce jointe n'est acceptée, la capacité photo/PDF générale reste payante");
}

{
  // Écart catalogue ↔ API constaté en S5, **tranché en S6** : la promesse
  // générale « Analyse de photos et de PDF » a été retirée du catalogue (elle
  // annonçait une capacité que la route n'a jamais servie, pour aucune formule),
  // et la ligne Plus dit désormais que les photos et PDF sont acceptés *pour
  // chaque analyse de devis*. Le comportement ci-dessous est donc le contrat :
  // hors analyse de devis, aucune pièce jointe, même en Plus.
  setEnv();
  const db = createUsageDb();
  installSupabase({
    rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
    db,
    provider: "ok",
  });

  const out = await send("192.0.2.16", {
    attachments: [{ type: "text", name: "facture.pdf", mimeType: "application/pdf", text: "Facture" }],
    // Pas de tâche : c'est le cas d'usage « photos et PDF » promis à Plus.
  });

  assert.equal(out.status, 400, "aujourd'hui, même un abonné Plus ne peut pas joindre hors analyse de devis");
  assert.match(out.body.error, /only supported for garage quote analysis/i);
  assert.equal(db.rpc.length, 0, "aucune consommation sur un refus de validation");

  restoreEnv();
  pass("hors analyse de devis : aucune pièce jointe, même en Plus — la promesse générale a été retirée du catalogue en S6");
}

// ---------------------------------------------------------------------------
// 11. FREE / PLUS / PRO : la même requête, trois droits, à la même porte
// ---------------------------------------------------------------------------
// Everything above tests one rule at a time. This block walks the three plans
// through the *same* handler with the *same* request shapes, so a regression that
// makes two plans behave alike (or swaps one limit for another) is caught even
// if each individual rule still looks right.
{
  const PROFILES = [
    {
      label: "FREE (Découverte)",
      rows: [],
      planId: "decouverte",
      messagesPerDay: 15,
      quoteAnalysesPerDay: 1,
      requestsPerMinute: 10,
    },
    {
      label: "PLUS",
      rows: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
      planId: "plus",
      messagesPerDay: 200,
      quoteAnalysesPerDay: null,
      requestsPerMinute: 20,
    },
    {
      label: "PRO",
      rows: [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }],
      planId: "pro",
      messagesPerDay: 600,
      quoteAnalysesPerDay: null,
      requestsPerMinute: 30,
    },
  ];

  for (const profile of PROFILES) {
    resetRateLimits();

    // 1. Une requête ordinaire passe, et débite un message.
    {
      setEnv();
      const db = createUsageDb();
      installSupabase({ rows: profile.rows, db, provider: "ok" });
      const out = await send("198.51.100.7");
      assert.equal(out.status, 200, `${profile.label} : une requête ordinaire doit passer`);
      assert.deepEqual(db.count(USER_ID), { messages: 1, quotes: 0 }, `${profile.label} : un message débité, aucune analyse`);
      restoreEnv();
    }

    // 2. Le plafond quotidien est celui de la formule, et il refuse au bon moment.
    {
      setEnv();
      const db = createUsageDb();
      db.seed(USER_ID, { messages: profile.messagesPerDay, quotes: 0 });
      installSupabase({ rows: profile.rows, db, provider: "ok" });
      const out = await send("198.51.100.8");
      assert.equal(out.status, 429, `${profile.label} : plafond quotidien atteint → 429`);
      assert.equal(out.body.code, "daily_messages");
      assert.equal(out.body.plan, profile.planId, `${profile.label} : le plan appliqué est celui de la base`);
      assert.equal(out.body.limit, profile.messagesPerDay, `${profile.label} : la limite annoncée est celle de la formule`);
      restoreEnv();
    }

    // 3. L'analyse de devis : une seule par jour pour Découverte, jamais refusée
    //    au-delà pour les formules payantes.
    {
      setEnv();
      const db = createUsageDb();
      installSupabase({ rows: profile.rows, db, provider: "ok" });
      const first = await send("198.51.100.9", {
        attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
        task: "garage-quote",
      });
      assert.equal(first.status, 200, `${profile.label} : l'analyse de devis avec document est autorisée`);
      assert.deepEqual(db.count(USER_ID), { messages: 1, quotes: 1 }, `${profile.label} : l'analyse est comptée à part`);
      restoreEnv();
    }

    if (profile.quoteAnalysesPerDay === 1) {
      setEnv();
      const separate = createUsageDb();
      separate.seed(USER_ID, { messages: 1, quotes: 1 });
      installSupabase({ rows: profile.rows, db: separate, provider: "ok" });
      const second = await send("198.51.100.10", {
        attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
        task: "garage-quote",
      });
      assert.equal(second.status, 429, "Découverte : une seule analyse de devis par jour");
      assert.equal(second.body.code, "daily_quotes");
      assert.equal(second.body.limit, 1);
      restoreEnv();
    } else {
      // Payant : le compteur d'analyses ne refuse jamais, quel que soit l'usage.
      setEnv();
      const busy = createUsageDb();
      busy.seed(USER_ID, { messages: 3, quotes: 40 });
      installSupabase({ rows: profile.rows, db: busy, provider: "ok" });
      const again = await send("198.51.100.11", {
        attachments: [{ type: "text", name: "devis.pdf", mimeType: "application/pdf", text: "Devis" }],
        task: "garage-quote",
      });
      assert.equal(again.status, 200, `${profile.label} : analyses de devis illimitées`);
      restoreEnv();
    }

    // 4. Hors analyse de devis, la pièce jointe est refusée pour les trois
    //    formules : la capacité photo/PDF générale n'existe pour personne.
    {
      setEnv();
      const db = createUsageDb();
      installSupabase({ rows: profile.rows, db, provider: "ok" });
      const out = await send("198.51.100.12", {
        attachments: [{ type: "image", name: "photo.jpg", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA" }],
      });
      assert.equal(out.status, 400, `${profile.label} : aucune pièce jointe hors analyse de devis`);
      assert.equal(db.rpc.length, 0, `${profile.label} : un refus de validation ne débite rien`);
      restoreEnv();
    }

    // 5. La rafale est bornée par le plafond de la formule, pas par un chiffre
    //    commun : on dépasse la limite de la formule et on vérifie la valeur
    //    annoncée dans le 429.
    {
      setEnv();
      resetRateLimits();
      const db = createUsageDb();
      installSupabase({ rows: profile.rows, db, provider: "ok" });
      let last = null;
      for (let index = 0; index <= profile.requestsPerMinute; index += 1) {
        last = await send("203.0.113.200");
      }
      assert.equal(last.status, 429, `${profile.label} : la rafale finit par être refusée`);
      assert.equal(last.body.code, "rate_minute");
      assert.equal(last.body.limit, profile.requestsPerMinute, `${profile.label} : plafond par minute = ${profile.requestsPerMinute}`);
      restoreEnv();
      resetRateLimits();
    }
  }

  pass("FREE / PLUS / PRO : messages, analyses de devis, pièces jointes et plafond par minute suivent la formule, à porte identique");
}

restoreFetch();
console.log(`\n${checks} vérifications d'accès au chat passées.`);
