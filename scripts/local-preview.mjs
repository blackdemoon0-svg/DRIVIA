/**
 * Local preview server (development aid, not used in production).
 *
 * Serves the built dist/ folder AND mounts the real api/chat.ts handler on
 * /api/chat, so the frontend + serverless logic can be exercised locally the
 * way Vercel would (minus the AI provider key — without it the chat surfaces
 * its designed "not configured" error, exactly like a fresh deployment).
 *
 * Run:  npx tsx scripts/local-preview.mjs   (http://localhost:4173)
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../api/chat.ts";
import paddleConfigHandler from "../api/paddle-config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");
const port = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

function adaptResponse(res) {
  let statusCode = 200;
  const adapted = Object.create(res);
  adapted.status = (code) => {
    statusCode = code;
    return adapted;
  };
  adapted.json = (body) => {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };
  // `setHeader` is inherited from ServerResponse and uses internal state bound to
  // `this`; calling it on the wrapper would target the wrapper instead of the
  // real response (headers silently dropped). Bind it explicitly so both
  // /api/chat (SSE headers) and /api/paddle-config (Cache-Control) behave like
  // the deployed functions.
  adapted.setHeader = (name, value) => res.setHeader(name, value);
  return adapted;
}

async function serveStatic(res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(distDir, safePath === "/" || safePath === "" ? "index.html" : safePath);
  if (!filePath.startsWith(distDir)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    const data = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/paddle-config") {
    return paddleConfigHandler({ method: req.method }, adaptResponse(res));
  }

  if (url.pathname === "/api/chat") {
    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
    }
    return handler({ method: req.method, headers: req.headers, body }, adaptResponse(res));
  }

  await serveStatic(res, url.pathname);
});

await stat(path.join(distDir, "index.html"));
server.listen(port, "0.0.0.0", () => {
  console.log(`VEYVRO local preview ready on http://0.0.0.0:${port} (static dist/ + real /api/chat handler)`);
});
