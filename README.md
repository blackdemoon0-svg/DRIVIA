# DRIVIA

DRIVIA is an independent, responsive automotive AI experience built with React, Vite and Tailwind CSS. Its first release focuses on one simple conversation flow and a compact side-by-side car comparison.

## AI connection

This is a generative chat, not a response library: every user turn sends the recent conversation to `POST /api/chat`, which asks the configured language model to generate a fresh response. OpenAI's streamed chat completions are forwarded as Server-Sent Events, so text appears progressively in the chat. No automotive replies are hardcoded in the frontend. `server/driviaSystemPrompt.ts` defines DRIVIA's enthusiast personality, automotive knowledge, multilingual behavior, conversation memory, and honesty/safety rules.

`api/chat.ts` is the single Vercel serverless handler; support files such as DRIVIA's system prompt live outside the `api/` route directory so Vercel does not mistake them for extra endpoints. `vercel.json` explicitly builds the Vite frontend to `dist` and configures `/api/chat` as a 60-second function. The handler keeps the model key server-side and supports OpenAI, Google's Gemini OpenAI-compatible endpoint, or another OpenAI-compatible API. Set these environment variables in the **server/deployment settings**, not in a public `VITE_` variable:

- `DRIVIA_AI_PROVIDER` (optional: `openai`, `gemini`, or `openai-compatible`; defaults to `openai`)
- `DRIVIA_AI_API_KEY` (required, server-side only)
- `DRIVIA_AI_BASE_URL` (optional; defaults to the selected provider's compatible endpoint)
- `DRIVIA_AI_MODEL` (optional; defaults to `gpt-4.1-mini` for OpenAI or `gemini-3.8-flash` for Gemini)

For another provider, choose `DRIVIA_AI_PROVIDER=openai-compatible` and set its base URL, API key, and model. The Gemini option uses `https://generativelanguage.googleapis.com/v1beta/openai` and accepts an override for the model or URL. The browser always calls the same-origin `/api/chat` endpoint; the provider is only contacted by the server.

For local development, copy `.env.example` to `.env.local`, set `DRIVIA_AI_API_KEY` there, and run the API route through `vercel dev`. `.env.local` is ignored by Git. For a deployed Vercel project, add the key in the project's server environment variable settings and redeploy. Never put the real key in React code, a `VITE_` variable, HTML, or a committed file.

Provider references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).

## Deployment requirements

This repository is a Vite frontend plus a Vercel Node.js serverless function. Deploy it to **Vercel** with the Vercel project Root Directory set to the repository root (the folder containing `vercel.json`, `api/`, and `package.json`). The committed `vercel.json` selects the Vite framework, runs `npm run build`, publishes the Vite `dist` assets, and explicitly matches `api/chat.ts` as a 60-second serverless function. Vercel discovers the route from the root-level `api/chat.ts` and serves it at `/api/chat`. The `dist` setting is the frontend asset output; this config does not define a legacy static-only `builds` pipeline that would discard serverless functions.

**The Arena preview is static and cannot execute the serverless API. The repository must be deployed to Vercel.** The root-level function folder and environment variables are evaluated by the hosting platform, not by Vite's static `dist` preview. The Arena build preview can render the frontend, but it cannot run `api/chat.ts`. If the chosen host is static-only, use Vercel or provide a Node.js serverless backend and same-origin `/api/chat` route/proxy. In a Vercel project, also set the Root Directory to the project root; a Vercel app pointed at another subdirectory will not see this `api/` folder or `vercel.json`.

For an initial test, add `DRIVIA_AI_API_KEY` under Vercel Project Settings > Environment Variables with the **Preview** environment selected, then create a Preview deployment. Leave `DRIVIA_AI_PROVIDER` unset or set it to `openai`. Do not configure or deploy Production until explicitly approved. No real key is stored in this repository. For local end-to-end use, copy `.env.example` to `.env.local`, add the key, then run Vercel's development server with `vercel dev` (not plain `npm run dev`). Without a configured route/key, DRIVIA reports the service error instead of returning mock answers.

After creating a Vercel Preview deployment, verify that its route is actually present without invoking the model or exposing a key:

```sh
DRIVIA_DEPLOYMENT_URL=https://your-preview.vercel.app node scripts/verify-vercel-api.mjs
```

The check expects `/api/chat` to return its method-specific `405` JSON response to a GET request. A static page/HTML fallback or a missing function will fail this check. This repository cannot set Vercel dashboard settings, create the remote Vercel project, add secrets, or confirm a remote deployment by itself.

## Vercel Web Analytics

The app mounts Vercel's official `@vercel/analytics` React component from `src/main.tsx`. Once Web Analytics is enabled for the Vercel project and this code is deployed, Vercel can collect site visits and page views and show traffic breakdowns in the project dashboard. No API key, frontend secret, or extra environment variable is needed. The integration does not change the AI chat or DRIVIA Battle UI/behavior.

To activate and verify it for Production:

1. In the Vercel dashboard, open the DRIVIA project, select **Analytics**, and click **Enable** for Web Analytics.
2. After the code is approved for release, deploy it to Production using the project's usual deployment flow. Vercel provisions the Analytics routes on a subsequent deployment; this repository change alone does not affect the already-live deployment.
3. Open the Production site and use browser DevTools → **Network**. Filter for `insights` or `view`; the Analytics script should load and a page-view request should complete successfully. Ad blockers may block these requests.
4. In the project's **Analytics** dashboard, review visitors, page views, referrers, and available browser/device/location breakdowns. Allow for real visitor traffic to arrive before expecting useful reports.

DRIVIA currently uses one URL for its AI and Battle views, so basic page-view reporting treats the app as one page; switching between those in-app views does not create a separate URL page view.

## Live AI smoke test

With the API route running and a real server-side provider key configured, run:

```sh
node scripts/ai-smoke-test.mjs
```

The script streams answers from the live model for all eight automotive questions, checks for non-empty, topic-related, distinct replies, prints the generated answers, and then checks follow-up context from the BMW M3 to the Mercedes C63. Point it at a deployed or non-default endpoint with `DRIVIA_CHAT_TEST_URL`. These tests make real provider calls and may incur usage charges.

Before a public launch, add provider-side usage limits and request rate limiting appropriate for an anonymous chat.

## Run locally

```sh
npm install
npm run dev
```

For a local end-to-end AI session, use `vercel dev` after setting the server variables in the local environment.

## DRIVIA Battle

The comparison currently uses a small curated set of representative 2024 European-market trims. Prices are indicative; figures may differ by market, model year, equipment and source. Verify vehicle specifications with the manufacturer before making a purchase decision.