/**
 * VEYVRO — post-build SEO / publish-readiness check.
 *
 * Run after `npm run build`:  node scripts/check-seo-build.mjs
 *
 * It asserts against the *built* output in dist/, i.e. exactly the bytes Vercel
 * publishes, not the source template. Exits non-zero on the first failure.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");

const VERIFICATION_TAG =
  '<meta name="google-site-verification" content="Q9IY-30MOLsIMVPW3h8IKngR6DfnOZYC8vP09WKBwcY" />';

// Secret shapes that must never reach a public bundle.
const SECRET_PATTERNS = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", re: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

const results = [];
let failures = 0;

function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  if (!ok) failures += 1;
}

function read(name) {
  const path = resolve(distDir, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

const html = read("index.html");
const robots = read("robots.txt");
const sitemap = read("sitemap.xml");

if (html === null) {
  console.error("FAIL: dist/index.html is missing. Run `npm run build` first.");
  process.exit(1);
}

const head = html.slice(0, html.indexOf("</head>") + 7);
const body = html.slice(html.indexOf("</head>") + 7);

/* ---------- 1. Google Search Console verification ---------- */
check("index.html contains the exact google-site-verification meta tag", html.includes(VERIFICATION_TAG));
check(
  "verification tag appears exactly once",
  html.split(VERIFICATION_TAG).length - 1 === 1,
  `occurrences: ${html.split(VERIFICATION_TAG).length - 1}`
);
check(
  "verification tag sits inside <head>",
  head.includes(VERIFICATION_TAG)
);

/* ---------- 2. Indexability directives ---------- */
const robotsMeta = head.match(/<meta\s+name="robots"\s+content="([^"]*)"/i);
check("no blocking noindex directive in the HTML", !/\bnoindex\b/i.test(html));
check(
  "robots meta allows indexing",
  robotsMeta ? /\bindex\b/i.test(robotsMeta[1]) && !/\bnoindex\b/i.test(robotsMeta[1]) : false,
  robotsMeta ? robotsMeta[1] : "meta name=robots missing"
);

const canonicals = head.match(/<link\s+rel="canonical"\s+href="([^"]*)"/gi) || [];
check("exactly one canonical link in <head>", canonicals.length === 1, `found: ${canonicals.length}`);

/* ---------- 3. Title / description / language ---------- */
const title = head.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
check("title present and <= 65 chars", title.length > 0 && title.length <= 65, `"${title}" (${title.length} chars)`);

const description = head.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]?.trim() ?? "";
check(
  "meta description present and 70-170 chars",
  description.length >= 70 && description.length <= 170,
  `${description.length} chars`
);

const lang = html.match(/<html[^>]*\slang="([^"]*)"/i)?.[1];
check("html lang attribute declared", Boolean(lang), `lang="${lang}"`);
check("html has exactly one <title>", (html.match(/<title>/gi) || []).length === 1);

/* ---------- 4. Renderable content root ---------- */
check("app mount point present", body.includes('id="root"'));

/* ---------- 5. robots.txt ---------- */
if (robots === null) {
  check("dist/robots.txt exists", false);
} else {
  check("dist/robots.txt exists", true);
  check("robots.txt has a User-agent directive", /^User-agent:/im.test(robots));
  check("robots.txt allows crawling of /", /^Allow:\s*\/\s*$/im.test(robots));
  check("robots.txt disallows /api/", /^Disallow:\s*\/api\/\s*$/im.test(robots));
  check("robots.txt contains no Disallow: / (full block)", !/^Disallow:\s*\/\s*$/im.test(robots));
  const sitemapLine = robots.match(/^Sitemap:\s*(\S+)\s*$/im);
  if (sitemapLine) {
    check("robots.txt Sitemap URL is absolute https", /^https:\/\/\S+\/sitemap\.xml$/.test(sitemapLine[1]), sitemapLine[1]);
  } else {
    console.warn("note: robots.txt has no Sitemap line (site origin was unknown at build time).");
  }
}

/* ---------- 6. sitemap.xml ---------- */
if (sitemap === null) {
  console.warn("note: dist/sitemap.xml was not generated (site origin unknown at build time).");
  console.warn("      On Vercel, VERCEL_PROJECT_PRODUCTION_URL normally provides it; or set VEYVRO_SITE_URL.");
} else {
  check("dist/sitemap.xml exists", true);
  check("sitemap declares the sitemap 0.9 namespace", sitemap.includes("http://www.sitemaps.org/schemas/sitemap/0.9"));
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check("sitemap has at least one <loc>", locs.length >= 1, `locs: ${locs.length}`);
  check("every sitemap <loc> is an absolute https URL", locs.every((l) => /^https:\/\/[^/]+\/?$/.test(l)), locs.join(", "));
  check("sitemap <url> count matches <loc> count", (sitemap.match(/<url>/g) || []).length === locs.length);
}

/* ---------- 7. No secrets in the public bundle ---------- */
for (const { name, re } of SECRET_PATTERNS) {
  check(`no ${name} leaked into dist/index.html`, !re.test(html));
}

/* ---------- 8. Brand guard (VEYVRO) ---------- */
check("title mentions VEYVRO", /veyvro/i.test(title), `"${title}"`);
const ogSiteName = head.match(/<meta\s+property="og:site_name"\s+content="([^"]*)"/i)?.[1] ?? "";
check("og:site_name is VEYVRO", ogSiteName === "VEYVRO", ogSiteName || "og:site_name missing");
const appName = head.match(/<meta\s+name="application-name"\s+content="([^"]*)"/i)?.[1] ?? "";
check("application-name is VEYVRO", appName === "VEYVRO", appName || "application-name missing");

// Deployment origins (canonical, og:image, sitemap) may legitimately still
// contain the project's historical slug, so strip absolute URLs before
// looking for leftover brand copy.
const withoutUrls = (text) => text.replace(/https?:\/\/[^\s"'<>]+/g, "");
check(
  "no leftover legacy brand (DRIVIA / VEYDRIVO) in dist/index.html",
  !/(drivia|veydrivo)/i.test(withoutUrls(html))
);
if (robots !== null) {
  check("no leftover legacy brand in robots.txt", !/(drivia|veydrivo)/i.test(withoutUrls(robots)));
}
if (sitemap !== null) {
  check("no leftover legacy brand in sitemap.xml", !/(drivia|veydrivo)/i.test(withoutUrls(sitemap)));
}

/* ---------- report ---------- */
console.log("\nVEYVRO post-build SEO check");
console.log("=".repeat(72));
for (const { label, ok, detail } of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
}
console.log("=".repeat(72));
console.log(`${results.length - failures}/${results.length} checks passed`);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll publish-readiness checks passed.");
