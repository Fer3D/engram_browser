/**
 * Regression suite written by the independent verifier, kept as permanent tests.
 *
 * Each case here corresponds to a defect the verifier found in the reviewed
 * revision. They were RED against that revision and are the contract that keeps
 * them fixed. Zero dependencies, no browser, no real Engram store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_JS = path.join(ROOT, "public", "app.js");
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

async function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${base}/api/health`); return { child, base, output: () => output }; }
    catch { if (child.exitCode !== null) break; await new Promise((r) => setTimeout(r, 50)); }
  }
  return { child, base, output: () => output };
}

const alive = async (base) => { try { await fetch(`${base}/`); return true; } catch { return false; } };

test("S3: no path encoding reaches a file outside public/", async () => {
  const stub = await startStub();
  const ui = await startUi({ ENGRAM_BROWSER_PORT: "17601", ENGRAM_URL: `http://127.0.0.1:${stub.port}` });
  try {
    for (const attack of ["/api/../../package.json", "/api/..%2f..%2fpackage.json"]) {
      assert.ok(await alive(ui.base), `server died before ${attack}`);
      const text = await (await fetch(ui.base + attack, { redirect: "manual" })).text();
      assert.ok(!text.includes('"dependencies"'), `${attack} leaked package.json`);
      assert.ok(!text.includes("ENGRAM_URL"), `${attack} leaked server.mjs`);
    }
    const staticAttacks = ["/../package.json", "/..%2fpackage.json", "/%2e%2e/package.json", "/../server.mjs",
      "/..%2F..%2Fpackage.json", "/%2e%2e%2fpackage.json", "/..%5cpackage.json", "/%252e%252e/package.json",
      "/.%2e/package.json", "/public/../package.json", "/../tests/regressions.test.mjs",
      "/../odd/tasks/engram-web-ui.md", "/C:/Windows/win.ini", "/app.js/../package.json"];
    for (const attack of staticAttacks) {
      assert.ok(await alive(ui.base), `server died before ${attack}`);
      const res = await fetch(ui.base + attack, { redirect: "manual" });
      const text = await res.text();
      assert.ok(res.status >= 400, `${attack} returned ${res.status}`);
      assert.ok(!text.includes('"dependencies"'), `${attack} leaked package.json`);
      assert.ok(!text.includes("ENGRAM_URL"), `${attack} leaked server.mjs`);
      assert.ok(!text.includes("proxies PATCH with method"), `${attack} leaked a test file body`);
      assert.ok(!text.includes("Hard requirement"), `${attack} leaked the task document`);
      assert.match(res.headers.get("content-type") ?? "", /application\/json|text\/plain/);
    }
    assert.ok(fs.existsSync(path.join(ROOT, "package.json")), "fixture missing");
  } finally { ui.child.kill(); await new Promise((r) => stub.server.close(r)); }
});

test("S3: the proxy only ever talks to ENGRAM_URL, whatever path is asked for", async () => {
  const stub = await startStub();
  const victim = await startStub();
  const ui = await startUi({ ENGRAM_BROWSER_PORT: "17602", ENGRAM_URL: `http://127.0.0.1:${stub.port}` });
  try {
    for (const attack of [`//127.0.0.1:${victim.port}/health`, "/api//../probe", `/api//127.0.0.1:${victim.port}/health`]) {
      assert.ok(await alive(ui.base), `server died before ${attack}`);
      await fetch(ui.base + attack, { redirect: "manual" }).catch(() => {});
    }
    assert.equal(victim.seen.length, 0, "a second host was contacted");
    for (const r of stub.seen) assert.ok(r.url.startsWith("/"), `upstream saw a non-path target: ${r.url}`);
  } finally {
    ui.child.kill();
    await new Promise((r) => stub.server.close(r));
    await new Promise((r) => victim.server.close(r));
  }
});

// Was RED: decodeURIComponent threw a URIError that killed the process.
test("S3: a malformed percent-encoded path must not kill the server", async () => {
  for (const [i, attack] of ["/%", "/%zz", "/a%", "/%2", "/%c0%ae", "/%e0%a4", "/%GG"].entries()) {
    const ui = await startUi({ ENGRAM_BROWSER_PORT: String(17610 + i), ENGRAM_URL: "http://127.0.0.1:1" });
    try {
      let status = null;
      try { status = (await fetch(ui.base + attack)).status; }
      catch (err) { assert.fail(`GET ${attack} failed at the transport: ${err.message}`); }
      assert.ok(status >= 400 && status < 500, `${attack} answered ${status}`);
      assert.ok(await alive(ui.base), `GET ${attack} left the server dead. Output:\n${ui.output()}`);
      assert.ok(!/URIError/.test(ui.output()), `URIError reached the process for ${attack}`);
    } finally { ui.child.kill(); }
  }
});

test("S3: a missing Engram yields an honest 502 and still serves the shell", async () => {
  const ui = await startUi({ ENGRAM_BROWSER_PORT: "17620", ENGRAM_URL: "http://127.0.0.1:1" });
  try {
    for (const route of ["/api/health", "/api/projects", "/api/observations?project=x"]) {
      const res = await fetch(ui.base + route);
      assert.equal(res.status, 502, `${route} -> ${res.status}`);
      const body = await res.json();
      assert.match(body.error, /Cannot reach the Engram server/);
      assert.ok(body.hint.includes("engram serve"), "the hint must name the fix");
      assert.equal(body.engram_url, "http://127.0.0.1:1");
    }
    const shell = await fetch(ui.base + "/");
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /Engram/);
  } finally { ui.child.kill(); }
});

test("S3: app.js is a JavaScript content type and API errors are JSON, not HTML", async () => {
  const ui = await startUi({ ENGRAM_BROWSER_PORT: "17630", ENGRAM_URL: "http://127.0.0.1:1" });
  try {
    for (const [file, type] of [["/app.js", /javascript/], ["/styles.css", /css/], ["/", /html/]]) {
      const res = await fetch(ui.base + file);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), type);
    }
    const reflected = await fetch(ui.base + "/does-not-exist");
    assert.equal(reflected.status, 404);
    assert.match(reflected.headers.get("content-type"), /application\/json/);
  } finally { ui.child.kill(); }
});

// Was RED: the only pinned affordances were a card star and a counter.
test("S2: the observations view offers pinned grouping and filtering", async () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  assert.ok(/"pinned"/.test(src), "no pinned mode exists at all");
  assert.ok(/id:\s*"pinned"|data-group="pinned"|value="pinned"/.test(src), "no pinned grouping or filter control is rendered");
  assert.ok(/\bpinned\b[^]*?groupObservations|groupObservations[^]*?\bpinned\b/.test(src), "grouping never considers pinned rows");
});

// Was RED: a stored scope outside SCOPES (a real row held scope "global", a value
// Engram accepts) resolved to the first option, so a save with no user edit
// PATCHed {"scope":"project"} — a silent rewrite of the user's data.
test("A2: the scope select must not silently rewrite an out-of-list scope", async () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  const scopeSelect = src.match(/<select id="f-scope"[^]*?<\/select>/)?.[0] ?? "";
  assert.ok(scopeSelect, "the scope select was not found");
  assert.ok(/o\.scope\s*&&\s*!SCOPES\.includes\(o\.scope\)/.test(scopeSelect),
    `the scope select has no fallback option for a stored scope outside SCOPES, so it resolves to "project" and saveObservation() PATCHes an untouched field. Select source: ${scopeSelect.replace(/\s+/g, " ").slice(0, 200)}`);
});

// The `hidden` attribute must beat the `display: flex` on .modal/.drawer, or the
// full-screen overlay stays on top of the page and swallows every click.
test("the hidden attribute must always win the cascade", async () => {
  const css = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/, "no [hidden] display:none !important rule");
  for (const selector of [".modal", ".drawer"]) {
    assert.ok(new RegExp(`\\${selector}\\s*\\{[^}]*display:\\s*flex`).test(css), `${selector} is expected to set display: flex`);
  }
});

test("A5: every Engram-destructive action goes through the typed confirmation", async () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  const destructive = src.match(/async function (deleteObservation|deleteSession|deletePrompt)\([^]*?\n\}/g) ?? [];
  assert.equal(destructive.length, 3, "expected three destructive handlers");
  for (const fn of destructive) {
    assert.match(fn, /await confirmModal\(/, `${fn.slice(0, 40)} does not confirm`);
    assert.match(fn, /requireText/, `${fn.slice(0, 40)} confirms without a typed gate`);
  }
  assert.equal((src.match(/method:\s*"DELETE"/g) ?? []).length, 3, "expected exactly three unconditional DELETE call sites");
});

test("relations can be judged with a verb Engram accepts", async () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  assert.match(src, /conflicts\/judge-many/, "no judge call site");
  assert.match(src, /judgment_id/, "judgment_id is the relation identity Engram looks up");
  assert.match(src, /not_conflict/, "the verb list must come from Engram's own validator");
});
