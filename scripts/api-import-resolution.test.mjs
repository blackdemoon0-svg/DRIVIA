/**
 * Resolution guard for the Vercel Node runtime.
 *
 * The Preview once answered `500 A server error has occurred` on
 * `/api/paddle-webhook`, and the runtime log named the cause:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/src/lib/paddleCore'
 *   imported from /var/task/src/lib/paddlePrices.js
 *
 * The defect was one missing extension: `paddlePrices.ts` imported
 * `"./paddleCore"`. TypeScript accepts it (`moduleResolution: "bundler"`), the
 * Vite build accepts it, and a bundler-based local check accepts it too — only
 * the deployed runtime does not. Vercel compiles the function **file by file**
 * and keeps the specifiers as written; Node ESM then requires an explicit
 * extension, with no probing at all. `"./paddleCore"` names no file.
 *
 * This test reproduces those conditions instead of trusting a bundler:
 *
 *   1. take every `api/*.ts` entry point and follow its relative imports down to
 *      the last module (the runtime closure);
 *   2. transpile each file **individually** with TypeScript — exactly what the
 *      platform does — so type-only imports disappear and specifiers stay as
 *      written;
 *   3. resolve every relative specifier of the emitted JavaScript against the
 *      emitted tree, with Node ESM semantics: the path must exist, verbatim.
 *
 * It reads no network, no database and no environment variable.
 */
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import os from "node:os";
import ts from "typescript";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");

// ---------------------------------------------------------------------------
// 1. The runtime closure of every API entry point
// ---------------------------------------------------------------------------
/**
 * Find the source file a specifier points at, the way the toolchain does
 * (`./x.js` names `x.ts` to TypeScript, `./x` names `x.ts` to the bundler).
 *
 * This helper is only used to *walk* the sources. Nothing is ever checked with
 * it: existence is verified on the emitted tree, where no such tolerance exists.
 */
function resolveSource(spec, fromFile) {
  const base = resolvePath(dirname(join(root, fromFile)), spec);
  const candidates = [];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base);
  candidates.push(base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Static and dynamic relative specifiers of a source file, in order. */
function relativeSpecifiers(source) {
  const found = [
    ...source.matchAll(/\bfrom\s*"((?:\.{1,2}\/)[^"]+)"/g),
    ...source.matchAll(/\bimport\s*\(\s*"((?:\.{1,2}\/)[^"]+)"\s*\)/g),
  ].map((match) => match[1]);
  return [...new Set(found)];
}

const entryPoints = readdirSync(join(root, "api"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join("api", name))
  .sort();

assert.ok(entryPoints.length > 0, "au moins un point d'entrée api/*.ts attendu");
assert.ok(
  entryPoints.includes(join("api", "paddle-webhook.ts")),
  "api/paddle-webhook.ts doit rester un point d'entrée du runtime",
);

const closure = new Set();
const pending = [...entryPoints];
while (pending.length > 0) {
  const file = pending.pop();
  if (closure.has(file)) continue;
  closure.add(file);
  const source = read(file);
  for (const spec of relativeSpecifiers(source)) {
    const target = resolveSource(spec, file);
    assert.ok(target, `${file} importe "${spec}" qui n'existe pas dans les sources`);
    const relativeTarget = target.slice(root.length + 1);
    if (!closure.has(relativeTarget)) pending.push(relativeTarget);
  }
}

pass(`chaîne runtime : ${closure.size} modules atteints depuis ${entryPoints.length} points d'entrée`);

// ---------------------------------------------------------------------------
// 2. Transpile file by file — what the platform actually deploys
// ---------------------------------------------------------------------------
/**
 * Type-only imports are erased here, not by us: that is the observable
 * difference between `import type { X } from "./x"` (harmless, gone) and
 * `from "./x"` in a value position (kept, and then unresolvable).
 */
const mirror = join(os.tmpdir(), `veyvro-imports-${process.pid}-${Date.now()}`);
const emitted = new Map();

try {
  for (const file of closure) {
    const source = readFileSync(join(root, file), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
      },
    });
    const outFile = `__mirror__/${file.replace(/\.tsx?$/, ".js")}`;
    const absolute = join(mirror, outFile.slice("__mirror__/".length));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, outputText, "utf8");
    emitted.set(file, { outFile, outputText, absolute });
  }

  pass(`transpilation fichier par fichier : ${emitted.size} modules émis en .js, sans bundler`);

  // -------------------------------------------------------------------------
  // 3. Node ESM resolution on the emitted tree: the exact path must exist
  // -------------------------------------------------------------------------
  const unresolved = [];
  const extensionless = [];

  for (const [file, { outFile, outputText, absolute }] of emitted) {
    for (const spec of relativeSpecifiers(outputText)) {
      const target = resolvePath(dirname(absolute), spec);
      if (!existsSync(target)) unresolved.push({ file: outFile, spec });
      if (!/\.[cm]?[jt]s$/.test(spec)) extensionless.push({ file: outFile, spec });
    }
  }

  assert.deepEqual(
    unresolved,
    [],
    `specifier(s) que Node ESM ne peut pas résoudre dans le déploiement (extension manquante) :\n` +
      unresolved.map((item) => `   ${item.file} → "${item.spec}"`).join("\n"),
  );
  assert.deepEqual(
    extensionless,
    [],
    `specifier(s) relatifs sans extension (interdits sous Node ESM) :\n` +
      extensionless.map((item) => `   ${item.file} → "${item.spec}"`).join("\n"),
  );

  pass("aucun specifier relatif sans extension dans le JavaScript émis : Node ESM peut tout résoudre");

  // -------------------------------------------------------------------------
  // 4. The two specific imports that broke, pinned by name
  // -------------------------------------------------------------------------
  const prices = emitted.get(join("src", "lib", "paddlePrices.ts"));
  assert.ok(prices, "src/lib/paddlePrices.ts doit faire partie de la chaîne runtime");
  assert.match(
    prices.outputText,
    /from\s*"\.\/paddleCore\.js"/,
    "paddlePrices.js doit importer « ./paddleCore.js » : c'est l'import exact qui a produit ERR_MODULE_NOT_FOUND",
  );

  const planChange = emitted.get(join("src", "lib", "planChange.ts"));
  assert.ok(planChange, "src/lib/planChange.ts doit faire partie de la chaîne runtime");
  assert.match(
    planChange.outputText,
    /from\s*"\.\/subscriptionAccess\.js"/,
    "planChange.js doit importer « ./subscriptionAccess.js » : même défaut, une ligne plus loin",
  );

  // Et la contre-épreuve : l'import `import type` de planChange.ts disparaît à
  // la compilation — il n'a jamais eu besoin d'extension, et le corriger
  // n'aurait changé aucun octet du runtime.
  assert.ok(
    !/from\s*"\.\/paddleCore"/.test(planChange.outputText),
    "l'import de type `./paddleCore` de planChange.ts doit être effacé à la compilation",
  );

  pass("les deux imports fautifs sont figés par leur nom, et l'import de type effacé est distingué");

  // -------------------------------------------------------------------------
  // 5. The webhook's own imports, the ones the sandbox depends on
  // -------------------------------------------------------------------------
  const webhook = emitted.get(join("api", "paddle-webhook.ts"));
  assert.ok(webhook, "api/paddle-webhook.ts doit être présent dans la chaîne");
  for (const spec of relativeSpecifiers(webhook.outputText)) {
    assert.match(spec, /\.js$/, `api/paddle-webhook.js → "${spec}" doit porter son extension`);
    assert.ok(
      existsSync(resolvePath(dirname(webhook.absolute), spec)),
      `api/paddle-webhook.js → "${spec}" doit exister dans l'arbre déployé`,
    );
  }

  pass("api/paddle-webhook.js : tous ses imports relatifs existent dans l'arbre déployé");
} finally {
  rmSync(mirror, { recursive: true, force: true });
}

console.log(`\n${checks} vérifications de résolution d'imports passées.`);
