/**
 * Engram Browser - front-end.
 *
 * Everything the app shows or changes comes from Engram's HTTP API through
 * /api/*, which this app's own server proxies. The app never touches the
 * Engram database and never invents fields Engram does not accept:
 *   - PATCH only ever sends the fields Engram declares in UpdateObservationParams.
 *   - Deletes always carry expected_project, which Engram requires.
 *   - Observation.project is immutable in Engram, so it is read-only here.
 */

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

const ALL = "__all__";

const TYPE_ORDER = [
  "decision", "bugfix", "discovery", "architecture", "pattern",
  "preference", "config", "guide", "fact", "session_summary", "manual",
];

const TYPES_KNOWN = new Set(TYPE_ORDER);

const SCOPES = ["project", "personal"];

const VIEWS = [
  { id: "observations", label: "Observations", ico: "🧠" },
  { id: "prompts", label: "Prompts", ico: "💬" },
  { id: "sessions", label: "Sessions", ico: "🗂" },
  { id: "relations", label: "Relations", ico: "🔗" },
  { id: "overview", label: "Overview", ico: "📊" },
];

const GROUPINGS = [
  { id: "none", label: "No grouping" },
  { id: "day", label: "Group by day" },
  { id: "type", label: "Group by type" },
  { id: "topic", label: "Group by topic" },
  { id: "session", label: "Group by session" },
  { id: "scope", label: "Group by scope" },
  { id: "pinned", label: "Group by pinned" },
];

const SORTS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "title", label: "Title A–Z" },
];

/**
 * The verbs Engram accepts for a relation judgment, from
 * `isValidRelationVerb` in its store: anything else is refused.
 */
const JUDGE_VERBS = ["related", "compatible", "scoped", "conflicts_with", "supersedes", "not_conflict"];

const PAGE_SIZE = 60;

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const state = {
  health: null,
  projects: [],
  project: null,
  view: "observations",
  observations: [],
  prompts: [],
  sessions: [],
  relations: [],
  relationsTotal: 0,
  stats: null,
  doctor: null,

  // observation list controls
  query: "",
  group: "day",
  sort: "newest",
  typeFilter: new Set(),
  scopeFilter: "",
  hideSummary: false,
  pinnedOnly: false,
  limit: PAGE_SIZE,

  // drawer
  drawer: null,        // { kind: 'observation'|'session'|'prompt', data, editing, history }
  loading: false,

  // Engram v3.4.0 exposes "pinned" only through /export and the pin endpoints,
  // so the client keeps its own per-project pin index, hydrated from /export.
  detectedProject: null,   // project Engram resolves from the working directory
  pins: new Map(),
  pinsLoaded: new Set(),

  // Engram v3.4.0 does not answer include_history; detect it instead of
  // pretending a version list exists.
  historySupported: null,
};

/* ------------------------------------------------------------------ *
 * tiny helpers
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function typeClass(type) {
  const t = String(type || "").toLowerCase();
  return "t-" + (TYPES_KNOWN.has(t) ? t : "other");
}

/** Engram stores UTC timestamps as "YYYY-MM-DD HH:MM:SS[.nanos]". */
function parseDate(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const ms = m[7] ? (m[7] + "000").slice(0, 3) : "000";
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(raw, withTime = true) {
  const d = parseDate(raw);
  if (!d) return raw ? String(raw) : "—";
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  if (!withTime) return date;
  return `${date} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function relTime(raw) {
  const d = parseDate(raw);
  if (!d) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 31) return `${days}d ago`;
  const mo = Math.round(days / 30.44);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function dayKey(raw) {
  const d = parseDate(raw);
  if (!d) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(key) {
  if (key === "unknown") return "Unknown date";
  const d = new Date(`${key}T00:00:00Z`);
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function snippet(text, max = 220) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function api(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (raw) {
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res;
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && (data.error || data.message)) ||
      (typeof data === "string" && data) ||
      `HTTP ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data;
}

const withProject = (path, extra = {}) => {
  const params = new URLSearchParams();
  if (state.project && state.project !== ALL) params.set("project", state.project);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const q = params.toString();
  return q ? `${path}?${q}` : path;
};

/* ------------------------------------------------------------------ *
 * loading
 * ------------------------------------------------------------------ */

async function loadHealth() {
  try {
    state.health = await api("/health");
  } catch (err) {
    state.health = { error: err.message };
  }
  renderHealth();
}

async function loadProjects() {
  const data = await api("/projects");
  state.projects = data.projects || [];
  if (!state.project) {
    const current = await api("/project/current").catch(() => null);
    const match = current && state.projects.find(
      (p) => p.name.toLowerCase() === String(current.project || "").toLowerCase()
    );
    state.detectedProject = match ? match.name : null;
    state.project = match ? match.name : (state.projects[0]?.name || ALL);
  }
  renderProjects();
}

const sortById = (a, b) => (b.id || 0) - (a.id || 0);

/* ------------------------------------------------------------------ *
 * pinned index
 *
 * Engram answers PATCH/PUT/DELETE pin with {id, pinned}, but omits "pinned"
 * from every read route. /export is the only read that includes it, so the
 * pin state is hydrated from there once per project and then kept in memory.
 * ------------------------------------------------------------------ */

function isPinned(o) {
  const project = o.project || (state.project === ALL ? null : state.project);
  if (!project) return false;
  return state.pins.get(project)?.has(o.id) === true;
}

async function hydratePins(project) {
  if (!project || project === ALL || state.pinsLoaded.has(project)) return;
  const data = await api(`/export?project=${encodeURIComponent(project)}`);
  const set = new Set((data.observations || []).filter((o) => o.pinned).map((o) => o.id));
  state.pins.set(project, set);
  state.pinsLoaded.add(project);
}

/**
 * Pin state lives only in /export, so the whole scope on screen must be hydrated
 * for the star, the "★ Pinned" filter and the Overview counter to be truthful.
 * A failure is deliberately NOT cached, so an explicit reload retries instead of
 * silently reporting everything as unpinned forever.
 */
async function hydrateAllPins() {
  if (state.project !== ALL) return hydratePins(state.project);
  await Promise.all(state.projects.map((p) => hydratePins(p.name).catch(() => {})));
}

function setPinned(project, id, pinned) {
  if (!project) return;
  if (!state.pins.has(project)) state.pins.set(project, new Set());
  const set = state.pins.get(project);
  if (pinned) set.add(id);
  else set.delete(id);
}

async function loadObservations() {
  if (state.project === ALL) {
    const groups = await Promise.all(state.projects.map(async (p) => {
      const rows = await api(`/observations?project=${encodeURIComponent(p.name)}&limit=10000`).catch(() => []);
      return rows.map((o) => ({ ...o, project: o.project || p.name }));
    }));
    state.observations = groups.flat().sort(sortById);
  } else {
    state.observations = (await api(withProject("/observations", { limit: 10000 }))).sort(sortById);
  }
}

async function loadPrompts() {
  const fetchFor = async (name) => {
    const rows = await api(`/prompts/recent?project=${encodeURIComponent(name)}&limit=10000`).catch(() => []);
    return rows.map((r) => ({ ...r, project: r.project || name }));
  };
  state.prompts = state.project === ALL
    ? (await Promise.all(state.projects.map((p) => fetchFor(p.name)))).flat()
    : await fetchFor(state.project);
  state.prompts.sort((a, b) => (b.id || 0) - (a.id || 0));
}

async function loadSessions() {
  const fetchFor = async (name) => {
    const rows = await api(`/sessions/recent?project=${encodeURIComponent(name)}&limit=10000`).catch(() => []);
    return rows.map((r) => ({ ...r, project: r.project || name }));
  };
  state.sessions = state.project === ALL
    ? (await Promise.all(state.projects.map((p) => fetchFor(p.name)))).flat()
    : await fetchFor(state.project);
  state.sessions.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
}

async function loadRelations() {
  const fetchFor = async (name) => {
    const data = await api(`/conflicts?project=${encodeURIComponent(name)}&limit=1000`).catch(() => ({ relations: [], total: 0 }));
    return { rows: (data.relations || []).map((r) => ({ ...r, project: name })), total: data.total || 0 };
  };
  if (state.project === ALL) {
    const all = await Promise.all(state.projects.map((p) => fetchFor(p.name)));
    state.relations = all.flatMap((r) => r.rows);
    state.relationsTotal = all.reduce((n, r) => n + r.total, 0);
  } else {
    const one = await fetchFor(state.project);
    state.relations = one.rows;
    state.relationsTotal = one.total;
  }
}

async function loadStats() {
  if (state.project === ALL) {
    state.stats = {
      total_observations: state.projects.reduce((n, p) => n + (p.observation_count || 0), 0),
      total_sessions: state.projects.reduce((n, p) => n + (p.session_count || 0), 0),
      total_prompts: state.projects.reduce((n, p) => n + (p.prompt_count || 0), 0),
      projects: state.projects.map((p) => p.name),
    };
    return;
  }
  state.stats = await api(withProject("/stats")).catch(() => null);
}

async function loadDoctor() {
  if (state.project === ALL) { state.doctor = null; return; }
  state.doctor = await api(withProject("/doctor")).catch(() => null);
}

/** Reload everything that depends on the selected project. */
async function reload() {
  if (state.loading) return;
  state.loading = true;
  renderContent();
  try {
    await Promise.all([loadStats(), loadObservations(), loadPrompts(), loadSessions(), loadRelations(), loadDoctor()]);
    await hydrateAllPins().catch(() => {});
  } catch (err) {
    banner("error", `Could not load data from Engram: ${esc(err.message)}`);
  } finally {
    state.loading = false;
    state.limit = PAGE_SIZE;
    renderAll();
  }
}

/* ------------------------------------------------------------------ *
 * rail
 * ------------------------------------------------------------------ */

function renderHealth() {
  const box = $("health");
  const h = state.health;
  if (!h || h.error) {
    box.innerHTML = `<span class="dot bad"></span><span>Engram<br><span class="health-hint">offline</span></span>`;
    box.title = h ? h.error : "no data";
    return;
  }
  box.innerHTML =
    `<span class="dot ok"></span><span><b>Engram v${esc(h.version)}</b><br>` +
    `<span class="faint">${esc(String(h.instance_id || "").slice(0, 8))}…</span></span>`;
  box.title = `instance_id: ${h.instance_id}`;
}

function renderProjects() {
  const box = $("projects");
  const filter = $("project-filter").value.trim().toLowerCase();
  const total = state.projects.reduce((n, p) => n + (p.observation_count || 0), 0);

  const rows = [];
  if (!filter) {
    rows.push(
      `<button class="proj all${state.project === ALL ? " active" : ""}" data-project="${ALL}">` +
      `<span class="pname">All projects</span><span class="pcount">${total}</span></button>`
    );
  }
  for (const p of state.projects) {
    if (filter && !p.name.toLowerCase().includes(filter)) continue;
    rows.push(
      `<button class="proj${state.project === p.name ? " active" : ""}" data-project="${esc(p.name)}" title="${esc(p.name)}">` +
      `<span class="pname">${esc(p.name)}</span><span class="pcount">${p.observation_count ?? 0}</span></button>`
    );
  }
  box.innerHTML = rows.join("") || `<div class="faint" style="padding:9px">No projects match.</div>`;
}

function renderViewsNav() {
  const counts = {
    observations: state.observations.length,
    prompts: state.prompts.length,
    sessions: state.sessions.length,
    relations: state.relationsTotal || state.relations.length,
  };
  $("views").innerHTML = VIEWS.map((v) => {
    const n = counts[v.id];
    return `<button class="view-btn${state.view === v.id ? " active" : ""}" data-view="${v.id}">` +
      `<span class="ico">${v.ico}</span><span>${v.label}</span>` +
      (n !== undefined ? `<span class="n">${n}</span>` : "") +
      `</button>`;
  }).join("");
}

function banner(kind, html) {
  const box = $("banner");
  if (!html) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.className = `banner ${kind}`;
  box.innerHTML = html;
}

/* ------------------------------------------------------------------ *
 * observation list
 * ------------------------------------------------------------------ */

function filteredObservations() {
  const q = state.query.trim().toLowerCase();
  let rows = state.observations;

  if (state.typeFilter.size) rows = rows.filter((o) => state.typeFilter.has(o.type));
  if (state.scopeFilter) rows = rows.filter((o) => o.scope === state.scopeFilter);
  if (state.hideSummary) rows = rows.filter((o) => o.type !== "session_summary");
  if (state.pinnedOnly) rows = rows.filter((o) => isPinned(o));

  if (q) {
    rows = rows.filter((o) =>
      String(o.title || "").toLowerCase().includes(q) ||
      String(o.content || "").toLowerCase().includes(q) ||
      String(o.topic_key || "").toLowerCase().includes(q) ||
      String(o.type || "").toLowerCase().includes(q) ||
      String(o.session_id || "").toLowerCase().includes(q) ||
      String(o.project || "").toLowerCase().includes(q)
    );
  }

  const sorted = [...rows];
  if (state.sort === "oldest") sorted.sort((a, b) => (a.id || 0) - (b.id || 0));
  else if (state.sort === "title") sorted.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
  else sorted.sort(sortById);
  return sorted;
}

function groupObservations(rows) {
  if (state.group === "none") return [{ label: null, rows }];

  const buckets = new Map();
  for (const o of rows) {
    let key;
    if (state.group === "day") key = dayKey(o.created_at);
    else if (state.group === "type") key = o.type || "unknown";
    else if (state.group === "topic") key = o.topic_key || "(no topic key)";
    else if (state.group === "session") key = o.session_id || "unknown session";
    else if (state.group === "pinned") key = isPinned(o) ? "★ Pinned" : "Not pinned";
    else key = o.scope || "unknown scope";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }

  let entries = [...buckets.entries()];
  if (state.group === "day") entries.sort((a, b) => (state.sort === "oldest" ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0])));
  else if (state.group === "pinned") entries.sort((a, b) => (a[0] === "★ Pinned" ? -1 : 1));
  else if (state.group === "type") {
    entries.sort((a, b) => {
      const ia = TYPE_ORDER.indexOf(a[0]); const ib = TYPE_ORDER.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  } else entries.sort((a, b) => b[1].length - a[1].length);

  return entries.map(([key, value]) => ({
    label: state.group === "day" ? dayLabel(key) : key,
    rows: value,
  }));
}

function observationCard(o, selectedId) {
  const projectChip = state.project === ALL && o.project ? `<span class="tag">${esc(o.project)}</span>` : "";
  const label = `${o.type || "memory"}: ${o.title || "untitled"}`;
  return `<article class="card ${typeClass(o.type)}${o.id === selectedId ? " selected" : ""}" data-obs="${esc(o.id)}" role="button" tabindex="0" aria-label="${esc(label)}">
    <div class="card-top">
      <span class="badge">${esc(o.type || "?")}</span>
      ${isPinned(o) ? `<span class="card-star" title="Pinned in Engram">★</span>` : ""}
      <span class="card-title">${esc(o.title || "(untitled)")}</span>
    </div>
    <div class="card-meta">
      <span title="${esc(fmtDate(o.created_at))}">${esc(relTime(o.created_at))}</span>
      ${o.topic_key ? `<span class="tag">${esc(o.topic_key)}</span>` : ""}
      ${projectChip}
      ${o.scope && o.scope !== "project" ? `<span class="tag">${esc(o.scope)}</span>` : ""}
      ${(o.revision_count || 1) > 1 ? `<span class="faint">rev ${esc(o.revision_count)}</span>` : ""}
      ${(o.duplicate_count || 1) > 1 ? `<span class="faint">×${esc(o.duplicate_count)}</span>` : ""}
    </div>
    ${state.query.trim() ? `<div class="card-snippet">${esc(snippet(o.content, 260))}</div>` : ""}
  </article>`;
}

function renderObservations() {
  const rows = filteredObservations();
  const selectedId = state.drawer?.kind === "observation" ? state.drawer.data.id : null;

  const visible = rows.slice(0, state.limit);
  const groups = groupObservations(visible);

  let html = "";
  if (!rows.length) {
    html = emptyState(
      state.observations.length ? "No observations match these filters." : "This project has no observations yet.",
      state.observations.length ? "Try clearing the search or the type filters." : "Create one with “New observation”."
    );
  } else {
    for (const g of groups) {
      if (g.label !== null) {
        html += `<div class="group-head"><span>${esc(g.label)}</span><span class="gn">${g.rows.length}</span></div>`;
      }
      html += `<div class="cards">${g.rows.map((o) => observationCard(o, selectedId)).join("")}</div>`;
    }
    if (rows.length > visible.length) {
      html += `<button class="btn load-more" id="load-more">Show ${Math.min(PAGE_SIZE, rows.length - visible.length)} more · ${visible.length} of ${rows.length}</button>`;
    }
  }
  return { html, shown: rows.length, total: state.observations.length };
}

/* ------------------------------------------------------------------ *
 * other views
 * ------------------------------------------------------------------ */

function renderPrompts() {
  const q = state.query.trim().toLowerCase();
  let rows = state.prompts;
  if (q) rows = rows.filter((p) =>
    String(p.content || "").toLowerCase().includes(q) ||
    String(p.project || "").toLowerCase().includes(q)
  );

  state._filteredCount = rows.length;
  if (!rows.length) {
    return { html: emptyState(state.prompts.length ? "No prompts match your filter." : "No prompts stored for this selection.", ""), shown: 0, total: state.prompts.length };
  }

  const visible = rows.slice(0, state.limit);
  const html = `<div class="cards">` + visible.map((p) => `
    <article class="card t-other" data-prompt="${p.id}" role="button" tabindex="0" aria-label="Prompt ${p.id}">
      <div class="card-top">
        <span class="badge">PROMPT</span>
        <span class="card-title">${esc(snippet(p.content, 110))}</span>
      </div>
      <div class="card-meta">
        <span title="${esc(fmtDate(p.created_at))}">${esc(fmtDate(p.created_at))}</span>
        ${state.project === ALL && p.project ? `<span class="tag">${esc(p.project)}</span>` : ""}
        <span class="faint mono">#${p.id}</span>
      </div>
    </article>`).join("") + `</div>` +
    (rows.length > visible.length ? `<button class="btn load-more" id="load-more">Show ${Math.min(PAGE_SIZE, rows.length - visible.length)} more · ${visible.length} of ${rows.length}</button>` : "");

  return { html, shown: rows.length, total: state.prompts.length };
}

function renderSessions() {
  const q = state.query.trim().toLowerCase();
  let rows = state.sessions;
  if (q) rows = rows.filter((s) =>
    String(s.id || "").toLowerCase().includes(q) ||
    String(s.project || "").toLowerCase().includes(q)
  );

  if (!rows.length) {
    return { html: emptyState(state.sessions.length ? "No sessions match your filter." : "No sessions for this selection.", ""), shown: 0, total: state.sessions.length };
  }

  const visible = rows.slice(0, state.limit);
  const html = `<div class="cards">` + visible.map((s) => `
    <article class="card t-other" data-session="${esc(s.id)}" role="button" tabindex="0" aria-label="Session ${esc(s.id)}">
      <div class="card-top">
        <span class="badge">SESSION</span>
        <span class="card-title mono">${esc(s.id)}</span>
      </div>
      <div class="card-meta">
        <span title="${esc(fmtDate(s.started_at))}">${esc(fmtDate(s.started_at))}</span>
        ${state.project === ALL && s.project ? `<span class="tag">${esc(s.project)}</span>` : ""}
        <span>${s.observation_count ?? 0} observations</span>
      </div>
    </article>`).join("") + `</div>` +
    (rows.length > visible.length ? `<button class="btn load-more" id="load-more">Show ${Math.min(PAGE_SIZE, rows.length - visible.length)} more · ${visible.length} of ${rows.length}</button>` : "");

  return { html, shown: rows.length, total: state.sessions.length };
}

function renderRelations() {
  const q = state.query.trim().toLowerCase();
  let rows = state.relations;
  if (state.scopeFilter) rows = rows.filter((r) => r.judgment_status === state.scopeFilter);
  if (q) rows = rows.filter((r) =>
    String(r.source_title || "").toLowerCase().includes(q) ||
    String(r.target_title || "").toLowerCase().includes(q) ||
    String(r.relation || "").toLowerCase().includes(q)
  );

  if (!rows.length) {
    return { html: emptyState("No memory relations for this selection.", "Engram creates relations when it detects related, duplicate or conflicting memories."), shown: 0, total: state.relations.length };
  }

  const visible = rows.slice(0, state.limit);
  const pending = rows.filter((r) => r.judgment_status === "pending").length;
  const html = `<p class="faint" style="margin:0 0 10px">
      ${esc(pending)} of ${esc(rows.length)} relations still await a judgment. Judging uses Engram's own
      <code>conflicts/judge-many</code>; a relation can be re-judged at any time.
    </p>` +
    `<table class="grid"><thead><tr>
      <th>Relation</th><th>Status</th><th>Source</th><th>Target</th><th>Judge as</th>
    </tr></thead><tbody>` +
    visible.map((r) => `<tr>
      <td>
        <span class="tag">${esc(r.relation || "?")}</span>
        ${r.confidence != null ? `<div class="faint">${esc(Math.round(Number(r.confidence) * 100))}% confidence</div>` : ""}
      </td>
      <td>${esc(r.judgment_status || "?")}</td>
      <td>${esc(snippet(r.source_title || r.source_id || "—", 70))}</td>
      <td>${esc(snippet(r.target_title || r.target_id || "—", 70))}</td>
      <td>${r.judgment_status === "pending" && r.sync_id
        ? `<select class="judge-verb" data-judgment="${esc(r.sync_id)}" aria-label="Judge relation ${esc(r.sync_id)}">
             <option value="">choose…</option>
             ${JUDGE_VERBS.map((v) => `<option value="${v}">${v}</option>`).join("")}
           </select>`
        : `<span class="faint">${esc(r.marked_by_kind || "—")}</span>`}</td>
    </tr>`).join("") +
    `</tbody></table>` +
    (rows.length > visible.length ? `<button class="btn load-more" id="load-more">Show ${Math.min(PAGE_SIZE, rows.length - visible.length)} more · ${visible.length} of ${rows.length}</button>` : "");

  return { html, shown: rows.length, total: state.relations.length };
}

/**
 * Record one relation judgment. `judgment_id` is the relation's `sync_id` — that
 * is the identity Engram's store looks up — and the outcome array is per-item, so
 * a refusal is reported without disturbing anything else.
 */
async function judgeRelation(syncId, verb, select) {
  if (!verb) return;
  select.disabled = true;
  try {
    const res = await api("/conflicts/judge-many", {
      method: "POST",
      body: { judgments: [{ judgment_id: syncId, relation: verb }] },
    });
    const outcome = Array.isArray(res?.outcomes) ? res.outcomes[0] : null;
    if (outcome?.status === "success") {
      toast(`Relation judged as "${verb}".`, "ok");
      await loadRelations();
      renderAll();
      return;
    }
    toast(`Engram refused that judgment: ${outcome?.error || "unknown reason"}`, "error");
  } catch (err) {
    toast(`Judging failed: ${err.message}`, "error");
  }
  select.disabled = false;
  select.value = "";
}

function renderOverview() {
  const s = state.stats || {};
  const obs = state.observations;
  const byType = {};
  const byScope = {};
  let pinned = 0;
  for (const o of obs) {
    byType[o.type] = (byType[o.type] || 0) + 1;
    byScope[o.scope] = (byScope[o.scope] || 0) + 1;
    if (isPinned(o)) pinned++;
  }
  const topics = new Set(obs.map((o) => o.topic_key).filter(Boolean));

  let html = `<div class="stat-row">
    <div class="stat"><div class="sv">${s.total_observations ?? obs.length}</div><div class="sl">Observations</div></div>
    <div class="stat"><div class="sv">${s.total_sessions ?? state.sessions.length}</div><div class="sl">Sessions</div></div>
    <div class="stat"><div class="sv">${s.total_prompts ?? state.prompts.length}</div><div class="sl">Prompts</div></div>
    <div class="stat"><div class="sv">${topics.size}</div><div class="sl">Distinct topic keys</div></div>
    <div class="stat"><div class="sv">${pinned}</div><div class="sl">Pinned</div></div>
    <div class="stat"><div class="sv">${state.projects.length}</div><div class="sl">Projects</div></div>
  </div>`;

  html += `<h2 class="sec">By type</h2><table class="grid"><thead><tr><th>Type</th><th class="num">Count</th></tr></thead><tbody>` +
    TYPE_ORDER.filter((t) => byType[t]).map((t) =>
      `<tr><td><span class="badge ${typeClass(t)}">${esc(t)}</span></td><td class="num">${byType[t]}</td></tr>`).join("") +
    Object.keys(byType).filter((t) => !TYPES_KNOWN.has(t)).map((t) =>
      `<tr><td><span class="badge ${typeClass(t)}">${esc(t)}</span></td><td class="num">${byType[t]}</td></tr>`).join("") +
    `</tbody></table>`;

  html += `<h2 class="sec">By scope</h2><table class="grid"><thead><tr><th>Scope</th><th class="num">Count</th></tr></thead><tbody>` +
    Object.entries(byScope).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join("") +
    `</tbody></table>`;

  html += `<h2 class="sec">Projects in this store</h2><table class="grid"><thead><tr>
      <th>Project</th><th class="num">Observations</th><th class="num">Sessions</th><th class="num">Prompts</th></tr></thead><tbody>` +
    state.projects.map((p) => `<tr>
      <td><button class="ghost-btn" style="text-align:left;padding:2px 4px" data-project="${esc(p.name)}">${esc(p.name)}</button></td>
      <td class="num">${p.observation_count ?? 0}</td>
      <td class="num">${p.session_count ?? 0}</td>
      <td class="num">${p.prompt_count ?? 0}</td></tr>`).join("") +
    `</tbody></table>`;

  if (state.doctor) {
    const d = state.doctor;
    const checks = (d.checks || []).map((c) => `<tr>
        <td>${esc(c.check_id)}</td><td>${esc(c.result)}</td><td>${esc(c.severity || "")}</td>
        <td class="faint">${esc(c.reason_code || "")}</td></tr>`).join("");
    html += `<h2 class="sec">Engram doctor — ${esc(d.status)}</h2>`;
    if (d.summary) {
      html += `<div class="stat-row">` + Object.entries(d.summary).map(([k, v]) =>
        `<div class="stat"><div class="sv">${esc(v)}</div><div class="sl">${esc(k.replace(/_/g, " "))}</div></div>`).join("") + `</div>`;
    }
    html += `<table class="grid"><thead><tr><th>Check</th><th>Result</th><th>Severity</th><th>Reason</th></tr></thead><tbody>${checks}</tbody></table>`;
  }

  return { html, shown: state.observations.length, total: state.observations.length };
}

function emptyState(title, hint) {
  return `<div class="empty"><div class="big">🧠</div><div>${esc(title)}</div>` +
    (hint ? `<div class="faint" style="margin-top:6px">${esc(hint)}</div>` : "") + `</div>`;
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

function renderToolbar() {
  const bar = $("toolbar");
  const v = state.view;

  if (v === "overview") { bar.innerHTML = ""; return; }

  const searchPlaceholder = {
    observations: "Filter observations by title, content, topic, type, session…",
    prompts: "Filter prompts…",
    sessions: "Filter sessions…",
    relations: "Filter relations…",
  }[v] || "Filter…";

  let html =
    `<div class="search-wrap">
      <input id="search" type="search" placeholder="${esc(searchPlaceholder)}" value="${esc(state.query)}" />
      ${state.query ? `<button class="clear" id="search-clear" title="Clear">✕</button>` : ""}
    </div>`;

  if (v === "observations") {
    const counts = {};
    for (const o of state.observations) counts[o.type] = (counts[o.type] || 0) + 1;
    const present = [...TYPE_ORDER.filter((t) => counts[t]), ...Object.keys(counts).filter((t) => !TYPES_KNOWN.has(t))];

    html += `<select id="group" class="control" title="Grouping">` +
      GROUPINGS.map((g) => `<option value="${g.id}"${state.group === g.id ? " selected" : ""}>${g.label}</option>`).join("") +
      `</select>`;
    html += `<select id="sort" class="control" title="Sort order">` +
      SORTS.map((s) => `<option value="${s.id}"${state.sort === s.id ? " selected" : ""}>${s.label}</option>`).join("") +
      `</select>`;
    html += `<select id="scope-filter" class="control" title="Scope">` +
      `<option value="">All scopes</option>` +
      SCOPES.map((s) => `<option value="${s}"${state.scopeFilter === s ? " selected" : ""}>${s}</option>`).join("") +
      `</select>`;
    const pinnedCount = state.observations.filter((o) => isPinned(o)).length;
    html += `<button class="chip${state.pinnedOnly ? " on" : ""}" id="toggle-pinned" title="Show only pinned observations">★ Pinned<span class="c">${esc(pinnedCount)}</span></button>`;
    html += `<button class="chip${state.hideSummary ? " on" : ""}" id="toggle-summary" title="Hide session summaries">Hide summaries</button>`;
    html += `</div><div class="chips" style="width:100%">` +
      present.map((t) =>
        `<button class="chip ${typeClass(t)}${state.typeFilter.has(t) ? " on" : ""}" data-type="${esc(t)}">` +
        `<span class="tdot"></span>${esc(t)}<span class="c">${counts[t]}</span></button>`).join("") +
      (state.typeFilter.size ? `<button class="chip" id="clear-types">clear types ✕</button>` : "") +
      `</div>`;
  } else if (v === "relations") {
    html += `<select id="scope-filter" class="control" title="Judgment status">
      <option value="">All statuses</option>
      <option value="pending"${state.scopeFilter === "pending" ? " selected" : ""}>pending</option>
      <option value="judged"${state.scopeFilter === "judged" ? " selected" : ""}>judged</option>
      <option value="deferred"${state.scopeFilter === "deferred" ? " selected" : ""}>deferred</option>
    </select>`;
  }

  bar.innerHTML = html;
}

function renderActions() {
  const box = $("view-actions");
  if (state.view === "observations") {
    box.innerHTML = `<button class="btn primary" id="new-observation">+ New observation</button>`;
  } else if (state.view === "overview") {
    box.innerHTML = state.project !== ALL
      ? `<button class="btn" id="export-project">⬇ Export JSON</button>`
      : `<div class="faint" style="align-self:center">Select one project to export</div>`;
  } else {
    box.innerHTML = "";
  }
}

function renderContent() {
  if (state.loading) {
    $("content").innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading from Engram…</div>`;
    $("view-count").textContent = "";
    return;
  }

  const result =
    state.view === "observations" ? renderObservations() :
    state.view === "prompts" ? renderPrompts() :
    state.view === "sessions" ? renderSessions() :
    state.view === "relations" ? renderRelations() :
    renderOverview();

  $("content").innerHTML = result.html;
  $("content").scrollTop = 0;

  const shown = result.shown ?? 0;
  const total = result.total ?? 0;
  $("view-count").textContent = state.view === "overview"
    ? `${total} observations`
    : (shown === total ? `${total}` : `${shown} of ${total}`);
}

function renderAll() {
  renderViewsNav();
  renderToolbar();
  renderActions();
  renderContent();
}

function renderProjectHeader() {
  const label = state.project === ALL ? "All projects" : (state.project || "—");
  $("view-title").textContent = VIEWS.find((v) => v.id === state.view)?.label || "Engram";
  $("view-title").textContent += ` — ${label}`;
}

/* ------------------------------------------------------------------ *
 * drawer — observation detail
 * ------------------------------------------------------------------ */

const EDITABLE_TYPES = [...TYPE_ORDER];

async function openObservation(id) {
  const cached = state.observations.find((o) => o.id === id);
  const project = cached?.project || (state.project === ALL ? null : state.project);

  state.drawer = { kind: "observation", data: cached || { id }, project, editing: false, history: null, historyCount: null, busy: false };
  renderDrawer();

  try {
    const params = new URLSearchParams();
    if (project) params.set("project", project);
    params.set("include_history", "true");
    const fresh = await api(`/observations/${id}?${params}`);

    // Engram builds that expose versions answer with version_count. Detect it once
    // rather than showing an empty "version history" section forever.
    if (state.historySupported === null) {
      state.historySupported = Object.prototype.hasOwnProperty.call(fresh, "version_count");
    }

    state.drawer.data = fresh;
    state.drawer.project = fresh.project || project;
    state.drawer.history = fresh.history || [];
    state.drawer.historyCount = fresh.version_count ?? fresh.revision_count ?? null;

    if (state.drawer.project) await hydratePins(state.drawer.project);
  } catch (err) {
    toast(`Could not load observation #${id}: ${err.message}`, "error");
  }
  renderDrawer();
  renderContent();
}

function renderDrawer() {
  const panel = $("drawer");
  const d = state.drawer;
  if (!d) { panel.hidden = true; panel.innerHTML = ""; return; }

  if (d.kind === "observation") return renderObservationDrawer(panel, d);
  if (d.kind === "session") return renderSessionDrawer(panel, d);
  if (d.kind === "prompt") return renderPromptDrawer(panel, d);
}

function renderObservationDrawer(panel, d) {
  const o = d.data || {};
  const busy = d.busy ? " disabled" : "";
  const revCount = d.historyCount ?? (o.revision_count || 1);
  const pinned = o.pinned === true || isPinned(o);
  const showHistory = state.historySupported === true && ((d.history?.length || 0) > 0 || revCount > 1);
  const historyUnsupported = state.historySupported === false && revCount > 1;

  let body;
  if (d.editing) {
    body = `
      <div class="field">
        <label for="f-title">Title</label>
        <input id="f-title" type="text" value="${esc(o.title || "")}"${busy} />
      </div>
      <div class="field">
        <label for="f-content">Content</label>
        <textarea id="f-content" rows="14"${busy}>${esc(o.content || "")}</textarea>
        <div class="hint">Saving stores the previous text as a version, exactly like Engram's own <code>mem_update</code>.</div>
      </div>
      <div class="meta-grid">
        <div class="field">
          <label for="f-type">Type</label>
          <select id="f-type"${busy}>${EDITABLE_TYPES.map((t) => `<option value="${t}"${o.type === t ? " selected" : ""}>${t}</option>`).join("")}
            ${o.type && !EDITABLE_TYPES.includes(o.type) ? `<option value="${esc(o.type)}" selected>${esc(o.type)}</option>` : ""}
          </select>
        </div>
        <div class="field">
          <label for="f-scope">Scope</label>
          <select id="f-scope"${busy}>${SCOPES.map((s) => `<option value="${s}"${o.scope === s ? " selected" : ""}>${s}</option>`).join("")}${o.scope && !SCOPES.includes(o.scope) ? `<option value="${esc(o.scope)}" selected>${esc(o.scope)}</option>` : ""}</select>
          <div class="hint">Engram also stores other scopes; an unknown one is kept as-is rather than rewritten.</div>
        </div>
        <div class="field">
          <label for="f-topic">Topic key</label>
          <input id="f-topic" type="text" value="${esc(o.topic_key || "")}" placeholder="optional/stable-topic-key"${busy} />
        </div>
        <div class="field">
          <label>Project</label>
          <div class="readonly-value">${esc(o.project || "—")}</div>
          <div class="hint">Engram treats project ownership as immutable.</div>
        </div>
        <div class="field">
          <label>Engram id</label>
          <div class="readonly-value">#${esc(o.id)}</div>
        </div>
      </div>
      <div class="divider"></div>
      <h2 class="sec">Find &amp; replace saved text</h2>
      <div class="meta-grid">
        <div class="field">
          <label for="fr-find">Find</label>
          <input id="fr-find" type="text" placeholder="exact text to find"${busy} />
        </div>
        <div class="field">
          <label for="fr-replace">Replace with</label>
          <input id="fr-replace" type="text" placeholder="replacement text"${busy} />
        </div>
      </div>
      <button class="btn" id="apply-fr"${busy}>Replace in saved content</button>
      <div class="hint" style="margin-top:6px">
        Engram performs this on the stored text itself (its <code>find</code>/<code>replace</code> update),
        saves a new revision, and refuses the change if the result would be empty.
      </div>`;
  } else {
    body = `
      <div class="field">
        <label>Content</label>
        <div class="content-box">${esc(o.content || "(empty)")}</div>
      </div>
      <div class="meta-grid">
        ${metaField("Project", o.project)}
        ${metaField("Scope", o.scope)}
        ${metaField("Topic key", o.topic_key || "—")}
        ${metaField("Session", o.session_id)}
        ${metaField("Sync id", o.sync_id)}
        ${metaField("Created", fmtDate(o.created_at))}
        ${metaField("Updated", fmtDate(o.updated_at))}
        ${metaField("Last seen", fmtDate(o.last_seen_at))}
        ${metaField("Review after", o.review_after ? fmtDate(o.review_after) : "—")}
        ${metaField("Revisions", String(revCount))}
        ${metaField("Duplicate count", String(o.duplicate_count ?? 1))}
        ${metaField("Engram id", `#${o.id}`)}
      </div>`;
  }

  let history = "";
  if (historyUnsupported && !d.editing) {
    history = `<div class="divider"></div><h2 class="sec">Version history</h2>
      <div class="faint">This Engram build (${esc(state.health?.version || "unknown")}) keeps revisions internally —
      <code>revision_count</code> is already ${esc(revCount)} — but does not expose them over HTTP, so the list cannot be
      shown here. Nothing is lost: upgrading Engram enables it automatically.</div>`;
  }
  if (showHistory && !d.editing) {
    const items = (d.history || []).slice(); // oldest first as returned
    history = `<div class="divider"></div><h2 class="sec">Version history (${d.historyCount ?? items.length})</h2>`;
    if (!items.length) {
      history += `<div class="faint">No previous versions loaded.</div>`;
    } else {
      history += items.map((h) => `
        <div class="hist-item">
          <div class="hh">
            <span class="tag">v${esc(h.version)}</span>
            <span>${esc(fmtDate(h.created_at))}</span>
            <span class="grow" style="flex:1"></span>
            <button class="chip" data-restore="${esc(h.version)}">Restore this version</button>
          </div>
          <div class="hc">${esc(h.content || "(empty)")}</div>
        </div>`).join("");
      if (d.historyTruncated) {
        history += `<div class="faint" style="margin-top:6px">History is paginated by Engram; showing the most recent page.</div>`;
      }
    }
  }

  panel.hidden = false;
  panel.innerHTML = `
    <div class="drawer-head">
      <div class="dh-main">
        <span class="badge ${typeClass(o.type)}">${esc(o.type || "?")}</span>
        ${pinned ? `<span class="card-star">★ pinned</span>` : ""}
        <h2>${esc(o.title || "(untitled)")}</h2>
      </div>
      <button class="icon-btn" id="drawer-close" title="Close (Esc)" aria-label="Close">✕</button>
    </div>
    <div class="drawer-body">${body}${history}</div>
    <div class="drawer-foot">
      ${d.editing
        ? `<button class="btn primary" id="save-obs"${busy}>Save changes</button>
           <button class="btn" id="cancel-edit"${busy}>Cancel</button>`
        : `<button class="btn primary" id="edit-obs">Edit</button>
           <button class="btn" id="pin-obs">${pinned ? "Unpin" : "Pin"}</button>
           <button class="btn" id="review-obs" title="Clear the review date for this memory">Mark reviewed</button>
           <button class="btn" id="copy-obs">Copy</button>`}
      <span class="grow"></span>
      ${d.editing ? "" : `<button class="btn danger" id="delete-obs"${busy}>Delete</button>`}
    </div>`;
}

function metaField(label, value) {
  return `<div class="field">
      <label>${esc(label)}</label>
      <div class="readonly-value">${esc(value ?? "—")}</div>
    </div>`;
}

async function saveObservation() {
  const d = state.drawer;
  if (!d || d.kind !== "observation") return;
  const o = d.data;

  const title = $("f-title").value;
  const content = $("f-content").value;
  const type = $("f-type").value;
  const scope = $("f-scope").value;
  const topicKey = $("f-topic").value;

  // Send only what actually changed: Engram rejects empty fields and records a
  // version on every update, so no-op writes would pollute the history.
  const patch = {};
  if (title !== (o.title || "")) patch.title = title;
  if (content !== (o.content || "")) patch.content = content;
  if (type !== (o.type || "")) patch.type = type;
  if (scope !== (o.scope || "")) patch.scope = scope;
  if (topicKey !== (o.topic_key || "")) patch.topic_key = topicKey;

  if (!Object.keys(patch).length) {
    d.editing = false;
    renderDrawer();
    toast("Nothing changed.", "ok");
    return;
  }
  if ("title" in patch && !patch.title.trim()) return toast("A title is required.", "error");
  if ("content" in patch && !patch.content.trim()) return toast("Content is required.", "error");
  // Engram accepts an empty type and would store it, leaving an unlabelled memory.
  if ("type" in patch && !patch.type.trim()) return toast("A type is required.", "error");

  d.busy = true;
  renderDrawer();
  try {
    const project = d.project || o.project;
    const updated = await api(`/observations/${o.id}?expected_project=${encodeURIComponent(project)}`, {
      method: "PATCH",
      body: patch,
    });
    d.data = updated;
    d.editing = false;
    toast("Observation updated.", "ok");
    // refresh list row + history
    const idx = state.observations.findIndex((x) => x.id === o.id);
    if (idx !== -1) state.observations[idx] = { ...state.observations[idx], ...updated };
    const params = new URLSearchParams({ include_history: "true" });
    if (project) params.set("project", project);
    const fresh = await api(`/observations/${o.id}?${params}`).catch(() => null);
    if (fresh) { d.data = fresh; d.history = fresh.history || []; d.historyCount = fresh.version_count; }
  } catch (err) {
    toast(`Update failed: ${err.message}`, "error");
  } finally {
    d.busy = false;
    renderDrawer();
    renderContent();
  }
}

/**
 * Engram's own surgical edit: it replaces `find` with `replace` inside the stored
 * content server-side and saves a new revision, so the browser never round-trips
 * the whole document just to change part of it.
 */
async function applyFindReplace() {
  const d = state.drawer;
  const o = d?.data;
  if (!o) return;

  // Refuse when the textarea holds unsaved edits: replacing the stored text while
  // the user is editing a different version of it would silently lose their work.
  const textarea = $("f-content");
  if (textarea && textarea.value !== (o.content || "")) {
    return toast("You have unsaved edits in the content box. Save or cancel them first.", "error");
  }

  const find = $("fr-find").value;
  const replace = $("fr-replace").value;
  if (!find) return toast("Write the text to find.", "error");

  const project = d.project || o.project;
  d.busy = true;
  renderDrawer();
  try {
    const updated = await api(`/observations/${o.id}?expected_project=${encodeURIComponent(project)}`, {
      method: "PATCH",
      body: { find, replace },
    });
    d.data = updated;
    d.historyCount = updated.revision_count ?? d.historyCount;
    const idx = state.observations.findIndex((x) => x.id === o.id);
    if (idx !== -1) state.observations[idx] = { ...state.observations[idx], ...updated };
    toast("Replaced in the stored content.", "ok");
  } catch (err) {
    toast(`Replace failed: ${err.message}`, "error");
  } finally {
    d.busy = false;
    renderDrawer();
    renderContent();
  }
}

async function togglePin() {
  const d = state.drawer;
  const o = d?.data;
  if (!o) return;
  const project = d.project || o.project;
  const next = !(o.pinned === true || isPinned(o));
  d.busy = true;
  renderDrawer();
  try {
    const res = await api(`/observations/${o.id}/pin`, { method: next ? "PUT" : "DELETE" });
    // Engram answers {id, pinned}; that response is the authoritative value.
    const actual = typeof res?.pinned === "boolean" ? res.pinned : next;
    o.pinned = actual;
    setPinned(project, o.id, actual);
    const idx = state.observations.findIndex((x) => x.id === o.id);
    if (idx !== -1) state.observations[idx].pinned = actual;
    toast(actual ? "Pinned." : "Unpinned.", "ok");
  } catch (err) {
    toast(`Could not change pin: ${err.message}`, "error");
  } finally {
    d.busy = false;
    renderDrawer();
    renderContent();
  }
}

async function markReviewed() {
  const d = state.drawer;
  const o = d?.data;
  if (!o) return;
  const project = d.project || o.project;
  d.busy = true;
  renderDrawer();
  try {
    const params = project ? `?project=${encodeURIComponent(project)}` : "";
    await api(`/review/mark_reviewed${params}`, { method: "POST", body: { observation_id: o.id } });
    toast("Marked as reviewed.", "ok");
  } catch (err) {
    toast(`Could not mark reviewed: ${err.message}`, "error");
  } finally {
    d.busy = false;
    renderDrawer();
  }
}

async function deleteObservation() {
  const d = state.drawer;
  const o = d?.data;
  if (!o) return;
  const project = d.project || o.project;

  const ok = await confirmModal({
    title: "Delete this observation?",
    body: `Engram will soft-delete observation <b>#${o.id}</b> from project <code>${esc(project)}</code>. ` +
          `It disappears from search and listings and the deletion syncs to the cloud, but the row stays in the store — ` +
          `Engram's HTTP API has no purge. To remove it for good later, run:<br><br>` +
          `<code>engram delete ${o.id} --hard</code>`,
    confirmLabel: "Delete observation",
    requireText: project,
    requireLabel: `Type the project name to confirm`,
  });
  if (!ok) return;

  try {
    await api(`/observations/${o.id}?expected_project=${encodeURIComponent(project)}`, { method: "DELETE" });
    state.observations = state.observations.filter((x) => x.id !== o.id);
    closeDrawer();
    toast("Observation deleted.", "ok");
    renderAll();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, "error");
  }
}

/* ------------------------------------------------------------------ *
 * drawer — session / prompt
 * ------------------------------------------------------------------ */

async function openSession(id, project) {
  state.drawer = { kind: "session", data: { id, project }, busy: false };
  renderDrawer();
  try {
    const params = project && project !== ALL ? `?project=${encodeURIComponent(project)}` : "";
    state.drawer.data = { ...(await api(`/sessions/${encodeURIComponent(id)}${params}`)), project };
  } catch (err) {
    toast(`Could not load session: ${err.message}`, "error");
  }
  renderDrawer();
}

function renderSessionDrawer(panel, d) {
  const s = d.data || {};
  panel.hidden = false;
  panel.innerHTML = `
    <div class="drawer-head">
      <div class="dh-main">
        <span class="badge">SESSION</span>
        <h2 class="mono" style="font-size:13px">${esc(s.id || "")}</h2>
      </div>
      <button class="icon-btn" id="drawer-close" title="Close (Esc)">✕</button>
    </div>
    <div class="drawer-body">
      <div class="meta-grid">
        ${metaField("Project", s.project || d.data.project)}
        ${metaField("Directory", s.directory)}
        ${metaField("Started", fmtDate(s.started_at))}
        ${metaField("Ended", s.ended_at ? fmtDate(s.ended_at) : "still open")}
        ${metaField("Ownership", s.ownership_mode)}
        ${metaField("Observations", String(s.observation_count ?? "—"))}
      </div>
      ${s.summary ? `<div class="field"><label>Summary</label><div class="content-box">${esc(s.summary)}</div></div>` : ""}
      <div class="divider"></div>
      <h2 class="sec">Finalize session</h2>
      <div class="field">
        <label for="s-summary">Summary</label>
        <textarea id="s-summary" rows="8" placeholder="## Goal&#10;…&#10;## Accomplished&#10;…&#10;## Next Steps&#10;…"></textarea>
        <div class="hint">Engram saves this as a session-summary observation and closes the session in one atomic step.</div>
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn primary" id="finalize-session">Finalize with summary</button>
      <button class="btn" id="end-session">End session</button>
      <button class="btn" id="copy-session">Copy ID</button>
      <span class="grow"></span>
      <button class="btn danger" id="delete-session" title="Engram only deletes sessions with no observations">Delete</button>
    </div>`;
}

async function finalizeSession() {
  const d = state.drawer;
  const summary = $("s-summary").value.trim();
  const project = d.data.project || d.data.project;
  if (!summary) return toast("Write a summary first.", "error");
  if (!project || project === ALL) return toast("A concrete project is required to finalize.", "error");

  d.busy = true;
  try {
    await api(`/sessions/${encodeURIComponent(d.data.id)}/finalize`, { method: "POST", body: { project, summary } });
    toast("Session finalized.", "ok");
    closeDrawer();
    await reload();
  } catch (err) {
    toast(`Finalize failed: ${err.message}`, "error");
  } finally {
    d.busy = false;
    renderDrawer();
  }
}

async function endSession() {
  const d = state.drawer;
  try {
    await api(`/sessions/${encodeURIComponent(d.data.id)}/end`, { method: "POST", body: {} });
    toast("Session ended.", "ok");
    closeDrawer();
    await reload();
  } catch (err) {
    toast(`End failed: ${err.message}`, "error");
  }
}

async function deleteSession() {
  const d = state.drawer;
  const id = d.data.id;
  const ok = await confirmModal({
    title: "Delete this session?",
    body: `Engram refuses to delete a session that still has observations. This is permanent for sessions.`,
    confirmLabel: "Delete session",
    requireText: id,
    requireLabel: "Type the session id to confirm",
  });
  if (!ok) return;
  try {
    await api(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("Session deleted.", "ok");
    closeDrawer();
    await reload();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, "error");
  }
}

async function openPrompt(id) {
  const p = state.prompts.find((x) => x.id === id) || { id };
  state.drawer = { kind: "prompt", data: p };
  renderDrawer();
}

function renderPromptDrawer(panel, d) {
  const p = d.data || {};
  panel.hidden = false;
  panel.innerHTML = `
    <div class="drawer-head">
      <div class="dh-main">
        <span class="badge">PROMPT #${esc(p.id)}</span>
        <h2>${esc(fmtDate(p.created_at))}</h2>
      </div>
      <button class="icon-btn" id="drawer-close" title="Close (Esc)">✕</button>
    </div>
    <div class="drawer-body">
      <div class="field"><label>Prompt</label><div class="content-box">${esc(p.content || "")}</div></div>
      <div class="meta-grid">
        ${metaField("Project", p.project)}
        ${metaField("Session", p.session_id)}
        ${metaField("Sync id", p.sync_id)}
        ${metaField("Created", fmtDate(p.created_at))}
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn" id="copy-prompt">Copy</button>
      <span class="grow"></span>
      <button class="btn danger" id="delete-prompt">Delete</button>
    </div>`;
}

async function deletePrompt() {
  const d = state.drawer;
  const id = d.data.id;
  const ok = await confirmModal({
    title: "Delete this prompt?",
    body: `Engram deletes prompts permanently — there is no soft delete and no version history for prompts.`,
    confirmLabel: "Delete prompt",
    requireText: `#${id}`,
    requireLabel: "Type the prompt number to confirm",
  });
  if (!ok) return;
  try {
    await api(`/prompts/${id}`, { method: "DELETE" });
    state.prompts = state.prompts.filter((x) => x.id !== id);
    closeDrawer();
    toast("Prompt deleted.", "ok");
    renderAll();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, "error");
  }
}

function closeDrawer() {
  state.drawer = null;
  renderDrawer();
  renderContent();
}

/* ------------------------------------------------------------------ *
 * modal
 * ------------------------------------------------------------------ */

function confirmModal({ title, body, confirmLabel, requireText, requireLabel }) {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.hidden = false;
    modal.innerHTML = `
      <div class="modal-box">
        <div class="modal-head"><h2>${esc(title)}</h2><p>${body}</p></div>
        <div class="modal-body">
          <div class="field">
            <label for="confirm-text">${esc(requireLabel)}</label>
            <input id="confirm-text" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(requireText)}" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn danger" id="modal-confirm" disabled>${esc(confirmLabel)}</button>
        </div>
      </div>`;

    const input = $("confirm-text");
    const confirm = $("modal-confirm");
    const done = (value) => { modal.hidden = true; modal.innerHTML = ""; resolve(value); };

    input.addEventListener("input", () => { confirm.disabled = input.value.trim() !== requireText; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !confirm.disabled) done(true);
      if (e.key === "Escape") done(false);
    });
    $("modal-cancel").addEventListener("click", () => done(false));
    confirm.addEventListener("click", () => done(true));
    input.focus();
  });
}

/* ------------------------------------------------------------------ *
 * create observation
 * ------------------------------------------------------------------ */

async function openCreateModal() {
  if (!state.projects.length) return toast("No projects available.", "error");

  // With no single project selected, default to the project Engram resolves from the
  // current directory, so the form opens on what the user is actually working on.
  const project = state.project === ALL
    ? (state.detectedProject || state.projects[0].name)
    : state.project;

  const sessions = state.sessions.filter((s) => s.project === project);
  const modal = $("modal");
  modal.hidden = false;

  const sessionOptions = sessions.length
    ? sessions.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${s.observation_count ?? 0} obs · ${esc(fmtDate(s.started_at))}</option>`).join("")
    : `<option value="">— no sessions yet —</option>`;

  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <h2>New observation</h2>
        <p>Written through Engram's own <code>POST /observations</code>, so indexing, project scope and sync all keep working.</p>
      </div>
      <div class="modal-body">
        <div class="field">
          <label for="c-project">Project</label>
          <select id="c-project">${state.projects.map((p) => `<option value="${esc(p.name)}"${p.name === project ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label for="c-session">Session</label>
          <select id="c-session">${sessionOptions}</select>
          <div class="hint" id="c-session-hint">Engram requires every observation to belong to an existing session.</div>
        </div>
        <div class="meta-grid">
          <div class="field">
            <label for="c-type">Type</label>
            <select id="c-type">${EDITABLE_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
          </div>
          <div class="field">
            <label for="c-scope">Scope</label>
            <select id="c-scope">${SCOPES.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
          </div>
        </div>
        <div class="field">
          <label for="c-title">Title</label>
          <input id="c-title" type="text" placeholder="Short, searchable title" />
        </div>
        <div class="field">
          <label for="c-content">Content</label>
          <textarea id="c-content" rows="8" placeholder="What should future sessions know?"></textarea>
        </div>
        <div class="field">
          <label for="c-topic">Topic key (optional)</label>
          <input id="c-topic" type="text" placeholder="architecture/auth-model" />
          <div class="hint">Reusing a topic key makes Engram treat this as an update to that topic.</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn primary" id="c-save">Save to Engram</button>
      </div>
    </div>`;

  const sessionSelect = $("c-session");
  const projectSelect = $("c-project");

  // Sessions must be refreshed per project: Engram rejects a session/project mismatch.
  projectSelect.addEventListener("change", async () => {
    const name = projectSelect.value;
    try {
      const rows = await api(`/sessions/recent?project=${encodeURIComponent(name)}&limit=200`);
      sessionSelect.innerHTML = rows.length
        ? rows.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${s.observation_count ?? 0} obs · ${esc(fmtDate(s.started_at))}</option>`).join("")
        : `<option value="">— no sessions yet —</option>`;
    } catch {
      sessionSelect.innerHTML = `<option value="">— could not load sessions —</option>`;
    }
    $("c-session-hint").textContent = sessionSelect.value
      ? "Engram requires every observation to belong to an existing session."
      : "This project has no session yet. Create one from the Sessions view first, or use Engram itself.";
  });

  const close = () => { modal.hidden = true; modal.innerHTML = ""; };
  $("modal-cancel").addEventListener("click", close);

  $("c-save").addEventListener("click", async () => {
    const sessionId = sessionSelect.value;
    const content = $("c-content").value.trim();
    const title = $("c-title").value.trim();
    if (!sessionId) return toast("Pick a session first.", "error");
    if (!content) return toast("Content is required.", "error");

    const body = {
      session_id: sessionId,
      content,
      title: title || content.split("\n")[0].slice(0, 80),
      type: $("c-type").value,
      project: projectSelect.value,
      scope: $("c-scope").value,
    };
    const topic = $("c-topic").value.trim();
    if (topic) body.topic_key = topic;

    try {
      const created = await api("/observations", { method: "POST", body });
      close();
      toast("Observation saved to Engram.", "ok");
      await reload();
      if (created && created.id) openObservation(created.id);
    } catch (err) {
      toast(`Could not save: ${err.message}`, "error");
    }
  });
}

/* ------------------------------------------------------------------ *
 * toast
 * ------------------------------------------------------------------ */

let toastTimer = null;
function toast(message, kind = "ok") {
  const box = $("toast");
  box.hidden = false;
  box.className = `toast ${kind}`;
  box.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === "error" ? 7000 : 3200);
}

/* ------------------------------------------------------------------ *
 * events
 * ------------------------------------------------------------------ */

function bindStaticEvents() {
  $("views").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (!btn) return;
    state.view = btn.dataset.view;
    state.query = "";
    state.scopeFilter = "";
    state.limit = PAGE_SIZE;
    renderProjectHeader();
    renderAll();
  });

  $("projects").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-project]");
    if (!btn) return;
    selectProject(btn.dataset.project);
  });

  $("project-filter").addEventListener("input", renderProjects);

  $("project-search-toggle").addEventListener("click", () => {
    const input = $("project-filter");
    input.hidden = !input.hidden;
    if (!input.hidden) input.focus();
  });

  $("reload").addEventListener("click", async () => {
    await loadHealth();
    await loadProjects();
    await reload();
    toast("Reloaded from Engram.", "ok");
  });

  $("view-actions").addEventListener("click", async (e) => {
    if (e.target.closest("#new-observation")) return openCreateModal();
    if (e.target.closest("#export-project")) return exportProject();
  });

  $("toolbar").addEventListener("input", (e) => {
    if (e.target.id === "search") {
      state.query = e.target.value;
      state.limit = PAGE_SIZE;
      const clear = $("search-clear");
      if (clear) clear.hidden = !e.target.value;
      if (!clear && e.target.value) {
        const wrap = e.target.parentElement;
        wrap.insertAdjacentHTML("beforeend", `<button class="clear" id="search-clear" title="Clear">✕</button>`);
      }
      renderContent();
    }
  });

  $("toolbar").addEventListener("click", (e) => {
    if (e.target.closest("#search-clear")) {
      state.query = "";
      state.limit = PAGE_SIZE;
      renderToolbar();
      renderContent();
      $("search")?.focus();
      return;
    }
    const typeBtn = e.target.closest("[data-type]");
    if (typeBtn) {
      const t = typeBtn.dataset.type;
      if (state.typeFilter.has(t)) state.typeFilter.delete(t);
      else state.typeFilter.add(t);
      state.limit = PAGE_SIZE;
      renderToolbar();
      renderContent();
      return;
    }
    if (e.target.closest("#clear-types")) {
      state.typeFilter.clear();
      renderToolbar();
      renderContent();
      return;
    }
    if (e.target.closest("#toggle-summary")) {
      state.hideSummary = !state.hideSummary;
      renderToolbar();
      renderContent();
      return;
    }
    if (e.target.closest("#toggle-pinned")) {
      state.pinnedOnly = !state.pinnedOnly;
      renderToolbar();
      renderContent();
      return;
    }
  });

  $("toolbar").addEventListener("change", (e) => {
    if (e.target.id === "group") { state.group = e.target.value; renderContent(); }
    if (e.target.id === "sort") { state.sort = e.target.value; renderContent(); }
    if (e.target.id === "scope-filter") {
      state.scopeFilter = e.target.value;
      renderContent();
    }
  });

  $("content").addEventListener("click", async (e) => {
    if (e.target.closest("#load-more")) {
      state.limit += PAGE_SIZE;
      renderContent();
      return;
    }
    const card = e.target.closest("[data-obs]");
    if (card) return openObservation(Number(card.dataset.obs));

    const prompt = e.target.closest("[data-prompt]");
    if (prompt) return openPrompt(Number(prompt.dataset.prompt));

    const session = e.target.closest("[data-session]");
    if (session) return openSession(session.dataset.session, state.project);

    const proj = e.target.closest("[data-project]");
    if (proj) return selectProject(proj.dataset.project);
  });

  // Cards are buttons for the keyboard too, not only for the mouse.
  $("content").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const target = e.target.closest("[data-obs], [data-prompt], [data-session]");
    if (!target) return;
    e.preventDefault();
    target.click();
  });

  $("content").addEventListener("change", (e) => {
    const select = e.target.closest(".judge-verb");
    if (select) return judgeRelation(select.dataset.judgment, select.value, select);
  });

  $("drawer").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("#drawer-close")) return closeDrawer();

    if (t.closest("#edit-obs")) { state.drawer.editing = true; renderDrawer(); $("f-title")?.focus(); return; }
    if (t.closest("#cancel-edit")) { state.drawer.editing = false; renderDrawer(); return; }
    if (t.closest("#save-obs")) return saveObservation();
    if (t.closest("#apply-fr")) return applyFindReplace();
    if (t.closest("#pin-obs")) return togglePin();
    if (t.closest("#review-obs")) return markReviewed();
    if (t.closest("#delete-obs")) return deleteObservation();
    if (t.closest("#copy-obs")) return copyText(state.drawer.data?.content || "", "Content copied.");
    if (t.closest("#copy-prompt")) return copyText(state.drawer.data?.content || "", "Prompt copied.");
    if (t.closest("#copy-session")) return copyText(state.drawer.data?.id || "", "Session id copied.");
    if (t.closest("#finalize-session")) return finalizeSession();
    if (t.closest("#end-session")) return endSession();
    if (t.closest("#delete-session")) return deleteSession();
    if (t.closest("#delete-prompt")) return deletePrompt();

    const restore = t.closest("[data-restore]");
    if (restore) {
      const version = Number(restore.dataset.restore);
      const entry = (state.drawer.history || []).find((h) => h.version === version);
      if (!entry) return;
      const ok = await confirmModal({
        title: `Restore version ${version}?`,
        body: `Engram will save this older text as a new revision. Nothing is lost — the current text stays in the history.`,
        confirmLabel: "Restore",
        requireText: "restore",
        requireLabel: "Type <b>restore</b> to confirm",
      });
      if (!ok) return;
      const d = state.drawer;
      const project = d.project || d.data.project;
      try {
        const updated = await api(`/observations/${d.data.id}?expected_project=${encodeURIComponent(project)}`, {
          method: "PATCH",
          body: { title: entry.title || d.data.title, content: entry.content },
        });
        d.data = updated;
        toast(`Restored version ${version} as a new revision.`, "ok");
        const params = new URLSearchParams({ include_history: "true" });
        if (project) params.set("project", project);
        const fresh = await api(`/observations/${d.data.id}?${params}`).catch(() => null);
        if (fresh) { d.data = fresh; d.history = fresh.history || []; d.historyCount = fresh.version_count; }
      } catch (err) {
        toast(`Restore failed: ${err.message}`, "error");
      }
      renderDrawer();
      renderContent();
    }
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "Escape") {
      if (!$("modal").hidden) return;
      if (state.drawer) return closeDrawer();
    }
    if (typing) return;
    if (e.key === "/") { e.preventDefault(); $("search")?.focus(); }
    if (e.key === "r" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); $("reload").click(); }
  });
}

async function selectProject(name) {
  state.project = name;
  state.limit = PAGE_SIZE;
  state.drawer = null;
  renderDrawer();
  renderProjects();
  renderProjectHeader();
  await reload();
}

async function exportProject() {
  try {
    const res = await api(withProject("/export"), { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `engram-export-${state.project}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Export downloaded.", "ok");
  } catch (err) {
    toast(`Export failed: ${err.message}`, "error");
  }
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, "ok");
  } catch {
    toast("Clipboard blocked by the browser.", "error");
  }
}

/* ------------------------------------------------------------------ *
 * init
 * ------------------------------------------------------------------ */

async function init() {
  bindStaticEvents();
  renderViewsNav();

  await loadHealth();
  try {
    await loadProjects();
  } catch (err) {
    banner("error", `Cannot reach the Engram API. Start it with <code>engram serve</code>, then reload. (${esc(err.message)})`);
    return;
  }
  renderProjectHeader();
  await reload();
}

init();
