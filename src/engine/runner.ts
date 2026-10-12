import { performance } from "node:perf_hooks";
import { cacheKey, JudgmentCache } from "./cache";
import { buildQuestions, type BuiltQuestion, type JsonValue } from "./questions";
import { stableStringify } from "./stable";
import type { EngineId, Judgment, Scenario, StepResult } from "./types";

export interface AdapterResult {
  answers: Record<string, Judgment>;
  requests: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface Adapter {
  engine: EngineId;
  model: string;
  /** Answer every question against one shared state. */
  ask(state: { [key: string]: JsonValue }, questions: BuiltQuestion[]): Promise<AdapterResult>;
}

/**
 * Run one step: build every question, answer cache hits from the cache, and send only the
 * misses to the model, one batched ask per distinct state.
 */
export async function runStep(
  scenario: Scenario,
  step: number,
  adapter: Adapter,
  cache: JudgmentCache,
): Promise<StepResult> {
  const questions = buildQuestions(scenario, step);
  const judgments: Record<string, Judgment> = {};
  const groups = new Map<string, { state: BuiltQuestion["state"]; qs: BuiltQuestion[]; keys: string[] }>();
  for (const q of questions) {
    const ck = cacheKey(adapter.engine, adapter.model, q.state, q.spec);
    const hit = cache.get(ck);
    if (hit) {
      judgments[q.key] = hit;
      continue;
    }
    const gk = stableStringify(q.state);
    let g = groups.get(gk);
    if (!g) {
      g = { state: q.state, qs: [], keys: [] };
      groups.set(gk, g);
    }
    g.qs.push(q);
    g.keys.push(ck);
  }
  let requests = 0;
  let asked = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let sawUsage = false;
  const t0 = performance.now();
  const results = await Promise.all([...groups.values()].map((g) => adapter.ask(g.state, g.qs)));
  const ms = groups.size ? Math.round(performance.now() - t0) : 0;
  [...groups.values()].forEach((g, i) => {
    const r = results[i]!;
    requests += r.requests;
    if (r.usage) {
      sawUsage = true;
      usage.input_tokens += r.usage.input_tokens;
      usage.output_tokens += r.usage.output_tokens;
    }
    g.qs.forEach((q, qi) => {
      const j = r.answers[q.key];
      if (!j) throw new Error(`${adapter.engine}: no answer for ${q.key}`);
      judgments[q.key] = j;
      cache.set(g.keys[qi]!, j);
      asked++;
    });
  });
  return {
    engine: adapter.engine,
    model: adapter.model,
    step,
    judgments,
    asked,
    total: questions.length,
    requests,
    ms,
    ...(sawUsage ? { usage } : {}),
  };
}

/** Run every step of a scenario (0 = before any update, then one per update). */
export async function runScenario(
  scenario: Scenario,
  adapter: Adapter,
  cache: JudgmentCache,
  onStep?: (r: StepResult) => void,
): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (let step = 0; step <= scenario.updates.length; step++) {
    const r = await runStep(scenario, step, adapter, cache);
    onStep?.(r);
    out.push(r);
  }
  return out;
}
