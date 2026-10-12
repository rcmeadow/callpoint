import "./style.css";
import {
  defaultSettings,
  explain,
  nearTieMarginOf,
  rank,
  rankLabel,
  validateScenario,
  type EngineId,
  type RankedOption,
  type RankSettings,
  type Recording,
  type Scenario,
  type StepResult,
} from "../engine/index";

// ---------- Data: scenarios and recordings are plain JSON files in scenarios/ ----------

const scenarioFiles = import.meta.glob<unknown>(["/scenarios/*.json", "!/scenarios/*.recording*.json"], {
  eager: true,
  import: "default",
});
const recordingFiles = import.meta.glob<Recording>("/scenarios/*.recording*.json", { eager: true, import: "default" });

const scenarios: Scenario[] = Object.entries(scenarioFiles)
  .map(([path, data]) => validateScenario(data, path))
  .sort((a, b) => a.title.localeCompare(b.title));

/** Prefer a real recording over a synthetic sample. */
function recordingFor(id: string): Recording | undefined {
  const all = Object.values(recordingFiles).filter((r) => r.scenarioId === id);
  return all.find((r) => !r.synthetic) ?? all[0];
}

// ---------- State ----------

type Mode = "replay" | "live";
const ENGINES: EngineId[] = ["jev", "local"];
const ENGINE_LABEL: Record<EngineId, string> = { jev: "Jev (TypeSafe)", local: "Local (Ollama)" };

interface Column {
  loading: boolean;
  error: string | null;
  results: StepResult[];
  ranked: RankedOption[];
  /** Metrics line for the last thing that happened in this column. */
  metric: { ms: number; asked: number; total: number; requests: number; modelCalls: number; kind: "step" | "rerank" } | null;
  model: string;
}

interface FeedItem {
  id: number;
  label: string;
  engine?: EngineId;
  lines: string[];
  tone: "update" | "rerank" | "info" | "error";
}

const state = {
  mode: "replay" as Mode,
  scenario: scenarios[0]!,
  settings: defaultSettings(scenarios[0]!),
  step: -1,
  columns: {} as Record<EngineId, Column>,
  feed: [] as FeedItem[],
  feedSeq: 0,
  status: null as null | { jev: { keyPresent: boolean; keySource: string; model: string }; local: { running: boolean; modelPulled: boolean; model: string; engine?: string; version?: string; versionOk?: boolean; minVersion?: string; ready?: boolean } },
  statusError: null as string | null,
  /** Count of every model-call request this page has made (live) or replayed. */
  modelCalls: 0,
  runId: 0,
};

function freshColumns(): Record<EngineId, Column> {
  const rec = recordingFor(state.scenario.id);
  const model = (e: EngineId) =>
    state.mode === "replay" ? rec?.engines[e]?.model ?? "" : e === "jev" ? state.status?.jev.model ?? "" : state.status?.local.model ?? "";
  return Object.fromEntries(
    ENGINES.map((e) => [e, { loading: false, error: null, results: [], ranked: [], metric: null, model: model(e) }]),
  ) as unknown as Record<EngineId, Column>;
}
state.columns = freshColumns();

// ---------- Engine access ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchStep(engine: EngineId, step: number, runId: number): Promise<StepResult> {
  if (state.mode === "replay") {
    const rec = recordingFor(state.scenario.id);
    const r = rec?.engines[engine]?.steps[step];
    if (!r) throw new Error(rec ? `This recording has no ${ENGINE_LABEL[engine]} data.` : "No recording for this scenario yet.");
    // Play back with the recorded wall-clock timing.
    await sleep(r.ms);
    if (runId !== state.runId) throw new Error("cancelled");
    state.modelCalls += r.requests;
    return r;
  }
  const res = await fetch(`/api/${engine}/step`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: state.scenario.id, step }),
  }).catch(() => {
    throw new Error("Cannot reach the local server. Live mode needs `npm run dev`.");
  });
  const body = (await res.json().catch(() => ({}))) as StepResult & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`);
  state.modelCalls += body.requests;
  return body;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error();
    state.status = await res.json();
    state.statusError = null;
  } catch {
    state.status = null;
    state.statusError = "Local server not reachable. Live mode needs `npm run dev`.";
  }
}

// ---------- Actions ----------

function pushFeed(item: Omit<FeedItem, "id">) {
  state.feed.unshift({ ...item, id: ++state.feedSeq });
  state.feed = state.feed.slice(0, 40);
}

function updateLabel(step: number): string {
  if (step === 0) return "Initial scoring";
  const u = state.scenario.updates[step - 1];
  return u ? `${u.at} ${u.title}` : `Update ${step}`;
}

async function runEngineStep(engine: EngineId, step: number, runId: number) {
  const col = state.columns[engine];
  if (col.error && step > 0) return;
  col.loading = true;
  renderColumn(engine);
  try {
    const r = await fetchStep(engine, step, runId);
    if (runId !== state.runId) return;
    const prev = col.results[step - 1];
    const prevRanked = col.ranked;
    col.results[step] = r;
    col.model = r.model;
    col.ranked = rank(state.scenario, r.judgments, state.settings);
    col.metric = { ms: r.ms, asked: r.asked, total: r.total, requests: r.requests, modelCalls: r.requests, kind: "step" };
    if (prev) {
      const moves = explain(state.scenario, { judgments: prev.judgments, ranked: prevRanked }, { judgments: r.judgments, ranked: col.ranked }, state.settings);
      pushFeed({
        label: `${updateLabel(step)} · ${ENGINE_LABEL[engine]}`,
        engine,
        lines: moves.length ? moves.map((m) => m.text) : ["No change in order."],
        tone: "update",
      });
    }
  } catch (err) {
    if (runId !== state.runId) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled") return;
    col.error = msg;
  } finally {
    if (runId === state.runId) {
      col.loading = false;
      renderColumn(engine);
      renderControls();
    }
  }
}

async function goTo(step: number) {
  const runId = state.runId;
  state.step = step;
  renderIncident();
  renderControls();
  await Promise.all(ENGINES.map((e) => runEngineStep(e, step, runId)));
  renderFeed();
  renderControls();
}

function start() {
  state.runId++;
  state.step = -1;
  state.columns = freshColumns();
  state.feed = [];
  render();
  void goTo(0);
}

function nextUpdate() {
  if (state.step < state.scenario.updates.length) void goTo(state.step + 1);
}

/** The code decides: re-rank from cached judgments. No fetch, no model call. */
function rerank(reason: string) {
  const callsBefore = state.modelCalls;
  for (const e of ENGINES) {
    const col = state.columns[e];
    const r = col.results[state.step];
    if (!r) continue;
    const t0 = performance.now();
    const prevRanked = col.ranked;
    col.ranked = rank(state.scenario, r.judgments, state.settings);
    const ms = performance.now() - t0;
    const moves = explain(state.scenario, { judgments: r.judgments, ranked: prevRanked }, { judgments: r.judgments, ranked: col.ranked }, state.settings);
    col.metric = { ms, asked: 0, total: r.total, requests: 0, modelCalls: state.modelCalls - callsBefore, kind: "rerank" };
    if (moves.length) {
      pushFeed({
        label: `${reason} · ${ENGINE_LABEL[e]} · 0 model calls`,
        engine: e,
        lines: moves.map((m) => {
          const motion = m.from === m.to ? `held at ${m.to}` : `moved ${m.from} to ${m.to}`;
          if (m.reason?.kind === "constraint") {
            const on = state.settings.constraintsEnabled[m.reason.targetId] !== false;
            return `${m.optionName} ${motion}: the "${m.reason.targetName}" gate is ${on ? "on" : "off"}, same judgment P(yes) ${m.reason.after.toFixed(2)}.`;
          }
          return `${m.optionName} ${motion}: the code re-weighted the same judgments.`;
        }),
        tone: "rerank",
      });
    }
    renderColumn(e);
  }
  renderFeed();
}

function setMode(mode: Mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.runId++;
  state.step = -1;
  state.columns = freshColumns();
  state.feed = [];
  if (mode === "live")
    void loadStatus().then(() => {
      if (state.mode !== "live") return;
      for (const e of ENGINES) {
        const col = state.columns[e];
        if (!col.model) col.model = e === "jev" ? state.status?.jev.model ?? "" : state.status?.local.model ?? "";
      }
      render();
    });
  render();
}

function setScenario(id: string) {
  const s = scenarios.find((x) => x.id === id);
  if (!s) return;
  state.scenario = s;
  state.settings = defaultSettings(s);
  state.runId++;
  state.step = -1;
  state.columns = freshColumns();
  state.feed = [];
  render();
}

// ---------- Rendering ----------

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmtMs = (ms: number) => (ms < 1 ? "under 1 ms" : ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms).toLocaleString("en-US")} ms`);

function shell() {
  $("#app").innerHTML = `
    <header class="top">
      <div class="brand">
        <h1>Reflex</h1>
        <p class="tagline">The model judges, the code decides.</p>
      </div>
      <p class="lede">A small model scores every response option against every goal criterion as typed probabilities. Plain code ranks them. When an incident update lands, only the affected judgments are re-asked, and you can see why each option moved. Jev and a local model run side by side.</p>
    </header>
    <section class="controls" id="controls"></section>
    <div id="banner"></div>
    <main class="grid">
      <section class="panel incident" id="incident"></section>
      <section class="columns">
        <div class="col" id="col-jev"></div>
        <div class="col" id="col-local"></div>
      </section>
      <section class="panel feed" id="feed"></section>
      <section class="panel tuning" id="tuning"></section>
    </main>
    <footer class="panel caveats">
      <h2>Caveats</h2>
      <ul>
        <li>Jev answers are not guaranteed bit-identical across runs. TypeSafe's own docs show small run-to-run noise on some questions. Same inputs give the same ranking here, apart from swaps inside a declared near tie, because the model is pinned (jev-1.13.0), judgments are cached by a hash of state and question, and the ranking is plain code.</li>
        <li>The local column runs Cloudflare Clef (default clef-flash:9b, Apache 2.0 open weights) through Ollama's System One endpoint, with the same questions and batching as Jev. It is a different model, so the two columns can disagree. With LOCAL_ENGINE=llm the column falls back to a small chat model that returns one level per question, with no probabilities.</li>
        <li>Latency is wall clock. Jev numbers include the network round trip from one machine; local numbers are from this one Mac's hardware. Your numbers will differ.</li>
        <li>Near ties: when options' totals are within the scenario's near-tie margin (default 0.02, chained), they are marked "too close to call" with the gap shown, share a rank like "1=", and are listed in scenario file order. A swap inside that margin is noise, so the "why it moved" feed does not report it as a move. Blocked options always sort last.</li>
        <li>This is a demo scenario, not incident advice. Constraints and weights are yours to change.</li>
      </ul>
    </footer>`;
}

function renderControls() {
  const el = $("#controls");
  const n = state.scenario.updates.length;
  const busy = ENGINES.some((e) => state.columns[e].loading);
  const allFailed = ENGINES.every((e) => state.columns[e].error);
  const started = state.step >= 0;
  const options = scenarios.map((s) => `<option value="${esc(s.id)}" ${s.id === state.scenario.id ? "selected" : ""}>${esc(s.title)}</option>`).join("");
  el.innerHTML = `
    <label class="field">
      <span>Scenario</span>
      <select id="scenario">${options}</select>
    </label>
    <div class="field">
      <span>Mode</span>
      <div class="seg" role="group" aria-label="Mode">
        <button type="button" data-mode="replay" aria-pressed="${state.mode === "replay"}">Replay</button>
        <button type="button" data-mode="live" aria-pressed="${state.mode === "live"}">Live</button>
      </div>
    </div>
    <div class="actions">
      <button type="button" class="primary" id="run" ${busy ? "disabled" : ""}>${started ? "Restart" : state.mode === "live" ? "Run live" : "Play recording"}</button>
      <button type="button" id="next" ${!started || busy || allFailed || state.step >= n ? "disabled" : ""}>Next update${started ? ` (${Math.min(state.step, n)}/${n})` : ""}</button>
    </div>`;
  $("#scenario").addEventListener("change", (e) => setScenario((e.target as HTMLSelectElement).value));
  el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as Mode)));
  $("#run").addEventListener("click", start);
  $("#next").addEventListener("click", nextUpdate);
  renderBanner();
}

function renderBanner() {
  const el = $("#banner");
  if (state.mode === "replay") {
    const rec = recordingFor(state.scenario.id);
    if (!rec) {
      el.innerHTML = `<div class="banner warn">No recording for this scenario yet. Switch to Live, or run <code>npm run record</code>.</div>`;
    } else if (rec.synthetic) {
      el.innerHTML = `<div class="banner warn"><strong>Sample data, not a real run.</strong> These judgments and timings were written by hand so Replay works out of the box. Run <code>npm run record</code> with your own TypeSafe key to replace them with a real recording.</div>`;
    } else {
      el.innerHTML = `<div class="banner ok">Replaying a real live run recorded ${esc(new Date(rec.recordedAt).toLocaleString())}, with its measured timings. ${rec.note ? esc(rec.note) : ""}</div>`;
    }
    return;
  }
  const s = state.status;
  if (!s) {
    el.innerHTML = `<div class="banner warn">${esc(state.statusError ?? "Checking the local server...")}</div>`;
    return;
  }
  const jev = s.jev.keyPresent ? `Jev ready (key from ${esc(s.jev.keySource)}, model ${esc(s.jev.model)}).` : "Jev: no TypeSafe key. Set TYPESAFE_API_KEY in .env or the macOS Keychain, then restart the server.";
  const local = !s.local.running
    ? "Local model not running (start Ollama)."
    : s.local.versionOk === false
      ? `Local: ${esc(s.local.model)} needs Ollama ${esc(s.local.minVersion ?? "")}+ (this one is ${esc(s.local.version ?? "unknown")}).`
      : !s.local.modelPulled
        ? `Local: model ${esc(s.local.model)} not pulled.`
        : `Local ready (${esc(s.local.model)}).`;
  el.innerHTML = `<div class="banner ${s.jev.keyPresent && (s.local.ready ?? (s.local.running && s.local.modelPulled)) ? "ok" : "warn"}">Live mode. ${jev} ${local} Live runs call the models through the local server; the key never reaches this page.</div>`;
}

function renderIncident() {
  const s = state.scenario;
  const applied = s.updates.slice(0, Math.max(0, state.step));
  const next = state.step >= 0 ? s.updates[state.step] : undefined;
  $("#incident").innerHTML = `
    <h2>${esc(s.title)}</h2>
    <p class="goal"><strong>Goal.</strong> ${esc(s.goal)}</p>
    <p>${esc(s.incident.summary ?? "")}</p>
    <ol class="timeline">
      ${applied.map((u) => `<li class="fresh"><span class="at">${esc(u.at)}</span> <strong>${esc(u.title)}.</strong> ${esc(u.text)}</li>`).join("")}
    </ol>
    ${next ? `<p class="muted small">Next: ${esc(next.at)} ${esc(next.title)} (affects ${next.affects.map(nameOf).map(esc).join(", ")})</p>` : state.step < 0 ? `<p class="muted small">${s.updates.length} updates are scripted for this incident.</p>` : `<p class="muted small">All updates applied.</p>`}`;
}

function nameOf(id: string): string {
  return state.scenario.criteria.find((c) => c.id === id)?.name ?? state.scenario.constraints.find((c) => c.id === id)?.name ?? id;
}

function renderColumn(engine: EngineId) {
  const col = state.columns[engine];
  const root = $(`#col-${engine}`);
  if (!root.dataset.built) {
    root.innerHTML = `<div class="col-head"></div><div class="metrics"></div><div class="col-msg"></div><ul class="ranked"></ul>`;
    root.dataset.built = "1";
  }
  root.querySelector(".col-head")!.innerHTML = `<h2>${ENGINE_LABEL[engine]}</h2><span class="model">${esc(col.model)}</span>`;
  const m = col.metric;
  root.querySelector(".metrics")!.innerHTML = m
    ? m.kind === "rerank"
      ? `<span class="pill strong">${m.modelCalls} model calls</span><span class="pill">re-ranked in ${fmtMs(m.ms)}</span>`
      : `<span class="pill strong">${fmtMs(m.ms)}</span><span class="pill">${state.step === 0 ? `${m.asked} questions asked` : `${m.asked} of ${m.total} questions re-asked`}</span><span class="pill">${m.requests} ${m.requests === 1 ? "request" : "requests"}</span>`
    : `<span class="pill muted">${col.loading ? "" : "Not run yet"}</span>`;
  const msg = root.querySelector(".col-msg")!;
  msg.innerHTML = col.error
    ? `<div class="error">${esc(col.error)}</div>`
    : col.loading
      ? `<div class="loading">${state.mode === "replay" ? "Replaying recorded timing..." : "Asking the model..."}</div>`
      : "";
  flipRender(root.querySelector<HTMLUListElement>(".ranked")!, col.error ? [] : col.ranked);
}

/** FLIP: measure, reorder, invert, play. */
function flipRender(ul: HTMLUListElement, ranked: RankedOption[]) {
  const first = new Map<string, number>();
  ul.querySelectorAll<HTMLLIElement>("li[data-id]").forEach((li) => first.set(li.dataset.id!, li.getBoundingClientRect().top));
  const keep = new Set(ranked.map((r) => r.optionId));
  ul.querySelectorAll<HTMLLIElement>("li[data-id]").forEach((li) => {
    if (!keep.has(li.dataset.id!)) li.remove();
  });
  for (const r of ranked) {
    let li = ul.querySelector<HTMLLIElement>(`li[data-id="${CSS.escape(r.optionId)}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = r.optionId;
    }
    li.className = r.blocked ? "blocked" : "";
    li.innerHTML = rowHtml(r);
    ul.appendChild(li);
  }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  ul.querySelectorAll<HTMLLIElement>("li[data-id]").forEach((li) => {
    const before = first.get(li.dataset.id!);
    if (before === undefined || reduce) return;
    const dy = before - li.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    li.style.transition = "none";
    li.style.transform = `translateY(${dy}px)`;
    li.classList.add("moving");
    void li.offsetHeight;
    li.style.transition = "transform 600ms cubic-bezier(.2,.8,.2,1)";
    li.style.transform = "";
    li.addEventListener("transitionend", () => li.classList.remove("moving"), { once: true });
  });
}

function rowHtml(r: RankedOption): string {
  const s = state.scenario;
  const o = s.options.find((x) => x.id === r.optionId)!;
  const pct = Math.round(r.total * 100);
  const parts = s.criteria.map((c) => `<span title="${esc(c.name)}">${esc(c.name)} ${(r.parts[c.id] ?? 0).toFixed(2)}</span>`).join("");
  const gate = r.blocked ? `<div class="gate">Blocked: ${r.blockedBy.map(nameOf).map(esc).join(", ")}</div>` : "";
  return `
    <div class="rank">${r.blocked ? "X" : rankLabel(r)}</div>
    <div class="body">
      <div class="name-row"><span class="name">${esc(o.name)}${r.nearTie ? ` <span class="tag" title="Totals in this group are within the near-tie margin (${nearTieMarginOf(state.scenario)}). The code makes no call between them; they are shown in scenario file order.">too close to call (margin ${r.tieSpread.toFixed(3)})</span>` : ""}</span><span class="total">${r.total.toFixed(2)}</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${gate}
      <div class="parts">${parts}</div>
    </div>`;
}

function renderFeed() {
  $("#feed").innerHTML = `
    <h2>Why it moved</h2>
    ${
      state.feed.length
        ? `<ol class="feed-list">${state.feed
            .map(
              (f) =>
                `<li class="${f.tone}"><div class="feed-label">${esc(f.label)}</div><ul>${f.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></li>`,
            )
            .join("")}</ol>`
        : `<p class="muted">Start a run, then apply updates. Each line names the judgment that moved an option and its probability before and after.</p>`
    }`;
}

function renderTuning() {
  const s = state.scenario;
  const st = state.settings;
  $("#tuning").innerHTML = `
    <h2>The code decides</h2>
    <p class="muted small">Weights and hard constraints live in code. Changing them re-ranks the same judgments instantly, with 0 model calls.</p>
    <div class="sliders">
      ${s.criteria
        .map(
          (c) => `
        <label class="slider">
          <span class="slider-head"><span>${esc(c.name)}</span><output id="w-${esc(c.id)}">${(st.weights[c.id] ?? 0).toFixed(2)}</output></span>
          <input type="range" min="0" max="1" step="0.05" value="${st.weights[c.id] ?? 0}" data-weight="${esc(c.id)}" aria-label="Weight for ${esc(c.name)}" />
        </label>`,
        )
        .join("")}
    </div>
    <fieldset class="toggles">
      <legend>Hard constraints (block when P(yes) is at or above the threshold)</legend>
      ${s.constraints
        .map(
          (k) => `
        <label class="toggle"><input type="checkbox" data-constraint="${esc(k.id)}" ${st.constraintsEnabled[k.id] !== false ? "checked" : ""} /> ${esc(k.name)} <span class="muted small">(${k.threshold})</span></label>`,
        )
        .join("")}
    </fieldset>
    <button type="button" id="reset-weights">Reset to scenario defaults</button>`;
  $("#tuning")
    .querySelectorAll<HTMLInputElement>("[data-weight]")
    .forEach((input) =>
      input.addEventListener("input", () => {
        const id = input.dataset.weight!;
        state.settings = { ...state.settings, weights: { ...state.settings.weights, [id]: Number(input.value) } };
        $(`#w-${CSS.escape(id)}`).textContent = Number(input.value).toFixed(2);
        rerank(`Weight changed: ${nameOf(id)}`);
      }),
    );
  $("#tuning")
    .querySelectorAll<HTMLInputElement>("[data-constraint]")
    .forEach((input) =>
      input.addEventListener("change", () => {
        const id = input.dataset.constraint!;
        state.settings = { ...state.settings, constraintsEnabled: { ...state.settings.constraintsEnabled, [id]: input.checked } };
        rerank(`Constraint ${input.checked ? "on" : "off"}: ${nameOf(id)}`);
      }),
    );
  $("#reset-weights").addEventListener("click", () => {
    state.settings = defaultSettings(s) as RankSettings;
    renderTuning();
    rerank("Weights reset");
  });
}

function render() {
  renderControls();
  renderIncident();
  ENGINES.forEach((e) => {
    const root = $(`#col-${e}`);
    delete root.dataset.built;
    renderColumn(e);
  });
  renderFeed();
  renderTuning();
}

if (!scenarios.length) {
  document.body.textContent = "No scenarios found in scenarios/*.json.";
} else {
  shell();
  render();
}

