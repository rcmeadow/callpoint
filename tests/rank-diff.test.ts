import { describe, expect, it } from "vitest";
import { explain } from "../src/engine/diff";
import { questionKey } from "../src/engine/questions";
import { defaultSettings, normalize, order, rank } from "../src/engine/rank";
import type { Judgment } from "../src/engine/types";
import { loadFixture, score } from "./helpers";

const s = loadFixture();

/** All options at level 1 on every criterion, no constraint hits, with overrides. */
function judgments(over: Record<string, Judgment> = {}): Record<string, Judgment> {
  const j: Record<string, Judgment> = {};
  for (const o of s.options) {
    for (const c of s.criteria) j[questionKey(o.id, c.id)] = score(1);
    for (const k of s.constraints) j[questionKey(o.id, k.id)] = { kind: "noul", p: 0.05 };
  }
  return { ...j, ...over };
}

describe("ranker", () => {
  it("normalizes a score to 0..1 by its top level", () => {
    expect(normalize(score(3), 4)).toBe(1);
    expect(normalize({ kind: "score", score: 1.5, probabilities: [0, 0.5, 0.5, 0] }, 4)).toBe(0.5);
    expect(normalize(undefined, 4)).toBe(0);
  });

  it("ranks by weighted sum, ties keep scenario order", () => {
    const r = rank(s, judgments({ [questionKey("hotfix", "impact")]: score(3) }));
    expect(r[0]!.optionId).toBe("hotfix");
    expect(order(r).slice(1)).toEqual(["rollback", "disable_flag", "scale_db", "region_failover"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("gates on constraints before the weighted sum", () => {
    const r = rank(
      s,
      judgments({
        [questionKey("hotfix", "impact")]: score(3),
        [questionKey("hotfix", "ic_forbidden")]: { kind: "noul", p: 0.9 },
      }),
    );
    const last = r[r.length - 1]!;
    expect(last.optionId).toBe("hotfix");
    expect(last.blocked).toBe(true);
    expect(last.blockedBy).toEqual(["ic_forbidden"]);
  });

  it("re-ranks from new weights and constraint toggles with zero model calls", () => {
    const j = judgments({
      [questionKey("rollback", "impact")]: score(3),
      [questionKey("disable_flag", "speed")]: score(3),
      [questionKey("rollback", "data_loss")]: { kind: "noul", p: 0.7 },
    });
    const base = defaultSettings(s);
    // Rollback is blocked by data_loss by default.
    expect(order(rank(s, j, base))[4]).toBe("rollback");
    // Turn the constraint off: rollback wins on impact (weight 0.4 vs speed 0.25).
    const off = { ...base, constraintsEnabled: { ...base.constraintsEnabled, data_loss: false } };
    expect(order(rank(s, j, off))[0]).toBe("rollback");
    // Now weight speed heavily: the flag wins.
    const fast = { ...off, weights: { ...off.weights, speed: 5 } };
    expect(order(rank(s, j, fast))[0]).toBe("disable_flag");
    // The ranker is pure and synchronous: no adapter, no promise, nothing to call.
    expect(rank(s, j, fast)).toEqual(rank(s, j, fast));
  });

  it("gives every option zero when all weights are zero, without NaN", () => {
    const zero = { ...defaultSettings(s), weights: Object.fromEntries(s.criteria.map((c) => [c.id, 0])) };
    expect(rank(s, judgments(), zero).every((r) => r.total === 0)).toBe(true);
  });
});

describe("why it moved", () => {
  it("names the criterion and the before/after probability", () => {
    const settings = defaultSettings(s);
    const prevJ = judgments();
    const nextJ = judgments({
      [questionKey("disable_flag", "evidence")]: { kind: "score", score: 2.9, probabilities: [0, 0, 0.1, 0.9] },
      [questionKey("disable_flag", "impact")]: { kind: "score", score: 2.8, probabilities: [0, 0, 0.2, 0.8] },
    });
    const moves = explain(s, { judgments: prevJ, ranked: rank(s, prevJ) }, { judgments: nextJ, ranked: rank(s, nextJ) }, settings);
    const flag = moves.find((m) => m.optionId === "disable_flag")!;
    expect(flag.from).toBe(2);
    expect(flag.to).toBe(1);
    expect(flag.reason?.targetId).toBe("impact");
    expect(flag.reason?.before).toBe(0);
    expect(flag.reason?.after).toBe(0.8);
    expect(flag.text).toBe(
      "Disable the smart-retries flag moved 2 to 1: Error reduction rose, P(top level) 0.00 to 0.80 (score 1.0 to 2.8 of 3).",
    );
    const rb = moves.find((m) => m.optionId === "rollback")!;
    expect(rb.from).toBe(1);
    expect(rb.to).toBe(2);
    expect(rb.reason).toBeNull();
  });

  it("explains a constraint gate flip with P(yes)", () => {
    const settings = defaultSettings(s);
    const prevJ = judgments();
    const nextJ = judgments({ [questionKey("rollback", "data_loss")]: { kind: "noul", p: 0.82 } });
    const moves = explain(s, { judgments: prevJ, ranked: rank(s, prevJ) }, { judgments: nextJ, ranked: rank(s, nextJ) }, settings);
    const rb = moves.find((m) => m.optionId === "rollback")!;
    expect(rb.to).toBe(5);
    expect(rb.reason?.kind).toBe("constraint");
    expect(rb.text).toBe('Roll back to v2.30 moved 1 to 5: now blocked by "No payment data loss", P(yes) 0.05 to 0.82.');
  });

  it("is empty when nothing moved", () => {
    const j = judgments();
    expect(explain(s, { judgments: j, ranked: rank(s, j) }, { judgments: j, ranked: rank(s, j) }, defaultSettings(s))).toEqual([]);
  });
});
