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
    // Round so float noise below 1e-9 cannot flip an order; ties keep scenario order.
    const d = Math.round((b.total - a.total) * 1e9);
    return d !== 0 ? d : a.index - b.index;
  });
  const tieKey = (r: { blocked: boolean; total: number }) => `${r.blocked}:${Math.round(r.total * 1e9)}`;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(tieKey(r), (counts.get(tieKey(r)) ?? 0) + 1);
  return rows.map(({ index: _index, ...r }, i) => ({ ...r, rank: i + 1, tied: (counts.get(tieKey(r)) ?? 0) > 1 }));
}

export function order(ranked: RankedOption[]): string[] {
  return ranked.map((r) => r.optionId);
}
