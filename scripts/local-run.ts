// Live run of a scenario through the local engine (LOCAL_ENGINE=clef or llm), twice with the cache cleared,
// to measure latency and check that the ranking order is the same at every step.
import "dotenv/config";
import { createLocalEngine, localConfigFromEnv, localEngineStatus } from "../src/server/local-engine";
import { getScenario } from "../src/server/scenarios";
import { arg, compareOrders, flag, runAndPrint, summarize } from "./common";

const id = arg("scenario") ?? "incident-triage";
const scenario = getScenario(id);
if (!scenario) throw new Error(`No scenario ${id}`);
const cfg = localConfigFromEnv();
const st = await localEngineStatus(cfg);
if (!st.ready) {
  console.error(`Local engine ${cfg.kind} (${cfg.model}) not ready (running=${st.running}, pulled=${st.modelPulled}, ollama=${st.version ?? "?"}, versionOk=${st.versionOk}).`);
  process.exit(1);
}
const adapter = createLocalEngine(cfg);
const run1 = await runAndPrint(scenario, adapter, "run 1");
console.log(`run 1: ${summarize(run1)}`);
if (!flag("once")) {
  const run2 = await runAndPrint(scenario, adapter, "run 2");
  console.log(`run 2: ${summarize(run2)}`);
  const cmp = compareOrders(scenario, run1, run2);
  console.log(`\nDeterminism check (ranking order, cache cleared between runs): ${cmp.same ? "PASS" : "FAIL"}`);
  cmp.lines.forEach((l) => console.log(l));
}
