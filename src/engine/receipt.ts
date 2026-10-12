import { explain } from "./diff";
import type { Snapshot } from "./insight";
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

/** A markdown decision trail for the postmortem. Pure code. */
export function buildReceipt(input: ReceiptInput): string {
  const { scenario, settings } = input;
  const out: string[] = [];
  const base = input.engines.find((e) => e.snapshots[0]);
  const facts = (base?.snapshots ?? []).map((s) => s?.fact ?? null);
  out.push(`# Decision receipt: ${scenario.title}`, "");
  out.push(`- Generated: ${input.generatedAt}`);
  out.push(`- Mode: ${input.mode}`);
  out.push(`- Engines: ${input.engines.map((e) => `${e.label}, model ${e.model}`).join("; ")}`);
  out.push(`- Goal: ${scenario.goal}`);
  out.push(`- Weights: ${scenario.criteria.map((c) => `${c.name} ${(settings.weights[c.id] ?? 0).toFixed(2)}`).join(", ")}`);
  out.push(
    `- Constraints: ${scenario.constraints.map((k) => `${k.name} (block at P(yes) >= ${k.threshold}${settings.constraintsEnabled[k.id] === false ? ", turned off" : ""})`).join(", ") || "none"}`,
  );
  out.push(`- Near-tie margin: ${nearTieMarginOf(scenario)}`);
  if (scenario.incident.summary) out.push("", `> ${scenario.incident.summary}`);

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
    for (const e of input.engines) {
      const snap = e.snapshots[i];
      if (!snap) continue;
      const ranked = rank(scenario, snap.result.judgments, settings);
      const r = snap.result;
      const first = e.snapshots.findIndex(Boolean) === i;
      out.push("", `**${e.label}**: ${r.ms} ms, ${first ? `first pass, ${r.asked} questions asked` : `${r.asked} of ${r.total} questions re-asked`}, ${r.requests} ${r.requests === 1 ? "request" : "requests"}`, "");
      rankingLines(scenario, ranked).forEach((l) => out.push(`- ${l}`));
      const prev = e.snapshots[i - 1];
      if (i > 0 && prev) {
        const moves = explain(
          scenario,
          { judgments: prev.result.judgments, ranked: rank(scenario, prev.result.judgments, settings) },
          { judgments: snap.result.judgments, ranked },
          settings,
        );
        out.push("", "Moves:");
        if (moves.length) moves.forEach((m) => out.push(`- ${m.text}`));
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
    "_Judgments come from the models. The ranking, constraint gates, near ties, and this receipt are plain code. Rankings above use the weights listed at the top._",
    "",
  );
  return out.join("\n");
}
