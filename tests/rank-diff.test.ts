import { describe, expect, it } from "vitest";
import { explain } from "../src/engine/diff";
import { compareRankings } from "../src/engine/ordercheck";
import { questionKey } from "../src/engine/questions";
import { defaultSettings, normalize, order, rank, rankLabel } from "../src/engine/rank";
import { validateScenario } from "../src/engine/validate";
import type { Judgment } from "../src/engine/types";
import { loadFixture, score } from "./helpers";

const s = loadFixture();

/** All options at level 1 on every criterion, no constraint hits, with overrides. */
function flat(over: Record<string, Judgment> = {}): Record<string, Judgment> {
  const j: Record<string, Judgment> = {};
  for (const o of s.options) {
    for (const c of s.criteria) j[questionKey(o.id, c.id)] = score(1);
    for (const k of s.constraints) j[questionKey(o.id, k.id)] = { kind: "noul", p: 0.05 };
  }
  return { ...j, ...over };
}

/**
 * Distinct totals: rollback 0.600, disable_flag 0.467, scale_db 0.333, region_failover 0.200,
 * hotfix 0.150. Every gap is wider than the 0.02 near-tie margin.
 */
function distinct(over: Record<string, Judgment> = {}): Record<string, Judgment> {
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

const spread = (sc: number, probabilities: number[]): Judgment => ({ kind: "score", score: sc, probabilities });

describe("ranker", () => {
  it("normalizes a score to 0..1 by its top level", () => {
    expect(normalize(score(3), 4)).toBe(1);
    expect(normalize(spread(1.5, [0, 0.5, 0.5, 0]), 4)).toBe(0.5);
    expect(normalize(undefined, 4)).toBe(0);
  });

  it("ranks by weighted sum", () => {
    const r = rank(s, distinct());
    expect(order(r)).toEqual(["rollback", "disable_flag", "scale_db", "region_failover", "hotfix"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.every((x) => !x.nearTie && x.groupRank === x.rank)).toBe(true);
    expect(r[0]!.total).toBeCloseTo(0.6, 6);
  });

  it("gates on constraints before the weighted sum", () => {
    const r = rank(s, distinct({ [questionKey("rollback", "ic_forbidden")]: { kind: "noul", p: 0.9 } }));
    const last = r[r.length - 1]!;
    expect(last.optionId).toBe("rollback");
    expect(last.blocked).toBe(true);
    expect(last.blockedBy).toEqual(["ic_forbidden"]);
  });

  it("re-ranks from new weights and constraint toggles with zero model calls", () => {
    const j = flat({
      [questionKey("rollback", "impact")]: score(3),
      [questionKey("disable_flag", "speed")]: score(3),
      [questionKey("rollback", "data_loss")]: { kind: "noul", p: 0.7 },
    });
    const base = defaultSettings(s);
    expect(order(rank(s, j, base))[4]).toBe("rollback");
    const off = { ...base, constraintsEnabled: { ...base.constraintsEnabled, data_loss: false } };
    expect(order(rank(s, j, off))[0]).toBe("rollback");
    const fast = { ...off, weights: { ...off.weights, speed: 5 } };
    expect(order(rank(s, j, fast))[0]).toBe("disable_flag");
    expect(rank(s, j, fast)).toEqual(rank(s, j, fast));
  });

  it("gives every option zero when all weights are zero, without NaN", () => {
    const zero = { ...defaultSettings(s), weights: Object.fromEntries(s.criteria.map((c) => [c.id, 0])) };
    expect(rank(s, flat(), zero).every((r) => r.total === 0)).toBe(true);
  });
});

describe("near ties", () => {
  // rollback 0.596 vs disable_flag 0.600: a 0.004 gap, like the real 0.883 vs 0.879 case.
  const close = distinct({
    [questionKey("rollback", "impact")]: spread(2.97, [0, 0, 0.03, 0.97]),
    [questionKey("disable_flag", "impact")]: score(3),
  });

  it("groups totals within nearTieMargin, shows them in file order, and labels the group", () => {
    const r = rank(s, close);
    expect(order(r).slice(0, 2)).toEqual(["rollback", "disable_flag"]);
    expect(r[0]!.nearTie && r[1]!.nearTie).toBe(true);
    expect(r[0]!.groupRank).toBe(1);
    expect(r[1]!.groupRank).toBe(1);
    expect(r[0]!.tieSpread).toBeCloseTo(0.004, 6);
    expect(rankLabel(r[1]!)).toBe("1=");
    expect(r[2]!.nearTie).toBe(false);
    expect(rankLabel(r[2]!)).toBe("3");
  });

  it("uses the scenario's margin (0 turns grouping off for non-equal totals)", () => {
    const r = rank({ ...s, nearTieMargin: 0 }, close);
    expect(order(r).slice(0, 2)).toEqual(["disable_flag", "rollback"]);
    expect(r.some((x) => x.nearTie)).toBe(false);
  });

  it("chains neighbours: a-b and b-c within the margin make one group even when a-c is not", () => {
    // disable_flag 0.467, scale_db 0.400, region_failover 0.333: gaps 0.067, end to end 0.133.
    const r = rank(
      { ...s, nearTieMargin: 0.07 },
      distinct({
        [questionKey("scale_db", "impact")]: spread(1.5, [0, 0.5, 0.5, 0]),
        [questionKey("region_failover", "impact")]: score(1),
      }),
    );
    expect(r.filter((x) => x.nearTie).map((x) => x.optionId)).toEqual(["disable_flag", "scale_db", "region_failover"]);
    expect(new Set(r.filter((x) => x.nearTie).map((x) => x.groupRank))).toEqual(new Set([2]));
    expect(r.find((x) => x.optionId === "disable_flag")!.tieSpread).toBeCloseTo(0.1333, 3);
  });

  it("does not report a swap inside the margin as a move", () => {
    const flipped = distinct({
      [questionKey("rollback", "impact")]: score(3),
      [questionKey("disable_flag", "impact")]: spread(2.97, [0, 0, 0.03, 0.97]),
    });
    const settings = defaultSettings(s);
    const moves = explain(s, { judgments: close, ranked: rank(s, close) }, { judgments: flipped, ranked: rank(s, flipped) }, settings);
    expect(moves).toEqual([]);
  });

  it("reports joining a near-tie group with the shared label", () => {
    const settings = defaultSettings(s);
    const prev = distinct();
    const next = distinct({ [questionKey("scale_db", "impact")]: spread(2.0, [0, 0, 1, 0]) });
    const moves = explain(s, { judgments: prev, ranked: rank(s, prev) }, { judgments: next, ranked: rank(s, next) }, settings);
    const m = moves.find((x) => x.optionId === "scale_db")!;
    expect(m.text.startsWith("Fail over to a larger database moved 3 to 2=")).toBe(true);
  });

  it("order check collapses swaps inside a near tie and still catches real flips", () => {
    const flipped = distinct({
      [questionKey("rollback", "impact")]: score(3),
      [questionKey("disable_flag", "impact")]: spread(2.97, [0, 0, 0.03, 0.97]),
    });
    const ok = compareRankings(rank(s, close), rank(s, flipped));
    expect(ok.same).toBe(true);
    expect(ok.collapsed).toHaveLength(1);
    expect([ok.collapsed[0]!.a, ok.collapsed[0]!.b].sort()).toEqual(["disable_flag", "rollback"]);
    expect(ok.collapsed[0]!.totals1[0]).toBeCloseTo(0.596, 6);

    const far = distinct({ [questionKey("rollback", "impact")]: score(0) });
    const bad = compareRankings(rank(s, distinct()), rank(s, far));
    expect(bad.same).toBe(false);
    expect(bad.conflicts.length).toBeGreaterThan(0);
  });

  it("validates nearTieMargin", () => {
    expect(() => validateScenario({ ...s, nearTieMargin: -1 })).toThrow(/nearTieMargin/);
    expect(validateScenario({ ...s, nearTieMargin: 0.05 }).nearTieMargin).toBe(0.05);
  });
});

describe("why it moved", () => {
  it("names the criterion and the before/after probability", () => {
    const settings = defaultSettings(s);
    const prevJ = distinct();
    const nextJ = distinct({
      [questionKey("disable_flag", "evidence")]: spread(2.9, [0, 0, 0.1, 0.9]),
      [questionKey("disable_flag", "impact")]: spread(2.8, [0, 0, 0.2, 0.8]),
    });
    const moves = explain(s, { judgments: prevJ, ranked: rank(s, prevJ) }, { judgments: nextJ, ranked: rank(s, nextJ) }, settings);
    const flag = moves.find((m) => m.optionId === "disable_flag")!;
    expect(flag.from).toBe(2);
    expect(flag.to).toBe(1);
    expect(flag.reason?.targetId).toBe("impact");
    expect(flag.text).toBe(
      "Disable the smart-retries flag moved 2 to 1: Error reduction rose, P(top level) 0.00 to 0.80 (score 2.0 to 2.8 of 3).",
    );
    const rb = moves.find((m) => m.optionId === "rollback")!;
    expect(rb.from).toBe(1);
    expect(rb.to).toBe(2);
    expect(rb.reason).toBeNull();
  });

  it("explains a constraint gate flip with P(yes)", () => {
    const settings = defaultSettings(s);
    const prevJ = distinct();
    const nextJ = distinct({ [questionKey("rollback", "data_loss")]: { kind: "noul", p: 0.82 } });
    const moves = explain(s, { judgments: prevJ, ranked: rank(s, prevJ) }, { judgments: nextJ, ranked: rank(s, nextJ) }, settings);
    const rb = moves.find((m) => m.optionId === "rollback")!;
    expect(rb.to).toBe(5);
    expect(rb.text).toBe('Roll back to v2.30 moved 1 to blocked: now blocked by "No payment data loss", P(yes) 0.05 to 0.82.');
  });

  it("shows the level change, not P(top level), when both judgments are one-hot", () => {
    const settings = defaultSettings(s);
    const prevJ = distinct();
    const nextJ = distinct({ [questionKey("hotfix", "impact")]: score(2) });
    const moves = explain(s, { judgments: prevJ, ranked: rank(s, prevJ) }, { judgments: nextJ, ranked: rank(s, nextJ) }, settings);
    const m = moves.find((x) => x.optionId === "hotfix")!;
    expect(m.text).toBe(
      'Ship a forward hotfix moved 5 to 3: Error reduction rose, level "Would not reduce the errors, or would make them worse" to "Large reduction" (0.0 to 2.0 of 3).',
    );
  });

  it("is empty when nothing moved", () => {
    const j = distinct();
    expect(explain(s, { judgments: j, ranked: rank(s, j) }, { judgments: j, ranked: rank(s, j) }, defaultSettings(s))).toEqual([]);
  });
});
