const deploymentUrl = process.env.DRIVIA_DEPLOYMENT_URL;

if (!deploymentUrl) {
  console.error("Set DRIVIA_DEPLOYMENT_URL to a reachable Vercel deployment URL.");
  console.error("This check sends GET /api/chat and does not call the AI provider or require an API key.");
  process.exit(1);
}

let endpoint;
try {
  const base = new URL(deploymentUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost") {
    throw new Error("Use an HTTPS deployment URL (or localhost for local testing).");
  }
  endpoint = new URL("/api/chat", base);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid deployment URL.");
  process.exit(1);
}

try {
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : null;

  if (
    response.status === 405 &&
    contentType.includes("application/json") &&
    payload?.error === "Only POST requests are supported."
  ) {
    console.log(`PASS: ${endpoint} is handled by the DRIVIA serverless function.`);
    console.log("The 405 response is expected for GET; POST requests continue to the configured AI provider.");
    process.exit(0);
  }

  if ([401, 403].includes(response.status)) {
    throw new Error(
      "The deployment is protected by Vercel Deployment Protection. Run this check from an authorized environment or use an accessible preview URL.",
    );
  }

  if (response.status === 404 || response.status === 200 || contentType.includes("text/html")) {
    throw new Error(
      `The route did not return the function's expected 405 JSON response (got ${response.status}, ${contentType || "unknown content type"}). Check that the Vercel project root contains api/chat.ts and that it was built as a Vercel deployment, not a static-only preview.`,
    );
  }

  throw new Error(`Unexpected response from /api/chat: HTTP ${response.status}.`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : "Could not verify /api/chat."}`);
  process.exitCode = 1;
}