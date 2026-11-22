/**
 * Ask the real provider which models your key can actually use.
 *
 *   npm run ai:models
 *
 * Reading the documentation tells us which ids exist; only `GET /v1/models`
 * with this deployment's key tells us which ones *this account* may call. That
 * second answer is the one the router depends on, so this script compares the
 * two and reports the difference.
 *
 * It makes one HTTP request and costs nothing (listing models is free). The key
 * is read from VEYVRO_AI_API_KEY (or the legacy names) and is never printed.
 *
 * Exit code 0 when every catalog model is reachable, 1 otherwise — so it can be
 * used as a pre-flight check in a deployment pipeline.
 */
import { OPENAI_CATALOG, LEGACY_CATALOG } from "../server/ai/modelCatalog.ts";

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

const apiKey = readEnv("VEYVRO_AI_API_KEY", "VEYDRIVO_AI_API_KEY", "DRIVIA_AI_API_KEY");
if (!apiKey) {
  console.error(
    "VEYVRO_AI_API_KEY (ou VEYDRIVO_AI_API_KEY / DRIVIA_AI_API_KEY) est requis pour interroger le fournisseur.",
  );
  process.exit(2);
}

const baseUrl = (
  readEnv("VEYVRO_AI_BASE_URL", "VEYDRIVO_AI_BASE_URL", "DRIVIA_AI_BASE_URL") ??
  "https://api.openai.com/v1"
).replace(/\/+$/, "");

console.log(`Fournisseur : ${baseUrl}`);
console.log("Modèles du catalogue (vérifiés dans la documentation le 2026-11-22) :\n");

let list;
try {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    console.error(
      `Échec de la lecture des modèles : HTTP ${response.status}. Vérifiez la clé et la facturation du compte.`,
    );
    process.exit(2);
  }
  list = await response.json();
} catch (error) {
  console.error(`Fournisseur injoignable : ${error.message}`);
  process.exit(2);
}

const available = new Set(
  Array.isArray(list?.data) ? list.data.map((entry) => String(entry?.id ?? "")).filter(Boolean) : [],
);
if (available.size === 0) {
  console.error("La réponse ne contient aucun modèle : la clé n'a probablement pas accès à l'API.");
  process.exit(2);
}

const rows = [];
let missing = 0;

for (const [role, entry] of Object.entries(OPENAI_CATALOG)) {
  const ok = available.has(entry.id);
  if (!ok) missing += 1;
  rows.push({
    rôle: role,
    modèle: entry.id,
    disponible: ok ? "oui" : "NON",
    "$/M entrée": entry.inputCostPerMTok,
    "$/M sortie": entry.outputCostPerMTok,
  });
}

console.table(rows);

const legacyRows = Object.keys(LEGACY_CATALOG).map((id) => ({
  "modèle hérité": id,
  disponible: available.has(id) ? "oui" : "non",
  "utilisé par le routeur": "non (uniquement si VEYVRO_AI_MODEL le fixe)",
}));
console.table(legacyRows);

const pinned = readEnv("VEYVRO_AI_MODEL", "VEYDRIVO_AI_MODEL", "DRIVIA_AI_MODEL");
if (pinned) {
  console.log(
    `VEYVRO_AI_MODEL=${pinned} est défini : ce modèle est prioritaire et le routage automatique est désactivé pour le choix du modèle.`,
  );
  if (!available.has(pinned)) {
    console.warn(`ATTENTION : ${pinned} n'apparaît pas dans /v1/models pour cette clé.`);
    missing += 1;
  }
}

if (missing > 0) {
  console.error(
    `\n${missing} modèle(s) du catalogue ne sont pas disponibles pour cette clé. Le routeur les contournera automatiquement (repli), mais la qualité prévue ne sera pas atteinte : demandez l'accès à ces modèles sur platform.openai.com.`,
  );
  process.exit(1);
}

console.log("\nTous les modèles du catalogue sont accessibles pour cette clé.");
