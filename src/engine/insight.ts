import { questionKey } from "./questions";
import { nearTieMarginOf, normalize, rank, rankLabel } from "./rank";
import type { Fact, Judgment, RankedOption, RankSettings, Scenario, StepResult } from "./types";

/** One point in a session for one engine: the fact that produced it (null = starting point). */
export interface Snapshot {
  fact: Fact | null;
  /** ISO time the fact was applied. */
  appliedAt: string;
  result: StepResult;
}

export interface Driver {
  /** 1-based index of the fact in the session. */
  factIndex: number;
  fact: Fact;
  kind: "criterion" | "constraint";
  targetName: string;
  /** Signed change to the option's total (criterion), or +1 / -1 for a gate change (constraint). */
  delta: number;
  text: string;
}

export interface CompareRow {
  optionId: string;
  name: string;
  rankThen: string;
  rankNow: string;
  totalThen: number;
  totalNow: number;
  blockedThen: boolean;
  blockedNow: boolean;
  drivers: Driver[];
}

const f2 = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

function weightShare(scenario: Scenario, settings: RankSettings): Map<string, number> {
  const W = scenario.criteria.reduce((s, c) => s + Math.max(0, settings.weights[c.id] ?? 0), 0);
  return new Map(scenario.criteria.map((c) => [c.id, W > 0 ? Math.max(0, settings.weights[c.id] ?? 0) / W : 0]));
}

function rowLabel(r: RankedOption): string {
  return r.blocked ? "blocked" : rankLabel(r);
}

/**
 * Where we were vs where we are: the starting ranking next to the current one, with the facts
 * that moved each option most (largest changes to its total, attributed to the fact that
 * caused them). Pure code, no model calls.
 */
export function compareToBaseline(scenario: Scenario, snapshots: Snapshot[], settings: RankSettings, maxDrivers = 2): CompareRow[] {
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  if (!first || !last) return [];
  const then = new Map(rank(scenario, first.result.judgments, settings).map((r) => [r.optionId, r]));
  const nowRanked = rank(scenario, last.result.judgments, settings);
  const share = weightShare(scenario, settings);
  const rankedAt = snapshots.map((s) => new Map(rank(scenario, s.result.judgments, settings).map((r) => [r.optionId, r])));
  return nowRanked.map((now) => {
    const option = scenario.options.find((o) => o.id === now.optionId)!;
    const drivers: Driver[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const fact = snapshots[i]!.fact;
      if (!fact) continue;
      const prevJ = snapshots[i - 1]!.result.judgments;
      const nextJ = snapshots[i]!.result.judgments;
      for (const c of scenario.criteria) {
        const key = questionKey(now.optionId, c.id);
        const d = (share.get(c.id) ?? 0) * (normalize(nextJ[key], c.levels.length) - normalize(prevJ[key], c.levels.length));
        if (Math.abs(d) >= 0.005) drivers.push({ factIndex: i, fact, kind: "criterion", targetName: c.name, delta: d, text: `${c.name} ${signed(d)}` });
      }
      const before = rankedAt[i - 1]!.get(now.optionId)!;
      const after = rankedAt[i]!.get(now.optionId)!;
      for (const k of scenario.constraints) {
        const was = before.blockedBy.includes(k.id);
        const is = after.blockedBy.includes(k.id);
        if (was !== is) drivers.push({ factIndex: i, fact, kind: "constraint", targetName: k.name, delta: is ? -1 : 1, text: is ? `now blocked by "${k.name}"` : `no longer blocked by "${k.name}"` });
      }
    }
    drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.factIndex - b.factIndex);
    const t = then.get(now.optionId)!;
    return {
      optionId: now.optionId,
      name: option.name,
      rankThen: rowLabel(t),
      rankNow: rowLabel(now),
      totalThen: t.total,
      totalNow: now.total,
      blockedThen: t.blocked,
      blockedNow: now.blocked,
      drivers: drivers.slice(0, maxDrivers),
    };
  });
}

/**
 * What would change the call. `text` is the one-line sentence (banner, receipt); the other
 * fields are the same facts in structured form, so a UI can draw them without parsing text.
 */
export type Outlook =
  | {
      kind: "flip";
      text: string;
      via: "raise-second" | "lower-first" | "gate";
      /** The option whose judgment would have to change. */
      optionId: string;
      /** Current #1 and #2 (unblocked). */
      leaderId: string;
      challengerId: string;
      /** Criterion or constraint id and display name. */
      targetId: string;
      targetName: string;
      /** Current value and flip point on the 0 to 1 scale (gate: P(yes) and the threshold). */
      from: number;
      to: number;
      change: number;
    }
  | { kind: "too-close"; text: string; optionIds: string[]; totals: number[]; gap: number; margin: number }
  | { kind: "only-one"; text: string; leaderId: string; challengerId?: string }
  | { kind: "all-blocked"; text: string };

function levelHint(levels: string[], v: number): string {
  const i = Math.round(Math.min(1, Math.max(0, v)) * (levels.length - 1));
  return (levels[i] ?? "").split(";")[0]!.trim();
}

/**
 * Where we are going: what single judgment change would flip #1 and #2. Considers raising
 * one of #2's criteria, lowering one of #1's, or #1 crossing a constraint gate, and picks the
 * smallest change (on the 0 to 1 scale). Near ties are left to people. Pure code, no model calls.
 */
export function whereWeAreGoing(scenario: Scenario, judgments: Record<string, Judgment>, settings: RankSettings): Outlook {
  const ranked = rank(scenario, judgments, settings);
  const open = ranked.filter((r) => !r.blocked);
  const name = (id: string) => scenario.options.find((o) => o.id === id)?.name ?? id;
  if (open.length === 0) return { kind: "all-blocked", text: "Every option is blocked by a constraint. This is a human decision." };
  const a = open[0]!;
  if (open.length === 1) return { kind: "only-one", leaderId: a.optionId, text: `${name(a.optionId)} is the only option not blocked by a constraint.` };
  const b = open[1]!;
  const margin = nearTieMarginOf(scenario);
  if (a.nearTie && b.nearTie && a.groupRank === b.groupRank) {
    const group = open.filter((r) => r.nearTie && r.groupRank === a.groupRank);
    const names = group.map((r) => name(r.optionId));
    const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return {
      kind: "too-close",
      optionIds: group.map((r) => r.optionId),
      totals: group.map((r) => r.total),
      gap: a.tieSpread,
      margin,
      text: `Too close to call: this is a human decision. ${list} are ${a.tieSpread.toFixed(3)} apart, inside the ${margin} margin.`,
    };
  }
  const gap = a.total - b.total;
  const share = weightShare(scenario, settings);
  type Cand = Extract<Outlook, { kind: "flip" }>;
  const cands: Cand[] = [];
  for (const c of scenario.criteria) {
    const sh = share.get(c.id) ?? 0;
    if (sh <= 0) continue;
    const d = gap / sh;
    const bv = b.parts[c.id] ?? 0;
    if (bv + d <= 1 + 1e-9) {
      const to = Math.min(1, bv + d);
      cands.push({
        kind: "flip", via: "raise-second", optionId: b.optionId, leaderId: a.optionId, challengerId: b.optionId, targetId: c.id, targetName: c.name, from: bv, to, change: d,
        text: `${name(a.optionId)} stays first unless ${name(b.optionId)}'s "${c.name}" rises above ${f2(to)} (now ${f2(bv)} on a 0 to 1 scale, roughly "${levelHint(c.levels, to)}").`,
      });
    }
    const av = a.parts[c.id] ?? 0;
    if (av - d >= -1e-9) {
      const to = Math.max(0, av - d);
      cands.push({
        kind: "flip", via: "lower-first", optionId: a.optionId, leaderId: a.optionId, challengerId: b.optionId, targetId: c.id, targetName: c.name, from: av, to, change: d,
        text: `${name(a.optionId)} stays first unless its "${c.name}" falls below ${f2(to)} (now ${f2(av)} on a 0 to 1 scale, roughly "${levelHint(c.levels, to)}").`,
      });
    }
  }
  for (const k of scenario.constraints) {
    if (settings.constraintsEnabled[k.id] === false) continue;
    const j = judgments[questionKey(a.optionId, k.id)];
    const p = j && j.kind === "noul" ? j.p : 0;
    if (p >= k.threshold) continue;
    cands.push({
      kind: "flip", via: "gate", optionId: a.optionId, leaderId: a.optionId, challengerId: b.optionId, targetId: k.id, targetName: k.name, from: p, to: k.threshold, change: k.threshold - p,
      text: `${name(a.optionId)} stays first unless the chance it breaks "${k.name}" reaches ${k.threshold} (now ${f2(p)}). Then ${name(b.optionId)} takes the lead.`,
    });
  }
  const order = { "raise-second": 0, "lower-first": 1, gate: 2 } as const;
  cands.sort((x, y) => x.change - y.change || order[x.via] - order[y.via]);
  const best = cands[0];
  if (!best) return { kind: "only-one", leaderId: a.optionId, challengerId: b.optionId, text:`${name(a.optionId)} leads, and no single judgment change would put ${name(b.optionId)} on top.` };
  return best;
}
