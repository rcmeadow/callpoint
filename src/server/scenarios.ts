import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScenario } from "../engine/validate";
import type { Scenario } from "../engine/types";

export const SCENARIO_DIR = fileURLToPath(new URL("../../scenarios/", import.meta.url));

export const isRecordingFile = (f: string) => /\.recording(\.[A-Za-z0-9_-]+)?\.json$/.test(f);

/** Every scenarios/*.json that is not a recording. Read fresh on each call so new files show up. */
export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !isRecordingFile(f))
    .sort()
    .map((f) => validateScenario(JSON.parse(readFileSync(join(dir, f), "utf8")), f));
}

export function getScenario(id: string, dir = SCENARIO_DIR): Scenario | undefined {
  return loadScenarios(dir).find((s) => s.id === id);
}
