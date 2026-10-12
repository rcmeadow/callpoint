// Live run of a scenario through the local Ollama engine, twice with the cache cleared,
// to measure latency and check that the ranking order is the same at every step.
import "dotenv/config";
import { createLocalAdapter, DEFAULT_LOCAL_MODEL, localStatus } from "../src/server/local";
import { getScenario } from "../src/server/scenarios";
import { arg, compareOrders, flag, runAndPrint, summarize } from "./common";

const id = arg("scenario") ?? "incident-triage";
const scenario = getScenario(id);
if (!scenario) throw new Error(`No scenario ${id}`);
const url = process.env.OLLAMA_URL?.trim() || "http://localhost:11434";
const model = process.env.LOCAL_MODEL?.trim() || DEFAULT_LOCAL_MODEL;
const st = await localStatus(url, model);
if (!st.running || !st.modelPulled) {
  console.error(`Local model not ready (running=${st.running}, pulled=${st.modelPulled}).`);
  process.exit(1);
}
const adapter = createLocalAdapter({ url, model, concurrency: Number(process.env.LOCAL_CONCURRENCY ?? 4) });
const run1 = await runAndPrint(scenario, adapter, "run 1");
console.log(`run 1: ${summarize(run1)}`);
if (!flag("once")) {
  const run2 = await runAndPrint(scenario, adapter, "run 2");
  console.log(`run 2: ${summarize(run2)}`);
  const cmp = compareOrders(scenario, run1, run2);
  console.log(`\nDeterminism check (ranking order, cache cleared between runs): ${cmp.same ? "PASS" : "FAIL"}`);
  cmp.lines.forEach((l) => console.log(l));
}
