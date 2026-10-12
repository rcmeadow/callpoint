import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateScenario } from "../src/engine/validate";
import type { Adapter } from "../src/engine/runner";
import type { BuiltQuestion } from "../src/engine/questions";
import type { Judgment, Scenario } from "../src/engine/types";

export function loadFixture(): Scenario {
  const p = fileURLToPath(new URL("../scenarios/incident-triage.json", import.meta.url));
  return validateScenario(JSON.parse(readFileSync(p, "utf8")));
}

export function score(level: number, levels = 4): Judgment {
  return { kind: "score", score: level, probabilities: Array.from({ length: levels }, (_, i) => (i === level ? 1 : 0)) };
}

/** A fake adapter that counts calls and answers from a function of the question and its state. */
export function fakeAdapter(answer: (q: BuiltQuestion) => Judgment) {
  const calls: { state: unknown; keys: string[] }[] = [];
  const adapter: Adapter = {
    engine: "local",
    model: "fake",
    async ask(state, qs) {
      calls.push({ state, keys: qs.map((q) => q.key) });
      return { answers: Object.fromEntries(qs.map((q) => [q.key, answer(q)])), requests: 1 };
    },
  };
  return { adapter, calls };
}
