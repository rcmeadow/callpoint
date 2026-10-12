import { rank } from "./rank";
import type { Judgment, RankedOption, Scenario } from "./types";

export interface CollapsedSwap {
  a: string;
  b: string;
  totals1: [number, number];
  totals2: [number, number];
}

export interface OrderCheck {
  same: boolean;
  /** Pairs whose order by total differed between the runs but sat inside a near tie. */
  collapsed: CollapsedSwap[];
  /** Pairs whose order differed outside any near tie. */
  conflicts: CollapsedSwap[];
}

/**
 * Compare two rankings of the same step. Two options agree when their order by total is the
 * same in both runs. A disagreement is collapsed (excused) when the two options share a
 * near-tie group in either run, or when they are both blocked in both runs.
 */
export function compareRankings(r1: RankedOption[], r2: RankedOption[]): OrderCheck {
  const m1 = new Map(r1.map((r) => [r.optionId, r]));
  const m2 = new Map(r2.map((r) => [r.optionId, r]));
  const ids = r1.map((r) => r.optionId);
  const collapsed: CollapsedSwap[] = [];
  const conflicts: CollapsedSwap[] = [];
  // Position key: blocked options sort after unblocked ones, then by total.
  const ahead = (x: RankedOption, y: RankedOption) =>
    x.blocked !== y.blocked ? !x.blocked : Math.round((x.total - y.total) * 1e9) > 0 ? true : Math.round((x.total - y.total) * 1e9) < 0 ? false : null;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a1 = m1.get(ids[i]!)!, b1 = m1.get(ids[j]!)!;
      const a2 = m2.get(ids[i]!), b2 = m2.get(ids[j]!);
      if (!a2 || !b2) continue;
      const o1 = ahead(a1, b1);
      const o2 = ahead(a2, b2);
      if (o1 === o2) continue;
      const swap: CollapsedSwap = { a: a1.optionId, b: b1.optionId, totals1: [a1.total, b1.total], totals2: [a2.total, b2.total] };
      const sameGroup = (x: RankedOption, y: RankedOption) => x.nearTie && y.nearTie && x.groupRank === y.groupRank;
      const bothBlocked = a1.blocked && b1.blocked && a2.blocked && b2.blocked;
      if (sameGroup(a1, b1) || sameGroup(a2, b2) || bothBlocked) collapsed.push(swap);
      else conflicts.push(swap);
    }
  }
  return { same: conflicts.length === 0, collapsed, conflicts };
}

export function compareSteps(scenario: Scenario, j1: Record<string, Judgment>, j2: Record<string, Judgment>): OrderCheck {
  return compareRankings(rank(scenario, j1), rank(scenario, j2));
}
