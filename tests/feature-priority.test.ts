import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildQuestions } from "../src/engine/questions";
import { rank } from "../src/engine/rank";
import { validateScenario } from "../src/engine/validate";
import type { Recording } from "../src/engine/types";

const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../scenarios/${f}`, import.meta.url)), "utf8"));
const s = validateScenario(read("feature-priority.json"), "feature-priority.json");

describe("feature-priority scenario", () => {
  it("is a valid, plain-language decision scenario", () => {
    expect(s.id).toBe("feature-priority");
    expect(s.noun).toBe("decision");
    expect((s.incident.summary ?? "").length).toBeGreaterThan(40);
    expect(s.options).toHaveLength(5);
    expect(s.criteria).toHaveLength(4);
    expect(s.constraints.length).toBeGreaterThanOrEqual(1);
    expect(s.updates.length).toBeGreaterThanOrEqual(5);
    // The situation lives in the "incident" field, but no visible text calls it an incident.
    const visible = [s.title, s.goal, s.incident.summary ?? "", ...s.options.flatMap((o) => [o.name, o.description]), ...s.criteria.flatMap((c) => [c.name, c.question, ...c.levels]), ...s.constraints.flatMap((k) => [k.name, k.question]), ...s.updates.flatMap((u) => [u.title, u.text])];
    expect(visible.join(" ")).not.toMatch(/incident/i);
  });

  it("asks its questions about a decision, not an incident", () => {
    const q = buildQuestions(s, 0)[0]!;
    expect(Object.keys(q.state)).toContain("decision");
    expect(JSON.stringify(q.spec.instructions)).toContain("the goal, decision, and timeline");
  });

  it("has a real recording (Jev and Clef) with one step per fact, and the top option changes", () => {
    const rec = read("feature-priority.recording.json") as Recording;
    expect(rec.scenarioId).toBe("feature-priority");
    expect(rec.synthetic).toBe(false);
    const jev = rec.engines.jev!;
    expect(jev.model).toBe("jev-1.13.0");
    expect(jev.steps).toHaveLength(s.updates.length + 1);
    expect(rec.engines.local?.steps).toHaveLength(s.updates.length + 1);
    const tops = jev.steps.map((st) => rank(s, st.judgments).find((r) => !r.blocked)!.optionId);
    expect(new Set(tops).size).toBeGreaterThan(1);
  });

  it("reaches too close to call at the top at least once", () => {
    const rec = read("feature-priority.recording.json") as Recording;
    const topTies = rec.engines.jev!.steps.filter((st) => {
      const open = rank(s, st.judgments).filter((r) => !r.blocked);
      return open[0]!.nearTie && open[1]!.nearTie && open[0]!.groupRank === open[1]!.groupRank;
    });
    expect(topTies.length).toBeGreaterThan(0);
  });
});
