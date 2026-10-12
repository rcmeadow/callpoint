// Live run that writes scenarios/<id>.recording.json for Replay mode.
// Usage: npm run record [-- --scenario incident-triage] [-- --once] [-- --no-local]
// Jev always runs (needs TYPESAFE_API_KEY in .env or the Keychain item TYPESAFE_API_KEY).
// The local engine is included when Ollama is up. Without --once, Jev runs a second time
// with the cache cleared and the script checks the ranking order matches at every step.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Recording } from "../src/engine/types";
import { createJevAdapter, DEFAULT_JEV_MODEL } from "../src/server/jev";
import { keychainError, loadKey } from "../src/server/key";
import { createLocalEngine, localConfigFromEnv, localEngineStatus } from "../src/server/local-engine";
import { getScenario, SCENARIO_DIR } from "../src/server/scenarios";
import { arg, compareOrders, flag, runAndPrint, summarize } from "./common";

const id = arg("scenario") ?? "incident-triage";
const scenario = getScenario(id);
if (!scenario) throw new Error(`No scenario ${id}`);

const { key, source } = loadKey();
if (!key) {
  console.error("No TypeSafe key found. Set TYPESAFE_API_KEY in .env or add a Keychain item named TYPESAFE_API_KEY.");
  if (keychainError) console.error(`Keychain lookup failed: ${keychainError}`);
  process.exit(1);
}
console.log(`TypeSafe key loaded from ${source}.`);
const jevModel = process.env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
const jev = createJevAdapter({ apiKey: key, model: jevModel });

const recording: Recording = {
  scenarioId: scenario.id,
  synthetic: false,
  note: `Live run on ${process.platform}/${process.arch}, Node ${process.version}. Latency is wall clock from this one machine.`,
  recordedAt: new Date().toISOString(),
  engines: {},
};

const jevRun1 = await runAndPrint(scenario, jev, "Jev run 1");
console.log(`Jev run 1: ${summarize(jevRun1)}`);
recording.engines.jev = { model: jevModel, steps: jevRun1 };

if (!flag("no-local")) {
  const cfg = localConfigFromEnv();
  const st = await localEngineStatus(cfg);
  if (st.ready) {
    const local = createLocalEngine(cfg);
    const localRun = await runAndPrint(scenario, local, `Local run (${cfg.kind})`);
    console.log(`Local run: ${summarize(localRun)}`);
    recording.engines.local = { model: cfg.model, steps: localRun };
  } else {
    console.log(`Local engine ${cfg.kind} (${cfg.model}) not ready (running=${st.running}, pulled=${st.modelPulled}, ollama=${st.version ?? "?"}, versionOk=${st.versionOk}); recording Jev only.`);
  }
}

const out = join(SCENARIO_DIR, `${scenario.id}.recording.json`);
writeFileSync(out, JSON.stringify(recording, null, 2) + "\n");
console.log(`\nWrote ${out}`);

if (!flag("once")) {
  const jevRun2 = await runAndPrint(scenario, jev, "Jev run 2");
  console.log(`Jev run 2: ${summarize(jevRun2)}`);
  const cmp = compareOrders(scenario, jevRun1, jevRun2);
  console.log(`\nDeterminism check (Jev ranking order, cache cleared between runs): ${cmp.same ? "PASS" : "FAIL"}`);
  cmp.lines.forEach((l) => console.log(l));
}
