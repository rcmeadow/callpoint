import type { Judgment, RankedOption, RankSettings, Scenario } from "./types";
import { questionKey } from "./questions";
import { normalize, rankLabel } from "./rank";

export interface MoveReason {
  kind: "criterion" | "constraint";
  targetId: string;
  targetName: string;
  /** Probability before and after. Score: P(top level). Noul: P(yes). */
  before: number;
  after: number;
  /** Score only: expected level before and after, and the top level number. */
  /** Score only, when both judgments are one-hot (e.g. the local engine): the level descriptions. */
  levelBefore?: string;
  levelAfter?: string;
  scoreBefore?: number;
  scoreAfter?: number;
  topLevel?: number;
}

export interface Move {
  optionId: string;
  optionName: string;
  from: number;
  to: number;
  reason: MoveReason | null;
  text: string;
}

function topP(j: Judgment | undefined, levels: number): number {
  if (!j || j.kind !== "score") return 0;
  return j.probabilities[levels - 1] ?? 0;
}

/** The single level of a one-hot score judgment, or null when probability is spread. */
export function oneHotLevel(j: Judgment | undefined): number | null {
  if (!j || j.kind !== "score") return null;
  const hot = j.probabilities.findIndex((p) => p === 1);
  if (hot < 0 || j.probabilities.some((p, i) => i !== hot && p !== 0)) return null;
  return hot;
}

const shortLevel = (s: string) => s.split(";")[0]!.trim();

function noulP(j: Judgment | undefined): number {
  return j && j.kind === "noul" ? j.p : 0;
}

const f2 = (n: number) => n.toFixed(2);
const f1 = (n: number) => n.toFixed(1);

/** The single judgment that best explains why an option's position changed. */
export function reasonFor(
  scenario: Scenario,
  optionId: string,
  prev: Record<string, Judgment>,
  next: Record<string, Judgment>,
  prevRow: RankedOption | undefined,
  nextRow: RankedOption | undefined,
  settings: RankSettings,
): MoveReason | null {
  // A constraint that flipped the gate outranks any weighted change.
  const prevBlocked = new Set(prevRow?.blockedBy ?? []);
  const nextBlocked = new Set(nextRow?.blockedBy ?? []);
  for (const k of scenario.constraints) {
    if (prevBlocked.has(k.id) !== nextBlocked.has(k.id)) {
      const key = questionKey(optionId, k.id);
      return { kind: "constraint", targetId: k.id, targetName: k.name, before: noulP(prev[key]), after: noulP(next[key]) };
    }
  }
  let best: MoveReason | null = null;
  let bestImpact = 0;
  for (const c of scenario.criteria) {
    const key = questionKey(optionId, c.id);
    const n = c.levels.length;
    const impact = Math.abs((settings.weights[c.id] ?? 0) * (normalize(next[key], n) - normalize(prev[key], n)));
    if (impact > bestImpact + 1e-12) {
      bestImpact = impact;
      const pj = prev[key];
      const nj = next[key];
      best = {
        kind: "criterion",
        targetId: c.id,
        targetName: c.name,
        before: topP(pj, n),
        after: topP(nj, n),
        scoreBefore: pj && pj.kind === "score" ? pj.score : 0,
        scoreAfter: nj && nj.kind === "score" ? nj.score : 0,
        topLevel: n - 1,
      };
      const lb = oneHotLevel(pj);
      const la = oneHotLevel(nj);
      if (lb !== null && la !== null) {
        best.levelBefore = shortLevel(c.levels[lb] ?? String(lb));
        best.levelAfter = shortLevel(c.levels[la] ?? String(la));
      }
    }
  }
  return best;
}

export function describe(optionName: string, from: number | string, to: number | string, r: MoveReason | null): string {
  const motion = String(from) === String(to) ? `held at ${to}` : `moved ${from} to ${to}`;
  if (!r) return `${optionName} ${motion}: other options changed around it.`;
  if (r.kind === "constraint") {
    const verb = r.after >= r.before ? "now blocked by" : "no longer blocked by";
    return `${optionName} ${motion}: ${verb} "${r.targetName}", P(yes) ${f2(r.before)} to ${f2(r.after)}.`;
  }
  const dir = (r.scoreAfter ?? 0) >= (r.scoreBefore ?? 0) ? "rose" : "fell";
  if (r.levelBefore !== undefined && r.levelAfter !== undefined) {
    return `${optionName} ${motion}: ${r.targetName} ${dir}, level "${r.levelBefore}" to "${r.levelAfter}" (${f1(r.scoreBefore ?? 0)} to ${f1(r.scoreAfter ?? 0)} of ${r.topLevel}).`;
  }
  return `${optionName} ${motion}: ${r.targetName} ${dir}, P(top level) ${f2(r.before)} to ${f2(r.after)} (score ${f1(r.scoreBefore ?? 0)} to ${f1(r.scoreAfter ?? 0)} of ${r.topLevel}).`;
}

/** "Why it moved": one line per option whose rank or gate status changed. */
export function explain(
  scenario: Scenario,
  prev: { judgments: Record<string, Judgment>; ranked: RankedOption[] },
  next: { judgments: Record<string, Judgment>; ranked: RankedOption[] },
  settings: RankSettings,
): Move[] {
  const prevRows = new Map(prev.ranked.map((r) => [r.optionId, r]));
  const moves: Move[] = [];
  for (const row of next.ranked) {
    const before = prevRows.get(row.optionId);
    // Positions are compared as near-tie groups: a swap inside a "too close to call" group
    // is display order only, not a move.
    const from = before?.groupRank ?? row.groupRank;
    const gateChanged = (before?.blocked ?? false) !== row.blocked;
    if (from === row.groupRank && !gateChanged) continue;
    const option = scenario.options.find((o) => o.id === row.optionId);
    const name = option?.name ?? row.optionId;
    const reason = reasonFor(scenario, row.optionId, prev.judgments, next.judgments, before, row, settings);
    const label = (r: RankedOption) => (r.blocked ? "blocked" : rankLabel(r));
    const fromLabel = label(before ?? row);
    moves.push({ optionId: row.optionId, optionName: name, from, to: row.groupRank, reason, text: describe(name, fromLabel, label(row), reason) });
  }
  moves.sort((a, b) => a.to - b.to);
  return moves;
}
