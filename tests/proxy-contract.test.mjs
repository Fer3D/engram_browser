/**
 * Contract tests for the local server.
 *
 * These never touch a real Engram store: the proxy is pointed at a stub upstream
 * that records exactly what arrived. That proves the transport behaviour the UI
 * depends on (method, body, query, headers) and the safety behaviour the store
 * depends on (no arbitrary file access, honest failure when Engram is down).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        body,
        authorization: req.headers.authorization ?? null,
        contentType: req.headers["content-type"] ?? null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        echoed: { method: req.method, url: req.url, body: body ? JSON.parse(body) : null },
      }));
    });
  });
  return { server, port: await listen(server), seen };
}

async function startUi(env) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });

  const base = `http://127.0.0.1:${env.ENGRAM_BROWSER_PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.status < 500) return { child, base };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error(`UI server never came up.\n${output}`);
}

async function withStack(env, fn) {
  const stub = await startStub();
  let ui = null;
  try {
    ui = await startUi({ ...env, ENGRAM_URL: `http://127.0.0.1:${stub.port}` });
    await fn(ui.base, stub);
  } finally {
    if (ui) ui.child.kill();
    await new Promise((r) => stub.server.close(r));
  }
}

test("serves the UI from the same origin", async () => {
  await withStack({ ENGRAM_BROWSER_PORT: "17473" }, async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /Engram/);

    for (const [file, type] of [["/app.js", /javascript/], ["/styles.css", /css/]]) {
      const res = await fetch(base + file);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), type);
    }
  });
});

test("proxies GET with the query string intact", async () => {
  await withStack({ ENGRAM_BROWSER_PORT: "17474" }, async (base, stub) => {
    const res = await fetch(`${base}/api/observations?project=demo&limit=5`);
    assert.equal(res.status, 200);
    assert.equal(stub.seen.at(-1).url, "/observations?project=demo&limit=5");
    assert.equal(stub.seen.at(-1).method, "GET");
  });
});

test("proxies PATCH with method, body and query preserved", async () => {
  await withStack({ ENGRAM_BROWSER_PORT: "17475" }, async (base, stub) => {
    const res = await fetch(`${base}/api/observations/42?expected_project=demo`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "new title" }),
    });
    assert.equal(res.status, 200);

    const last = stub.seen.at(-1);
    assert.equal(last.method, "PATCH");
    assert.equal(last.url, "/observations/42?expected_project=demo");
    assert.deepEqual(JSON.parse(last.body), { title: "new title" });
    assert.match(last.contentType, /application\/json/);
  });
});

test("proxies DELETE and PUT with no body", async () => {
  await withStack({ ENGRAM_BROWSER_PORT: "17476" }, async (base, stub) => {
    await fetch(`${base}/api/observations/7?expected_project=demo`, { method: "DELETE" });
    assert.equal(stub.seen.at(-1).method, "DELETE");
    assert.equal(stub.seen.at(-1).url, "/observations/7?expected_project=demo");

    await fetch(`${base}/api/observations/7/pin`, { method: "PUT" });
    assert.equal(stub.seen.at(-1).method, "PUT");
    assert.equal(stub.seen.at(-1).url, "/observations/7/pin");
  });
});

test("adds a bearer token only when one is configured", async () => {
  await withStack({ ENGRAM_BROWSER_PORT: "17477" }, async (base, stub) => {
    await fetch(`${base}/api/health`);
    assert.equal(stub.seen.at(-1).authorization, null);
  });
  await withStack({ ENGRAM_BROWSER_PORT: "17478", ENGRAM_HTTP_TOKEN: "s3cret" }, async (base, stub) => {
    await fetch(`${base}/api/health`);
    assert.equal(stub.seen.at(-1).authorization, "Bearer s3cret");
  });
});

test("refuses to serve files outside public/", async () => {
  await withStack({ ENGRAM_BROWSER_PORT: "17479" }, async (base) => {
    for (const attack of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/package.json", "/../server.mjs"]) {
      const res = await fetch(base + attack);
      const text = await res.text();
      assert.ok(res.status >= 400, `${attack} returned ${res.status}`);
      assert.ok(!text.includes('"dependencies"'), `${attack} leaked package.json`);
      assert.ok(!text.includes("ENGRAM_URL"), `${attack} leaked server.mjs`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, "package.json")));
  });
});

test("reports an honest 502 when Engram is unreachable", async () => {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, ENGRAM_BROWSER_PORT: "17480", ENGRAM_URL: "http://127.0.0.1:1" },
      stdio: "ignore",
    });
    (async () => {
      const base = "http://127.0.0.1:17480";
      for (let i = 0; i < 100; i++) {
        try { await fetch(`${base}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.match(body.error, /Cannot reach the Engram server/);
      assert.ok(body.hint.includes("engram serve"));
      child.kill();
      resolve();
    })();
  });
});
