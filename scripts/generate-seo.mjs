/**
 * VEYDRIVO — SEO asset generator (runs as part of `npm run build`).
 *
 * Why this script exists
 * ----------------------
 * `robots.txt` and `sitemap.xml` must contain an *absolute* site origin, but the
 * origin differs between a local build, a Vercel Preview deployment and the
 * Vercel Production deployment. Hard-coding one of them would silently publish a
 * wrong Sitemap/og:image URL. So the origin is resolved at build time instead:
 *
 *   1. VEYDRIVO_SITE_URL                (explicit override, wins everywhere)
 *   2. VERCEL_URL on preview builds   (self-consistent preview sitemap)
 *   3. VERCEL_PROJECT_PRODUCTION_URL  (the real production domain, no protocol)
 *   4. VERCEL_URL                     (any other Vercel build)
 *
 * When no origin can be determined the script stays quiet about absolute URLs:
 * the static `public/robots.txt` fallback is left untouched and no sitemap is
 * written, so a wrong URL is never published.
 *
 * The script is deliberately non-fatal: an SEO asset problem must never break a
 * production build.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const distDir = resolve(repoRoot, "dist");

// Keep this in sync with index.html. Used as an integrity guard below.
const VERIFICATION_TAG =
  '<meta name="google-site-verification" content="Q9IY-30MOLsIMVPW3h8IKngR6DfnOZYC8vP09WKBwcY" />';

const warn = (message) => console.warn(`[generate-seo] ${message}`);
const info = (message) => console.log(`[generate-seo] ${message}`);

function resolveSiteOrigin() {
  // Canonical name first; the legacy DRIVIA_SITE_URL is still honored so
  // existing build pipelines keep working during the rename.
  const explicit = process.env.VEYDRIVO_SITE_URL?.trim() || process.env.DRIVIA_SITE_URL?.trim();
  if (explicit) {
    return { origin: normalizeOrigin(explicit), source: "VEYDRIVO_SITE_URL" };
  }

  const vercelEnv = process.env.VERCEL_ENV;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();

  if (vercelEnv === "preview" && vercelUrl) {
    return { origin: normalizeOrigin(vercelUrl), source: "VERCEL_URL (preview)" };
  }
  if (productionUrl) {
    return { origin: normalizeOrigin(productionUrl), source: "VERCEL_PROJECT_PRODUCTION_URL" };
  }
  if (vercelUrl) {
    return { origin: normalizeOrigin(vercelUrl), source: "VERCEL_URL" };
  }

  return { origin: null, source: "none" };
}

function normalizeOrigin(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    return url.origin; // strips any trailing slash / path
  } catch {
    warn(`Ignoring unparsable site origin "${value}".`);
    return null;
  }
}

function buildRobotsTxt(origin) {
  const lines = ["User-agent: *", "Allow: /", "Disallow: /api/"];
  if (origin) {
    lines.push("", `Sitemap: ${origin}/sitemap.xml`);
  }
  return `${lines.join("\n")}\n`;
}

function buildSitemapXml(origin) {
  const lastmod = new Date().toISOString().slice(0, 10);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <url>",
    `    <loc>${origin}/</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    "    <changefreq>weekly</changefreq>",
    "    <priority>1.0</priority>",
    "  </url>",
    "</urlset>",
    "",
  ].join("\n");
}

function absolutizeHtmlMetaTags(html, origin) {
  // Only these two attributes carry a document-relative image path, and social
  // crawlers do not resolve relative og:image / twitter:image URLs.
  // vite-plugin-singlefile forces a relative base, so the built HTML contains
  // "./veydrivo-hero.jpg"; the plain "/veydrivo-hero.jpg" form is matched too in
  // case the base config changes.
  return html.replace(
    /content="\.?\/veydrivo-hero\.jpg"/g,
    `content="${origin}/veydrivo-hero.jpg"`
  );
}

/**
 * Inject <link rel="canonical"> into the built HTML.
 *
 * It cannot live in index.html: Vite's HTML asset pipeline resolves any
 * `href="/..."` on a <link> against the project root, so `href="/"` throws
 * `EISDIR: illegal operation on a directory` and fails the whole build
 * (verified locally with Vite 7.3.2). Injecting after the build keeps Vite out
 * of the way while still shipping a valid, absolute canonical tag.
 */
function injectCanonical(html, origin) {
  if (/rel=["']canonical["']/i.test(html)) {
    return html; // already present, do not duplicate
  }
  const href = origin ? `${origin}/` : "/";
  const tag = `    <link rel="canonical" href="${href}" />`;
  const closeIdx = html.lastIndexOf("</head>");
  if (closeIdx === -1) {
    warn("No </head> found in dist/index.html — canonical tag not injected.");
    return html;
  }
  const before = html.slice(0, closeIdx).replace(/\s+$/, "");
  return `${before}\n${tag}\n  </head>${html.slice(closeIdx + "</head>".length)}`;
}

function main() {
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
    warn(`"${distDir}" did not exist and was created. Run "vite build" before this step for real output.`);
  }

  const { origin, source } = resolveSiteOrigin();

  // 1. robots.txt — always written with the crawler policy; the Sitemap line is
  //    added only when the origin is known.
  writeFileSync(resolve(distDir, "robots.txt"), buildRobotsTxt(origin), "utf8");
  info(`Wrote dist/robots.txt${origin ? ` (Sitemap: ${origin}/sitemap.xml)` : " (no Sitemap line: origin unknown)"}`);

  // 2. sitemap.xml — only when the origin is known, never with a guessed URL.
  if (origin) {
    writeFileSync(resolve(distDir, "sitemap.xml"), buildSitemapXml(origin), "utf8");
    info(`Wrote dist/sitemap.xml for ${origin} [origin from ${source}]`);
  } else {
    warn(`No site origin found (VEYDRIVO_SITE_URL / VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL). Skipping sitemap.xml.`);
    warn("On Vercel this is normally set automatically; set VEYDRIVO_SITE_URL to force one.");
  }

  // 3. Absolute og:image / twitter:image in the built single-file HTML.
  const indexPath = resolve(distDir, "index.html");
  if (!existsSync(indexPath)) {
    warn("dist/index.html not found — skipping HTML meta absolutization.");
    return;
  }

  const before = readFileSync(indexPath, "utf8");

  // Integrity guard: the Search Console tag must survive untouched.
  if (!before.includes(VERIFICATION_TAG)) {
    warn("WARNING: dist/index.html does not contain the exact google-site-verification meta tag.");
    warn("         Search Console verification will fail. Check index.html at the repository root.");
    return;
  }

  if (!origin) {
    info("Origin unknown: og:image stays relative and canonical is injected as a relative URL.");
  }

  let after = injectCanonical(before, origin);
  if (origin) {
    after = absolutizeHtmlMetaTags(after, origin);
    info(`Absolutized og:image / twitter:image to ${origin}/veydrivo-hero.jpg`);
  }

  if (after === before) {
    info("dist/index.html unchanged; google-site-verification meta tag verified present.");
    return;
  }

  if (!after.includes(VERIFICATION_TAG)) {
    warn("Aborting HTML rewrite: it would have altered the google-site-verification tag. dist/index.html left as built.");
    return;
  }

  writeFileSync(indexPath, after, "utf8");
  info("Rewrote dist/index.html; google-site-verification meta tag verified present.");
}

try {
  main();
} catch (error) {
  // Never fail the production build because of an SEO asset.
  warn(`Skipped SEO generation: ${error instanceof Error ? error.message : String(error)}`);
}
