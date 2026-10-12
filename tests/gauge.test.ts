import { describe, expect, it } from "vitest";
import { CLOSE, gaugeLayout } from "../src/web/gauge";

describe("gauge label layout", () => {
  it("puts each label under its own mark and keeps far marks on one row (step 0: 0.13 vs 0.50)", () => {
    const g = gaugeLayout(0.13, 0.5);
    expect(g.stacked).toBe(false);
    expect(g.now).toEqual({ left: 13, shift: 13, row: 0 });
    expect(g.at).toEqual({ left: 50, shift: 50, row: 0 });
  });

  it("stacks close marks so the labels cannot overlap (step 2: 0.87 vs 0.80)", () => {
    const g = gaugeLayout(0.87, 0.8);
    expect(g.stacked).toBe(true);
    expect(g.now.row).toBe(0);
    expect(g.at.row).toBe(1);
    expect(g.now.left).toBeCloseTo(87, 6);
    expect(g.at.left).toBeCloseTo(80, 6);
  });

  it("anchors labels at the ends so they stay inside the track", () => {
    // At 0 the label's left edge sits on the mark; at 1 its right edge does (shift 100%).
    const g = gaugeLayout(0, 1);
    expect(g.now).toEqual({ left: 0, shift: 0, row: 0 });
    expect(g.at).toEqual({ left: 100, shift: 100, row: 0 });
    const near = gaugeLayout(0.98, 1);
    expect(near.stacked).toBe(true);
    expect(near.at.shift).toBe(100);
  });

  it("clamps out-of-range and non-finite values", () => {
    const g = gaugeLayout(-0.2, 1.4);
    expect(g.now.left).toBe(0);
    expect(g.at.left).toBe(100);
    expect(gaugeLayout(Number.NaN, 0.5).now.left).toBe(0);
  });

  it("uses an 18% closeness threshold", () => {
    expect(CLOSE).toBe(0.18);
    expect(gaugeLayout(0.5, 0.69).stacked).toBe(false);
    expect(gaugeLayout(0.5, 0.67).stacked).toBe(true);
  });
});
