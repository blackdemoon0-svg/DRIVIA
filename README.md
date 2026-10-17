# VEYDRIVO

VEYDRIVO is an independent, responsive automotive AI experience built with React, Vite and Tailwind CSS. It is a dedicated automotive intelligence — brands, models, engines, performance, reliability, running costs, maintenance, electric cars, news and comparisons — with one simple conversation flow and a compact side-by-side car comparison.

## Rebrand note (DRIVIA → VEYDRIVO)

The product was renamed from DRIVIA to VEYDRIVO. Everything (routes, the `/api/chat` endpoint, behavior and features) is unchanged; only the brand identity, UI copy, SEO metadata, logo mark and internal symbol names moved. For a zero-downtime migration:

- Server environment variables are now named `VEYDRIVO_AI_*`. The handler still reads the legacy `DRIVIA_AI_*` names as a fallback, so an already-configured Vercel project keeps working until you rename the variables.
- `VEYDRIVO_SITE_URL` replaces `DRIVIA_SITE_URL` as the SEO origin override (legacy name still honored).
- Old asset URLs `/drivia-hero.jpg` and `/drivia-mark.svg` are rewritten to their `veydrivo-*` counterparts in `vercel.json`, so previously shared og:image links keep resolving.

## AI connection

This is a generative chat, not a response library: every user turn sends the recent conversation to `POST /api/chat`, which asks the configured language model to generate a fresh response. OpenAI's streamed chat completions are forwarded as Server-Sent Events, so text appears progressively in the chat. No automotive replies are hardcoded in the frontend. `server/veydrivoSystemPrompt.ts` defines VEYDRIVO's enthusiast personality, automotive knowledge, multilingual behavior, conversation memory, and honesty/safety rules.

`api/chat.ts` is the single Vercel serverless handler; support files such as VEYDRIVO's system prompt live outside the `api/` route directory so Vercel does not mistake them for extra endpoints. `vercel.json` explicitly builds the Vite frontend to `dist` and configures `/api/chat` as a 60-second function. The handler keeps the model key server-side and supports OpenAI, Google's Gemini OpenAI-compatible endpoint, or another OpenAI-compatible API. Set these environment variables in the **server/deployment settings**, not in a public `VITE_` variable:

- `VEYDRIVO_AI_PROVIDER` (optional: `openai`, `gemini`, or `openai-compatible`; defaults to `openai`)
- `VEYDRIVO_AI_API_KEY` (required, server-side only)
- `VEYDRIVO_AI_BASE_URL` (optional; defaults to the selected provider's compatible endpoint)
- `VEYDRIVO_AI_MODEL` (optional; defaults to `gpt-4.1-mini` for OpenAI or `gemini-3.8-flash` for Gemini)

For another provider, choose `VEYDRIVO_AI_PROVIDER=openai-compatible` and set its base URL, API key, and model. The Gemini option uses `https://generativelanguage.googleapis.com/v1beta/openai` and accepts an override for the model or URL. The browser always calls the same-origin `/api/chat` endpoint; the provider is only contacted by the server.

For local development, copy `.env.example` to `.env.local`, set `VEYDRIVO_AI_API_KEY` there, and run the API route through `vercel dev`. `.env.local` is ignored by Git. For a deployed Vercel project, add the key in the project's server environment variable settings and redeploy. Never put the real key in React code, a `VITE_` variable, HTML, or a committed file.

Provider references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).

## Deployment requirements

This repository is a Vite frontend plus a Vercel Node.js serverless function. Deploy it to **Vercel** with the Vercel project Root Directory set to the repository root (the folder containing `vercel.json`, `api/`, and `package.json`). The committed `vercel.json` selects the Vite framework, runs `npm run build`, publishes the Vite `dist` assets, and explicitly matches `api/chat.ts` as a 60-second serverless function. Vercel discovers the route from the root-level `api/chat.ts` and serves it at `/api/chat`. The `dist` setting is the frontend asset output; this config does not define a legacy static-only `builds` pipeline that would discard serverless functions.

**The Arena preview is static and cannot execute the serverless API. The repository must be deployed to Vercel.** The root-level function folder and environment variables are evaluated by the hosting platform, not by Vite's static `dist` preview. The Arena build preview can render the frontend, but it cannot run `api/chat.ts`. If the chosen host is static-only, use Vercel or provide a Node.js serverless backend and same-origin `/api/chat` route/proxy. In a Vercel project, also set the Root Directory to the project root; a Vercel app pointed at another subdirectory will not see this `api/` folder or `vercel.json`.

For an initial test, add `VEYDRIVO_AI_API_KEY` under Vercel Project Settings > Environment Variables with the **Preview** environment selected, then create a Preview deployment. Leave `VEYDRIVO_AI_PROVIDER` unset or set it to `openai`. Do not configure or deploy Production until explicitly approved. No real key is stored in this repository. For local end-to-end use, copy `.env.example` to `.env.local`, add the key, then run Vercel's development server with `vercel dev` (not plain `npm run dev`). Without a configured route/key, VEYDRIVO reports the service error instead of returning mock answers.

After creating a Vercel Preview deployment, verify that its route is actually present without invoking the model or exposing a key:

```sh
VEYDRIVO_DEPLOYMENT_URL=https://your-preview.vercel.app node scripts/verify-vercel-api.mjs
```

The check expects `/api/chat` to return its method-specific `405` JSON response to a GET request. A static page/HTML fallback or a missing function will fail this check. This repository cannot set Vercel dashboard settings, create the remote Vercel project, add secrets, or confirm a remote deployment by itself.

## SEO and Google Search Console

VEYDRIVO is a single-page app with one crawlable URL, so the crawl surface is small: the HTML
document, `robots.txt` and `sitemap.xml`.

`index.html` (repository root, the Vite entry document) carries, in this order:

- `<meta name="google-site-verification" …>` — the Search Console HTML-tag method. It is
  committed to Git and survives `vite build` byte for byte; it must stay the **first**
  verification-related tag in `<head>` and must not be injected from React.
- `<meta name="robots" content="index, follow, …">` — explicitly allows indexing.
- `<meta name="description">`, Open Graph and Twitter Card tags.
- `<html lang="fr">`, matching the French UI copy.

**Never add `<link rel="canonical" href="/">` to `index.html`.** Vite's HTML asset pipeline
resolves a `href="/…"` on a `<link>` against the project root, so `href="/"` aborts the build
with `EISDIR: illegal operation on a directory`. The canonical tag is injected into
`dist/index.html` after the build by `scripts/generate-seo.mjs` instead.

### Generated crawl assets

`npm run build` runs `vite build` and then `scripts/generate-seo.mjs`, which writes into
`dist/`:

- `robots.txt` — `Allow: /`, `Disallow: /api/`, plus a `Sitemap:` line when the origin is known.
- `sitemap.xml` — one entry for the homepage, with an absolute `<loc>`.
- absolute `og:image` / `twitter:image` URLs and the `<link rel="canonical">` tag.

The site origin is resolved at build time so no domain is ever hard-coded or guessed:

1. `VEYDRIVO_SITE_URL` (explicit override, wins everywhere)
2. `VERCEL_URL` on preview builds
3. `VERCEL_PROJECT_PRODUCTION_URL` (Vercel's production domain)
4. `VERCEL_URL`

When no origin is available (a plain local build) the script writes the relative canonical,
leaves `og:image` relative, skips `sitemap.xml` and omits the `Sitemap:` line, so a wrong URL
is never published. Nothing in this step can fail the build.

### Verifying a deployment

```sh
npm run verify          # typecheck + build + publish-readiness assertions (incl. rebrand guard)
npm run check:seo       # assertions only, against an existing dist/
```

`scripts/check-seo-build.mjs` reads `dist/` — the exact bytes Vercel publishes — and asserts
the verification tag is present once inside `<head>`, there is no `noindex`, there is exactly
one canonical, `robots.txt` and `sitemap.xml` are well formed, and no API-key-shaped string
leaked into the bundle.

Against a live deployment (substitute the project's production domain):

```sh
curl -s https://<production-domain>/ | grep -o '<meta name="google-site-verification"[^>]*>'
curl -sI https://<production-domain>/robots.txt
curl -s  https://<production-domain>/sitemap.xml
```

Vercel deployment URLs of the form `<project>-<hash>-<scope>.vercel.app` are **immutable**:
they keep serving the build they were created from forever. Always check the production
alias, not an old deployment URL, before concluding a change is missing.

## Vercel Web Analytics

The app mounts Vercel's official `@vercel/analytics` React component from `src/main.tsx`. Once Web Analytics is enabled for the Vercel project and this code is deployed, Vercel can collect site visits and page views and show traffic breakdowns in the project dashboard. No API key, frontend secret, or extra environment variable is needed. The integration does not change the AI chat or VEYDRIVO Battle UI/behavior.

To activate and verify it for Production:

1. In the Vercel dashboard, open the VEYDRIVO project, select **Analytics**, and click **Enable** for Web Analytics.
2. After the code is approved for release, deploy it to Production using the project's usual deployment flow. Vercel provisions the Analytics routes on a subsequent deployment; this repository change alone does not affect the already-live deployment.
3. Open the Production site and use browser DevTools → **Network**. Filter for `insights` or `view`; the Analytics script should load and a page-view request should complete successfully. Ad blockers may block these requests.
4. In the project's **Analytics** dashboard, review visitors, page views, referrers, and available browser/device/location breakdowns. Allow for real visitor traffic to arrive before expecting useful reports.

VEYDRIVO currently uses one URL for its AI and Battle views, so basic page-view reporting treats the app as one page; switching between those in-app views does not create a separate URL page view.

## Live AI smoke test

With the API route running and a real server-side provider key configured, run:

```sh
node scripts/ai-smoke-test.mjs
```

The script streams answers from the live model for all eight automotive questions, checks for non-empty, topic-related, distinct replies, prints the generated answers, and then checks follow-up context from the BMW M3 to the Mercedes C63. Point it at a deployed or non-default endpoint with `VEYDRIVO_CHAT_TEST_URL`. These tests make real provider calls and may incur usage charges.

Two offline aids (no provider key needed) live in `scripts/` as well:

```sh
npx tsx scripts/local-api-harness.test.mjs   # behavior checks for api/chat.ts (method guard, validation, env fallback)
npx tsx scripts/local-preview.mjs            # serves dist/ + the real /api/chat handler on http://localhost:4173
```

Before a public launch, add provider-side usage limits and request rate limiting appropriate for an anonymous chat.

## Run locally

```sh
npm install
npm run dev
```

For a local end-to-end AI session, use `vercel dev` after setting the server variables in the local environment.

## VEYDRIVO Battle

The comparison currently uses a small curated set of representative 2024 European-market trims. Prices are indicative; figures may differ by market, model year, equipment and source. Verify vehicle specifications with the manufacturer before making a purchase decision.