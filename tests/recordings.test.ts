import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Recording } from "../src/engine/types";

const dir = fileURLToPath(new URL("../scenarios/", import.meta.url));
const real = readdirSync(dir)
  .filter((f) => /\.recording\.json$/.test(f))
  .map((f) => ({ f, rec: JSON.parse(readFileSync(dir + f, "utf8")) as Recording }))
  .filter((x) => !x.rec.synthetic);

describe("real recordings", () => {
  it("exist for both starter scenarios", () => {
    expect(real.map((x) => x.rec.scenarioId).sort()).toEqual(["feature-priority", "incident-triage"]);
  });

  // A local 9B model answering a re-ask in under half a second means Ollama served cached
  // prompts; that contradicts the "about 3 s" the README and page state. Never commit those.
  it.each(real.map((x) => [x.f, x.rec] as const))("%s: every Clef update took at least 500 ms (no cached timings)", (_f, rec) => {
    const local = rec.engines.local;
    expect(local).toBeDefined();
    const updates = local!.steps.slice(1).filter((s) => s.asked > 0);
    expect(updates.length).toBeGreaterThan(0);
    for (const s of updates) expect(s.ms, `step ${s.step}: ${s.ms} ms`).toBeGreaterThanOrEqual(500);
  });
});
