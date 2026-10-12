import { describe, expect, it } from "vitest";
import { affectedKeys, buildQuestions, questionKey, stateFor } from "../src/engine/questions";
import { loadFixture } from "./helpers";

const s = loadFixture();

describe("question builder", () => {
  it("builds one Score per option x criterion and one Noul per option x constraint", () => {
    const qs = buildQuestions(s, 0);
    expect(qs).toHaveLength(5 * 4 + 5 * 2);
    expect(qs.filter((q) => q.kind === "score")).toHaveLength(20);
    expect(qs.filter((q) => q.kind === "noul")).toHaveLength(10);
    expect(new Set(qs.map((q) => q.key)).size).toBe(30);
  });

  it("names the option and criterion in the instructions (ids are not sent to the model)", () => {
    const q = buildQuestions(s, 0).find((x) => x.key === questionKey("disable_flag", "impact"))!;
    const text = JSON.stringify(q.spec.instructions);
    expect(text).toContain("Disable the smart-retries flag");
    expect(text).toContain("Error reduction");
    expect(text).not.toContain("disable_flag__impact");
    expect(q.spec.type).toBe("score");
    if (q.spec.type === "score") expect(q.spec.criteria).toEqual(s.criteria[0]!.levels);
  });

  it("scopes each question's state to the updates that affect its target", () => {
    expect(stateFor(s, 0, "impact").timeline).toEqual([]);
    const impact = stateFor(s, 5, "impact").timeline as { title: string }[];
    expect(impact.map((u) => u.title)).toEqual(["Deploy diff reviewed", "Standby region check"]);
    const speed = stateFor(s, 5, "speed").timeline as { title: string }[];
    expect(speed.map((u) => u.title)).toEqual(["Incident commander order", "Rollback artifact problem"]);
  });

  it("lists the keys an update affects", () => {
    expect(affectedKeys(s, 1).sort()).toEqual(
      s.options.flatMap((o) => [questionKey(o.id, "impact"), questionKey(o.id, "evidence")]).sort(),
    );
    expect(affectedKeys(s, 99)).toEqual([]);
  });
});
