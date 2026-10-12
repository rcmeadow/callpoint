import { JudgmentCache } from "../src/engine/cache";
import { order, rank } from "../src/engine/rank";
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
    const ranked = order(rank(scenario, r.judgments));
    const title = r.step === 0 ? "initial" : `update ${r.step} (${scenario.updates[r.step - 1]?.title})`;
    console.log(
      `step ${r.step} ${title.padEnd(36)} asked ${String(r.asked).padStart(2)}/${r.total}  requests ${String(r.requests).padStart(2)}  ${String(r.ms).padStart(6)} ms  order: ${ranked.join(" > ")}`,
    );
  });
}

export function compareOrders(scenario: Scenario, a: StepResult[], b: StepResult[]): { same: boolean; lines: string[] } {
  const lines: string[] = [];
  let same = true;
  a.forEach((ra, i) => {
    const rb = b[i];
    const oa = order(rank(scenario, ra.judgments)).join(" > ");
    const ob = rb ? order(rank(scenario, rb.judgments)).join(" > ") : "(missing)";
    const ok = oa === ob;
    if (!ok) same = false;
    lines.push(`step ${i}: ${ok ? "same order" : `DIFFERENT\n  run 1: ${oa}\n  run 2: ${ob}`}`);
  });
  return { same, lines };
}

export function summarize(steps: StepResult[]): string {
  const ms = steps.map((s) => s.ms);
  const total = ms.reduce((x, y) => x + y, 0);
  const asked = steps.reduce((x, s) => x + s.asked, 0);
  return `total ${total} ms over ${steps.length} steps, ${asked} questions asked; initial ${ms[0]} ms; updates ${ms.slice(1).join(", ")} ms`;
}
