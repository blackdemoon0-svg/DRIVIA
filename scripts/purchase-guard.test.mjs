/**
 * Purchase-guard tests — what the pricing buttons are allowed to do.
 *
 * The guard is a pure function of three things: the plan the button is for, what
 * the database says about the account, and whether a checkout is in flight. That
 * makes every dangerous case reproducible here, without a browser, without
 * Paddle and without a database:
 *
 *   - paying twice for the plan already in force;
 *   - paying again while the first checkout is still being created or open;
 *   - paying for something the database would refuse to record, which would
 *     leave the customer charged and the webhook with an unresolvable conflict;
 *   - reading "the checkout window opened" as "the payment is confirmed".
 *
 * The last three are the ones a UI-only guard usually gets wrong, so they are
 * tested as invariants, not as individual cases: no input combination may ever
 * produce a clickable button in a state that says "already yours".
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  BLOCKING_STATUSES,
  ENTITLED_STATUSES,
  findBlockingSubscription,
  resolveAccessPlan,
  toGrant,
} from "../src/lib/subscriptionAccess.ts";
import { decideCta, isBlocked, snapshotFromRows } from "../src/lib/purchaseGuard.ts";
import { PRICING_PLANS } from "../src/lib/paddleCore.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";

const FUTURE = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
const PAST = new Date(Date.now() - 24 * 3_600_000).toISOString();

const row = (overrides = {}) => ({
  user_id: USER_ID,
  plan: "plus",
  status: "active",
  current_period_ends_at: FUTURE,
  ...overrides,
});

const IDLE = { kind: "idle" };
const CHECKING = { kind: "checking" };
const UNKNOWN = { kind: "unknown", message: "lecture impossible" };
const FREE = { kind: "free" };
const subscribed = (plan, status) => ({ kind: "subscribed", plan, status });

const PLAN_LABEL = Object.fromEntries(PRICING_PLANS.map((plan) => [plan.id, plan.cta]));

function decide(plan, snapshot, activity = IDLE) {
  return decideCta(plan, PLAN_LABEL[plan] ?? "Choisir", snapshot, activity);
}

// ---------------------------------------------------------------------------
// 1. What the database says about the account
// ---------------------------------------------------------------------------

{
  assert.deepEqual(snapshotFromRows([], USER_ID), FREE);
  pass("aucune ligne : compte libre, un achat peut être ouvert");
}

{
  assert.deepEqual(snapshotFromRows([row()], USER_ID), subscribed("plus", "active"));
  pass("un abonnement Plus actif : la formule est lue en base, pas déduite d'un clic");
}

{
  // An upgraded customer keeps a stale `plus` row next to the `pro` one. The
  // guard must see Pro, otherwise it would offer a Pro checkout to a customer
  // who already has it — a second payment for the same product.
  const rows = [row({ plan: "plus" }), row({ plan: "pro", status: "past_due" })];
  assert.deepEqual(snapshotFromRows(rows, USER_ID), subscribed("pro", "past_due"));
  pass("lignes plus et pro : la formule la plus complète l'emporte, jamais de second achat de Pro");
}

{
  // The decisive case: `paused` grants NOTHING (toGrant is null) but it is named
  // by the partial unique index, so the database would refuse a new
  // subscription. Reasoning on the access rule here would take the money.
  const rows = [row({ status: "paused" })];
  assert.equal(toGrant(rows[0], USER_ID), null, "un abonnement en pause ne donne aucun accès");
  assert.deepEqual(snapshotFromRows(rows, USER_ID), subscribed("plus", "paused"));
  pass("abonnement en pause : aucun accès, et pourtant un nouvel achat est refusé (index partiel)");
}

{
  // Same trap, other status: an expired `past_due` grants nothing and still
  // blocks. This is the exact shape that produced an unresolvable 409 before.
  const rows = [row({ status: "past_due", current_period_ends_at: PAST })];
  assert.equal(toGrant(rows[0], USER_ID, Date.now()), null, "période terminée : aucun accès");
  assert.deepEqual(snapshotFromRows(rows, USER_ID), subscribed("plus", "past_due"));
  pass("paiement en retard et période terminée : aucun accès, achat toujours bloqué");
}

{
  // `canceled` is absent from the index predicate: the database accepts a new
  // subscription, so a customer whose access is ending must be able to renew.
  const rows = [row({ status: "canceled", current_period_ends_at: FUTURE })];
  assert.equal(resolveAccessPlan(rows, USER_ID), "plus", "l'accès court jusqu'à la fin de la période");
  assert.deepEqual(snapshotFromRows(rows, USER_ID), FREE);
  pass("résilié mais encore dans la période : l'accès reste, un renouvellement reste possible");
}

{
  assert.deepEqual(snapshotFromRows([row({ status: "canceled", current_period_ends_at: PAST })], USER_ID), FREE);
  pass("résilié et période terminée : compte libre, nouvel achat autorisé");
}

{
  assert.deepEqual(snapshotFromRows([row({ user_id: OTHER_ID })], USER_ID), FREE);
  pass("ligne d'un autre compte : ignorée, jamais utilisée pour bloquer ni pour afficher");
}

{
  assert.deepEqual(snapshotFromRows([row({ status: "suspended" })], USER_ID), FREE);
  assert.deepEqual(snapshotFromRows([row({ plan: "gold" })], USER_ID), FREE);
  pass("statut ou formule inconnus : rien n'est deviné, le compte est traité comme libre");
}

{
  assert.deepEqual(snapshotFromRows([row()], "   "), FREE);
  assert.equal(findBlockingSubscription([row()], ""), null);
  pass("identifiant de compte vide : aucune ligne ne peut être attribuée");
}

{
  // The list in `subscriptionAccess.ts` must stay identical to the predicate of
  // the partial unique index, because that predicate is what really refuses the
  // second subscription. A drift here would silently re-open the double purchase.
  const sql = readFileSync(new URL("../supabase/migrations/0001_subscriptions.sql", import.meta.url), "utf8");
  const indexBlock = sql.slice(sql.indexOf("subscriptions_paddle_customer_id_idx"));
  const predicate = indexBlock.slice(0, indexBlock.indexOf(";"));
  const statuses = [...predicate.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();

  assert.deepEqual(statuses, [...BLOCKING_STATUSES].sort());
  assert.notDeepEqual([...BLOCKING_STATUSES].sort(), [...ENTITLED_STATUSES].sort());
  pass("la liste des statuts bloquants est identique au prédicat de l'index unique partiel");
}

// ---------------------------------------------------------------------------
// 2. What each button does
// ---------------------------------------------------------------------------

{
  const decision = decide("plus", subscribed("plus", "active"));
  assert.equal(decision.disabled, true);
  assert.equal(decision.reason, "current");
  assert.equal(decision.label, "Formule actuelle");
  pass("formule déjà active : le bouton est désactivé et se nomme « Formule actuelle »");
}

{
  assert.equal(decide("plus", FREE).disabled, false);
  assert.equal(decide("plus", FREE).reason, "checkout");
  assert.equal(decide("pro", FREE).disabled, false);
  pass("compte sans abonnement : les deux formules payantes peuvent être achetées");
}

{
  const decision = decide("pro", subscribed("plus", "active"));
  assert.equal(decision.disabled, false, "passer de Plus à Pro doit rester possible");
  assert.equal(decision.reason, "upgrade");
  assert.match(decision.label, /Pro/);
  assert.match(decision.hint ?? "", /enregistré/);
  pass("Plus → Pro : le bouton reste actif et rappelle que l'enregistrement seul fait foi");
}

{
  const decision = decide("plus", subscribed("pro", "active"));
  assert.equal(decision.disabled, true);
  assert.equal(decision.reason, "included");
  assert.match(decision.label, /Pro/);
  pass("Pro → Plus : refusé, aucun second achat pour descendre de formule");
}

{
  const decision = decide("pro", subscribed("plus", "past_due"));
  assert.equal(decision.disabled, true);
  assert.equal(decision.reason, "arrears");
  pass("Plus en retard de paiement : pas de passage à Pro, qui créerait un second abonnement");
}

{
  const decision = decide("pro", subscribed("plus", "paused"));
  assert.equal(decision.disabled, true);
  assert.equal(decision.reason, "paused");
  pass("Plus en pause : pas de passage à Pro avant reprise");
}

{
  for (const plan of ["plus", "pro"]) {
    const decision = decide(plan, CHECKING);
    assert.equal(decision.disabled, true);
    assert.equal(decision.reason, "checking");
    assert.match(decision.hint ?? "", /Vérification/);
  }
  pass("formule en cours de lecture : aucun bouton n'est cliquable avant de savoir");
}

{
  for (const plan of ["plus", "pro"]) {
    const decision = decide(plan, UNKNOWN);
    assert.equal(decision.disabled, true);
    assert.equal(decision.reason, "unreadable");
    assert.match(decision.hint ?? "", /n'a pas pu être vérifiée/);
  }
  pass("formule illisible : paiement refusé, jamais « probablement aucun abonnement »");
}

// ---------------------------------------------------------------------------
// 3. One checkout at a time
// ---------------------------------------------------------------------------

{
  const creating = decide("plus", FREE, { kind: "creating", plan: "plus" });
  assert.equal(creating.disabled, true);
  assert.equal(creating.reason, "busy");
  assert.equal(creating.label, "Ouverture du paiement…");
  pass("double clic pendant la création : le bouton se verrouille et l'annonce");

  const other = decide("pro", FREE, { kind: "creating", plan: "plus" });
  assert.equal(other.disabled, true, "un second checkout ne doit pas pouvoir démarrer en parallèle");
  pass("création en cours : l'autre formule est verrouillée aussi");
}

{
  const open = decide("plus", FREE, { kind: "open", plan: "plus" });
  assert.equal(open.disabled, true);
  assert.equal(open.reason, "busy");
  pass("fenêtre Paddle ouverte : le bouton reste verrouillé jusqu'à sa fermeture");

  const otherOpen = decide("pro", FREE, { kind: "open", plan: "plus" });
  assert.equal(otherOpen.disabled, true);
  pass("fenêtre ouverte : aucune autre formule ne peut ouvrir un second checkout");
}

{
  // An upgrade is a click like any other: it must not slip through while a
  // checkout is already open.
  const decision = decide("pro", subscribed("plus", "active"), { kind: "open", plan: "plus" });
  assert.equal(decision.disabled, true);
  assert.equal(decision.reason, "busy");
  pass("passage à Pro pendant un paiement en cours : verrouillé, pas de second débit");
}

// ---------------------------------------------------------------------------
// 4. Opening a checkout is not a payment
// ---------------------------------------------------------------------------

{
  // The customer pressed Plus; a window is open; the database has still written
  // nothing. The guard must not start claiming the plan is theirs.
  const decision = decide("plus", FREE, { kind: "open", plan: "plus" });
  assert.notEqual(decision.reason, "current");
  assert.notEqual(decision.label, "Formule actuelle");
  pass("achat ouvert : la formule n'est pas déclarée acquise avant l'écriture en base");
}

{
  // Invariant, over every combination the interface can reach: "Formule
  // actuelle" is only ever shown for a plan the snapshot holds, and a click is
  // only possible for the two reasons that mean "go ahead".
  const snapshots = [
    CHECKING,
    UNKNOWN,
    FREE,
    subscribed("plus", "active"),
    subscribed("plus", "trialing"),
    subscribed("plus", "past_due"),
    subscribed("plus", "paused"),
    subscribed("plus", "canceled"),
    subscribed("pro", "active"),
    subscribed("pro", "trialing"),
    subscribed("pro", "past_due"),
    subscribed("pro", "paused"),
    subscribed("pro", "canceled"),
  ];
  const activities = [IDLE, { kind: "creating", plan: "plus" }, { kind: "open", plan: "pro" }];

  for (const plan of ["plus", "pro"]) {
    for (const snapshot of snapshots) {
      for (const activity of activities) {
        const decision = decide(plan, snapshot, activity);

        assert.equal(
          decision.disabled,
          isBlocked(decision.reason),
          `décision incohérente : ${plan} / ${snapshot.kind} / ${activity.kind}`,
        );
        assert.ok(
          decision.disabled ? decision.hint !== null : true,
          `un bouton désactivé doit dire pourquoi : ${plan} / ${snapshot.kind} / ${activity.kind}`,
        );

        if (!decision.disabled) {
          assert.ok(
            decision.reason === "checkout" || decision.reason === "upgrade",
            `seuls un achat ou un passage à Pro ouvrent un paiement (reçu : ${decision.reason})`,
          );
        }

        if (decision.label === "Formule actuelle") {
          assert.equal(snapshot.kind, "subscribed");
          assert.equal(snapshot.plan, plan);
        }

        if (snapshot.kind === "subscribed" && snapshot.plan === plan) {
          assert.equal(decision.disabled, true, `la formule déjà en place ne se rachète pas : ${plan}`);
        }
      }
    }
  }
  pass(`invariant : ${2 * snapshots.length * activities.length} combinaisons, jamais de double achat possible`);
}

// ---------------------------------------------------------------------------
// 5. The component actually obeys the guard
// ---------------------------------------------------------------------------

{
  const source = readFileSync(new URL("../src/components/PricingView.tsx", import.meta.url), "utf8");

  assert.match(source, /decideCta\(plan\.id, plan\.cta, snapshot, activity\)/, "chaque bouton payant passe par la garde");
  assert.match(source, /disabled=\{decision\.disabled\}/, "la décision doit atteindre l'attribut disabled");
  assert.match(source, /if \(checkoutLock\.current\) return;/, "verrou synchrone avant toute création de checkout");
  assert.match(source, /decideCta\(plan, catalogue\?\.cta/, "la garde est réévaluée au moment du clic");
  assert.ok(
    !/setSnapshot\(\{\s*kind:\s*"subscribed"/.test(source),
    "l'interface ne doit jamais se déclarer elle-même une formule",
  );
  assert.ok(!/pendingPlan/.test(source), "l'ancien verrou, relâché trop tôt, a disparu");
  pass("le composant : garde appliquée, bouton désactivé, verrou synchrone, aucune formule auto-déclarée");
}

{
  const source = readFileSync(new URL("../src/components/PricingView.tsx", import.meta.url), "utf8");
  const closed = source.slice(source.indexOf("onClosed:"), source.indexOf("onVerified:"));

  assert.match(closed, /checkoutLock\.current = false;/, "la fermeture libère le verrou");
  assert.match(closed, /refreshPlan\(\)/, "la fermeture relit la base au lieu de supposer un paiement");
  assert.match(closed, /aucun abonnement n'est encore enregistré/, "la fermeture ne prétend pas que le paiement a abouti");

  const opened = source.slice(source.indexOf("onOpened:"), source.indexOf("onClosed:"));
  assert.match(opened, /ne change pas/, "l'ouverture annonce explicitement qu'aucune formule ne change");
  pass("ouverture ≠ confirmation : la fermeture relit la base, l'ouverture ne promet rien");
}

console.log(`\n${checks} vérifications de la garde d'achat passées.`);
