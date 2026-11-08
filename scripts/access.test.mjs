/**
 * Access-control tests — the rules that decide whether a request may run.
 *
 * These are the conditions under which money matters: who is calling, which
 * plan the database grants them, and when that grant expires. Everything here
 * is pure or stubbed, so no network call leaves the process.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { expectedAmount, getPriceId, isSandboxPriceId, resolvePaddleConfig } from "../src/lib/paddleCore.ts";
import { describeLimits } from "../src/lib/planLimits.ts";
import {
  ACCESS_ENV_KEYS,
  PLAN_LIMITS,
  authorizeRequest,
  limitsFor,
  quotaKey,
  readAccessEnv,
  readBearerToken,
  readSubscriptions,
  resolveAccessPlan,
  resolveIdentity,
  toGrant,
} from "../server/access.ts";
import { PRICING_PLANS } from "../src/lib/paddleCore.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const SUPABASE_URL = "https://stub-project.supabase.test";
const ANON_KEY = "sb_publishable_stub_key";
const SERVICE_KEY = "sb_secret_stub_key";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
/** Realistic length: the reader refuses anything too short to be a JWT. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q";

const ENV = {
  [ACCESS_ENV_KEYS.supabaseUrl]: SUPABASE_URL,
  [ACCESS_ENV_KEYS.supabaseAnonKey]: ANON_KEY,
  [ACCESS_ENV_KEYS.serviceRoleKey]: SERVICE_KEY,
};

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const inDays = (days) => new Date(NOW + days * 86_400_000).toISOString();

function row(overrides = {}) {
  return {
    user_id: USER_ID,
    plan: "plus",
    status: "active",
    current_period_ends_at: inDays(20),
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
function restore() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// 1. Configuration : absente = aucun accès
// ---------------------------------------------------------------------------
{
  assert.equal(readAccessEnv({}), null);
  assert.equal(readAccessEnv({ ...ENV, [ACCESS_ENV_KEYS.supabaseAnonKey]: "  " }), null);
  assert.equal(readAccessEnv({ ...ENV, [ACCESS_ENV_KEYS.serviceRoleKey]: "" }), null);
  assert.equal(readAccessEnv({ ...ENV, [ACCESS_ENV_KEYS.supabaseUrl]: undefined }), null);

  // A trailing slash must not double up in the URLs built later.
  const parsed = readAccessEnv({ ...ENV, [ACCESS_ENV_KEYS.supabaseUrl]: `${SUPABASE_URL}///` });
  assert.equal(parsed.url, SUPABASE_URL);

  pass("configuration : une variable manquante ou vide interdit toute décision (fermé par défaut)");
}

// ---------------------------------------------------------------------------
// 2. Jeton : refusé avant tout appel réseau
// ---------------------------------------------------------------------------
{
  assert.equal(readBearerToken(null), null);
  assert.equal(readBearerToken(""), null);
  assert.equal(readBearerToken("Basic abc"), null);
  assert.equal(readBearerToken("Bearer court"), null, "trop court pour être un JWT");
  assert.equal(readBearerToken("Bearer pas.un.jwt.valide"), null, "doit avoir 3 segments");
  assert.equal(readBearerToken("Bearer header.payload.signature"), "header.payload.signature");
  assert.equal(readBearerToken("bearer header.payload.signature"), "header.payload.signature");
  pass("jeton : en-tête absent, schéma inconnu, valeur trop courte ou non-JWT sont refusés");
}

// ---------------------------------------------------------------------------
// 3. Lecture d'une ligne : la période payée est la seule preuve
// ---------------------------------------------------------------------------
{
  assert.equal(toGrant(row(), USER_ID, NOW), "plus");
  assert.equal(toGrant(row({ plan: "pro" }), USER_ID, NOW), "pro");

  // Propriété : la ligne d'un autre compte ne donne jamais de droit.
  assert.equal(toGrant(row(), OTHER_ID, NOW), null, "ligne d'un autre compte");
  assert.equal(toGrant(row({ user_id: undefined }), USER_ID, NOW), null, "sans propriétaire");
  assert.equal(toGrant(row({ user_id: "  " }), USER_ID, NOW), null);
  assert.equal(toGrant(null, USER_ID, NOW), null);
  assert.equal(toGrant("plus", USER_ID, NOW), null, "une chaîne n'est pas une ligne");
  assert.equal(toGrant(row(), "", NOW), null, "aucun compte attendu = aucun droit");
  pass("ligne : propriétaire vérifié, ligne d'un autre compte ou sans propriétaire refusée");
}

{
  // Plan inconnu : jamais deviné.
  assert.equal(toGrant(row({ plan: "gold" }), USER_ID, NOW), null);
  assert.equal(toGrant(row({ plan: "decouverte" }), USER_ID, NOW), null, "le gratuit ne vient pas d'une ligne");
  assert.equal(toGrant(row({ plan: 42 }), USER_ID, NOW), null);
  pass("plan : toute valeur hors plus/pro est refusée, aucun plan deviné");
}

{
  // Statuts : ce qui donne accès, et ce qui n'en donne pas.
  assert.equal(toGrant(row({ status: "active" }), USER_ID, NOW), "plus");
  assert.equal(toGrant(row({ status: "trialing" }), USER_ID, NOW), "plus");
  assert.equal(toGrant(row({ status: "past_due" }), USER_ID, NOW), "plus", "délai de régularisation en cours");
  assert.equal(toGrant(row({ status: "canceled" }), USER_ID, NOW), "plus", "résilié mais période payée non échue");

  assert.equal(toGrant(row({ status: "paused" }), USER_ID, NOW), null, "en pause = aucun accès");
  assert.equal(toGrant(row({ status: "expired" }), USER_ID, NOW), null);
  assert.equal(toGrant(row({ status: "unknown" }), USER_ID, NOW), null);
  assert.equal(toGrant(row({ status: null }), USER_ID, NOW), null);
  pass("statut : active/trialing/past_due/canceled ouvrent l'accès, paused et inconnus le ferment");
}

{
  // Expiration : le point le plus important de tout le module.
  assert.equal(toGrant(row({ current_period_ends_at: inDays(-1) }), USER_ID, NOW), null, "période échue");
  assert.equal(toGrant(row({ current_period_ends_at: new Date(NOW).toISOString() }), USER_ID, NOW), null, "échéance atteinte");
  assert.equal(toGrant(row({ current_period_ends_at: new Date(NOW + 1000).toISOString() }), USER_ID, NOW), "plus", "encore valide");

  // Pas de date = pas de preuve = pas d'accès.
  assert.equal(toGrant(row({ current_period_ends_at: undefined }), USER_ID, NOW), null);
  assert.equal(toGrant(row({ current_period_ends_at: null }), USER_ID, NOW), null);
  assert.equal(toGrant(row({ current_period_ends_at: "pas une date" }), USER_ID, NOW), null);

  // Une ligne `canceled` dont la période est échue n'ouvre plus rien.
  assert.equal(
    toGrant(row({ status: "canceled", current_period_ends_at: inDays(-2) }), USER_ID, NOW),
    null,
    "résiliation effective : l'accès est terminé",
  );
  pass("expiration : période échue, échéance atteinte ou date absente/illisible → aucun droit");
}

// ---------------------------------------------------------------------------
// 4. Résolution du plan sur l'ensemble des lignes
// ---------------------------------------------------------------------------
{
  assert.equal(resolveAccessPlan([], USER_ID, NOW), "decouverte", "aucune ligne = gratuit");
  assert.equal(resolveAccessPlan([row()], USER_ID, NOW), "plus");
  assert.equal(resolveAccessPlan([row({ plan: "pro" })], USER_ID, NOW), "pro");

  // Un client qui a changé de formule ne doit pas rester bloqué sur l'ancienne.
  assert.equal(
    resolveAccessPlan([row({ plan: "plus" }), row({ plan: "pro" })], USER_ID, NOW),
    "pro",
    "la formule la plus élevée valide l'emporte",
  );

  // Une ancienne ligne expirée ne contamine pas la nouvelle.
  assert.equal(
    resolveAccessPlan(
      [row({ plan: "pro", current_period_ends_at: inDays(-30) }), row({ plan: "plus" })],
      USER_ID,
      NOW,
    ),
    "plus",
  );

  // Des lignes appartenant à d'autres comptes ne donnent rien.
  assert.equal(resolveAccessPlan([row({ user_id: OTHER_ID })], USER_ID, NOW), "decouverte");
  pass("résolution : gratuit sans ligne, Plus/Pro selon les lignes, la plus élevée valide gagne");
}

// ---------------------------------------------------------------------------
// 5. Quotas : conformes aux promesses du catalogue
// ---------------------------------------------------------------------------
{
  assert.deepEqual(PLAN_LIMITS.decouverte, {
    messagesPerDay: 15,
    quoteAnalysesPerDay: 1,
    quoteAnalysis: true,
    requestsPerMinute: 10,
  });
  assert.deepEqual(PLAN_LIMITS.plus, {
    messagesPerDay: 200,
    quoteAnalysesPerDay: null,
    quoteAnalysis: true,
    requestsPerMinute: 20,
  });
  assert.deepEqual(PLAN_LIMITS.pro, {
    messagesPerDay: 600,
    quoteAnalysesPerDay: null,
    quoteAnalysis: true,
    requestsPerMinute: 30,
  });

  // No plan carries a "general photo/PDF" flag any more: the route refuses an
  // attachment outside the quote analysis for everyone, so such a flag would
  // describe a capability nothing exercises (the S5 finding).
  for (const plan of ["decouverte", "plus", "pro"]) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(PLAN_LIMITS[plan], "attachments"),
      `${plan} : aucune capacité photo/PDF générale n'est déclarée`,
    );
  }

  // Un plan inconnu retombe sur le plus restrictif, jamais sur un plan payant.
  assert.deepEqual(limitsFor("inconnu"), PLAN_LIMITS.decouverte);
  pass("quotas : 15/1, 200/illimité, 600/illimité (10/20/30 par minute), et aucune capacité photo/PDF générale déclarée");
}

{
  // Cohérence entre le code et les promesses affichées sur la page tarifs.
  const decouverte = PRICING_PLANS.find((plan) => plan.id === "decouverte");
  const plus = PRICING_PLANS.find((plan) => plan.id === "plus");
  const pro = PRICING_PLANS.find((plan) => plan.id === "pro");

  // « Analyse d'un devis de garage » (singulier) = une analyse par jour.
  assert.ok(
    decouverte.features.some((feature) => /Analyse d'un devis/i.test(feature)),
    "la promesse Découverte doit rester au singulier",
  );
  assert.equal(PLAN_LIMITS.decouverte.quoteAnalysesPerDay, 1);

  // « Devis et factures de garage illimités » + les documents, rattachés à ces
  // analyses : la promesse dit exactement ce que la route accepte.
  assert.ok(plus.features.some((feature) => /illimités/i.test(feature)));
  assert.ok(
    plus.features.some((feature) => /Photos et PDF acceptés pour chaque analyse de devis/i.test(feature)),
    "la ligne Plus rattache explicitement les photos et PDF aux analyses de devis",
  );
  assert.equal(PLAN_LIMITS.plus.quoteAnalysesPerDay, null);

  // Pro promet au moins autant que Plus.
  assert.ok(pro.features.some((feature) => /Tout VEYVRO Plus/i.test(feature)));
  assert.ok(PLAN_LIMITS.pro.messagesPerDay > PLAN_LIMITS.plus.messagesPerDay);
  assert.ok(PLAN_LIMITS.plus.messagesPerDay > PLAN_LIMITS.decouverte.messagesPerDay);

  // Aucune promesse de fonctionnalité payante n'est accordée au gratuit.
  assert.ok(
    !decouverte.features.some((feature) => /illimités|photos et de PDF/i.test(feature)),
    "le gratuit ne doit annoncer ni illimité ni analyse de photos",
  );

  // The withdrawn promise must not come back: no catalogue line may announce a
  // general photo/PDF analysis. This is the S6 regression guard — a "photos et
  // PDF" line is only allowed when it names the quote analysis.
  for (const plan of PRICING_PLANS) {
    for (const feature of plan.features) {
      if (!/photos? et (de )?PDF/i.test(feature)) continue;
      assert.match(
        feature,
        /analyse de devis|devis/i,
        `${plan.id} : « ${feature} » promet des photos/PDF sans les rattacher à l'analyse de devis`,
      );
    }
  }

  // The same rule for the client copy: an error message may not re-introduce the
  // withdrawn promise. Any "photos et PDF" wording in the interface has to name
  // the garage-quote analysis it belongs to.
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  for (const line of app.split("\n")) {
    if (!/photos? et (de )?PDF/i.test(line)) continue;
    assert.match(
      line,
      /devis/i,
      `message client sans mention du devis : ${line.trim().slice(0, 120)}`,
    );
  }

  pass("promesses ↔ quotas : le catalogue décrit exactement ce que la route accepte, et ne promet plus de photos/PDF générales");
}

{
  // Quatre lignes retirées du catalogue Pro avant lancement :
  // « Comparatifs détaillés et rapports exportables », « Vérification d'occasion
  // guidée, étape par étape » et « Réponses prioritaires ». Aucune n'existe
  // dans le produit — `access.plan` ne change que le quota de messages et la
  // rafale par minute — et elles sont reportées. Une ligne ne doit pas revenir
  // avant que la route qui la sert existe.
  const withdrawn = [/comparatif/i, /exportable/i, /v[ée]rification d'occasion/i, /guid[ée]e/i, /prioritaire/i];
  for (const plan of PRICING_PLANS) {
    for (const feature of plan.features) {
      for (const pattern of withdrawn) {
        assert.ok(
          !pattern.test(feature),
          `${plan.id} : « ${feature} » présente comme disponible une fonctionnalité reportée`,
        );
      }
    }
  }

  // Contrepartie : Pro garde son prix, son quota et son seul avantage réel.
  const pro = PRICING_PLANS.find((plan) => plan.id === "pro");
  assert.deepEqual(
    pro.features,
    ["Tout VEYVRO Plus"],
    "Pro n'annonce plus que ce qu'il tient : tout Plus",
  );
  assert.equal(pro.monthly, 15, "Pro reste à 15 $/mois");
  assert.equal(pro.yearly, 129, "Pro reste à 129 $/an");
  assert.equal(PLAN_LIMITS.pro.messagesPerDay, 600, "et à 600 messages par jour");
  assert.equal(PLAN_LIMITS.pro.requestsPerMinute, 30, "avec 30 requêtes par minute");

  pass("catalogue Pro : les quatre promesses reportées ne peuvent plus revenir ; prix, quota et avantage réel inchangés");
}

{
  // Tarifs : le prix affiché, le prix envoyé à Paddle et la formule vendue
  // doivent désigner la même chose. Un tarif modifié dans le catalogue sans
  // prix Paddle correspondant, c'est un bouton qui ne peut pas aboutir — ou
  // pire, un montant annoncé qui n'est pas celui débité.
  const tariff = new Map(PRICING_PLANS.map((plan) => [plan.id, plan]));

  assert.deepEqual(
    [...tariff.keys()].sort(),
    Object.keys(PLAN_LIMITS).sort(),
    "chaque formule tarifée doit avoir sa ligne de limites, et réciproquement",
  );
  assert.equal(tariff.get("decouverte").monthly, 0, "Découverte reste gratuite");
  assert.equal(tariff.get("decouverte").yearly, 0);
  assert.equal(tariff.get("plus").monthly, 7);
  assert.equal(tariff.get("plus").yearly, 59);
  assert.equal(tariff.get("pro").monthly, 15);
  assert.equal(tariff.get("pro").yearly, 129);

  // Chaque formule payante et chaque périodicité a un identifiant de prix, et
  // l'aller-retour prix → formule est bijectif (le webhook et le changement de
  // formule partagent cette table).
  for (const plan of ["plus", "pro"]) {
    for (const interval of ["month", "year"]) {
      // `resolvePaddleConfig` with no environment returns the built-in Sandbox
      // catalogue — exactly what a deployment without price variables sends to
      // Paddle, and exactly what the webhook must recognise in return.
      const priceId = getPriceId(resolvePaddleConfig({}), plan, interval);
      assert.ok(priceId, `${plan}/${interval} doit avoir un identifiant de prix`);
      assert.equal(isSandboxPriceId(priceId), true, `${plan}/${interval} : l'identifiant par défaut est celui du bac à sable`);
      assert.equal(expectedAmount(plan, interval), interval === "month" ? tariff.get(plan).monthly : tariff.get(plan).yearly);
    }
  }

  // La phrase de quota affichée est générée depuis la table appliquée : elle ne
  // peut donc pas promettre autre chose que ce que le handler refuse.
  assert.match(describeLimits("decouverte"), /15 messages par jour/);
  assert.match(describeLimits("decouverte"), /1 analyse de devis par jour/);
  // The sentence names where the document is accepted, on every plan: no plan
  // renders "photos et PDF acceptés" as a standalone capability any more.
  for (const plan of ["decouverte", "plus", "pro"]) {
    assert.match(
      describeLimits(plan),
      /document joint accepté pour l'analyse de devis/,
      `${plan} : la phrase de quota rattache le document à l'analyse de devis`,
    );
    assert.ok(
      !/photos et PDF acceptés/i.test(describeLimits(plan)),
      `${plan} : plus aucune promesse générale de photos/PDF dans la phrase affichée`,
    );
  }
  assert.match(describeLimits("plus"), /200 messages par jour/);
  assert.match(describeLimits("plus"), /analyses de devis illimitées/);
  assert.match(describeLimits("pro"), /600 messages par jour/);

  pass("tarifs ↔ quotas : 0/7/59 et 0/15/129, un prix par formule et périodicité, phrases de quota générées");
}

// ---------------------------------------------------------------------------
// 6. Identité : Supabase est la seule autorité
// ---------------------------------------------------------------------------
{
  let seen = null;
  globalThis.fetch = async (url, init = {}) => {
    seen = { url: String(url), headers: init.headers ?? {} };
    return new Response(JSON.stringify({ id: USER_ID, email_confirmed_at: inDays(0) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const identity = await resolveIdentity("header.payload.signature", readAccessEnv(ENV));
  assert.deepEqual(identity, { userId: USER_ID, emailConfirmed: true });
  assert.ok(seen.url.endsWith("/auth/v1/user"), "l'identité est demandée à Supabase");
  assert.equal(seen.headers.apikey, ANON_KEY, "la clé anonyme valide le jeton");
  assert.equal(
    seen.headers.Authorization,
    "Bearer header.payload.signature",
    "le jeton de l'utilisateur est transmis tel quel",
  );
  assert.notEqual(seen.headers.apikey, SERVICE_KEY, "la clé de service ne touche jamais un jeton utilisateur");
  restore();
  pass("identité : validée par /auth/v1/user avec la clé anonyme, jamais avec la clé de service");
}

{
  // Jeton refusé par Supabase → aucune identité.
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "invalid JWT" }), { status: 401 });
  assert.equal(await resolveIdentity(TOKEN, readAccessEnv(ENV)), null);
  restore();

  // Corps sans identifiant exploitable → aucune identité, même en 200.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ email: "x@y.z" }), { status: 200, headers: { "Content-Type": "application/json" } });
  assert.equal(await resolveIdentity(TOKEN, readAccessEnv(ENV)), null);
  restore();

  // Un identifiant qui n'est pas un UUID n'est pas une identité.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id: "pas-un-uuid" }), { status: 200, headers: { "Content-Type": "application/json" } });
  assert.equal(await resolveIdentity(TOKEN, readAccessEnv(ENV)), null);
  restore();
  pass("identité : jeton invalide, corps incomplet ou identifiant non-UUID → refus");
}

{
  // Panne Supabase : erreur distincte, pour répondre 503 et non 401.
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  await assert.rejects(() => resolveIdentity(TOKEN, readAccessEnv(ENV)), /unreachable/i);
  restore();

  globalThis.fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(() => resolveIdentity(TOKEN, readAccessEnv(ENV)), /500/);
  restore();
  pass("identité : panne Supabase distinguée d'un jeton invalide (503 et non 401)");
}

// ---------------------------------------------------------------------------
// 7. Décision complète
// ---------------------------------------------------------------------------
{
  // Sans configuration : 503, et aucun appel réseau.
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  const decision = await authorizeRequest("Bearer " + TOKEN, {});
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
  assert.equal(decision.code, "not_configured");
  assert.equal(called, false, "aucune requête quand la configuration manque");
  restore();
  pass("décision : configuration absente → 503 immédiat, sans appel réseau");
}

{
  // Sans jeton : 401.
  const decision = await authorizeRequest(null, ENV);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
  assert.equal(decision.code, "auth_required");
  pass("décision : requête anonyme → 401 `auth_required`");
}

{
  // Jeton invalide : 401, distinct de la panne.
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  const decision = await authorizeRequest("Bearer " + TOKEN, ENV);
  assert.equal(decision.status, 401);
  assert.equal(decision.code, "invalid_token");
  restore();
  pass("décision : jeton expiré ou falsifié → 401 `invalid_token`");
}

{
  // Compte valide sans abonnement : gratuit, jamais payant.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: USER_ID, email_confirmed_at: inDays(0) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const decision = await authorizeRequest("Bearer " + TOKEN, ENV);
  assert.equal(decision.ok, true);
  assert.equal(decision.plan, "decouverte");
  assert.deepEqual(decision.limits, PLAN_LIMITS.decouverte);
  assert.equal(decision.userId, USER_ID);
  restore();
  pass("décision : compte valide sans abonnement → Découverte (gratuit), quotas gratuits");
}

{
  // Compte valide avec abonnement en cours : le plan vient de la base.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: USER_ID, email_confirmed_at: inDays(0) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.match(String(url), /subscriptions\?user_id=eq\./, "la lecture est filtrée sur le compte vérifié");
    return new Response(JSON.stringify([row({ plan: "pro" })]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const decision = await authorizeRequest("Bearer " + TOKEN, ENV);
  assert.equal(decision.ok, true);
  assert.equal(decision.plan, "pro");
  assert.deepEqual(decision.limits, PLAN_LIMITS.pro);
  restore();
  pass("décision : abonnement Pro en cours → plan Pro lu en base, quotas Pro");
}

{
  // Supabase injoignable pendant la lecture des abonnements : 503, pas gratuit.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: USER_ID, email_confirmed_at: inDays(0) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("rest down");
  };
  const decision = await authorizeRequest("Bearer " + TOKEN, ENV);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
  restore();
  pass("décision : abonnements illisibles → 503, jamais un repli silencieux vers un accès");
}

{
  // La réponse ne doit jamais contenir de secret.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: USER_ID, email_confirmed_at: inDays(0) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([row()]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const decision = await authorizeRequest("Bearer " + TOKEN, ENV);
  const serialised = JSON.stringify(decision);
  assert.doesNotMatch(serialised, /sb_secret|sb_publishable/);
  assert.ok(!serialised.includes(TOKEN), "le jeton ne doit pas revenir dans la décision");
  restore();
  pass("décision : ni clé, ni jeton dans ce qui est renvoyé au handler");
}

// ---------------------------------------------------------------------------
// 8. Clé de quota
// ---------------------------------------------------------------------------
{
  assert.equal(quotaKey(USER_ID), quotaKey(` ${USER_ID} `), "stable malgré les espaces");
  assert.notEqual(quotaKey(USER_ID), quotaKey(OTHER_ID), "deux comptes ne partagent pas un quota");
  assert.equal(quotaKey(USER_ID).length, 32);
  assert.ok(!quotaKey(USER_ID).includes(USER_ID), "l'identifiant n'est pas conservé en clair");
  pass("clé de quota : stable, distincte par compte, et non réversible");
}

// ---------------------------------------------------------------------------
// 9. Lecture REST : filtrage et échec explicite
// ---------------------------------------------------------------------------
{
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    return new Response(JSON.stringify([row()]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const rows = await readSubscriptions(USER_ID, readAccessEnv(ENV));
  assert.equal(rows.length, 1);
  assert.match(seen[0].url, new RegExp(`user_id=eq\\.${USER_ID}`));
  assert.match(seen[0].url, /current_period_ends_at/, "la date d'échéance fait partie de la lecture");
  assert.equal(seen[0].headers.apikey, SERVICE_KEY);
  restore();

  globalThis.fetch = async () => new Response("denied", { status: 401 });
  await assert.rejects(() => readSubscriptions(USER_ID, readAccessEnv(ENV)), /subscriptions read failed \(401\)/);
  restore();
  pass("lecture REST : filtrée sur l'utilisateur, et toute erreur remonte (aucun repli)");
}

console.log(`\n${checks} vérifications de contrôle d'accès passées.`);
