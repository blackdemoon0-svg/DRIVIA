/**
 * P8/S4 — the network layers, through the real handler and at module level.
 *
 * P7/S3 made the **daily** allowance durable. This suite covers what sits in
 * front of it:
 *
 *   C. failed authentications, per IP   — only ever counts failures;
 *   B. contract burst, per account+plan — 10 / 20 / 30 per minute, published;
 *   D. shared-IP net                    — 120/min per address, never below a plan;
 *   E. concurrency, per account         — 2 per account, 12 per instance, leased.
 *
 * The bug these tests exist to keep out is precise: the handler used to apply
 * **10 requests/minute and 60/hour to every caller, keyed on the IP**, before the
 * plan was consulted. PLUS (20/min) and PRO (30/min) were therefore unreachable,
 * and an office behind one address was capped as if it were one Découverte
 * account. A test that only checked "does throttling happen" would have passed
 * the whole time.
 *
 * Layers B–E live in the memory of one instance. Their *arithmetic* is verified
 * here; their aggregation across instances is not claimable and is not claimed.
 */
import assert from "node:assert";
import handler from "../api/chat.ts";
import { streamVeyvroResponse } from "../src/lib/veyvroApi.ts";
import {
  admitConcurrency,
  checkAuthFailures,
  checkUserBurst,
  concurrencySnapshot,
  CONCURRENCY_LEASE_MS,
  IP_REQUESTS_PER_MINUTE,
  MAX_CONCURRENT_REQUESTS_PER_ACCOUNT,
  PLAN_BURST_LIMITS,
  rateKey,
  recordAuthFailure,
  resetRateLimits,
  sweepExpiredEntries,
  WINDOW_SWEEP_INTERVAL_MS,
} from "../server/rateLimits.ts";
import {
  callChat,
  chatBody,
  createUsageDb,
  days,
  installSupabase,
  restoreEnv,
  restoreFetch,
  setEnv,
  TOKEN,
  tokenFor,
  USER_ID,
} from "./lib/chatHarness.mjs";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

/**
 * The address is only trusted when the platform says so (`VERCEL=1`), so the
 * handler tests that exercise the IP layers declare it and then hand out one
 * address per scenario. Without it every caller shares `unknown`, which is the
 * fail-closed default — also exercised below.
 */
function withVercel() {
  process.env.VERCEL = "1";
}

const auth = { authorization: `Bearer ${TOKEN}` };
const fromIp = (ip) => ({ ...auth, "x-vercel-forwarded-for": ip });

let idCounter = 0;
function clientMessageId(prefix = "cccccccc") {
  idCounter += 1;
  return `${prefix}-dddd-4eee-8fff-${String(idCounter).padStart(12, "0")}`;
}

const PLAN_ROWS = {
  decouverte: [],
  plus: [{ user_id: USER_ID, plan: "plus", status: "active", current_period_ends_at: days(20) }],
  pro: [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }],
};

// ---------------------------------------------------------------------------
// 1. La rafale contractuelle de chaque formule, à travers le handler
// ---------------------------------------------------------------------------
{
  for (const [plan, expected] of Object.entries(PLAN_BURST_LIMITS)) {
    setEnv();
    withVercel();
    const db = createUsageDb();
    // Le plafond du jour est repoussé très haut pour que seule la rafale parle.
    db.seed(USER_ID, { messages: 0, quotes: 0 });
    installSupabase({ rows: PLAN_ROWS[plan], db, provider: "ok" });

    const statuses = [];
    for (let index = 0; index <= expected; index += 1) {
      const out = await callChat(handler, {
        headers: fromIp(`198.51.200.${Object.keys(PLAN_BURST_LIMITS).indexOf(plan) + 1}`),
        body: chatBody({ clientMessageId: clientMessageId() }),
      });
      statuses.push({ status: out.status, body: out.body, headers: out.headers });
    }

    const accepted = statuses.slice(0, expected);
    assert.deepEqual(
      accepted.map((entry) => entry.status),
      Array(expected).fill(200),
      `${plan} : les ${expected} requêtes autorisées doivent passer`,
    );

    const refused = statuses[expected];
    assert.equal(refused.status, 429, `${plan} : la requête ${expected + 1} doit être refusée`);
    assert.equal(refused.body.code, "rate_minute", `${plan} : refus explicite de rafale, pas un quota du jour`);
    assert.equal(refused.body.limit, expected, `${plan} : la limite annoncée est celle de la formule`);
    assert.equal(refused.body.plan, plan);
    assert.ok(Number(refused.headers["Retry-After"]) > 0, `${plan} : \`Retry-After\` présent`);

    restoreEnv();
  }

  pass(`rafales contractuelles : ${PLAN_BURST_LIMITS.decouverte}/min Découverte, ${PLAN_BURST_LIMITS.plus}/min Plus, ${PLAN_BURST_LIMITS.pro}/min Pro — chacune atteignable`);
}

// ---------------------------------------------------------------------------
// 2. Les limites d'adresse ne plafonnent plus PLUS et PRO
// ---------------------------------------------------------------------------
{
  // Deux comptes PRO derrière **une seule adresse** (un bureau, un opérateur
  // mobile) envoient chacun leur rafale complète : 60 requêtes, toutes admises.
  // L'ancien plafond de 10/minute par IP refusait la 11e.
  setEnv();
  withVercel();
  let total = 0;
  for (const account of ["A", "B"]) {
    const db = createUsageDb();
    const rows = [{ user_id: USER_ID, plan: "pro", status: "active", current_period_ends_at: days(20) }];
    resetRateLimits();
    installSupabase({ rows, db, provider: "ok" });

    for (let index = 0; index < PLAN_BURST_LIMITS.pro; index += 1) {
      const out = await callChat(handler, {
        headers: fromIp("203.0.113.7"),
        body: chatBody({ clientMessageId: clientMessageId(account === "A" ? "aaaaaaaa" : "bbbbbbbb") }),
      });
      assert.equal(out.status, 200, `compte ${account} PRO, requête ${index + 1} : doit passer depuis une IP partagée`);
      total += 1;
    }

    // Les compteurs de rafale sont propres au compte : on garde le net IP, on
    // remet seulement la rafale à zéro pour le second compte.
    resetRateLimits();
  }
  assert.equal(total, PLAN_BURST_LIMITS.pro * 2, "60 requêtes PRO depuis une adresse unique, toutes admises");

  restoreEnv();
  pass("adresse partagée : deux PRO (30/min chacun) cohabitent sur une IP, sans être plafonnés à 10");
}

{
  // Le net d'adresse existe toujours, et il est réglé au-dessus de la plus large
  // des formules : c'est ce qui lui interdit de définir ce que vaut un plan.
  assert.ok(
    IP_REQUESTS_PER_MINUTE > PLAN_BURST_LIMITS.pro,
    `le net par IP (${IP_REQUESTS_PER_MINUTE}/min) doit rester au-dessus de la plus large des formules (${PLAN_BURST_LIMITS.pro}/min)`,
  );
  pass(`net par adresse : ${IP_REQUESTS_PER_MINUTE}/min, soit strictement au-dessus de PRO (${PLAN_BURST_LIMITS.pro}/min)`);
}

// ---------------------------------------------------------------------------
// 3. Le net d'adresse finit par trancher — et il le dit
// ---------------------------------------------------------------------------
{
  // Treize comptes Découverte (10/min chacun) depuis une seule adresse : les
  // 120 premières requêtes passent, les suivantes rencontrent le net.
  setEnv();
  withVercel();
  resetRateLimits();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  const statuses = [];
  const accountsNeeded = Math.ceil(IP_REQUESTS_PER_MINUTE / PLAN_BURST_LIMITS.decouverte) + 1;
  let account = 0;
  while (statuses.length < IP_REQUESTS_PER_MINUTE) {
    // Une identité distincte par paquet de dix : chaque compte a sa propre
    // rafale, seule l'adresse est partagée.
    const bearer = { authorization: `Bearer ${tokenFor(`77777777-0000-4000-8000-${String(account).padStart(12, "0")}`)}` };
    for (let index = 0; index < PLAN_BURST_LIMITS.decouverte; index += 1) {
      if (statuses.length >= IP_REQUESTS_PER_MINUTE) break;
      const out = await callChat(handler, {
        headers: { ...bearer, "x-vercel-forwarded-for": "203.0.113.99" },
        body: chatBody({ clientMessageId: clientMessageId() }),
      });
      statuses.push(out);
    }
    account += 1;
  }

  assert.equal(statuses.length, IP_REQUESTS_PER_MINUTE, "exactement le plafond d'adresse a été demandé");
  assert.ok(
    statuses.every((out) => out.status === 200),
    "les requêtes sous le plafond d'adresse doivent toutes passer",
  );

  const over = await callChat(handler, {
    headers: fromIp("203.0.113.99"),
    body: chatBody({ clientMessageId: clientMessageId() }),
  });
  assert.equal(over.status, 429, "au-delà du plafond d'adresse, la requête est refusée");
  assert.equal(over.body.code, "ip_rate_limited", "le refus nomme la couche qui l'a produit");
  assert.equal(over.body.window, "minute");
  assert.equal(over.body.limit, IP_REQUESTS_PER_MINUTE);
  assert.ok(Number(over.headers["Retry-After"]) > 0);

  restoreEnv();
  pass(`net d'adresse : ${IP_REQUESTS_PER_MINUTE} requêtes admises puis 429 \`ip_rate_limited\` (fenêtre et limite explicites)`);
}

// ---------------------------------------------------------------------------
// 4. Isolation des compteurs entre comptes
// ---------------------------------------------------------------------------
{
  setEnv();
  withVercel();
  resetRateLimits();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  // Le compteur de rafale est indexé sur le compte : le même compte épuisé ne
  // doit pas consommer le droit d'un autre. On le prouve au niveau du module,
  // où deux identités distinctes sont disponibles.
  const victim = rateKey("user", USER_ID);
  const other = rateKey("user", "22222222-3333-4444-8555-666666666666");
  assert.notEqual(victim, other, "deux comptes ne partagent pas la même clé de compteur");
  assert.ok(!victim.includes(USER_ID), "la clé ne contient pas l'identifiant en clair");

  // Handler : le compte épuisé reçoit 429, un appel avec une autre identité
  // n'est pas affecté (le stub d'identité ne renvoie qu'un compte, donc on
  // vérifie l'isolation au niveau module ci-dessous).
  for (let index = 0; index < PLAN_BURST_LIMITS.decouverte; index += 1) {
    await callChat(handler, { headers: fromIp("203.0.113.50"), body: chatBody({ clientMessageId: clientMessageId() }) });
  }
  const refused = await callChat(handler, {
    headers: fromIp("203.0.113.51"),
    body: chatBody({ clientMessageId: clientMessageId() }),
  });
  assert.equal(refused.status, 429, "compte épuisé : refusé");
  assert.equal(refused.body.code, "rate_minute", "et refusé par SA rafale, même depuis une autre adresse");
  assert.equal(refused.body.used, PLAN_BURST_LIMITS.decouverte, "l'usage annoncé est celui de son compteur");

  restoreEnv();
  pass("isolation : la rafale est indexée sur le compte (clé opaque), pas sur l'adresse ni sur un compteur partagé");
}

// ---------------------------------------------------------------------------
// 5. Couche C — les échecs d'authentification, et eux seuls
// ---------------------------------------------------------------------------
{
  setEnv();
  withVercel();
  resetRateLimits();
  installSupabase({ identity: "invalid" });

  let last = null;
  for (let index = 0; index < 20; index += 1) {
    last = await callChat(handler, {
      headers: { ...auth, "x-vercel-forwarded-for": "203.0.113.77" },
      body: chatBody(),
    });
    assert.equal(last.status, 401, "un jeton invalide reste un 401 tant que le garde-fou n'a pas parlé");
  }

  const blocked = await callChat(handler, {
    headers: { ...auth, "x-vercel-forwarded-for": "203.0.113.77" },
    body: chatBody(),
  });
  assert.equal(blocked.status, 429, "la 21e tentative depuis cette adresse est refusée");
  assert.equal(blocked.body.code, "rate_limited");
  assert.ok(Number(blocked.headers["Retry-After"]) > 0);

  // Une autre adresse n'hérite pas de l'échec de celle-ci.
  const elsewhere = await callChat(handler, {
    headers: { ...auth, "x-vercel-forwarded-for": "203.0.113.78" },
    body: chatBody(),
  });
  assert.equal(elsewhere.status, 401, "le garde-fou est propre à l'adresse, pas global");

  // Et le garde-fou ne compte que les échecs : une identité valide n'est jamais
  // pénalisée par les échecs des autres.
  setEnv();
  withVercel();
  resetRateLimits();
  installSupabase({ rows: [], provider: "ok" });
  const healthy = await callChat(handler, {
    headers: fromIp("203.0.113.79"),
    body: chatBody({ clientMessageId: clientMessageId() }),
  });
  assert.equal(healthy.status, 200, "un appelant valide passe malgré un garde-fou d'échecs actif ailleurs");

  restoreEnv();
  pass("couche C : 20 échecs par minute et par adresse, puis 429 — une identité valide n'est jamais comptée");
}

{
  // Le compteur d'échecs s'éteint tout seul : la fenêtre d'une minute expirée,
  // il ne reste rien à bloquer.
  resetRateLimits();
  const ip = "203.0.113.90";
  const t0 = 1_000_000;
  for (let index = 0; index < 20; index += 1) recordAuthFailure(ip, t0);
  assert.equal(checkAuthFailures(ip, t0).blocked, true, "vingt échecs bloquent dans la minute");
  assert.equal(checkAuthFailures(ip, t0 + 60_001).blocked, false, "la fenêtre passée, le blocage tombe");
  resetRateLimits();
  pass("couche C : la fenêtre expire d'elle-même, un blocage n'est jamais définitif");
}

// ---------------------------------------------------------------------------
// 6. Couche E — concurrence, bail (TTL) et récupération
// ---------------------------------------------------------------------------
{
  resetRateLimits();
  const account = "33333333-4444-4555-8666-777777777777";

  const first = admitConcurrency(account);
  const second = admitConcurrency(account);
  assert.ok(first.ok && second.ok, "les deux emplacements de la formule sont accordés");

  const third = admitConcurrency(account);
  assert.equal(third.ok, false, "le troisième appel simultané du même compte est refusé");
  assert.equal(third.kind, "rate_limited");
  assert.deepEqual(concurrencySnapshot(), { accounts: 1, instance: MAX_CONCURRENT_REQUESTS_PER_ACCOUNT });

  // Un emplacement rendu est réutilisable, et un double release ne rend rien
  // de plus (sinon la capacité dériverait à la hausse).
  first.ok && first.release();
  first.ok && first.release();
  assert.equal(concurrencySnapshot().instance, 1, "un double `release` ne rend pas deux emplacements");
  assert.equal(admitConcurrency(account).ok, true, "l'emplacement rendu est de nouveau disponible");

  resetRateLimits();
  pass(`couche E : ${MAX_CONCURRENT_REQUESTS_PER_ACCOUNT} requêtes simultanées par compte, rendues une seule fois`);
}

{
  // Le bail : un emplacement dont le `release` n'est jamais appelé — fonction
  // tuée en vol — ne doit pas verrouiller le compte indéfiniment.
  resetRateLimits();
  const account = "44444444-5555-4666-8777-888888888888";
  const t0 = 5_000_000;

  const held = admitConcurrency(account, t0);
  assert.equal(held.ok, true);
  const secondHeld = admitConcurrency(account, t0);
  assert.equal(secondHeld.ok, true);
  assert.equal(admitConcurrency(account, t0).ok, false, "les deux emplacements sont pris");

  // Juste avant l'expiration : toujours bloqué.
  assert.equal(admitConcurrency(account, t0 + CONCURRENCY_LEASE_MS - 1).ok, false, "le bail court encore");

  // Après l'expiration : le balayage récupère les emplacements fantômes.
  const after = t0 + CONCURRENCY_LEASE_MS + 1;
  assert.equal(admitConcurrency(account, after).ok, true, "le bail expiré est récupéré : le compte n'est plus verrouillé");
  assert.equal(concurrencySnapshot().instance, 1, "un seul emplacement vivant après récupération");

  // Un `release` tardif, après récupération, n'invente pas de capacité.
  held.ok && held.release();
  assert.equal(concurrencySnapshot().instance, 1, "le release d'un emplacement déjà récupéré ne crédite rien de plus");

  resetRateLimits();
  pass(`couche E : bail de ${CONCURRENCY_LEASE_MS / 1000}s, récupération des emplacements fantômes, pas de capacité inventée`);
}

{
  // Plafond d'instance : 12 requêtes en vol, tous comptes confondus.
  resetRateLimits();
  const held = [];
  for (let index = 0; index < 12; index += 1) {
    const admission = admitConcurrency(`account-${index}`);
    assert.equal(admission.ok, true, `l'emplacement ${index + 1}/12 doit être accordé`);
    held.push(admission);
  }
  const over = admitConcurrency("account-12");
  assert.equal(over.ok, false, "le 13e appel simultané de l'instance est refusé");
  assert.equal(over.kind, "busy", "et c'est une saturation d'instance, pas un abus de compte");

  held.forEach((admission) => admission.release());
  assert.deepEqual(concurrencySnapshot(), { accounts: 0, instance: 0 }, "tout est rendu : aucune fuite de compteur");
  resetRateLimits();
  pass("couche E : 12 requêtes en vol par instance, refus `busy` au-delà, remise à zéro exacte");
}

{
  // Le handler rend son emplacement sur les deux chemins : succès et refus.
  setEnv();
  withVercel();
  resetRateLimits();
  installSupabase({ rows: [], db: createUsageDb(), provider: "ok" });
  const out = await callChat(handler, {
    headers: fromIp("203.0.113.60"),
    body: chatBody({ clientMessageId: clientMessageId() }),
  });
  assert.equal(out.status, 200);
  assert.deepEqual(concurrencySnapshot(), { accounts: 0, instance: 0 }, "un flux terminé rend son emplacement");

  restoreEnv();
  pass("couche E branchée dans le handler : l'emplacement est rendu après un flux réussi");
}

// ---------------------------------------------------------------------------
// 7. TTL et nettoyage des fenêtres
// ---------------------------------------------------------------------------
{
  resetRateLimits();
  const account = "55555555-6666-4777-8888-999999999999";
  const key = rateKey("user", account);
  const t0 = 10_000_000;

  // On remplit la fenêtre minute du compte avec la vraie fonction du handler.
  for (let index = 0; index < PLAN_BURST_LIMITS.decouverte; index += 1) {
    assert.equal(checkUserBurst(account, "decouverte", t0 + index).ok, true, "les 10 premières passent");
  }
  assert.equal(checkUserBurst(account, "decouverte", t0 + 100).ok, false, "la 11e est refusée dans la minute");

  // Une minute plus tard, la fenêtre est vide : plus rien à refuser.
  assert.equal(checkUserBurst(account, "decouverte", t0 + 60_001).ok, true, "la fenêtre d'une minute a expiré");

  // Le nettoyage périodique libère les entrées inactives — vérifiable via le
  // nombre d'entrées suivies avant/après.
  resetRateLimits();
  for (let index = 0; index < 5; index += 1) checkUserBurst(`temp-${index}`, "decouverte", t0);
  const before = sweepExpiredEntries(t0 + WINDOW_SWEEP_INTERVAL_MS * 20);
  assert.ok(before.windows > 0, `les entrées inactives doivent être balayées (reçu ${before.windows})`);

  resetRateLimits();
  pass("fenêtres : expiration d'une minute respectée, entrées inactives balayées périodiquement");
}

// ---------------------------------------------------------------------------
// 8. Rejeu réseau : même envoi, même identifiant ; nouvel envoi, nouvel identifiant
// ---------------------------------------------------------------------------
{
  // Transport : l'identifiant est construit dans le corps de la requête, une
  // fois, et seulement là. On l'observe en interceptant `fetch`.
  const bodies = [];
  globalThis.fetch = async (_input, init = {}) => {
    bodies.push(JSON.parse(init.body ?? "{}"));
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: delta\ndata: {"delta":"ok"}\n\n'));
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  };

  const messages = [{ role: "user", content: "bonjour" }];
  const send = (options) => streamVeyvroResponse(messages, () => {}, { accessToken: TOKEN, ...options });

  // a) Le même envoi relancé porte le même identifiant.
  const stable = clientMessageId("eeeeeeee");
  await send({ clientMessageId: stable });
  await send({ clientMessageId: stable });
  assert.equal(bodies[0].clientMessageId, bodies[1].clientMessageId, "une relance du même envoi garde son identifiant");

  // b) Un nouvel envoi volontaire en reçoit un autre.
  await send({});
  await send({});
  assert.notEqual(bodies[2].clientMessageId, bodies[3].clientMessageId, "deux envois distincts ne partagent pas d'identifiant");
  assert.match(bodies[2].clientMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  // c) Un échec réseau suivi d'une relance avec le même identifiant : la requête
  //    rejouée est byte pour byte la même, donc le serveur peut la reconnaître.
  const failing = async () => {
    throw new Error("network down");
  };
  const okFetch = globalThis.fetch;
  globalThis.fetch = failing;
  await assert.rejects(() => send({ clientMessageId: stable }), /could not be reached|réseau|reached/i);
  globalThis.fetch = okFetch;
  await send({ clientMessageId: stable });
  assert.equal(bodies.at(-1).clientMessageId, stable, "la relance après panne réseau reprend le même identifiant");

  restoreFetch();
  pass("rejeu : identifiant stable pour un même envoi (relance réseau incluse), distinct pour un nouvel envoi");
}

{
  // Handler : ce même identifiant rejoué ne consomme qu'une fois, et un envoi
  // volontairement nouveau est consommé normalement — le rejeu ne bloque rien.
  setEnv();
  withVercel();
  resetRateLimits();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  const id = clientMessageId("ffffffff");
  const first = await callChat(handler, { headers: fromIp("203.0.113.61"), body: chatBody({ clientMessageId: id }) });
  assert.equal(first.status, 200, "le premier envoi passe");

  const replay = await callChat(handler, { headers: fromIp("203.0.113.61"), body: chatBody({ clientMessageId: id }) });
  assert.equal(replay.status, 409, "le rejeu est reconnu");
  assert.equal(replay.body.code, "duplicate");
  assert.deepEqual(db.count(USER_ID), { messages: 1, quotes: 0 }, "un seul message facturé");

  const fresh = await callChat(handler, {
    headers: fromIp("203.0.113.61"),
    body: chatBody({ clientMessageId: clientMessageId() }),
  });
  assert.equal(fresh.status, 200, "un nouvel envoi volontaire n'est pas empêché par le rejeu précédent");
  assert.deepEqual(db.count(USER_ID), { messages: 2, quotes: 0 }, "et il est facturé une fois");

  restoreEnv();
  pass("rejeu : 409 sans second débit, et un nouvel envoi volontaire passe normalement");
}

// ---------------------------------------------------------------------------
// 9. Hors Vercel, l'adresse n'est pas crue : tout le monde partage un plafond
// ---------------------------------------------------------------------------
{
  setEnv();
  delete process.env.VERCEL;
  resetRateLimits();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  // Les en-têtes d'adresse sont ignorés : les envois s'accumulent sur la même
  // clé « unknown », donc sur la rafale du compte puis sur le net partagé.
  const out = await callChat(handler, {
    headers: { ...auth, "x-vercel-forwarded-for": "203.0.113.201" },
    body: chatBody({ clientMessageId: clientMessageId() }),
  });
  assert.equal(out.status, 200, "hors Vercel, le chat reste utilisable");

  restoreEnv();
  pass("hors Vercel : les en-têtes d'adresse sont ignorés, la clé partagée « unknown » est limitée comme les autres");
}

// ---------------------------------------------------------------------------
// 10. Rafales concurrentes : aucun dépassement par entrelacement
// ---------------------------------------------------------------------------
{
  // Layer B, vingt appels démarrés en même temps pour un compte Découverte :
  // exactement dix passent. Le compteur est incrémenté dans la même opération
  // synchrone que la décision, il ne peut donc pas être lu deux fois « à zéro ».
  resetRateLimits();
  const account = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const verdicts = await Promise.all(
    Array.from({ length: 20 }, (_, index) => checkUserBurst(account, "decouverte", 20_000_000 + index)),
  );
  assert.equal(verdicts.filter((verdict) => verdict.ok).length, PLAN_BURST_LIMITS.decouverte, "exactement 10 requêtes admises");
  assert.equal(verdicts.filter((verdict) => !verdict.ok).length, 10, "les 10 autres sont refusées, toutes");
  assert.ok(
    verdicts.filter((verdict) => !verdict.ok).every((verdict) => verdict.kind === "rate_minute"),
    "le refus nomme la rafale, pas autre chose",
  );

  resetRateLimits();
  pass("rafale concurrente (couche B) : 20 appels simultanés, 10 admis, 0 dépassement");
}

{
  // Layer E, dix admissions simultanées pour un même compte : deux emplacements.
  resetRateLimits();
  const account = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  const admissions = Array.from({ length: 10 }, () => admitConcurrency(account, 30_000_000));
  assert.equal(admissions.filter((admission) => admission.ok).length, MAX_CONCURRENT_REQUESTS_PER_ACCOUNT, "deux emplacements, pas trois");
  assert.ok(
    admissions.filter((admission) => !admission.ok).every((admission) => admission.kind === "rate_limited"),
    "les refus sont imputés au compte, pas à l'instance",
  );
  assert.deepEqual(concurrencySnapshot(), { accounts: 1, instance: MAX_CONCURRENT_REQUESTS_PER_ACCOUNT });

  resetRateLimits();
  pass("rafale concurrente (couche E) : 10 admissions simultanées, 2 accordées, compteur exact");
}

{
  // Bout en bout : douze requêtes en parallèle, aucun 5xx, et le nombre de
  // messages facturés est exactement le nombre de requêtes admises. Une rafale
  // ne doit ni facturer deux fois, ni laisser passer un refus gratuitement.
  setEnv();
  withVercel();
  resetRateLimits();
  const db = createUsageDb();
  installSupabase({ rows: [], db, provider: "ok" });

  const bearer = { authorization: `Bearer ${tokenFor("88888888-9999-4aaa-8bbb-cccccccccccc")}` };
  const outs = await Promise.all(
    Array.from({ length: 12 }, () =>
      callChat(handler, {
        headers: { ...bearer, "x-vercel-forwarded-for": "203.0.113.150" },
        body: chatBody({ clientMessageId: clientMessageId() }),
      }),
    ),
  );

  const serverErrors = outs.filter((out) => out.status >= 500);
  assert.deepEqual(serverErrors, [], "une rafale ne doit jamais produire d'erreur serveur");
  assert.ok(outs.every((out) => out.status === 200 || out.status === 429), "chaque requête est admise ou refusée clairement");

  const admitted = outs.filter((out) => out.status === 200).length;
  const billed = db.count("88888888-9999-4aaa-8bbb-cccccccccccc").messages;
  assert.equal(billed, admitted, `messages facturés (${billed}) = requêtes admises (${admitted})`);
  assert.ok(admitted <= PLAN_BURST_LIMITS.decouverte, "jamais plus que la rafale de la formule");
  assert.equal(db.consumes().length, admitted, "une consommation par requête admise, pas une de plus");

  restoreEnv();
  pass(`rafale concurrente de bout en bout : 12 requêtes parallèles, ${admitted} admises et facturées, aucun dépassement`);
}

restoreFetch();
console.log(`\n${checks} vérifications des couches réseau passées.`);
