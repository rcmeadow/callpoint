import { Hono } from "hono";
import { JudgmentCache } from "../engine/cache";
import { runStep, type Adapter } from "../engine/runner";
import type { EngineId, Scenario } from "../engine/types";
import { NoKeyError } from "./jev";
import { LocalNotRunningError } from "./local";

export interface AppDeps {
  adapters: Record<EngineId, Adapter>;
  getScenario: (id: string) => Scenario | undefined;
  listScenarios: () => Scenario[];
  status: () => Promise<unknown>;
}

/** The HTTP API. Every model call happens here; the browser only ever sees judgments. */
export function createApp(deps: AppDeps) {
  const caches: Record<EngineId, JudgmentCache> = { jev: new JudgmentCache(), local: new JudgmentCache() };
  const app = new Hono();

  app.get("/api/status", async (c) => c.json(await deps.status()));

  app.get("/api/scenarios", (c) => c.json(deps.listScenarios().map((s) => ({ id: s.id, title: s.title }))));

  app.post("/api/:engine/step", async (c) => {
    const engine = c.req.param("engine") as EngineId;
    const adapter = deps.adapters[engine];
    if (!adapter) return c.json({ error: `Unknown engine ${engine}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { scenarioId?: string; step?: number };
    const scenario = body.scenarioId ? deps.getScenario(body.scenarioId) : undefined;
    if (!scenario) return c.json({ error: "Unknown scenario" }, 404);
    const step = Number(body.step ?? 0);
    if (!Number.isInteger(step) || step < 0 || step > scenario.updates.length) return c.json({ error: "Bad step" }, 400);
    try {
      return c.json(await runStep(scenario, step, adapter, caches[engine]));
    } catch (err) {
      if (err instanceof NoKeyError) return c.json({ error: err.message, code: "no_key" }, 503);
      if (err instanceof LocalNotRunningError) return c.json({ error: err.message, code: "local_not_running" }, 503);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "engine_error" }, 502);
    }
  });

  app.post("/api/cache/clear", (c) => {
    caches.jev.clear();
    caches.local.clear();
    return c.json({ ok: true });
  });

  return app;
}
