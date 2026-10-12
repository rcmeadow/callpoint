import { explain } from "./diff";
import type { Snapshot, TuningEvent } from "./insight";
import { whereWeAreGoing } from "./insight";
import { nearTieMarginOf, rank, rankLabel } from "./rank";
import type { EngineId, RankedOption, RankSettings, Scenario } from "./types";

export interface ReceiptEngine {
  id: EngineId;
  label: string;
  model: string;
  /** Snapshots aligned with the session's facts: index 0 = starting point, i = after fact i. Missing = not run. */
  snapshots: (Snapshot | undefined)[];
}

export interface ReceiptInput {
  scenario: Scenario;
  settings: RankSettings;
  engines: ReceiptEngine[];
  generatedAt: string;
  /** e.g. "Live" or "Replay of a recording made 2026-10-12T16:29:18Z". */
  mode: string;
  /** Weights or constraint changes made during the session, in order. */
  tuning?: TuningEvent[];
}

const f3 = (n: number) => n.toFixed(3);

function rankingLines(scenario: Scenario, ranked: RankedOption[]): string[] {
  const name = (id: string) => scenario.options.find((o) => o.id === id)?.name ?? id;
  const cname = (id: string) => scenario.constraints.find((c) => c.id === id)?.name ?? id;
  return ranked.map((r) => {
    const flag = r.blocked
      ? ` (blocked: ${r.blockedBy.map(cname).join(", ")})`
      : r.nearTie
        ? ` (too close to call, gap ${f3(r.tieSpread)})`
        : "";
    return `${r.blocked ? "X" : rankLabel(r)}. ${name(r.optionId)}, ${f3(r.total)}${flag}`;
  });
}

function call(scenario: Scenario, ranked: RankedOption[]): string {
  const name = (id: string) => scenario.options.find((o) => o.id === id)?.name ?? id;
  const open = ranked.filter((r) => !r.blocked);
  const top = open[0];
  if (!top) return "No call: every option is blocked by a constraint.";
  if (top.nearTie) {
    const group = open.filter((r) => r.nearTie && r.groupRank === top.groupRank).map((r) => name(r.optionId));
    return `Too close to call between ${group.join(" and ")} (gap ${f3(top.tieSpread)}).`;
  }
  return `**${name(top.optionId)}** (${f3(top.total)})`;
}

const weightsLine = (scenario: Scenario, st: RankSettings) => scenario.criteria.map((c) => `${c.name} ${(st.weights[c.id] ?? 0).toFixed(2)}`).join(", ");

/**
 * A markdown decision trail for the postmortem. Pure code. It is a historical record: each
 * section is ranked with the weights and constraints in force when it happened (stored on the
 * snapshot or the tuning event), not with whatever the sliders say now.
 */
export function buildReceipt(input: ReceiptInput): string {
  const { scenario, settings } = input;
  const tuning = input.tuning ?? [];
  const out: string[] = [];
  const base = input.engines.find((e) => e.snapshots[0]);
  const facts = (base?.snapshots ?? []).map((s) => s?.fact ?? null);
  const startSettings = base?.snapshots[0]?.settings ?? settings;
  out.push(`# Decision receipt: ${scenario.title}`, "");
  out.push(`- Generated: ${input.generatedAt}`);
  out.push(`- Mode: ${input.mode}`);
  out.push(`- Engines: ${input.engines.map((e) => `${e.label}, model ${e.model}`).join("; ")}`);
  out.push(`- Goal: ${scenario.goal}`);
  out.push(`- Weights at start: ${weightsLine(scenario, startSettings)}`);
  if (tuning.length) out.push(`- Weights now: ${weightsLine(scenario, settings)} (${tuning.length} ${tuning.length === 1 ? "change" : "changes"}, listed below)`);
  out.push(
    `- Constraints: ${scenario.constraints.map((k) => `${k.name} (block at P(yes) >= ${k.threshold}${startSettings.constraintsEnabled[k.id] === false ? ", off at start" : ""})`).join(", ") || "none"}`,
  );
  out.push(`- Near-tie margin: ${nearTieMarginOf(scenario)}`);
  if (scenario.incident.summary) out.push("", `> ${scenario.incident.summary}`);

  /** Latest snapshot at or before index i, for an engine. */
  const at = (e: ReceiptEngine, i: number): Snapshot | undefined => {
    for (let k = Math.min(i, e.snapshots.length - 1); k >= 0; k--) if (e.snapshots[k]) return e.snapshots[k];
    return undefined;
  };
  let current = startSettings;

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    out.push("");
    if (!fact) out.push("## Starting point (before any facts)");
    else {
      out.push(`## Fact ${i}: ${fact.title}`, "");
      out.push(`- Applied: ${base?.snapshots[i]?.appliedAt ?? "unknown"}`);
      out.push(`- Timeline time: ${fact.at}`);
      out.push(`- Source: ${fact.source === "live" ? "live fact" : "scripted update"}`, "");
      out.push(`> ${fact.text}`);
    }
    const sectionSettings = base?.snapshots[i]?.settings ?? current;
    current = sectionSettings;
    for (const e of input.engines) {
      const snap = e.snapshots[i];
      if (!snap) continue;
      const st = snap.settings ?? sectionSettings;
      const ranked = rank(scenario, snap.result.judgments, st);
      const r = snap.result;
      const first = e.snapshots.findIndex(Boolean) === i;
      out.push("", `**${e.label}**: ${r.ms} ms, ${first ? (r.asked === 0 ? "first pass, cached" : `first pass, ${r.asked} questions asked`) : `${r.asked} of ${r.total} questions re-asked`}, ${r.requests} ${r.requests === 1 ? "request" : "requests"}`, "");
      rankingLines(scenario, ranked).forEach((l) => out.push(`- ${l}`));
      const prev = e.snapshots[i - 1];
      if (i > 0 && prev) {
        // Same weights on both sides, so these moves come from the fact alone.
        const moves = explain(scenario, { judgments: prev.result.judgments, ranked: rank(scenario, prev.result.judgments, st) }, { judgments: snap.result.judgments, ranked }, st);
        out.push("", "Moves:");
        if (moves.length) moves.forEach((m) => out.push(`- ${m.text}`));
        else out.push("- No change in order.");
      }
    }
    for (const t of tuning.filter((x) => x.afterFact === i)) {
      const before = current;
      current = t.settings;
      out.push("", `## Weights changed (${t.at})`, "");
      out.push(`- Applied: ${t.appliedAt}`);
      t.changes.forEach((c) => out.push(`- ${c}`));
      for (const e of input.engines) {
        const snap = at(e, i);
        if (!snap) continue;
        const prevRanked = rank(scenario, snap.result.judgments, before);
        const ranked = rank(scenario, snap.result.judgments, t.settings);
        out.push("", `**${e.label}**: re-ranked the same judgments, 0 model calls`, "");
        rankingLines(scenario, ranked).forEach((l) => out.push(`- ${l}`));
        const moves = explain(scenario, { judgments: snap.result.judgments, ranked: prevRanked }, { judgments: snap.result.judgments, ranked }, t.settings);
        out.push("", "Moves:");
        if (moves.length) moves.forEach((m) => out.push(`- ${m.optionName} moved ${m.from} to ${m.to}: the code re-weighted the same judgments.`));
        else out.push("- No change in order.");
      }
    }
  }

  out.push("", "## Final call", "");
  for (const e of input.engines) {
    const last = [...e.snapshots].reverse().find(Boolean);
    if (!last) continue;
    const ranked = rank(scenario, last.result.judgments, settings);
    out.push(`- ${e.label}: ${call(scenario, ranked)}`);
    out.push(`  - Where we are going: ${whereWeAreGoing(scenario, last.result.judgments, settings).text}`);
  }
  out.push(
    "",
    "_Judgments come from the models. The ranking, constraint gates, near ties, and this receipt are plain code. Each section is ranked with the weights in force at that time; the final call uses the current weights._",
    "",
  );
  return out.join("\n");
}
