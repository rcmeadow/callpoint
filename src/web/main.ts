import "./style.css";
import {
  buildReceipt,
  compareToBaseline,
  defaultSettings,
  describeTuning,
  explain,
  nearTieMarginOf,
  rank,
  rankLabel,
  nounOf,
  scriptedFacts,
  validateScenario,
  whereWeAreGoing,
  type EngineId,
  type Fact,
  type Judgment,
  type RankedOption,
  type RankSettings,
  type Recording,
  type Scenario,
  type Snapshot,
  type StepResult,
  type TuningEvent,
} from "../engine/index";
import { cloneScenario, renderEditor } from "./editor";
import { gaugeLayout, type GaugeLabel } from "./gauge";
import { plainHeadline, plainOutlook } from "./plain";
import { readPref, themeToggleHtml, wireThemeToggle, writePref } from "./theme";

const VIEW_KEY = "callpoint-view";
const GUIDE_KEY = "callpoint-guide";

// ---------- Data: scenarios and recordings are plain JSON files in scenarios/ ----------

const scenarioFiles = import.meta.glob<unknown>(["/scenarios/*.json", "!/scenarios/*.recording*.json"], { eager: true, import: "default" });
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
const LABEL: Record<EngineId, string> = { jev: "Jev", local: "Clef" };
const LONG_LABEL: Record<EngineId, string> = { jev: "Jev (TypeSafe)", local: "Clef (Cloudflare, local via Ollama)" };

interface Metric {
  kind: "step" | "rerank";
  ms: number;
  asked: number;
  total: number;
  requests: number;
}

interface Column {
  snapshots: (Snapshot | undefined)[];
  loading: boolean;
  error: string | null;
  model: string;
  metric: Metric | null;
}

interface Status {
  jev: { keyPresent: boolean; keySource: string; model: string };
  local: { running: boolean; modelPulled: boolean; model: string; engine?: string; version?: string; versionOk?: boolean; minVersion?: string; ready?: boolean };
}

const state = {
  mode: "replay" as Mode,
  base: scenarios[0]!,
  /** Edited problem, used in Live mode. */
  edited: null as Scenario | null,
  draft: cloneScenario(scenarios[0]!),
  settings: defaultSettings(scenarios[0]!),
  facts: [] as Fact[],
  started: false,
  compareLocal: false,
  /** Simple view by default; "Show the engine" switches to the full instrument panel. */
  view: initialView(),
  guideDismissed: readPref(GUIDE_KEY) === "dismissed",
  /** Phone-only UI state: expanded problem text and option cards with criteria showing. */
  problemOpen: false,
  /** Details toggles people have tapped. Untouched cards use the default (open only for #1 on desktop). */
  partsToggled: new Map<string, boolean>(),
  /** The last weights/constraints re-rank (shared by both columns); cleared on the next step. */
  rerank: null as null | { ms: number; reason: string },
  /** Compare rows with their extra reasons expanded. */
  cmpOpen: new Set<string>(),
  /** Weights/constraint changes made in this session (the receipt's history). */
  tuning: [] as TuningEvent[],
  /** Settings as of the last recorded tuning event (or the session start). */
  lastTuned: null as RankSettings | null,
  /** Receipt preview open, kept across re-renders. */
  receiptOpen: false,
  playing: false,
  cols: {} as Record<EngineId, Column>,
  status: null as Status | null,
  statusError: null as string | null,
  runId: 0,
  toast: "",
};

/** Link back to the landing page, keeping ?theme= when it was set. */
function homeHref(): string {
  try {
    const t = new URLSearchParams(location.search).get("theme");
    return t ? `../?theme=${encodeURIComponent(t)}` : "../";
  } catch {
    return "../";
  }
}

function initialView(): "simple" | "full" {
  try {
    const q = new URLSearchParams(location.search).get("view");
    if (q === "full" || q === "simple") return q;
  } catch {
    // no URL params available
  }
  return readPref(VIEW_KEY) === "full" ? "full" : "simple";
}
const isSimple = () => state.view === "simple";

const scenario = (): Scenario => (state.mode === "live" && state.edited ? state.edited : state.base);
const activeEngines = (): EngineId[] => (state.compareLocal ? ENGINES : ["jev"]);
const liveAvailable = () => !!state.status;
const busy = () => ENGINES.some((e) => state.cols[e].loading);

function defaultModel(e: EngineId): string {
  if (state.mode === "replay") return recordingFor(state.base.id)?.engines[e]?.model ?? "";
  return (e === "jev" ? state.status?.jev.model : state.status?.local.model) ?? "";
}

/** Clear the session. `defaults` also puts weights and constraints back to the scenario's own. */
function resetSession(opts: { defaults?: boolean } = {}) {
  state.runId++;
  if (opts.defaults) state.settings = defaultSettings(scenario());
  state.facts = [];
  state.started = false;
  state.playing = false;
  state.cols = Object.fromEntries(ENGINES.map((e) => [e, { snapshots: [], loading: false, error: null, model: defaultModel(e), metric: null }])) as unknown as Record<EngineId, Column>;
  state.rerank = null;
  state.tuning = [];
  state.lastTuned = cloneSettings(state.settings);
  // A fresh session should not animate the call banner as if the call had changed.
  const call = document.querySelector<HTMLElement>("#call");
  if (call) delete call.dataset.key;
  if (state.mode === "replay") primeReplay();
}

/** Replay: show the recorded starting point right away, so a visitor sees a ranking on load. */
function primeReplay() {
  const rec = recordingFor(state.base.id);
  if (!rec) return;
  for (const e of activeEngines()) {
    const r = rec.engines[e]?.steps[0];
    if (!r) continue;
    const col = state.cols[e];
    col.snapshots[0] = { fact: null, appliedAt: new Date().toISOString(), result: r, settings: cloneSettings(state.settings) };
    col.model = r.model;
    col.metric = { kind: "step", ms: r.ms, asked: r.asked, total: r.total, requests: r.requests };
  }
  state.started = !!state.cols.jev.snapshots[0];
}
resetSession();

// ---------- Engine access ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchResult(engine: EngineId, facts: Fact[], runId: number): Promise<StepResult> {
  if (state.mode === "replay") {
    const rec = recordingFor(state.base.id);
    const r = rec?.engines[engine]?.steps[facts.length];
    if (!r) throw new Error(rec ? `This recording has no ${LABEL[engine]} data.` : "No recording for this scenario yet.");
    await sleep(r.ms); // recorded wall-clock timing
    if (runId !== state.runId) throw new Error("cancelled");
    return r;
  }
  const res = await fetch(`/api/${engine}/facts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: scenario(), facts }),
  }).catch(() => {
    throw new Error("Cannot reach the local server. Live mode needs `npm run dev`.");
  });
  const body = (await res.json().catch(() => ({}))) as StepResult & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`);
  return body;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error();
    state.status = (await res.json()) as Status;
    state.statusError = null;
  } catch {
    state.status = null;
    state.statusError = "No local server here, so this page can only replay. Run it yourself with `npm run dev` for Live mode.";
  }
}

/** Run one engine at the current fact index. */
async function runEngine(engine: EngineId, runId: number) {
  const col = state.cols[engine];
  const index = state.facts.length;
  const facts = [...state.facts];
  if (col.error && index > 0 && !col.snapshots.some(Boolean)) return;
  col.loading = true;
  col.error = null;
  renderAll();
  try {
    const r = await fetchResult(engine, facts, runId);
    if (runId !== state.runId) return;
    col.snapshots[index] = { fact: facts[index - 1] ?? null, appliedAt: new Date().toISOString(), result: r, settings: cloneSettings(state.settings) };
    col.model = r.model;
    col.metric = { kind: "step", ms: r.ms, asked: r.asked, total: r.total, requests: r.requests };
  } catch (err) {
    if (runId !== state.runId) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== "cancelled") col.error = msg;
  } finally {
    if (runId === state.runId) col.loading = false;
  }
}

async function runActive() {
  const runId = state.runId;
  await Promise.all(activeEngines().map((e) => runEngine(e, runId)));
  if (runId === state.runId) renderAll();
}

// ---------- Actions ----------

async function ensureStarted() {
  if (state.started) return;
  state.started = true;
  await runActive();
}

function nextScripted(): Fact | undefined {
  const done = new Set(state.facts.filter((f) => f.source === "scripted").map((f) => f.id));
  return scriptedFacts(scenario(), scenario().updates.length).find((f) => !done.has(f.id));
}

async function applyFact(f: Fact) {
  await ensureStarted();
  state.rerank = null;
  state.facts.push(f);
  await runActive();
}

async function nextUpdate() {
  await ensureStarted();
  const f = nextScripted();
  if (f) await applyFact(f);
}

async function playDemo() {
  const runId = state.runId;
  state.playing = true;
  renderAll();
  await ensureStarted();
  while (state.playing && runId === state.runId) {
    const f = nextScripted();
    if (!f) break;
    await sleep(900);
    if (!state.playing || runId !== state.runId) break;
    await applyFact(f);
  }
  if (runId === state.runId) {
    state.playing = false;
    renderAll();
  }
}

function liveFactBlocker(): string | null {
  if (state.mode === "replay") return "Live facts call the models, so they need Live mode.";
  if (!state.status) return state.statusError ?? "Checking the local server...";
  if (!state.status.jev.keyPresent) return "No TypeSafe key loaded. See Bring your own key in the README, then restart the server.";
  return null;
}

async function addLiveFact(text: string) {
  const t = text.trim();
  if (!t || liveFactBlocker()) return;
  const now = new Date();
  const at = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  await applyFact({ id: `live_${now.getTime()}`, at, title: "Live fact", text: t, source: "live" });
}

async function setCompareLocal(on: boolean) {
  state.compareLocal = on;
  if (!on || !state.started) return renderAll();
  const col = state.cols.local;
  if (state.mode === "replay") {
    // Fill in the recorded Clef run up to where the session is.
    const rec = recordingFor(state.base.id)?.engines.local;
    if (!rec) col.error = "This recording has no Clef data.";
    else {
      for (let i = 0; i <= state.facts.length; i++) {
        const r = rec.steps[i];
        if (r) col.snapshots[i] = { fact: state.facts[i - 1] ?? null, appliedAt: new Date().toISOString(), result: r, settings: state.cols.jev.snapshots[i]?.settings ?? cloneSettings(state.settings) };
      }
      const last = rec.steps[state.facts.length];
      if (last) col.metric = { kind: "step", ms: last.ms, asked: last.asked, total: last.total, requests: last.requests };
      col.model = rec.model;
    }
    return renderAll();
  }
  await runEngine("local", state.runId);
  renderAll();
}

function setMode(mode: Mode) {
  if (state.mode === mode) return;
  if (mode === "live" && !liveAvailable()) return;
  state.mode = mode;
  state.settings = defaultSettings(scenario());
  resetSession();
  renderAll(true);
}

function setScenario(id: string) {
  const s = scenarios.find((x) => x.id === id);
  if (!s) return;
  state.base = s;
  state.edited = null;
  state.draft = cloneScenario(s);
  state.settings = defaultSettings(s);
  resetSession();
  renderAll(true);
}

// A function declaration (hoisted): resetSession() runs at load, before this line.
function cloneSettings(st: RankSettings): RankSettings {
  return { weights: { ...st.weights }, constraintsEnabled: { ...st.constraintsEnabled } };
}

/** Add a timeline/receipt event for any weights or constraints change since the last one. */
function recordTuning() {
  if (!state.started || !state.lastTuned) {
    state.lastTuned = cloneSettings(state.settings);
    return;
  }
  const changes = describeTuning(scenario(), state.lastTuned, state.settings);
  if (!changes.length) return;
  const now = new Date();
  state.tuning.push({
    at: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
    appliedAt: now.toISOString(),
    afterFact: state.facts.length,
    changes,
    settings: cloneSettings(state.settings),
  });
  state.lastTuned = cloneSettings(state.settings);
  renderAll();
}

function rerank(reason: string) {
  const t0 = performance.now();
  // Everything below is derived from cached judgments; there is no fetch on this path.
  renderAll();
  const ms = performance.now() - t0;
  state.rerank = latest("jev") ? { ms, reason } : null;
  state.toast = `${reason}: re-ranked with 0 model calls.`;
  renderAll();
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// ---------- Derived views ----------

function latest(e: EngineId): Snapshot | undefined {
  const s = state.cols[e].snapshots;
  for (let i = s.length - 1; i >= 0; i--) if (s[i]) return s[i];
  return undefined;
}

/** Index of an engine's first snapshot (its first pass asks every question). */
function firstIndex(e: EngineId): number {
  return state.cols[e].snapshots.findIndex(Boolean);
}

function rankedNow(e: EngineId): RankedOption[] {
  const s = latest(e);
  return s ? rank(scenario(), s.result.judgments, state.settings) : [];
}

/** Mean confidence across an option's Score answers (API confidence, else the top probability). */
function confidenceOf(judgments: Record<string, Judgment>, optionId: string): number {
  const vals = scenario().criteria.map((c) => {
    const j = judgments[`${optionId}__${c.id}`];
    if (!j || j.kind !== "score") return 0;
    return j.confidence ?? Math.max(...j.probabilities);
  });
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function receipt(): string {
  const engines = activeEngines()
    .filter((e) => state.cols[e].snapshots.some(Boolean))
    .map((e) => ({ id: e, label: LONG_LABEL[e], model: state.cols[e].model, snapshots: state.cols[e].snapshots }));
  const rec = recordingFor(state.base.id);
  const mode =
    state.mode === "live"
      ? "Live"
      : rec?.synthetic
        ? "Replay of SAMPLE data (hand-written, not a real run)"
        : `Replay of a real recording made ${rec?.recordedAt ?? "unknown"}`;
  return buildReceipt({ scenario: scenario(), settings: state.settings, engines, generatedAt: new Date().toISOString(), mode, tuning: state.tuning });
}

// ---------- Rendering ----------

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmtMs = (ms: number) => (ms < 1 ? "under 1 ms" : ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms).toLocaleString("en-US")} ms`);
const nameOf = (id: string) =>
  scenario().options.find((o) => o.id === id)?.name ??
  scenario().criteria.find((c) => c.id === id)?.name ??
  scenario().constraints.find((c) => c.id === id)?.name ??
  id;

function shell() {
  $("#app").innerHTML = `
    <header class="top">
${themeToggleHtml}
      <div class="brand">
        <h1><a class="brand-link" href="${homeHref()}">Callpoint</a></h1>
        <p class="tagline">An incident co-pilot. The model judges, the code decides.</p>
        <p class="pitch">Add facts as your incident unfolds. Callpoint re-ranks your options in milliseconds, flags when it's too close to call, and writes the decision trail for your postmortem.</p>
      </div>
      <div class="view-switch" id="view-switch"></div>
      <div class="top-controls" id="top-controls"></div>
    </header>
    <div id="banner"></div>
    <section class="guide" id="guide" aria-label="How to read this page"></section>
    <section class="card problem" id="problem"></section>
    <main class="layout" id="layout">
      <section class="card timeline" id="timeline" aria-label="Timeline"></section>
      <section class="center" id="center">
        <div class="call" id="call" aria-live="polite"></div>
        <section class="race" id="race" aria-label="Ranking"></section>
      </section>
      <section class="insight" id="insight" aria-label="Where we are going"></section>
    </main>
    <section class="lower">
      <section class="card tuning" id="tuning"></section>
      <section class="card receipt" id="receipt"></section>
    </section>
    <footer class="card caveats">
      <h2>Keys, terms and licenses</h2>
      <p class="terms">Bring your own keys. Callpoint doesn't include or resell model access. Live mode calls TypeSafe's API with your own key, and your use is governed by TypeSafe's terms. The local comparison runs Cloudflare's Clef (Apache 2.0) through Ollama on your machine, under their licenses. Callpoint is not affiliated with or endorsed by TypeSafe or Cloudflare. Provided as is under the MIT license.</p>
      <p class="terms">Live facts and your scenario text are sent to TypeSafe's API (and to Ollama on your machine if the comparison is on). Don't paste secrets or customer data. Sessions live only in your browser tab and are gone on reload.</p>
      <p class="terms-links small">
        <a href="https://typesafe.ai/legal/mca" target="_blank" rel="noopener noreferrer">TypeSafe terms</a>
        <a href="https://typesafe.ai/legal/acceptable-use-policy" target="_blank" rel="noopener noreferrer">TypeSafe acceptable use policy</a>
        <a href="https://huggingface.co/Cloudflare/clef-flash" target="_blank" rel="noopener noreferrer">Clef model card</a>
        <a href="https://github.com/ollama/ollama/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">Ollama license</a>
      </p>
      <div class="fine-print">
      <h2>Fine print</h2>
      <ul>
        <li>Jev answers are not bit-identical across runs; TypeSafe's docs show small noise on some questions. The ranking holds steady because the model is pinned (jev-1.13.0), judgments are cached by a hash of the state and question, and the ranking is plain code.</li>
        <li>Too close to call: when totals are within the near-tie margin (default 0.02, chained), the code makes no call between them. They share a rank like "1=" and are shown in file order, and a swap inside that margin is not reported as a move.</li>
        <li>Free-text facts have no labels saying what they affect, so each one re-asks every question in one request per engine. Scripted demo updates only re-ask what they touch.</li>
        <li>The local comparison runs Cloudflare Clef (clef-flash:9b, Apache 2.0 open weights) through Ollama with the same questions. It is a different model and can disagree. Latency is wall clock: Jev includes the network from one machine, Clef is this one Mac.</li>
        <li>Scores and certainty are model judgments, not validated outcome probabilities.</li>
        <li id="advice-note">This is a demo scenario, not incident advice. You set the goals, weights, and constraints.</li>
      </ul>
      </div>
    </footer>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;
}

function renderTop() {
  const options = scenarios.map((s) => `<option value="${esc(s.id)}" ${s.id === state.base.id ? "selected" : ""}>${esc(s.title)}</option>`).join("");
  $("#top-controls").innerHTML = `
    <label class="field"><span>Starter problem</span><select id="scenario">${options}</select></label>
    <div class="field">
      <span>Mode</span>
      <div class="seg" role="group" aria-label="Mode">
        <button type="button" data-mode="replay" aria-pressed="${state.mode === "replay"}">Replay</button>
        <button type="button" data-mode="live" aria-pressed="${state.mode === "live"}" ${liveAvailable() ? "" : `disabled title="${esc(state.statusError ?? "")}"`}>Live</button>
      </div>
    </div>
    <div class="switch-wrap">
      <label class="switch">
        <input type="checkbox" role="switch" id="compare-local" aria-describedby="compare-note" ${state.compareLocal ? "checked" : ""} />
        <span class="track" aria-hidden="true"><span class="thumb"></span></span>
        <span class="switch-label">Compare local model</span>
      </label>
      <small class="note" id="compare-note">Cloudflare Clef via Ollama, runs on this machine, several seconds per re-ask</small>
    </div>`;
  $("#scenario").addEventListener("change", (e) => setScenario((e.target as HTMLSelectElement).value));
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as Mode)));
  $<HTMLInputElement>("#compare-local").addEventListener("change", (e) => void setCompareLocal((e.target as HTMLInputElement).checked));
}

function renderBanner() {
  const el = $("#banner");
  if (state.mode === "replay") {
    const rec = recordingFor(state.base.id);
    el.innerHTML = !rec
      ? `<div class="banner warn">No recording for this problem yet. Use Live, or run <code>npm run record</code>.</div>`
      : rec.synthetic
        ? `<div class="banner warn"><strong>Sample data, not a real run.</strong> Hand-written judgments and timings so Replay works out of the box. <code>npm run record</code> makes a real one.</div>`
        : `<div class="banner calm">Replaying a real recorded run<span class="wide-only"> from ${esc(new Date(rec.recordedAt).toLocaleString())}</span>, at its recorded speed.<span class="wide-only"> Switch to Live to add your own facts.</span></div>`;
    return;
  }
  const s = state.status;
  if (!s) return void (el.innerHTML = `<div class="banner warn">${esc(state.statusError ?? "Checking the local server...")}</div>`);
  const jev = s.jev.keyPresent ? `Jev ready (${esc(s.jev.model)}).` : "No TypeSafe key loaded, so Jev cannot run.";
  const local = !state.compareLocal
    ? ""
    : !s.local.running
      ? "Ollama is not running."
      : s.local.versionOk === false
        ? `Clef needs Ollama ${esc(s.local.minVersion ?? "")}+ (this is ${esc(s.local.version ?? "unknown")}).`
        : !s.local.modelPulled
          ? `Model ${esc(s.local.model)} is not pulled.`
          : `Clef ready (${esc(s.local.model)}).`;
  el.innerHTML = `<div class="banner ${s.jev.keyPresent ? "calm" : "warn"}">Live. ${jev} ${local} Models are called by the local server; the key never reaches this page.</div>`;
}

function renderProblem() {
  const s = scenario();
  const n = s.updates.length;
  const applied = state.facts.filter((f) => f.source === "scripted").length;
  const isBusy = busy();
  const editable = state.mode === "live";
  $("#problem").innerHTML = `
    <div class="problem-head">
      <div>
        <p class="eyebrow">The problem${state.mode === "live" && state.edited ? " (edited)" : ""}</p>
        <h2>${esc(s.title)}</h2>
      </div>
      <div class="actions">
        <button type="button" class="primary" id="play" ${isBusy || state.playing || applied >= n ? "disabled" : ""}>${playLabel(applied, n)}</button>
        <button type="button" id="next" ${isBusy || state.playing || applied >= n ? "disabled" : ""}>Next<span class="wide-only"> update</span>${state.started ? ` (${applied}/${n})` : ""}</button>
        <button type="button" class="${applied >= n ? "" : "ghost"}" id="reset" ${applied || state.facts.length ? "" : "disabled"}>${resetLabel(applied, n)}</button>
      </div>
    </div>
    <div class="problem-text ${state.problemOpen ? "open" : ""}" id="problem-text">
      <p class="goal"><strong>Goal:</strong> ${esc(s.goal)}</p>
      <p class="summary">${esc(s.incident.summary ?? "")}</p>
    </div>
    <button type="button" class="more-toggle" id="problem-more" aria-expanded="${state.problemOpen}" aria-controls="problem-text">${state.problemOpen ? "Less" : "More"}</button>
    <details class="editor ${state.problemOpen ? "open" : ""}" id="editor-details">
      <summary>Edit the problem${editable ? "" : " (runs in Live mode)"}</summary>
      <div id="editor"></div>
    </details>`;
  $("#play").addEventListener("click", () => void playDemo());
  $("#next").addEventListener("click", () => void nextUpdate());
  $("#problem-more").addEventListener("click", () => {
    state.problemOpen = !state.problemOpen;
    $("#problem-text").classList.toggle("open", state.problemOpen);
    $("#editor-details").classList.toggle("open", state.problemOpen);
    const b = $("#problem-more");
    b.textContent = state.problemOpen ? "Less" : "More";
    b.setAttribute("aria-expanded", String(state.problemOpen));
  });
  $("#reset").addEventListener("click", () => {
    const again = state.mode === "replay" && state.facts.filter((f) => f.source === "scripted").length >= scenario().updates.length;
    // Replay should reproduce the recording, so it also restores the scenario's weights.
    resetSession({ defaults: state.mode === "replay" });
    renderAll(true);
    if (again) void playDemo();
  });
  renderEditor($("#editor"), state.draft, {
    liveAvailable: liveAvailable(),
    onApply: (sc) => {
      state.edited = sc;
      state.draft = cloneScenario(sc);
      if (state.mode !== "live") state.mode = "live";
      state.settings = defaultSettings(sc);
      resetSession();
      state.toast = "Problem updated. Start the demo or add a fact.";
      renderAll(true);
    },
    onExport: (sc) => download(`${sc.id || "scenario"}.json`, JSON.stringify(sc, null, 2) + "\n", "application/json"),
    onReset: () => {
      state.edited = null;
      state.draft = cloneScenario(state.base);
      state.settings = defaultSettings(state.base);
      resetSession();
      renderAll(true);
    },
  });
}

function renderTimeline() {
  const s = scenario();
  const blocker = liveFactBlocker();
  const jev = state.cols.jev.snapshots;
  const items: string[] = [];
  const metricLine = (i: number) =>
    activeEngines()
      .map((e) => {
        const r = state.cols[e].snapshots[i]?.result;
        if (!r) return "";
        return `<span class="pill">${LABEL[e]} ${fmtMs(r.ms)} · ${i === firstIndex(e) ? (r.asked === 0 ? "first pass, cached" : `first pass, ${r.asked} asked`) : `${r.asked}/${r.total} re-asked`}</span>`;
      })
      .join("");
  const tuningItems = (afterFact: number) =>
    state.tuning
      .filter((t) => t.afterFact === afterFact)
      .forEach((t) =>
        items.push(`<li class="tl-item tuning">
      <div class="tl-time">${esc(t.at)}</div>
      <div class="tl-body">
        <div class="tl-title"><strong>Weights changed</strong> <span class="src">0 model calls</span></div>
        <ul class="moves">${t.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>
    </li>`),
      );
  if (state.started) {
    items.push(`<li class="tl-item start"><div class="tl-time">Start</div><div class="tl-body"><strong>Starting point</strong><div class="tl-metrics">${metricLine(0)}</div></div></li>`);
    tuningItems(0);
  }
  state.facts.forEach((f, idx) => {
    const i = idx + 1;
    const prev = jev[i - 1];
    const cur = jev[i];
    let moves = "";
    if (prev && cur) {
      const m = explain(
        s,
        { judgments: prev.result.judgments, ranked: rank(s, prev.result.judgments, state.settings) },
        { judgments: cur.result.judgments, ranked: rank(s, cur.result.judgments, state.settings) },
        state.settings,
      );
      moves = `<ul class="moves">${(m.length ? m.map((x) => x.text) : ["No change in order."]).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
    }
    const loading = !cur && state.cols.jev.loading ? `<div class="loading">Asking...</div>` : "";
    items.push(`<li class="tl-item ${f.source}">
      <div class="tl-time">${esc(f.at)}</div>
      <div class="tl-body">
        <div class="tl-title"><strong>${esc(f.title)}</strong> <span class="src">${f.source === "live" ? "live" : "demo"}</span></div>
        <p>${esc(f.text)}</p>
        <div class="tl-metrics">${metricLine(i)}</div>
        ${loading}${moves}
      </div>
    </li>`);
    tuningItems(i);
  });
  const next = nextScripted();
  const live = state.mode === "live";
  const form = `
    <form id="fact-form" class="fact-form">
      <label for="fact-text" class="sr">Add a fact</label>
      <textarea id="fact-text" rows="2" placeholder="Add what you just learned, e.g. The flag service confirms smart-retries can be turned off in one minute." ${blocker ? "disabled" : ""}></textarea>
      <div class="fact-row">
        <button type="submit" class="primary" ${blocker || busy() ? "disabled" : ""}>Add fact</button>
        <span class="muted small">${blocker ? esc(blocker) : "Re-asks every question in one request."}</span>
      </div>
    </form>`;
  const list = items.length
    ? `<ol class="tl">${items.reverse().join("")}</ol>`
    : `<p class="muted">Press Play demo to watch the scripted ${esc(nounNow())} unfold${live ? ", or add a fact" : ""}.</p>`;
  const nextLine = next && state.started ? `<p class="muted small">Next in the demo: ${esc(next.at)} ${esc(next.title)}</p>` : "";
  // Replay: the facts come first, and the input folds into one line.
  const liveHint = liveAvailable()
    ? `<p class="live-hint"><button type="button" class="linkish" id="go-live">Switch to Live</button> to add your own facts.</p>`
    : `<p class="live-hint muted">Live facts need the local server (npm run dev). This page can only replay.</p>`;
  $("#timeline").innerHTML = live
    ? `<h2>Timeline</h2>${form}${list}${nextLine}`
    : `<h2>Timeline</h2>${list}${nextLine}${liveHint}`;
  document.querySelector("#go-live")?.addEventListener("click", () => setMode("live"));
  // Newest fact is on top; jump back to it whenever a fact lands.
  const tl = $("#timeline");
  if (Number(tl.dataset.count ?? -1) !== state.facts.length) {
    tl.scrollTop = 0;
    tl.dataset.count = String(state.facts.length);
  }
  document.querySelector<HTMLFormElement>("#fact-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const ta = $<HTMLTextAreaElement>("#fact-text");
    const v = ta.value;
    ta.value = "";
    void addLiveFact(v);
  });
}

function renderRace() {
  const root = $("#race");
  const engines = activeEngines();
  root.classList.toggle("two", engines.length === 2);
  let note = root.querySelector<HTMLElement>(".race-note");
  if (state.rerank) {
    if (!note) {
      note = document.createElement("div");
      note.className = "race-note";
      root.prepend(note);
    }
    note.innerHTML = `<span class="pill strong">0 model calls</span><span class="pill">${esc(state.rerank.reason)}: ${engines.length === 2 ? "both columns" : "ranking"} re-ranked in ${fmtMs(state.rerank.ms)}</span>`;
  } else note?.remove();
  $("#layout").classList.toggle("two", engines.length === 2);
  for (const e of ENGINES) {
    let col = root.querySelector<HTMLElement>(`[data-engine="${e}"]`);
    if (!engines.includes(e)) {
      col?.remove();
      continue;
    }
    if (!col) {
      col = document.createElement("div");
      col.className = "card col";
      col.dataset.engine = e;
      col.innerHTML = `<div class="col-head"></div><div class="metrics"></div><div class="col-msg"></div><ul class="ranked"></ul>`;
      const noteEl = root.querySelector(".race-note");
      if (e !== "jev") root.appendChild(col);
      else if (noteEl) noteEl.after(col);
      else root.prepend(col);
    }
    const c = state.cols[e];
    col.querySelector(".col-head")!.innerHTML = isSimple()
      ? `<h2>Your options, best first</h2>`
      : `<h2>${LONG_LABEL[e]}</h2><span class="model">${esc(c.model)}</span>`;
    const m = c.metric;
    col.querySelector(".metrics")!.innerHTML = m
      ? m.kind === "rerank"
        ? `<span class="pill strong">0 model calls</span><span class="pill">re-ranked in ${fmtMs(m.ms)}</span>`
        : `<span class="pill strong">${fmtMs(m.ms)}</span><span class="pill">${state.cols[e].snapshots.length - 1 === firstIndex(e) ? (m.asked === 0 ? "first pass, cached" : `first pass, ${m.asked} questions asked`) : `${m.asked} of ${m.total} re-asked`}</span><span class="pill req">${m.requests} ${m.requests === 1 ? "request" : "requests"}</span>`
      : `<span class="pill muted">${c.loading ? "Running..." : "Not run yet"}</span>`;
    col.querySelector(".col-msg")!.innerHTML = c.error
      ? `<div class="error">${esc(c.error)}</div>`
      : c.loading
        ? `<div class="loading">${state.mode === "replay" ? "Replaying at recorded speed..." : "Asking the model..."}</div>`
        : "";
    const snap = latest(e);
    flipRender(col.querySelector<HTMLUListElement>(".ranked")!, c.error ? [] : rankedNow(e), snap?.result.judgments ?? {});
  }
}

/** FLIP: measure, reorder, invert, play. */
function flipRender(ul: HTMLUListElement, ranked: RankedOption[], judgments: Record<string, Judgment>) {
  const first = new Map<string, number>();
  ul.querySelectorAll<HTMLLIElement>("li[data-id]").forEach((li) => first.set(li.dataset.id!, li.offsetTop));
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
    li.className = `${r.blocked ? "blocked" : r.nearTie ? "tie" : r.rank === 1 ? "lead" : ""}${detailsOpen(r) ? " show-parts" : ""}`;
    li.innerHTML = rowHtml(r, judgments);
    ul.appendChild(li);
  }
  // A real label row before the first blocked option (works even when every option is blocked).
  let label = ul.querySelector<HTMLLIElement>("li.blocked-label");
  const firstBlocked = ul.querySelector<HTMLLIElement>("li[data-id].blocked");
  if (firstBlocked) {
    if (!label) {
      label = document.createElement("li");
      label.className = "blocked-label";
    }
    label.textContent = isSimple() ? "Ruled out: breaks a hard rule" : "Blocked by a constraint";
    ul.insertBefore(label, firstBlocked);
  } else label?.remove();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  ul.querySelectorAll<HTMLLIElement>("li[data-id]").forEach((li) => {
    const before = first.get(li.dataset.id!);
    if (before === undefined || reduce) return;
    const dy = before - li.offsetTop;
    if (Math.abs(dy) < 1) return;
    li.style.transition = "none";
    li.style.transform = `translateY(${dy}px)`;
    li.classList.add("moving");
    void li.offsetHeight;
    li.style.transition = "transform 650ms cubic-bezier(.2,.8,.2,1)";
    li.style.transform = "";
    li.addEventListener("transitionend", () => li.classList.remove("moving"), { once: true });
  });
}

const isDesktop = () => window.matchMedia("(min-width: 821px)").matches;

/** Details are closed by default, except the #1 card on desktop. A tap overrides the default. */
function detailsOpen(r: RankedOption): boolean {
  const t = state.partsToggled.get(r.optionId);
  if (t !== undefined) return t;
  return isDesktop() && r.rank === 1 && !r.blocked;
}

function rowHtml(r: RankedOption, judgments: Record<string, Judgment>): string {
  const s = scenario();
  const o = s.options.find((x) => x.id === r.optionId)!;
  const conf = confidenceOf(judgments, r.optionId);
  const open = detailsOpen(r);
  const toggle = `<button type="button" class="parts-toggle" data-parts="${esc(r.optionId)}" aria-expanded="${open}">${open ? "Hide details" : "Details"}</button>`;
  const parts = s.criteria.map((c) => `<span class="chip"><i style="width:${Math.round((r.parts[c.id] ?? 0) * 100)}%"></i><span>${esc(c.name)} ${(r.parts[c.id] ?? 0).toFixed(2)}</span></span>`).join("");
  const details = `
      <div class="details-body">
        <div class="conf-line" title="Average certainty of this option's Score answers, from the model's own probabilities. A model judgment, not a validated probability.">
          <span>Model certainty ${conf.toFixed(2)}</span>
          <div class="conf"><span style="width:${Math.round(conf * 100)}%"></span></div>
        </div>
        <div class="parts">${parts}</div>
      </div>`;
  if (r.blocked) {
    // Compact row: the option is out of the running, but its score and reasons stay one tap away.
    return `
    <div class="rank">X</div>
    <div class="body">
      <div class="name-row"><span class="name">${esc(o.name)}</span><span class="total">${r.total.toFixed(3)}</span></div>
      <div class="meta-row"><span class="reason">Blocked: ${r.blockedBy.map(nameOf).map(esc).join(", ")}</span>${toggle}</div>
      ${details}
    </div>`;
  }
  const tag = r.nearTie
    ? isSimple()
      ? `<span class="tag amber">too close to call</span>`
      : `<span class="tag amber" title="Within the near-tie margin (${nearTieMarginOf(s)}). The code makes no call between these.">too close to call (gap ${r.tieSpread.toFixed(3)})</span>`
    : "";
  return `
    <div class="rank">${rankLabel(r)}</div>
    <div class="body">
      <div class="name-row"><span class="name">${esc(o.name)}</span><span class="total">${r.total.toFixed(3)}</span></div>
      <div class="bar" aria-label="Score ${r.total.toFixed(2)}"><span style="width:${Math.round(r.total * 100)}%"></span></div>
      <div class="meta-row">${tag}${toggle}</div>
      ${details}
    </div>`;
}

const f2 = (n: number) => n.toFixed(2);

const numLabel = (cls: string, label: string, v: number, l: GaugeLabel) =>
  `<span class="g-num ${cls}" data-row="${l.row}" style="left:${l.left.toFixed(1)}%;transform:translateX(-${l.shift.toFixed(1)}%)">${esc(label)} <b>${f2(v)}</b></span>`;

/**
 * A thin track with a dot at the current value and a tick at the flip point. Each number sits
 * under its own mark, anchored so it never runs past the track ends; close marks stack.
 */
function gauge(now: number, at: number, nowLabel: string, atLabel: string): string {
  const pct = (v: number) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(1)}%`;
  const lo = Math.min(now, at);
  const hi = Math.max(now, at);
  const g = gaugeLayout(now, at);
  return `<span class="gauge ${g.stacked ? "stacked" : ""}" role="img" aria-label="${esc(nowLabel)} ${f2(now)}, ${esc(atLabel)} ${f2(at)}">
    <span class="g-track"><span class="g-gap" style="left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})"></span><span class="g-tick" style="left:${pct(at)}"></span><span class="g-dot" style="left:${pct(now)}"></span></span>
    <span class="g-nums">${numLabel("g-now", nowLabel, now, g.now)}${numLabel("g-at", atLabel, at, g.at)}</span>
  </span>`;
}

/** After render: if two labels still collide (narrow screens, long labels), stack them. */
function unstickGaugeLabels(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".gauge:not(.stacked)").forEach((gEl) => {
    const a = gEl.querySelector<HTMLElement>(".g-now")?.getBoundingClientRect();
    const b = gEl.querySelector<HTMLElement>(".g-at")?.getBoundingClientRect();
    if (!a || !b) return;
    if (a.right + 6 > b.left && b.right + 6 > a.left) {
      gEl.classList.add("stacked");
      gEl.querySelector<HTMLElement>(".g-at")!.dataset.row = "1";
    }
  });
}

/** The card body, drawn from whereWeAreGoing's structured fields (not from its sentence). */
function outlookBody(o: ReturnType<typeof whereWeAreGoing>): string {
  if (o.kind === "flip") {
    const leader = esc(nameOf(o.leaderId));
    const challenger = esc(nameOf(o.challengerId));
    const label =
      o.via === "gate"
        ? `Risk to "${esc(o.targetName)}"`
        : o.via === "raise-second"
          ? `${challenger}'s "${esc(o.targetName)}"`
          : `Its "${esc(o.targetName)}"`;
    const verb = o.via === "gate" ? "reaches" : o.via === "raise-second" ? "rises above" : "falls below";
    return `
      <p class="oc-lead"><span class="oc-name">${leader}</span> stays first unless:</p>
      <div class="oc-cond">
        <div class="oc-label">${label} <span class="muted">${verb}</span></div>
        ${gauge(o.from, o.to, "now", o.via === "gate" ? "blocks at" : "flips at")}
      </div>
      <p class="oc-then"><span class="muted">Then:</span> <span class="oc-name">${challenger}</span> takes the lead.</p>`;
  }
  if (o.kind === "too-close") {
    const rows = o.optionIds
      .map((id, i) => `<li><span class="oc-name">${esc(nameOf(id))}</span><span class="oc-num">${(o.totals[i] ?? 0).toFixed(3)}</span></li>`)
      .join("");
    return `
      <ul class="oc-tie">${rows}</ul>
      <div class="oc-tie-foot"><span class="oc-num">gap ${o.gap.toFixed(3)}, inside the ${o.margin} margin</span><span class="tag amber">Your call</span></div>`;
  }
  return `<p class="oc-plain">${esc(o.text)}</p>`;
}

function renderInsight() {
  const s = scenario();
  const jevSnaps = state.cols.jev.snapshots.filter(Boolean) as Snapshot[];
  const last = latest("jev");
  const cardHead = `<div class="card-head"><h2>What would change the call</h2><span class="pill">0 model calls</span></div>`;
  if (!last) {
    $("#insight").innerHTML = `<div class="card outlook-card">${cardHead}<p class="muted small">Start the demo to see what would change the call.</p></div>`;
    return;
  }
  const outlook = whereWeAreGoing(s, last.result.judgments, state.settings);
  let localLine = "";
  if (state.compareLocal) {
    const l = rankedNow("local").find((r) => !r.blocked);
    const j = rankedNow("jev").find((r) => !r.blocked);
    if (l && j) localLine = `<p class="oc-local">${l.optionId === j.optionId ? `Clef agrees: ${esc(nameOf(l.optionId))} first.` : `Clef puts ${esc(nameOf(l.optionId))} first instead.`}</p>`;
  }
  const rows = compareToBaseline(s, jevSnaps, state.settings, 4);
  const clean = (n: number) => (Math.abs(n) < 0.005 ? 0 : n);
  const delta = (n: number) => `${clean(n) >= 0 ? "+" : ""}${clean(n).toFixed(2)}`;
  const driverText = (d: (typeof rows)[number]["drivers"][number]) => `${d.fact.at} ${d.fact.title}: ${d.text}`;
  const compareList = rows
    .map((r) => {
      const d = clean(r.totalNow - r.totalThen);
      const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
      const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "";
      const [main, ...more] = r.drivers;
      return `<li class="cmp-row ${dir} ${r.blockedNow ? "blocked" : ""}">
        <div class="cmp-head">
          <span class="name">${esc(r.name)}</span>
          <span class="cmp-move">${esc(r.rankThen)} → <strong>${esc(r.rankNow)}</strong></span>
          <span class="cmp-delta">${arrow} ${delta(r.totalNow - r.totalThen)}</span>
        </div>
        <div class="cmp-reason">${main ? esc(driverText(main)) : "No change from the facts so far."}</div>
        ${
          more.length
            ? `<details class="cmp-more" data-cmp="${esc(r.optionId)}" ${state.cmpOpen.has(r.optionId) ? "open" : ""}><summary>${more.length} more ${more.length === 1 ? "reason" : "reasons"}</summary><ul>${more.map((x) => `<li>${esc(driverText(x))}</li>`).join("")}</ul></details>`
            : ""
        }
      </li>`;
    })
    .join("");
  $("#insight").innerHTML = `
    <div class="card outlook-card ${outlook.kind}" aria-label="What would change the call">
      ${cardHead}
      ${outlookBody(outlook)}
      ${localLine}
    </div>
    <div class="card compare">
      <div class="card-head"><h2>Where we were, where we are</h2></div>
      ${
        jevSnaps.length < 2
          ? `<p class="muted small">Add a fact or play the demo to compare against the starting point.</p>`
          : `<ol class="cmp">${compareList}</ol>`
      }
    </div>`;
  unstickGaugeLabels($("#insight"));
  document.querySelectorAll<HTMLDetailsElement>("details[data-cmp]").forEach((el) =>
    el.addEventListener("toggle", () => {
      if (el.open) state.cmpOpen.add(el.dataset.cmp!);
      else state.cmpOpen.delete(el.dataset.cmp!);
    }),
  );
}

/** The hero: the current call, straight from the code, with the one-line outlook under it. */
function renderCall() {
  const el = $("#call");
  const s = scenario();
  const last = latest("jev");
  if (!last) {
    el.innerHTML = "";
    el.className = "call";
    return;
  }
  const ranked = rank(s, last.result.judgments, state.settings);
  const open = ranked.filter((r) => !r.blocked);
  const top = open[0];
  const outlook = whereWeAreGoing(s, last.result.judgments, state.settings);
  let tone = "teal";
  let headline: string;
  // Simple view: plain words. Full view: the detailed sentence.
  let sub = isSimple() ? plainOutlook(outlook, nameOf) : outlook.text;
  if (!top) {
    tone = "red";
    headline = isSimple() ? plainHeadline("none", []) : "No call: every option is blocked by a constraint. This is your decision.";
    sub = isSimple() ? plainOutlook(outlook, nameOf) : "Change a constraint below, or add a fact that unblocks an option.";
  } else if (top.nearTie) {
    tone = "amber";
    const group = open.filter((r) => r.nearTie && r.groupRank === top.groupRank).map((r) => nameOf(r.optionId));
    const names = group.length === 2 ? `${group[0]} vs ${group[1]}` : `${group.slice(0, -1).join(", ")} vs ${group[group.length - 1]}`;
    headline = isSimple() ? plainHeadline("tie", group) : `Too close to call: ${names} (gap ${top.tieSpread.toFixed(3)}). This is your decision.`;
    sub = isSimple() ? plainOutlook(outlook, nameOf) : `Callpoint won't pick between options within the ${nearTieMarginOf(s)} near-tie margin.`;
  } else {
    headline = isSimple() ? plainHeadline("call", [nameOf(top.optionId)]) : `Current call: ${nameOf(top.optionId)} · ${top.total.toFixed(3)}`;
  }
  const key = `${tone}|${headline}`;
  const changed = el.dataset.key !== key;
  el.className = `call ${tone}`;
  el.innerHTML = `<p class="call-head">${esc(headline)}</p><p class="call-sub">${esc(sub)}</p>`;
  if (changed && el.dataset.key !== undefined && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.classList.remove("swap");
    void el.offsetWidth;
    el.classList.add("swap");
  }
  el.dataset.key = key;
}

function renderTuning() {
  const s = scenario();
  const st = state.settings;
  $("#tuning").innerHTML = `
    <h2>The code decides</h2>
    <p class="muted small">Weights and hard constraints live in code. Change them and the same judgments re-rank instantly, with 0 model calls.</p>
    <div class="sliders">
      ${s.criteria
        .map(
          (c) => `<label class="slider">
          <span class="slider-head"><span>${esc(c.name)}</span><output id="w-${esc(c.id)}">${(st.weights[c.id] ?? 0).toFixed(2)}</output></span>
          <input type="range" min="0" max="1" step="0.05" value="${st.weights[c.id] ?? 0}" data-weight="${esc(c.id)}" aria-label="Weight for ${esc(c.name)}" />
        </label>`,
        )
        .join("")}
    </div>
    <fieldset class="toggles">
      <legend>Hard constraints</legend>
      ${s.constraints
        .map(
          (k) => `<label class="toggle"><input type="checkbox" data-constraint="${esc(k.id)}" ${st.constraintsEnabled[k.id] !== false ? "checked" : ""} /> ${esc(k.name)} <span class="muted small">blocks at ${k.threshold}</span></label>`,
        )
        .join("")}
    </fieldset>
    <button type="button" class="ghost" id="reset-weights">Reset weights</button>`;
  document.querySelectorAll<HTMLInputElement>("[data-weight]").forEach((input) =>
    input.addEventListener("input", () => {
      const id = input.dataset.weight!;
      state.settings = { ...state.settings, weights: { ...state.settings.weights, [id]: Number(input.value) } };
      $(`#w-${CSS.escape(id)}`).textContent = Number(input.value).toFixed(2);
      rerank(`${nameOf(id)} weight changed`);
    }),
  );
  // Record the change once, when the slider is released, so the receipt has one line per change.
  document.querySelectorAll<HTMLInputElement>("[data-weight]").forEach((input) => input.addEventListener("change", () => recordTuning()));
  document.querySelectorAll<HTMLInputElement>("[data-constraint]").forEach((input) =>
    input.addEventListener("change", () => {
      const id = input.dataset.constraint!;
      state.settings = { ...state.settings, constraintsEnabled: { ...state.settings.constraintsEnabled, [id]: input.checked } };
      rerank(`${nameOf(id)} turned ${input.checked ? "on" : "off"}`);
      recordTuning();
    }),
  );
  $("#reset-weights").addEventListener("click", () => {
    state.settings = defaultSettings(s) as RankSettings;
    renderTuning();
    rerank("Weights reset");
    recordTuning();
  });
}

function renderReceipt() {
  const has = !!latest("jev");
  const md = has ? receipt() : "";
  $("#receipt").innerHTML = `
    <h2>Decision receipt</h2>
    <p class="muted small">A timestamped trail of every fact, the ranking after it, what moved and why, and the final call. Paste it into the postmortem.</p>
    <div class="actions">
      <button type="button" class="primary" id="copy-receipt" ${has ? "" : "disabled"}>Copy</button>
      <button type="button" id="dl-receipt" ${has ? "" : "disabled"}>Download .md</button>
    </div>
    ${has ? `<details class="receipt-view" id="receipt-view" ${state.receiptOpen ? "open" : ""}><summary>Preview</summary><pre>${esc(md)}</pre></details>` : ""}`;
  document.querySelector<HTMLDetailsElement>("#receipt-view")?.addEventListener("toggle", (e) => {
    state.receiptOpen = (e.target as HTMLDetailsElement).open;
  });
  $("#copy-receipt").addEventListener("click", async () => {
    state.toast = (await copyText(receipt())) ? "Receipt copied." : "Could not copy. Use Download instead.";
    renderToast();
  });
  $("#dl-receipt").addEventListener("click", () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    download(`callpoint-receipt-${scenario().id}-${stamp}.md`, receipt(), "text/markdown");
  });
}

let toastTimer: number | undefined;
function renderToast() {
  const el = $("#toast");
  el.textContent = state.toast;
  el.classList.toggle("show", !!state.toast);
  window.clearTimeout(toastTimer);
  if (state.toast)
    toastTimer = window.setTimeout(() => {
      state.toast = "";
      el.classList.remove("show");
    }, 2600);
}

/** Re-render everything except the editor and tuning, which keep focus while you type. */
/** "an incident", "a decision". */
const withArticle = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
const nounNow = () => nounOf(scenario());
const pitchFull = (n: string) => `Add facts as your ${n} unfolds. Callpoint re-ranks your options in milliseconds, flags when it's too close to call, and writes the decision trail for your postmortem.`;
const pitchSimple = (n: string) => `Press Play demo to watch ${withArticle(n)} unfold. Callpoint re-ranks the options as each new fact lands, and tells you when it's too close to call.`;

function renderViewSwitch() {
  const n = nounNow();
  const pitch = document.querySelector<HTMLElement>(".pitch");
  if (pitch) pitch.textContent = isSimple() ? pitchSimple(n) : pitchFull(n);
  const tagline = document.querySelector<HTMLElement>(".tagline");
  if (tagline) tagline.textContent = `${withArticle(n).replace(/^a/, "A")} co-pilot. The model judges, the code decides.`;
  const advice = document.querySelector<HTMLElement>("#advice-note");
  if (advice) advice.textContent = `This is a demo scenario, not ${n} advice. You set the goals, weights, and constraints.`;
  $("#view-switch").innerHTML = `
    <label class="switch">
      <input type="checkbox" role="switch" id="show-engine" ${isSimple() ? "" : "checked"} />
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      <span class="switch-label">Show the engine</span>
    </label>`;
  $<HTMLInputElement>("#show-engine").addEventListener("change", (e) => {
    state.view = (e.target as HTMLInputElement).checked ? "full" : "simple";
    writePref(VIEW_KEY, state.view);
    renderAll(true);
  });
}

function renderGuide() {
  const el = $("#guide");
  if (!isSimple() || state.guideDismissed) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <ol class="guide-steps">
      <li><span class="step-n">1</span> Here's the problem.</li>
      <li><span class="step-n">2</span> Press play: new facts arrive.</li>
      <li><span class="step-n">3</span> Watch the call change, and see when it hands the decision to you.</li>
    </ol>
    <button type="button" class="ghost small" id="guide-close">Got it</button>`;
  $("#guide-close").addEventListener("click", () => {
    state.guideDismissed = true;
    writePref(GUIDE_KEY, "dismissed");
    renderGuide();
  });
}

function renderAll(full = false) {
  document.body.classList.toggle("view-simple", isSimple());
  renderViewSwitch();
  renderGuide();
  renderTop();
  renderBanner();
  if (full) {
    renderProblem();
    renderTuning();
    $("#race").innerHTML = "";
  } else {
    // Keep the editor open and intact; refresh only the buttons.
    const open = (document.querySelector("#editor-details") as HTMLDetailsElement | null)?.open;
    if (open) refreshProblemButtons();
    else renderProblem();
  }
  renderTimeline();
  renderCall();
  renderRace();
  renderInsight();
  renderReceipt();
  renderToast();
}

function playLabel(applied: number, n: number): string {
  if (state.playing) return "Playing...";
  if (applied >= n) return `<span class="wide-only">Demo finished</span><span class="narrow-only">Done</span>`;
  return applied ? `Continue<span class="wide-only"> demo</span>` : "Play demo";
}

function resetLabel(applied: number, n: number): string {
  return applied >= n && state.mode === "replay" ? `<span class="wide-only">Replay from start</span><span class="narrow-only">Replay</span>` : "Start over";
}

function refreshProblemButtons() {
  const n = scenario().updates.length;
  const applied = state.facts.filter((f) => f.source === "scripted").length;
  const off = busy() || state.playing || applied >= n;
  const play = $<HTMLButtonElement>("#play");
  play.disabled = off;
  play.innerHTML = playLabel(applied, n);
  $<HTMLButtonElement>("#next").disabled = off;
  const reset = $<HTMLButtonElement>("#reset");
  reset.disabled = !(applied || state.facts.length);
  reset.innerHTML = resetLabel(applied, n);
  reset.className = applied >= n ? "" : "ghost";
}

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-parts]");
  if (!b) return;
  const id = b.dataset.parts!;
  const open = !(b.closest("li")?.classList.contains("show-parts") ?? false);
  state.partsToggled.set(id, open);
  document.querySelectorAll<HTMLLIElement>(`.ranked li[data-id="${CSS.escape(id)}"]`).forEach((li) => li.classList.toggle("show-parts", open));
  document.querySelectorAll<HTMLButtonElement>(`[data-parts="${CSS.escape(id)}"]`).forEach((x) => {
    x.textContent = open ? "Hide details" : "Details";
    x.setAttribute("aria-expanded", String(open));
  });
});

if (!scenarios.length) {
  document.body.textContent = "No scenarios found in scenarios/*.json.";
} else {
  shell();
  wireThemeToggle();
  renderAll(true);
  void loadStatus().then(() => {
    for (const e of ENGINES) if (!state.cols[e].model) state.cols[e].model = defaultModel(e);
    renderAll(true);
  });
}
