import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildQuestions, nounOf, questionKey } from "../src/engine/questions";
import { stableStringify } from "../src/engine/stable";
import { validateScenario } from "../src/engine/validate";
import { loadFixture } from "./helpers";

const s = loadFixture();

/** sha256 of every question (key, state, spec) at every step. */
function questionsHash(sc: typeof s): string {
  const all = [];
  for (let step = 0; step <= sc.updates.length; step++) all.push(buildQuestions(sc, step).map((q) => ({ key: q.key, state: q.state, spec: q.spec })));
  return createHash("sha256").update(stableStringify(all)).digest("hex");
}

describe("scenario noun", () => {
  it("keeps the incident-triage questions byte-identical (hash taken before the noun existed)", () => {
    expect(s.noun).toBeUndefined();
    expect(questionsHash(s)).toBe("37f5b7c50b1be75751e1fb3ce83a0c66a173196cda8083fee0aa3e9727611029");
    // Setting the default explicitly changes nothing either.
    expect(questionsHash({ ...s, noun: "incident" })).toBe(questionsHash(s));
  });

  it("uses the noun in the state key and the question wording", () => {
    const d = { ...s, noun: "decision" };
    expect(nounOf(d)).toBe("decision");
    const q = buildQuestions(d, 0).find((x) => x.key === questionKey("rollback", "impact"))!;
    expect(Object.keys(q.state)).toEqual(["goal", "decision", "timeline"]);
    expect(JSON.stringify(q.spec.instructions)).toContain("Judge it against the goal, decision, and timeline in the state.");
    expect(JSON.stringify(q.spec.instructions)).not.toContain("incident");
    const n = buildQuestions(d, 0).find((x) => x.key === questionKey("rollback", "data_loss"))!;
    expect(JSON.stringify(n.spec.instructions)).toContain("Answer from the goal, decision, and timeline in the state.");
  });

  it("validates the noun and requires the situation text", () => {
    expect(() => validateScenario({ ...s, noun: "Big Decision!" })).toThrow(/noun/);
    expect(() => validateScenario({ ...s, incident: {} })).toThrow(/incident.summary/);
    expect(() => validateScenario({ ...s, incident: { summary: "  " } })).toThrow(/incident.summary/);
    expect(validateScenario({ ...s, noun: "decision" }).noun).toBe("decision");
  });
});
