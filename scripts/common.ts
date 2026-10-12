import { JudgmentCache } from "../src/engine/cache";
import { nearTieMarginOf, rank, rankLabel } from "../src/engine/rank";
import { compareRankings } from "../src/engine/ordercheck";
import { runScenario, type Adapter } from "../src/engine/runner";
import type { Scenario, StepResult } from "../src/engine/types";

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);

export async function runAndPrint(scenario: Scenario, adapter: Adapter, label: string): Promise<StepResult[]> {
  const cache = new JudgmentCache();
  console.log(`\n== ${label}: ${adapter.engine} (${adapter.model}), cache cleared ==`);
  return runScenario(scenario, adapter, cache, (r) => {
    const ranked = rank(scenario, r.judgments).map((x) => `${x.optionId}(${x.blocked ? "X" : rankLabel(x)} ${x.total.toFixed(3)})`);
    const title = r.step === 0 ? "initial" : `update ${r.step} (${scenario.updates[r.step - 1]?.title})`;
    console.log(
      `step ${r.step} ${title.padEnd(36)} asked ${String(r.asked).padStart(2)}/${r.total}  requests ${String(r.requests).padStart(2)}  ${String(r.ms).padStart(6)} ms  order: ${ranked.join(" > ")}`,
    );
  });
}

export function compareOrders(scenario: Scenario, a: StepResult[], b: StepResult[]): { same: boolean; lines: string[] } {
  const lines: string[] = [];
  let same = true;
  const f3 = (n: number) => n.toFixed(3);
  lines.push(`(near-tie margin ${nearTieMarginOf(scenario)}: swaps inside a near-tie group are collapsed, not failures)`);
  a.forEach((ra, i) => {
    const rb = b[i];
    if (!rb) {
      same = false;
      lines.push(`step ${i}: DIFFERENT (run 2 missing)`);
      return;
    }
    const k1 = rank(scenario, ra.judgments);
    const k2 = rank(scenario, rb.judgments);
    const cmp = compareRankings(k1, k2);
    if (!cmp.same) same = false;
    const label = (k: typeof k1) => k.map((r) => `${r.optionId}(${rankLabel(r)} ${f3(r.total)})`).join(" > ");
    lines.push(`step ${i}: ${cmp.same ? (cmp.collapsed.length ? "same order after collapsing near ties" : "same order") : "DIFFERENT"}`);
    for (const s of cmp.collapsed) lines.push(`  collapsed swap: ${s.a} vs ${s.b}: run 1 ${f3(s.totals1[0])} vs ${f3(s.totals1[1])}, run 2 ${f3(s.totals2[0])} vs ${f3(s.totals2[1])}`);
    for (const s of cmp.conflicts) lines.push(`  conflict: ${s.a} vs ${s.b}: run 1 ${f3(s.totals1[0])} vs ${f3(s.totals1[1])}, run 2 ${f3(s.totals2[0])} vs ${f3(s.totals2[1])}`);
    if (!cmp.same) lines.push(`  run 1: ${label(k1)}\n  run 2: ${label(k2)}`);
  });
  return { same, lines };
}

export function summarize(steps: StepResult[]): string {
  const ms = steps.map((s) => s.ms);
  const total = ms.reduce((x, y) => x + y, 0);
  const asked = steps.reduce((x, s) => x + s.asked, 0);
  return `total ${total} ms over ${steps.length} steps, ${asked} questions asked; initial ${ms[0]} ms; updates ${ms.slice(1).join(", ")} ms`;
}
