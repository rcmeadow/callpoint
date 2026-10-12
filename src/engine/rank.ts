import type { Judgment, RankedOption, RankSettings, Scenario } from "./types";
import { questionKey } from "./questions";

/** Score judgment to 0..1 (levels run worst to best). */
export function normalize(j: Judgment | undefined, levels: number): number {
  if (!j || j.kind !== "score" || levels < 2) return 0;
  return Math.min(1, Math.max(0, j.score / (levels - 1)));
}

export function defaultSettings(scenario: Scenario): RankSettings {
  return {
    weights: Object.fromEntries(scenario.criteria.map((c) => [c.id, c.weight])),
    constraintsEnabled: Object.fromEntries(scenario.constraints.map((c) => [c.id, true])),
  };
}

/**
 * The code decides: a constraint gate, then a weighted sum. Pure and synchronous,
 * so changing weights or constraints never calls a model.
 */
export function rank(
  scenario: Scenario,
  judgments: Record<string, Judgment>,
  settings: RankSettings = defaultSettings(scenario),
): RankedOption[] {
  const weightSum = scenario.criteria.reduce((s, c) => s + Math.max(0, settings.weights[c.id] ?? 0), 0);
  const rows = scenario.options.map((option, index) => {
    const parts: Record<string, number> = {};
    let weighted = 0;
    for (const c of scenario.criteria) {
      const v = normalize(judgments[questionKey(option.id, c.id)], c.levels.length);
      parts[c.id] = v;
      weighted += Math.max(0, settings.weights[c.id] ?? 0) * v;
    }
    const blockedBy: string[] = [];
    for (const k of scenario.constraints) {
      if (settings.constraintsEnabled[k.id] === false) continue;
      const j = judgments[questionKey(option.id, k.id)];
      if (j && j.kind === "noul" && j.p >= k.threshold) blockedBy.push(k.id);
    }
    return {
      optionId: option.id,
      rank: 0,
      total: weightSum > 0 ? weighted / weightSum : 0,
      blocked: blockedBy.length > 0,
      blockedBy,
      parts,
      index,
    };
  });
  rows.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    // Round so float noise below 1e-9 cannot flip an order; exact ties keep scenario order.
    const d = Math.round((b.total - a.total) * 1e9);
    return d !== 0 ? d : a.index - b.index;
  });
  const margin = nearTieMarginOf(scenario);
  // Chain unblocked neighbours whose totals are within the margin into near-tie groups.
  const groups: (typeof rows)[] = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && !r.blocked && !prev.blocked && prev.total - r.total <= margin + 1e-9) g.push(r);
    else groups.push([r]);
  }
  const out: RankedOption[] = [];
  for (const g of groups) {
    const groupRank = out.length + 1;
    const nearTie = g.length > 1;
    const spread = nearTie ? Math.max(...g.map((x) => x.total)) - Math.min(...g.map((x) => x.total)) : 0;
    // Inside a near tie the code makes no call, so show the group in scenario file order.
    const shown = nearTie ? [...g].sort((x, y) => x.index - y.index) : g;
    for (const { index: _index, ...r } of shown) {
      out.push({ ...r, rank: out.length + 1, groupRank, nearTie, tieSpread: spread });
    }
  }
  return out;
}

export const DEFAULT_NEAR_TIE_MARGIN = 0.02;

export function nearTieMarginOf(scenario: Scenario): number {
  const m = scenario.nearTieMargin;
  return typeof m === "number" && m >= 0 ? m : DEFAULT_NEAR_TIE_MARGIN;
}

/** Display rank label: "2" or "2=" for a near-tie group. */
export function rankLabel(r: Pick<RankedOption, "groupRank" | "nearTie">): string {
  return `${r.groupRank}${r.nearTie ? "=" : ""}`;
}

export function order(ranked: RankedOption[]): string[] {
  return ranked.map((r) => r.optionId);
}
