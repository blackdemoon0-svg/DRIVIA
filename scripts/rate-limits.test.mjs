/**
 * Anti-abuse layer tests — the invariant that protects the published plans.
 *
 * The regression these tests exist for is precise and documented: the deployed
 * handler applies 10 requests/minute and 60/hour **per IP to everyone**, so a
 * PLUS (20/min) or PRO (30/min) customer is capped at 10, and PRO's 600
 * messages/day is unreachable at 60/hour.
 *
 * Every assertion below is written so that this specific regression cannot come
 * back: the protective ceilings are derived from the plan table, and the tests
 * fail if that relationship is ever broken.
 */
import assert from "node:assert";
import { PLAN_LIMITS } from "../src/lib/planLimits.ts";
import {
  AUTH_FAILURES_PER_MINUTE,
  BUSY_RETRY_AFTER_SECONDS,
  IP_HOUR_HEADROOM,
  IP_MINUTE_HEADROOM,
  IP_REQUESTS_PER_HOUR,
  IP_REQUESTS_PER_MINUTE,
  MAX_CONCURRENT_REQUESTS_PER_ACCOUNT,
  MAX_CONCURRENT_REQUESTS_PER_INSTANCE,
  MAX_PLAN_MESSAGES_PER_DAY,
  MAX_PLAN_REQUESTS_PER_MINUTE,
  PLAN_BURST_LIMITS,
  UNKNOWN_CLIENT_KEY,
  activeInstanceRequests,
  admitConcurrency,
  assertAntiAbuseContract,
  checkAuthFailures,
  checkIpNet,
  checkUserBurst,
  clientKeyFromHeaders,
  createSlidingWindowLimiter,
  rateKey,
  recordAuthFailure,
  resetRateLimits,
} from "../server/rateLimits.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

/** Fixed clock: tests must not depend on the machine's time. */
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

// ---------------------------------------------------------------------------
// 1. The invariant itself
// ---------------------------------------------------------------------------
{
  assert.doesNotThrow(() => assertAntiAbuseContract());
  pass("invariant anti-abus respecté : aucune couche de protection ne passe sous un plan");
}

{
  assert.deepEqual(PLAN_BURST_LIMITS, { decouverte: 10, plus: 20, pro: 30 });
  assert.equal(MAX_PLAN_REQUESTS_PER_MINUTE, 30);
  assert.equal(MAX_PLAN_MESSAGES_PER_DAY, 600);
  pass("les plafonds de rafale sont lus dans la table des plans (10 / 20 / 30)");
}

// ---------------------------------------------------------------------------
// 2. The historical bug, asserted as impossible
// ---------------------------------------------------------------------------
{
  // "10 per minute for everyone" cannot come back: the IP net is derived.
  assert.equal(IP_REQUESTS_PER_MINUTE, MAX_PLAN_REQUESTS_PER_MINUTE * IP_MINUTE_HEADROOM);
  assert.equal(IP_REQUESTS_PER_MINUTE, 120);
  assert.ok(IP_REQUESTS_PER_MINUTE > PLAN_LIMITS.pro.requestsPerMinute);

  // "60 per hour for everyone" made PRO's 600 messages/day unreachable.
  assert.equal(IP_REQUESTS_PER_HOUR, 1_200);
  assert.ok(
    IP_REQUESTS_PER_HOUR >= PLAN_LIMITS.pro.messagesPerDay * IP_HOUR_HEADROOM,
    "le plafond horaire doit rester au-dessus de l'allocation quotidienne PRO",
  );
  pass("le filet IP (120/min, 1 200/h) reste strictement au-dessus des plans PLUS et PRO");
}

// ---------------------------------------------------------------------------
// 3. Layer B — the contractual burst, per account
// ---------------------------------------------------------------------------
{
  resetRateLimits();

  for (let index = 0; index < PLAN_LIMITS.decouverte.requestsPerMinute; index += 1) {
    assert.equal(checkUserBurst("user-free", "decouverte", T0).ok, true);
  }
  const refused = checkUserBurst("user-free", "decouverte", T0);
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, "rate_minute");
  assert.equal(refused.limit, 10);
  assert.ok(refused.retryAfterSeconds >= 1);
  pass("FREE : 10 requêtes/minute passent, la 11e est refusée (rate_minute, Retry-After ≥ 1)");
}

{
  resetRateLimits();

  // The regression: a PRO customer must reach 30, not be stopped at 10.
  for (let index = 0; index < 10; index += 1) {
    assert.equal(checkUserBurst("user-pro", "pro", T0).ok, true);
  }
  for (let index = 10; index < PLAN_LIMITS.pro.requestsPerMinute; index += 1) {
    assert.equal(checkUserBurst("user-pro", "pro", T0).ok, true, "PRO ne doit pas être bridé à 10/min");
  }
  assert.equal(checkUserBurst("user-pro", "pro", T0).ok, false);

  for (let index = 0; index < 20; index += 1) {
    assert.equal(checkUserBurst("user-plus", "plus", T0).ok, true);
  }
  assert.equal(checkUserBurst("user-plus", "plus", T0).ok, false);
  pass("PLUS atteint 20/min et PRO 30/min : les limites publiées sont réellement applicables");
}

{
  resetRateLimits();
  // Accounts are independent.
  checkUserBurst("user-1", "decouverte", T0);
  checkUserBurst("user-1", "decouverte", T0);
  assert.equal(checkUserBurst("user-2", "decouverte", T0).used, 0);
  pass("les compteurs de rafale sont cloisonnés par compte");
}

// ---------------------------------------------------------------------------
// 4. Layer D — the shared-IP net
// ---------------------------------------------------------------------------
{
  resetRateLimits();

  for (let index = 0; index < IP_REQUESTS_PER_MINUTE; index += 1) {
    assert.equal(checkIpNet("203.0.113.7", T0).ok, true);
  }
  const refused = checkIpNet("203.0.113.7", T0);
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, "ip_rate_limited");
  assert.equal(refused.window, "minute");
  assert.equal(refused.limit, IP_REQUESTS_PER_MINUTE);
  pass("filet IP : 120 requêtes authentifiées/minute passent, la 121e est refusée (ip_rate_limited)");
}

{
  resetRateLimits();

  // A shared address (office, mobile CGNAT) hosting three PRO customers at full
  // burst: 3 × 30 = 90 < 120, so the net must never fire.
  for (const user of ["pro-a", "pro-b", "pro-c"]) {
    for (let index = 0; index < PLAN_LIMITS.pro.requestsPerMinute; index += 1) {
      assert.equal(checkUserBurst(user, "pro", T0).ok, true);
      assert.equal(checkIpNet("198.51.100.42", T0).ok, true, "trois PRO derrière une IP ne doivent pas être bridés");
    }
  }
  pass("trois comptes PRO derrière une même IP : 90 requêtes/minute, aucune n'est bridée par le filet");
}

// ---------------------------------------------------------------------------
// 5. Layer C — failed authentications
// ---------------------------------------------------------------------------
{
  resetRateLimits();

  for (let index = 0; index < AUTH_FAILURES_PER_MINUTE; index += 1) {
    assert.equal(recordAuthFailure("192.0.2.5", T0).blocked, false);
  }
  const blocked = recordAuthFailure("192.0.2.5", T0);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.limit, AUTH_FAILURES_PER_MINUTE);
  pass("garde d'authentification : 20 échecs/minute par IP, le 21e est bloqué");
}

{
  resetRateLimits();

  // Reading the guard must never count anything — it is called on the happy path.
  for (let index = 0; index < 50; index += 1) {
    assert.equal(checkAuthFailures("192.0.2.9", T0).used, 0);
  }
  assert.equal(checkAuthFailures("192.0.2.9", T0).blocked, false);

  // And it shares nothing with the plan burst or the IP net.
  assert.equal(checkUserBurst("someone", "pro", T0).ok, true);
  assert.equal(checkIpNet("192.0.2.9", T0).ok, true);
  pass("la garde d'échecs ne compte pas les requêtes légitimes et n'interfère avec aucune autre couche");
}

// ---------------------------------------------------------------------------
// 6. Sliding window mechanics
// ---------------------------------------------------------------------------
{
  const limiter = createSlidingWindowLimiter({ windowMs: 60_000, entryTtlMs: 120_000, maxKeys: 10 });

  assert.equal(limiter.take("k", 2, T0).ok, true);
  assert.equal(limiter.take("k", 2, T0 + 1_000).ok, true);
  const refused = limiter.take("k", 2, T0 + 2_000);
  assert.equal(refused.ok, false);
  assert.equal(refused.used, 2);
  assert.equal(refused.retryAfterSeconds, 58);

  // `peek` observes without counting.
  const peeked = limiter.peek("k", 2, T0 + 3_000);
  assert.equal(peeked.ok, false);
  assert.equal(peeked.used, 2);
  assert.equal(limiter.peek("unknown", 2, T0).used, 0);

  // The window slides: once the first requests are older than a minute, the key
  // is allowed again.
  assert.equal(limiter.take("k", 2, T0 + 61_000).ok, true);
  assert.equal(limiter.take("k", 2, T0 + 61_001).ok, true);
  assert.equal(limiter.take("k", 2, T0 + 61_002).ok, false);

  limiter.reset();
  assert.equal(limiter.size(), 0);
  assert.equal(limiter.take("k", 2, T0).ok, true);
  pass("fenêtre glissante : blocage au plafond, Retry-After calculé, réouverture après la fenêtre, reset");
}

{
  const limiter = createSlidingWindowLimiter({ windowMs: 60_000, entryTtlMs: 60_000, maxKeys: 3 });
  limiter.take("a", 5, T0);
  limiter.take("b", 5, T0 + 1);
  limiter.take("c", 5, T0 + 2);
  limiter.take("d", 5, T0 + 3);
  assert.ok(limiter.size() <= 3, "la mémoire reste bornée par maxKeys");
  pass("le nombre de clés suivies reste borné (maxKeys) — pas de croissance illimitée en mémoire");
}

// ---------------------------------------------------------------------------
// 7. Layer E — concurrency, keyed on the ACCOUNT
// ---------------------------------------------------------------------------
// These identifiers are account ids (verified from the token), not addresses.
// The regression this section guards against is keying the layer on the client
// address: a whole office would then share two slots while a plan allows more.
const ACCOUNT_A = "11111111-2222-4333-8444-555555555555";
const ACCOUNT_B = "99999999-8888-4777-8666-555555555555";
const SHARED_ADDRESS = "203.0.113.7";

{
  resetRateLimits();

  const first = admitConcurrency(ACCOUNT_A);
  const second = admitConcurrency(ACCOUNT_A);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(activeInstanceRequests(), 2);

  const third = admitConcurrency(ACCOUNT_A);
  assert.equal(third.ok, false);
  assert.equal(third.kind, "rate_limited");
  assert.equal(third.retryAfterSeconds, BUSY_RETRY_AFTER_SECONDS);

  first.release();
  first.release(); // double release must be harmless
  assert.equal(activeInstanceRequests(), 1);
  assert.equal(admitConcurrency(ACCOUNT_A).ok, true);

  resetRateLimits();
  assert.equal(activeInstanceRequests(), 0);
  pass(`concurrence : ${MAX_CONCURRENT_REQUESTS_PER_ACCOUNT} par compte, release idempotent, état remis à zéro`);
}

{
  resetRateLimits();

  const admissions = [];
  for (let index = 0; index < MAX_CONCURRENT_REQUESTS_PER_INSTANCE; index += 1) {
    const admission = admitConcurrency(`account-${index}`);
    assert.equal(admission.ok, true);
    admissions.push(admission);
  }
  const overflow = admitConcurrency("account-extra");
  assert.equal(overflow.ok, false);
  assert.equal(overflow.kind, "busy");

  for (const admission of admissions) admission.release();
  assert.equal(activeInstanceRequests(), 0);
  pass(`concurrence : plafond de ${MAX_CONCURRENT_REQUESTS_PER_INSTANCE} par instance, refus « busy » au-delà`);
}

{
  // M1 — deux comptes distincts derrière la MÊME adresse : chacun conserve ses
  // 2 créneaux, et l'adresse n'en divise ni n'en multiplie aucun. Une clé
  // dérivée de l'IP ferait échouer ce bloc (4 créneaux deviendraient 2).
  resetRateLimits();

  // L'adresse est bien la même pour les deux comptes : c'est la prémisse.
  assert.equal(clientKeyFromHeaders({ "x-vercel-forwarded-for": SHARED_ADDRESS }, { VERCEL: "1" }), SHARED_ADDRESS);

  const a1 = admitConcurrency(ACCOUNT_A);
  const a2 = admitConcurrency(ACCOUNT_A);
  const b1 = admitConcurrency(ACCOUNT_B);
  const b2 = admitConcurrency(ACCOUNT_B);
  for (const admission of [a1, a2, b1, b2]) assert.equal(admission.ok, true);
  assert.equal(activeInstanceRequests(), 4, "deux comptes sur une même IP doivent obtenir 2 + 2 créneaux");

  const a3 = admitConcurrency(ACCOUNT_A);
  assert.equal(a3.ok, false, "le 3e flux du compte A est refusé même si l'instance a encore de la place");
  assert.equal(a3.kind, "rate_limited");
  assert.equal(activeInstanceRequests(), 4, "un refus ne doit jamais modifier le compteur d'instance");

  // Le plafond d'instance reste global et inchangé.
  for (const admission of [a1, a2, b1, b2]) admission.release();
  assert.equal(activeInstanceRequests(), 0);
  assert.equal(MAX_CONCURRENT_REQUESTS_PER_INSTANCE, 12);

  pass("concurrence indexée par compte : 2 + 2 créneaux pour deux comptes sur la même IP, plafond global de 12 conservé");
}

// ---------------------------------------------------------------------------
// 8. Client key extraction: who may be believed
// ---------------------------------------------------------------------------
// The regression this guards against: reading the leftmost `x-forwarded-for`
// entry — the part a client can write — with no `isIP` validation and no
// platform check. That key is fully spoofable off Vercel and, on Vercel, was
// accepted as soon as it was short enough to pass a length test.

{
  assert.equal(UNKNOWN_CLIENT_KEY, "unknown");
  const onVercel = { VERCEL: "1" };
  const key = (headers, env = onVercel) => clientKeyFromHeaders(headers, env);

  // Priority: the platform-written header wins over every other source.
  assert.equal(
    key({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-real-ip": "198.51.100.5",
      "x-forwarded-for": "192.0.2.1",
    }),
    "203.0.113.7",
  );
  assert.equal(key({ "x-real-ip": "198.51.100.5", "x-forwarded-for": "192.0.2.1" }), "198.51.100.5");
  assert.equal(key({ "x-forwarded-for": "192.0.2.1" }), "192.0.2.1");
  // A single-element array is one value, not a list.
  assert.equal(key({ "X-Vercel-Forwarded-For": ["203.0.113.7"] }), "203.0.113.7");
  // IPv4 and IPv6 are both accepted; IPv6 is canonicalised so one address owns
  // exactly one bucket whatever the case the platform emits.
  assert.equal(key({ "x-vercel-forwarded-for": "203.0.113.7" }), "203.0.113.7");
  assert.equal(key({ "x-vercel-forwarded-for": "2001:DB8::1" }), "2001:db8::1");
  assert.equal(key({ "x-vercel-forwarded-for": "2001:db8::1" }), "2001:db8::1");
  // Padding around a single address is tolerated.
  assert.equal(key({ "x-vercel-forwarded-for": "  203.0.113.7  " }), "203.0.113.7");
  pass("clé client sur Vercel : x-vercel-forwarded-for prioritaire, IPv4 et IPv6 normalisée acceptées");
}

{
  const onVercel = { VERCEL: "1" };
  const key = (headers) => clientKeyFromHeaders(headers, onVercel);

  // A list is never resolved by picking a side: the leftmost element is the one
  // a caller can write.
  assert.equal(key({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }), "unknown");
  assert.equal(key({ "x-vercel-forwarded-for": "203.0.113.7, 70.41.3.18" }), "unknown");
  // ...but an intact, lower-priority source is still used instead of guessing.
  assert.equal(
    key({ "x-vercel-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "198.51.100.5" }),
    "198.51.100.5",
  );
  // A repeated header is ambiguous.
  assert.equal(key({ "x-vercel-forwarded-for": ["1.2.3.4", "5.6.7.8"] }), "unknown");
  assert.equal(key({ "x-real-ip": ["1.2.3.4", "5.6.7.8"], "x-forwarded-for": "192.0.2.1" }), "192.0.2.1");
  // Invalid values are refused, never hashed as though they were addresses.
  assert.equal(key({ "x-vercel-forwarded-for": "203.0.113.7:443" }), "unknown");
  assert.equal(key({ "x-vercel-forwarded-for": "999.1.1.1" }), "unknown");
  assert.equal(key({ "x-vercel-forwarded-for": "not-an-ip" }), "unknown");
  assert.equal(key({ "x-vercel-forwarded-for": "fe80::1%eth0" }), "unknown");
  assert.equal(key({ "x-vercel-forwarded-for": "" }), "unknown");
  assert.equal(key({ "x-forwarded-for": "   " }), "unknown");
  assert.equal(key({ "x-forwarded-for": "x".repeat(65) }), "unknown");
  assert.equal(key({}), "unknown");
  assert.equal(clientKeyFromHeaders(undefined, onVercel), "unknown");
  pass("clé client : listes et en-têtes répétés refusés, valeurs invalides ou absentes → « unknown »");
}

{
  // Outside Vercel the headers are attacker-controlled: they are ignored
  // wholesale, whatever they contain, so every caller shares one strict bucket.
  for (const env of [{}, { VERCEL: "" }, { VERCEL: "0" }, { VERCEL: "true" }, { VERCEL: "yes" }]) {
    assert.equal(
      clientKeyFromHeaders(
        {
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-real-ip": "198.51.100.5",
          "x-forwarded-for": "192.0.2.1",
        },
        env,
      ),
      "unknown",
    );
  }
  pass("clé client hors Vercel : en-têtes ignorés, tous les appelants partagent « unknown »");
}

{
  const key = rateKey("ip", "203.0.113.7");
  assert.equal(key, rateKey("ip", "203.0.113.7"));
  assert.notEqual(key, rateKey("ip", "203.0.113.8"));
  assert.notEqual(key, rateKey("user", "203.0.113.7"));
  assert.ok(!key.includes("203.0.113.7"), "la clé ne doit pas conserver l'adresse en clair");
  assert.equal(key.length, "ip:".length + 32);
  pass("clés de compteur opaques : stables, préfixées, sans identifiant en clair");
}

console.log(`\n${checks} vérifications de limitation de débit passées.`);
