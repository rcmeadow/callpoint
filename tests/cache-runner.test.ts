import { describe, expect, it } from "vitest";
import { cacheKey, JudgmentCache } from "../src/engine/cache";
import { affectedKeys } from "../src/engine/questions";
import { runScenario, runStep } from "../src/engine/runner";
import { fakeAdapter, loadFixture, score } from "./helpers";

const s = loadFixture();
const answer = (q: { kind: string }) => (q.kind === "noul" ? { kind: "noul" as const, p: 0.1 } : score(2));

describe("judgment cache", () => {
  it("keys by a hash of engine, model, state and question, independent of key order", () => {
    const a = cacheKey("jev", "m", { x: 1, y: [1, 2] }, { q: "a" });
    const b = cacheKey("jev", "m", { y: [1, 2], x: 1 }, { q: "a" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey("jev", "m", { x: 2 }, { q: "a" })).not.toBe(cacheKey("jev", "m", { x: 1 }, { q: "a" }));
    expect(cacheKey("local", "m", { x: 1 }, { q: "a" })).not.toBe(cacheKey("jev", "m", { x: 1 }, { q: "a" }));
  });

  it("stores and clears", () => {
    const c = new JudgmentCache();
    c.set("k", score(1));
    expect(c.get("k")).toEqual(score(1));
    c.clear();
    expect(c.size).toBe(0);
  });
});

describe("runner", () => {
  it("asks all 30 questions in one batched request at step 0", async () => {
    const { adapter, calls } = fakeAdapter(answer);
    const r = await runStep(s, 0, adapter, new JudgmentCache());
    expect(r.asked).toBe(30);
    expect(r.requests).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("re-asks only the questions an update affects", async () => {
    const { adapter, calls } = fakeAdapter(answer);
    const cache = new JudgmentCache();
    const steps = await runScenario(s, adapter, cache);
    for (let k = 1; k <= s.updates.length; k++) {
      expect(steps[k]!.asked).toBe(affectedKeys(s, k).length);
      expect(steps[k]!.total).toBe(30);
      expect(Object.keys(steps[k]!.judgments)).toHaveLength(30);
    }
    // Update 5 touches speed and safety, whose timelines differ, so two requests.
    expect(steps[5]!.requests).toBe(2);
    expect(calls.reduce((n, c) => n + c.keys.length, 0)).toBe(30 + s.updates.reduce((n, _u, i) => n + affectedKeys(s, i + 1).length, 0));
  });

  it("asks nothing when the same step runs again", async () => {
    const { adapter, calls } = fakeAdapter(answer);
    const cache = new JudgmentCache();
    await runStep(s, 2, adapter, cache);
    const before = calls.length;
    const again = await runStep(s, 2, adapter, cache);
    expect(again.asked).toBe(0);
    expect(again.requests).toBe(0);
    expect(again.ms).toBe(0);
    expect(calls.length).toBe(before);
  });

  it("fails loudly when an adapter skips an answer", async () => {
    const { adapter } = fakeAdapter(answer);
    const broken = { ...adapter, ask: async () => ({ answers: {}, requests: 1 }) };
    await expect(runStep(s, 0, broken, new JudgmentCache())).rejects.toThrow(/no answer/);
  });
});
