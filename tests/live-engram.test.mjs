/**
 * Live end-to-end test against a real Engram server.
 *
 * Opt-in, because it writes to a real store:
 *     $env:ENGRAM_LIVE="1"; npm test        (PowerShell)
 *     ENGRAM_LIVE=1 npm test                (bash)
 *
 * It exercises the exact edit path the UI uses, then removes everything it
 * created — including a hard delete of the observation, because Engram's HTTP
 * DELETE is a soft delete and would otherwise leave a tombstone behind.
 *
 * Two behaviours here are pinned to what the installed build actually does, and
 * were confirmed by probing Engram v3.4.0 rather than by reading a newer source
 * tree:
 *   - `pinned` is returned by the pin endpoints and by /export, never by read routes.
 *   - `include_history` is not answered, so version history is not reachable over HTTP.
 * The UI adapts to both; these tests fail loudly if a future Engram changes them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGRAM = process.env.ENGRAM_URL || "http://127.0.0.1:7437";
const PROJECT = process.env.ENGRAM_TEST_PROJECT || "engram_browser";
const LIVE = process.env.ENGRAM_LIVE === "1";

const api = async (route, { method = "GET", body } = {}) => {
  const res = await fetch(ENGRAM + route, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

test("real Engram round trip", { skip: !LIVE && "set ENGRAM_LIVE=1 to run against a real store" }, async (t) => {
  const stamp = Date.now();
  const sessionId = `engram-browser-selftest-${stamp}`;
  // Unique per run: a reused topic key makes Engram upsert into the previous run's row.
  const topicKey = `engram-browser/selftest-${stamp}`;
  let observationId = null;

  t.after(async () => {
    // Hard delete first: HTTP DELETE is soft, and the session cannot be removed
    // while it still owns observations.
    if (observationId) {
      try { execFileSync("engram", ["delete", String(observationId), "--hard"], { cwd: ROOT, stdio: "ignore" }); }
      catch (err) { console.error(`CLEANUP: could not hard-delete observation ${observationId}: ${err.message}`); }
    }
    try { execFileSync("engram", ["delete", "session", sessionId], { cwd: ROOT, stdio: "ignore" }); }
    catch (err) { console.error(`CLEANUP: could not delete session ${sessionId}: ${err.message}`); }
  });

  await t.test("session registration is accepted", async () => {
    const res = await api("/sessions", { method: "POST", body: { id: sessionId, project: PROJECT } });
    assert.ok([200, 201].includes(res.status), `status ${res.status}: ${JSON.stringify(res.data)}`);
  });

  await t.test("observation is created through POST /observations", async () => {
    const res = await api("/observations", {
      method: "POST",
      body: {
        session_id: sessionId,
        project: PROJECT,
        scope: "project",
        type: "discovery",
        title: "engram-browser selftest",
        content: "created by the engram-browser live test",
        topic_key: topicKey,
      },
    });
    // Capture the id before asserting so cleanup always has something to remove.
    observationId = res.data?.id ?? res.data?.observation?.id;
    assert.ok(Number.isInteger(observationId) && observationId > 0, `bad id: ${JSON.stringify(res.data)}`);
    assert.ok([200, 201].includes(res.status), `unexpected status ${res.status}`);
  });

  await t.test("PATCH without expected_project is refused", async () => {
    const res = await api(`/observations/${observationId}`, { method: "PATCH", body: { title: "nope" } });
    assert.equal(res.status, 400, "Engram must require expected_project");
  });

  await t.test("PATCH with no known field is refused", async () => {
    const empty = await api(`/observations/${observationId}?expected_project=${PROJECT}`, { method: "PATCH", body: {} });
    assert.equal(empty.status, 400);
    assert.match(String(empty.data.error), /at least one field/);

    // Proof that the UI must send only real fields: an unknown key is dropped,
    // which leaves no field at all.
    const unknown = await api(`/observations/${observationId}?expected_project=${PROJECT}`, { method: "PATCH", body: { pinned: true, totally_bogus: 1 } });
    assert.equal(unknown.status, 400);
  });

  await t.test("PATCH edits title and content and leaves other fields alone", async () => {
    const res = await api(`/observations/${observationId}?expected_project=${PROJECT}`, {
      method: "PATCH",
      body: { title: "engram-browser selftest v2", content: "edited by the engram-browser live test" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.title, "engram-browser selftest v2");

    const read = await api(`/observations/${observationId}?project=${PROJECT}`);
    assert.equal(read.data.content, "edited by the engram-browser live test");
    assert.equal(read.data.topic_key, topicKey, "untouched fields must survive an edit");
    assert.equal(read.data.type, "discovery");
    assert.equal(read.data.scope, "project");
    assert.equal(read.data.project, PROJECT);
  });

  await t.test("PATCH edits type, scope and topic key", async () => {
    const res = await api(`/observations/${observationId}?expected_project=${PROJECT}`, {
      method: "PATCH",
      body: { type: "bugfix", scope: "personal", topic_key: `${topicKey}-v2` },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.type, "bugfix");
    assert.equal(res.data.scope, "personal");
    assert.equal(res.data.topic_key, `${topicKey}-v2`);
  });

  await t.test("PATCH refuses to reassign the owning project", async () => {
    const res = await api(`/observations/${observationId}?expected_project=${PROJECT}`, {
      method: "PATCH",
      body: { project: "some-other-project" },
    });
    assert.equal(res.status, 409, JSON.stringify(res.data));
  });

  await t.test("find/replace edits the stored text", async () => {
    const res = await api(`/observations/${observationId}?expected_project=${PROJECT}`, {
      method: "PATCH",
      body: { find: "edited by the engram-browser live test", replace: "replaced by the engram-browser live test" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.content, "replaced by the engram-browser live test");
  });

  await t.test("an edit records a revision", async () => {
    const res = await api(`/observations/${observationId}?project=${PROJECT}&include_history=true`);
    assert.equal(res.status, 200);
    assert.ok(res.data.revision_count >= 2, `revision_count should grow after edits, got ${res.data.revision_count}`);

    if (has(res.data, "version_count")) {
      assert.ok(res.data.version_count >= 1, "a history-capable build must report versions");
      assert.ok(Array.isArray(res.data.history));
    } else {
      // Engram v3.4.0 keeps versions internally but exposes no route for them.
      assert.equal(res.data.history, undefined);
    }
  });

  await t.test("pin and unpin report their state", async () => {
    const on = await api(`/observations/${observationId}/pin`, { method: "PUT" });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(on.data.pinned, true);

    const off = await api(`/observations/${observationId}/pin`, { method: "DELETE" });
    assert.equal(off.status, 200, JSON.stringify(off.data));
    assert.equal(off.data.pinned, false);
  });

  await t.test("pinned state is readable from /export", async () => {
    await api(`/observations/${observationId}/pin`, { method: "PUT" });
    const exp = await api(`/export?project=${PROJECT}`);
    assert.equal(exp.status, 200);
    const row = (exp.data.observations || []).find((o) => o.id === observationId);
    assert.ok(row, "the observation must appear in the project export");
    assert.equal(row.pinned, true, "the UI hydrates pin state from /export");

    await api(`/observations/${observationId}/pin`, { method: "DELETE" });
  });

  await t.test("mark reviewed is accepted", async () => {
    const res = await api(`/review/mark_reviewed?project=${PROJECT}`, { method: "POST", body: { observation_id: observationId } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  });

  await t.test("delete hides the observation from listings", async () => {
    const res = await api(`/observations/${observationId}?expected_project=${PROJECT}`, { method: "DELETE" });
    assert.equal(res.status, 200, JSON.stringify(res.data));

    const list = await api(`/observations?project=${PROJECT}&limit=10000`);
    assert.equal(list.status, 200);
    assert.ok(!list.data.some((o) => o.id === observationId), "soft-deleted observation still listed");
  });
});
