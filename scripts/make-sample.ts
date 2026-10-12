// Builds scenarios/incident-triage.recording.SAMPLE.json: hand-authored, SYNTHETIC judgments
// so Replay mode has something to show before a real recording exists. Not model output.
// The real recording comes from `npm run record` with your own TypeSafe key.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { JudgmentCache } from "../src/engine/cache";
import type { BuiltQuestion } from "../src/engine/questions";
import { runScenario, type Adapter } from "../src/engine/runner";
import type { EngineId, Judgment, Recording } from "../src/engine/types";
import { getScenario, SCENARIO_DIR } from "../src/server/scenarios";

const scenario = getScenario("incident-triage")!;

type Row = Record<string, number>;
// Authored levels (0..3) for criteria and P(yes) for constraints, by option, after N updates.
const base: Record<string, Row> = {
  rollback: { impact: 3, speed: 2, safety: 2, evidence: 2, data_loss: 0.08, ic_forbidden: 0.04 },
  disable_flag: { impact: 2, speed: 3, safety: 3, evidence: 1, data_loss: 0.03, ic_forbidden: 0.03 },
  scale_db: { impact: 1, speed: 2, safety: 1, evidence: 1, data_loss: 0.3, ic_forbidden: 0.04 },
  region_failover: { impact: 2, speed: 2, safety: 1, evidence: 1, data_loss: 0.2, ic_forbidden: 0.04 },
  hotfix: { impact: 2, speed: 0, safety: 1, evidence: 1, data_loss: 0.05, ic_forbidden: 0.05 },
};
const changes: Record<number, Record<string, Row>> = {
  1: { disable_flag: { impact: 3, evidence: 3 }, rollback: { evidence: 3 }, scale_db: { evidence: 1 } },
  2: { scale_db: { safety: 0, data_loss: 0.91 }, region_failover: { data_loss: 0.38 } },
  3: { region_failover: { impact: 0, evidence: 0 } },
  4: { hotfix: { ic_forbidden: 0.94 }, rollback: { ic_forbidden: 0.31 } },
  5: { rollback: { speed: 1, safety: 1 } },
};
// The sample "local" column disagrees in a few places, to show what a comparison looks like.
const localDiff: Record<string, Row> = { hotfix: { speed: 1 }, scale_db: { impact: 2 } };

function valueAt(option: string, target: string, step: number, engine: EngineId): number {
  let v = base[option]![target]!;
  for (let k = 1; k <= step; k++) v = changes[k]?.[option]?.[target] ?? v;
  if (engine === "local") v = localDiff[option]?.[target] ?? v;
  return v;
}

function judge(q: BuiltQuestion, engine: EngineId): Judgment {
  const step = (q.state.timeline as unknown[]).length === 0 ? 0 : stepOf(q);
  const v = valueAt(q.optionId, q.targetId, step, engine);
  if (q.kind === "noul") return { kind: "noul", p: engine === "local" ? (v >= 0.5 ? 1 : 0) : v };
  const n = q.spec.type === "score" ? q.spec.criteria.length : 4;
  const probabilities: number[] = Array.from({ length: n }, (_, i) => (i === v ? 1 : 0));
  if (engine === "jev") {
    // Spread a little mass to a neighbour so the sample looks like a distribution.
    const nb = v === n - 1 ? v - 1 : v + 1;
    probabilities[v] = 0.85;
    probabilities[nb] = 0.15;
  }
  const score = probabilities.reduce((s, p, i) => s + p * i, 0);
  return { kind: "score", score: Math.round(score * 100) / 100, probabilities, ...(engine === "jev" ? { confidence: 0.7 } : {}) };
}

/** The latest update in this question's scoped timeline tells us which step it belongs to. */
function stepOf(q: BuiltQuestion): number {
  const tl = q.state.timeline as { title: string }[];
  const last = tl[tl.length - 1]!;
  return scenario.updates.findIndex((u) => u.title === last.title) + 1;
}

function fake(engine: EngineId, model: string): Adapter {
  return {
    engine,
    model,
    async ask(_state, qs) {
      return { answers: Object.fromEntries(qs.map((q) => [q.key, judge(q, engine)])), requests: engine === "jev" ? 1 : qs.length };
    },
  };
}

// Placeholder timings, not measurements.
const placeholderMs: Record<EngineId, number[]> = { jev: [500, 400, 400, 400, 400, 800], local: [8000, 2500, 2500, 2500, 2500, 3000] };

const rec: Recording = {
  scenarioId: scenario.id,
  synthetic: true,
  note: "SAMPLE DATA, NOT A REAL RUN. Hand-authored judgments and placeholder timings so Replay mode works before a real recording exists. Run `npm run record` with your own TypeSafe key to make a real one.",
  recordedAt: new Date().toISOString(),
  engines: {},
};
for (const [engine, model] of [["jev", "jev-1.13.0"], ["local", "llama3.2:3b"]] as const) {
  const steps = await runScenario(scenario, fake(engine, model), new JudgmentCache());
  steps.forEach((s, i) => (s.ms = placeholderMs[engine][i] ?? 500));
  rec.engines[engine] = { model, steps };
}
const out = join(SCENARIO_DIR, "incident-triage.recording.SAMPLE.json");
writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
console.log(`Wrote ${out}`);
