// Prints "where we are going" and a receipt from the real recording. No model calls.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareToBaseline, whereWeAreGoing, type Snapshot } from "../src/engine/insight";
import { scriptedFacts } from "../src/engine/questions";
import { defaultSettings } from "../src/engine/rank";
import { buildReceipt } from "../src/engine/receipt";
import type { Recording } from "../src/engine/types";
import { getScenario, SCENARIO_DIR } from "../src/server/scenarios";

const s = getScenario("incident-triage")!;
const rec = JSON.parse(readFileSync(join(SCENARIO_DIR, "incident-triage.recording.json"), "utf8")) as Recording;
const settings = defaultSettings(s);
const facts = scriptedFacts(s, s.updates.length);
const snaps = (e: "jev" | "local"): Snapshot[] =>
  (rec.engines[e]?.steps ?? []).map((r, i) => ({ fact: i === 0 ? null : facts[i - 1]!, appliedAt: rec.recordedAt, result: r }));
for (const e of ["jev", "local"] as const) {
  const sn = snaps(e);
  sn.forEach((x, i) => console.log(`${e} step ${i}: ${whereWeAreGoing(s, x.result.judgments, settings).text}`));
  console.log(JSON.stringify(compareToBaseline(s, sn, settings).map((r) => [r.name, r.rankThen, r.rankNow, r.totalThen.toFixed(3), r.totalNow.toFixed(3), r.drivers.map((d) => `${d.fact.title}: ${d.text}`)])));
}
if (process.argv.includes("--receipt"))
  console.log(
    buildReceipt({
      scenario: s,
      settings,
      generatedAt: new Date().toISOString(),
      mode: `Replay of a recording made ${rec.recordedAt}`,
      engines: [
        { id: "jev", label: "Jev (TypeSafe)", model: rec.engines.jev!.model, snapshots: snaps("jev") },
        { id: "local", label: "Clef (Cloudflare, local via Ollama)", model: rec.engines.local!.model, snapshots: snaps("local") },
      ],
    }),
  );
