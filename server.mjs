/**
 * Engram Browser - local server.
 *
 * Two jobs, nothing else:
 *   1. Serve the static UI from this same origin.
 *   2. Proxy /api/* to the official Engram HTTP API (`engram serve`).
 *
 * Why a proxy instead of calling Engram directly from the browser:
 * the Engram API sends no CORS headers and answers preflight with 405, so a
 * page on another origin cannot talk to it. Proxying also keeps the API token
 * out of the browser and keeps the app on one origin.
 *
 * This process NEVER opens, reads or writes the Engram SQLite store. Every byte
 * of memory data goes through Engram's own HTTP API, so Engram keeps ownership
 * of validation, full-text indexing, versioning, project scope and sync.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const HOST = process.env.ENGRAM_BROWSER_HOST || "127.0.0.1";
const PORT = Number(process.env.ENGRAM_BROWSER_PORT || 7473);
const ENGRAM_URL = (process.env.ENGRAM_URL || "http://127.0.0.1:7437").replace(/\/+$/, "");
const ENGRAM_TOKEN = process.env.ENGRAM_HTTP_TOKEN || "";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Forward one request to the Engram API and stream the answer back untouched. */
async function handleApi(req, res, url) {
  const upstreamPath = url.pathname.replace(/^\/api/, "") || "/";
  const target = ENGRAM_URL + upstreamPath + url.search;

  const headers = { accept: "application/json, text/plain, */*" };
  const contentType = req.headers["content-type"];
  if (contentType) headers["content-type"] = contentType;
  if (ENGRAM_TOKEN) headers.authorization = `Bearer ${ENGRAM_TOKEN}`;

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      const raw = await readBody(req);
      if (raw.length > 0) body = raw;
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
  }

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body });
  } catch (err) {
    return sendJson(res, 502, {
      error: "Cannot reach the Engram server",
      detail: String((err && err.message) || err),
      hint: `Start it with "engram serve" and make sure it listens on ${ENGRAM_URL}.`,
      engram_url: ENGRAM_URL,
    });
  }

  const payload = Buffer.from(await upstream.arrayBuffer());
  const upstreamType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
  res.writeHead(upstream.status, {
    "content-type": upstreamType,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-engram-upstream-ms": String(Date.now() - startedAt),
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else res.end(payload);
}

/** Serve the UI. Static files only; no path may escape PUBLIC_DIR. */
function serveStatic(req, res, url) {
  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    // A malformed escape (for example "/%", "/%zz") must never take the server
    // down: decodeURIComponent throws a URIError that would otherwise be
    // unhandled and exit the process.
    return sendJson(res, 400, { error: "malformed request path" });
  }
  if (relative === "/" || relative === "") relative = "/index.html";

  const resolved = path.resolve(PUBLIC_DIR, "." + relative);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  fs.readFile(resolved, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found", path: relative });
    const type = MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": data.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch {
    return sendJson(res, 400, { error: "bad request url" });
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed" });
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, async () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Engram Browser  →  ${url}`);
  console.log(`  Engram API →  ${ENGRAM_URL}${ENGRAM_TOKEN ? "  (bearer token configured)" : ""}\n`);
  try {
    const probe = await fetch(`${ENGRAM_URL}/health`);
    const health = await probe.json();
    console.log(`  Connected to Engram v${health.version} (instance ${String(health.instance_id).slice(0, 8)}…)\n`);
  } catch {
    console.log("  WARNING: Engram is not answering yet. Start it with: engram serve");
    console.log("           The UI will keep retrying, so you can start Engram afterwards.\n");
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. Start with a different one:`);
    console.error(`    $env:ENGRAM_BROWSER_PORT=7474; npm start\n`);
  } else {
    console.error("\n  Server error:", err.message, "\n");
  }
  process.exit(1);
});
