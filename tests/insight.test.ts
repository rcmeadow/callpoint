import { describe, expect, it } from "vitest";
import { JudgmentCache } from "../src/engine/cache";
import { compareToBaseline, whereWeAreGoing, type Snapshot } from "../src/engine/insight";
import { buildQuestionsFor, questionKey, scriptedFacts, stateForFacts } from "../src/engine/questions";
import { defaultSettings, rank } from "../src/engine/rank";
import { buildReceipt } from "../src/engine/receipt";
import { runFacts, runStep } from "../src/engine/runner";
import type { Fact, Judgment, StepResult } from "../src/engine/types";
import { fakeAdapter, loadFixture, score } from "./helpers";

const s = loadFixture();
const settings = defaultSettings(s);
const spread = (sc: number, probabilities: number[]): Judgment => ({ kind: "score", score: sc, probabilities });

function flat(over: Record<string, Judgment> = {}): Record<string, Judgment> {
  const j: Record<string, Judgment> = {};
  for (const o of s.options) {
    for (const c of s.criteria) j[questionKey(o.id, c.id)] = score(1);
    for (const k of s.constraints) j[questionKey(o.id, k.id)] = { kind: "noul", p: 0.05 };
  }
  return { ...j, ...over };
}
/** rollback 0.600, disable_flag 0.467, scale_db 0.333, region_failover 0.200, hotfix 0.150. */
function distinct(over: Record<string, Judgment> = {}) {
  return flat({
    [questionKey("rollback", "impact")]: score(3),
    [questionKey("disable_flag", "impact")]: score(2),
    [questionKey("scale_db", "impact")]: score(1),
    [questionKey("region_failover", "impact")]: score(0),
    [questionKey("hotfix", "impact")]: score(0),
    [questionKey("hotfix", "evidence")]: score(0),
    ...over,
  });
}
const result = (judgments: Record<string, Judgment>, step = 0): StepResult => ({ engine: "jev", model: "m", step, judgments, asked: 30, total: 30, requests: 1, ms: 200 });
const liveFact: Fact = { id: "l1", at: "16:40", title: "Live fact", text: "Flag service confirms the flag can be turned off.", source: "live" };

describe("facts and state", () => {
  it("keeps scoped timelines for scripted updates", () => {
    const facts = scriptedFacts(s, 2);
    expect(stateForFacts(s, facts, "impact").timeline).toHaveLength(1);
    expect(stateForFacts(s, facts, "speed").timeline).toHaveLength(0);
  });

  it("gives every question the full timeline once a live fact lands", () => {
    const facts = [...scriptedFacts(s, 2), liveFact];
    for (const t of ["impact", "speed", "data_loss"]) expect(stateForFacts(s, facts, t).timeline).toHaveLength(3);
    const qs = buildQuestionsFor(s, facts);
    expect(new Set(qs.map((q) => JSON.stringify(q.state))).size).toBe(1);
  });

  it("re-asks all 30 questions in one request for a live fact", async () => {
    const { adapter, calls } = fakeAdapter((q) => (q.kind === "noul" ? { kind: "noul", p: 0 } : score(1)));
    const cache = new JudgmentCache();
    await runStep(s, 0, adapter, cache);
    const r = await runFacts(s, [liveFact], adapter, cache);
    expect(r.asked).toBe(30);
    expect(r.requests).toBe(1);
    expect(r.step).toBe(1);
    expect(calls).toHaveLength(2);
    // Same facts again: all cached.
    expect((await runFacts(s, [liveFact], adapter, cache)).asked).toBe(0);
  });

  it("matches runStep for scripted-only facts (same cache keys)", async () => {
    const { adapter } = fakeAdapter(() => score(1));
    const cache = new JudgmentCache();
    await runStep(s, 3, adapter, cache);
    expect((await runFacts(s, scriptedFacts(s, 3), adapter, cache)).asked).toBe(0);
  });
});

describe("where we are going", () => {
  it("finds the smallest single change that flips #1 and #2", () => {
    const o = whereWeAreGoing(s, distinct(), settings);
    expect(o.kind).toBe("flip");
    if (o.kind !== "flip") return;
    // Gap 0.133. Raising disable_flag's impact (share 0.4) needs +0.333, from 0.667 to 1.0.
    // Lowering rollback's impact needs the same 0.333; the gate needs 0.45. Tie goes to raising #2.
    expect(o.via).toBe("raise-second");
    expect(o.targetId).toBe("impact");
    expect(o.to).toBeCloseTo(1, 6);
    expect(o.text).toBe(
      'Roll back to v2.30 stays first unless Disable the smart-retries flag\'s "Error reduction" rises above 1.00 (now 0.67 on a 0 to 1 scale, roughly "Would very likely stop the errors").',
    );
  });

  it("uses a constraint gate when that is the smallest change", () => {
    const o = whereWeAreGoing(s, distinct({ [questionKey("rollback", "data_loss")]: { kind: "noul", p: 0.45 } }), settings);
    expect(o.kind).toBe("flip");
    if (o.kind !== "flip") return;
    expect(o.via).toBe("gate");
    expect(o.text).toBe('Roll back to v2.30 stays first unless the chance it breaks "No payment data loss" reaches 0.5 (now 0.45). Then Disable the smart-retries flag takes the lead.');
  });

  it("calls a near tie a human decision", () => {
    const o = whereWeAreGoing(
      s,
      distinct({ [questionKey("rollback", "impact")]: spread(2.97, [0, 0, 0.03, 0.97]), [questionKey("disable_flag", "impact")]: score(3) }),
      settings,
    );
    expect(o.kind).toBe("too-close");
    expect(o.text).toBe("Too close to call: this is a human decision. Roll back to v2.30 and Disable the smart-retries flag are 0.004 apart, inside the 0.02 margin.");
  });

  it("handles one or zero unblocked options", () => {
    const blockAll = (except?: string) =>
      flat(Object.fromEntries(s.options.filter((o) => o.id !== except).map((o) => [questionKey(o.id, "data_loss"), { kind: "noul" as const, p: 0.9 }])));
    expect(whereWeAreGoing(s, blockAll("hotfix"), settings).text).toBe("Ship a forward hotfix is the only option not blocked by a constraint.");
    expect(whereWeAreGoing(s, blockAll(), settings).kind).toBe("all-blocked");
  });
});

describe("compare view and receipt", () => {
  const facts = scriptedFacts(s, 2);
  const j0 = distinct();
  const j1 = distinct({ [questionKey("disable_flag", "impact")]: score(3), [questionKey("disable_flag", "evidence")]: score(3) });
  const j2 = distinct({
    [questionKey("disable_flag", "impact")]: score(3),
    [questionKey("disable_flag", "evidence")]: score(3),
    [questionKey("scale_db", "data_loss")]: { kind: "noul", p: 0.9 },
  });
  const snaps: Snapshot[] = [
    { fact: null, appliedAt: "2026-10-12T16:00:00.000Z", result: result(j0) },
    { fact: facts[0]!, appliedAt: "2026-10-12T16:01:00.000Z", result: result(j1, 1) },
    { fact: facts[1]!, appliedAt: "2026-10-12T16:02:00.000Z", result: result(j2, 2) },
  ];

  it("shows then vs now with the facts that moved each option", () => {
    const rows = compareToBaseline(s, snaps, settings);
    const flag = rows.find((r) => r.optionId === "disable_flag")!;
    expect(flag.rankThen).toBe("2");
    expect(flag.rankNow).toBe("1");
    expect(flag.totalNow).toBeGreaterThan(flag.totalThen);
    expect(flag.drivers[0]!.fact.title).toBe("Deploy diff reviewed");
    expect(flag.drivers[0]!.text).toBe("Error reduction +0.13");
    const db = rows.find((r) => r.optionId === "scale_db")!;
    expect(db.rankNow).toBe("blocked");
    expect(db.drivers[0]!.text).toBe('now blocked by "No payment data loss"');
    expect(db.drivers[0]!.factIndex).toBe(2);
    expect(rows[0]!.optionId).toBe(rank(s, j2, settings)[0]!.optionId);
  });

  it("builds a markdown receipt with timestamps, rankings, moves, near ties and the final call", () => {
    const md = buildReceipt({
      scenario: s,
      settings,
      generatedAt: "2026-10-12T16:03:00.000Z",
      mode: "Live",
      engines: [{ id: "jev", label: "Jev (TypeSafe)", model: "jev-1.13.0", snapshots: snaps }],
    });
    expect(md).toContain("# Decision receipt: Checkout errors after a payments deploy");
    expect(md).toContain("- Engines: Jev (TypeSafe), model jev-1.13.0");
    expect(md).toContain("## Starting point (before any facts)");
    expect(md).toContain("## Fact 1: Deploy diff reviewed");
    expect(md).toContain("- Applied: 2026-10-12T16:01:00.000Z");
    expect(md).toContain("- 1. Disable the smart-retries flag, 0.700");
    expect(md).toContain("Moves:");
    expect(md).toContain("Disable the smart-retries flag moved 2 to 1");
    expect(md).toContain("(blocked: No payment data loss)");
    expect(md).toContain("## Final call");
    expect(md).toContain("- Jev (TypeSafe): **Disable the smart-retries flag** (0.700)");
    expect(md).toContain("Where we are going:");
    expect(md).not.toContain(String.fromCharCode(0x2014));
  });

  it("labels an engine's first snapshot as a first pass even mid-session", () => {
    const md = buildReceipt({
      scenario: s,
      settings,
      generatedAt: "x",
      mode: "Live",
      engines: [
        { id: "jev", label: "Jev", model: "m", snapshots: snaps },
        { id: "local", label: "Clef", model: "c", snapshots: [undefined, undefined, { ...snaps[2]!, result: { ...snaps[2]!.result, engine: "local" } }] },
      ],
    });
    expect(md).toContain("**Clef**: 200 ms, first pass, 30 questions asked");
    expect(md).toContain("**Jev**: 200 ms, 30 of 30 questions re-asked");
  });

  it("flags near ties in the receipt", () => {
    const tie = distinct({ [questionKey("rollback", "impact")]: spread(2.97, [0, 0, 0.03, 0.97]), [questionKey("disable_flag", "impact")]: score(3) });
    const md = buildReceipt({
      scenario: s,
      settings,
      generatedAt: "x",
      mode: "Live",
      engines: [{ id: "jev", label: "Jev", model: "m", snapshots: [{ fact: null, appliedAt: "x", result: result(tie) }] }],
    });
    expect(md).toContain("1=. Roll back to v2.30, 0.596 (too close to call, gap 0.004)");
    expect(md).toContain("Too close to call between Roll back to v2.30 and Disable the smart-retries flag (gap 0.004).");
  });
});
