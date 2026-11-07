/**
 * The net guards itself.
 *
 * P5 found two silent holes: six test suites existed but were not part of
 * `npm test`, and three server modules were never typechecked because
 * `tsconfig.json` did not include `server/`. Both looked fine — they simply were
 * not running. A file that is not executed is worse than a missing file: it
 * looks like coverage.
 *
 * This test asserts the wiring itself, so it cannot be lost again without a
 * red build:
 *
 *   1. `tsconfig.json` includes `server` (the three RPC modules are typechecked);
 *   2. every `scripts/*.test.mjs` is referenced by at least one `test:*` script;
 *   3. `npm test` chains every `test:*` script — no suite runs only on request;
 *   5. every error code the chat route can send is known to the client.
 *
 * It reads no network, no database and no environment variable.
 */
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");

// ---------------------------------------------------------------------------
// 1. TypeScript must see server/
// ---------------------------------------------------------------------------
{
  const tsconfig = read("tsconfig.json");
  const include = tsconfig.match(/"include"\s*:\s*\[([^\]]*)\]/);
  assert.ok(include, "tsconfig.json doit déclarer un tableau « include »");

  const entries = include[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  assert.ok(
    entries.includes("server"),
    `« server » doit être dans include (trouvé : ${entries.join(", ")}) — sans lui, usageStore.ts, rateLimits.ts et consumptionId.ts ne sont jamais typés`,
  );
  assert.ok(entries.includes("api/**/*.ts"), "les routes doivent rester typées");
  assert.ok(entries.includes("src"), "le front doit rester typé");

  pass("tsconfig.json inclut « server » : les trois modules RPC sont vérifiés par tsc, pas seulement exécutés");
}

// ---------------------------------------------------------------------------
// 2. No test suite may live outside the scripts
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read("package.json"));
const scripts = pkg.scripts ?? {};
const testScripts = Object.entries(scripts).filter(([name]) => name.startsWith("test:"));

{
  assert.ok(testScripts.length >= 19, `au moins 19 scripts test:* attendus (trouvé ${testScripts.length})`);

  const suites = readdirSync(join(root, "scripts"))
    .filter((file) => file.endsWith(".test.mjs"))
    .sort();

  assert.ok(suites.length >= 19, `au moins 19 suites attendues (trouvé ${suites.length})`);

  const orphans = suites.filter(
    (file) => !testScripts.some(([, command]) => command.includes(file)),
  );

  assert.deepEqual(
    orphans,
    [],
    `suite(s) sans script test:* — elles ne tourneraient jamais : ${orphans.join(", ")}`,
  );

  pass(`les ${suites.length} suites de scripts/ sont toutes reliées à un script test:*`);
}

// ---------------------------------------------------------------------------
// 3. `npm test` must chain every test:* script
// ---------------------------------------------------------------------------
{
  const chain = scripts.test ?? "";
  assert.ok(chain.length > 0, "package.json doit définir un script « test »");

  const missing = testScripts
    .map(([name]) => name)
    .filter((name) => !chain.includes(`npm run ${name}`));

  assert.deepEqual(missing, [], `script(s) test:* absents de « npm test » : ${missing.join(", ")}`);

  // Et réciproquement : la chaîne ne doit pas invoquer un script inexistant.
  const invoked = [...chain.matchAll(/npm run (test:[\w-]+)/g)].map((match) => match[1]);
  const unknown = invoked.filter((name) => !(name in scripts));
  assert.deepEqual(unknown, [], `script(s) invoqué(s) mais inexistant(s) : ${unknown.join(", ")}`);

  assert.equal(new Set(invoked).size, invoked.length, "un script ne doit être chaîné qu'une fois");

  pass(`npm test enchaîne les ${invoked.length} scripts test:* — aucun n'est laissé de côté, aucun n'est fantôme`);
}

// ---------------------------------------------------------------------------
// 4. The two invariants that made P5 possible to miss
// ---------------------------------------------------------------------------
{
  // Un module de production ne doit pas vivre uniquement dans les tests : la
  // question « qui importe usageStore.ts ? » restera posée en P6/S3, mais elle
  // doit rester visible dans la CI plutôt que dans un rapport.
  const chat = read("api/chat.ts");
  const store = read("server/usageStore.ts");

  assert.ok(
    store.includes("export async function consumeDurableUsage"),
    "le store doit exposer consumeDurableUsage",
  );
  assert.ok(
    store.includes("usageFailureStatus"),
    "le mapping HTTP doit rester centralisé dans le store",
  );

  // S3 est fait : le chat doit consommer et rembourser via le store durable.
  // Si quelqu'un débranche le store, ce test tombe — le retour à un compteur
  // d'instance ne peut pas se produire en silence.
  assert.ok(chat.includes('from "../server/usageStore.js"'), "api/chat.ts doit importer le store durable (S3)");
  assert.ok(chat.includes("consumeDurableUsage"), "le chat doit consommer via le store durable");
  assert.ok(chat.includes("refundDurableUsage"), "le chat doit rembourser via le store durable");
  assert.ok(chat.includes("resolveConsumptionId"), "le chat doit résoudre un identifiant de consommation par requête");

  // S4 est fait : les quatre couches réseau sont branchées dans le handler, et
  // dans cet ordre (C avant l'authentification, B avant D et E).
  assert.ok(chat.includes('from "../server/rateLimits.js"'), "api/chat.ts doit appliquer la couche réseau (S4)");
  assert.ok(chat.includes("checkUserBurst"), "la rafale contractuelle par formule doit être appliquée");
  assert.ok(chat.includes("checkIpNet"), "le net d'adresse doit être appliqué");
  assert.ok(chat.includes("admitConcurrency"), "la concurrence par compte doit être appliquée");
  assert.ok(chat.includes("checkAuthFailures"), "le garde-fou d'échecs d'authentification doit être lu avant l'identité");
  assert.ok(chat.includes("admission.release()"), "l'emplacement de concurrence doit être rendu, y compris en cas d'erreur");

  // L'ancien compteur en mémoire ne doit jamais revenir, même « en secours » :
  // un repli mémoire est une remise à zéro gratuite à chaque cold start.
  assert.ok(!chat.includes("consumeQuota"), "l'ancien compteur mémoire ne doit jamais servir de repli");
  assert.ok(!chat.includes("server/quotas.js"), "api/chat.ts ne doit plus importer l'ancien module de quotas mémoire");

  // Et le module lui-même a été retiré (P8/S4) : un module de production que
  // plus personne n'importe, mais que ses tests continuent de valider, donne une
  // fausse impression de couverture. Les helpers de jour UTC qu'il contenait
  // vivent maintenant dans `server/utcDay.ts`.
  const serverFiles = readdirSync(join(root, "server"));
  assert.ok(
    !serverFiles.includes("quotas.ts"),
    "server/quotas.ts doit rester supprimé : ses règles vivent dans le RPC durable et la couche B",
  );
  const usageStore = read("server/usageStore.ts");
  assert.ok(
    usageStore.includes('from "./utcDay.js"'),
    "les helpers de jour UTC doivent venir de server/utcDay.ts",
  );

  // Le plafond indifférencié de 10/minute par adresse, appliqué avant que le
  // plan ne soit connu, est le bug que S4 supprime : il ne doit pas revenir sous
  // une autre forme dans le handler.
  assert.ok(
    !/maxRequests:\s*10\b/.test(chat),
    "un plafond fixe de 10 requêtes dans le handler remettrait PLUS et PRO sous la limite de Découverte",
  );

  pass("frontières verrouillées : quotas durables (S3) + couches réseau (S4) branchés, ancien module mémoire supprimé");
}

// ---------------------------------------------------------------------------
// 5. Client contract: no error code may reach the screen unexplained
// ---------------------------------------------------------------------------
// P8/S4 added four codes to the chat route; before this guard, a code the client
// did not know fell through to "AI provider server error" — a wrong, unactionable
// message for a customer who simply hit a quota or a replayed message. Codes are
// a contract, so they are checked like one.
{
  const chat = read("api/chat.ts");
  const app = read("src/App.tsx");
  const known = new Set([...app.matchAll(/code === "([a-z_]+)"/g)].map((match) => match[1]));

  // Codes the client decides not to branch on, each with the reason it does not
  // need to: `provider_error` arrives both as a JSON body and as an SSE error
  // frame, and `formatChatError` ends with the provider-error wording.
  const HANDLED_BY_FALLBACK = new Set(["provider_error"]);

  const emitted = new Set([...chat.matchAll(/code: "([a-z_]+)"/g)].map((match) => match[1]));
  const unexplained = [...emitted].filter((code) => !known.has(code) && !HANDLED_BY_FALLBACK.has(code));
  assert.deepEqual(
    unexplained,
    [],
    `code(s) d'erreur servis au client sans message: ${unexplained.join(", ")} — ajouter un cas dans formatChatError`,
  );

  // The dynamic families: the quota store and the guard rails send a `code`
  // taken from a union, never from a literal, so they must be named here too.
  const dynamic = [
    "daily_messages",
    "daily_quotes",
    "duplicate",
    "conflict",
    "invalid_identifier",
    "unavailable",
    "rate_minute",
    "rate_limited",
    "busy",
    "auth_required",
    "invalid_token",
    "identity_unavailable",
  ];
  const missing = dynamic.filter((code) => !known.has(code));
  assert.deepEqual(missing, [], `code(s) dynamique(s) inconnu(s) du client: ${missing.join(", ")}`);

  pass(`contrat d'erreurs : les ${emitted.size} codes littéraux du chat et les ${dynamic.length} codes dynamiques ont un message côté client`);
}

console.log(`\n${checks} vérifications du filet de tests passées.`);
