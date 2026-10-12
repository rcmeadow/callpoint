import { Hono } from "hono";
import { JudgmentCache } from "../engine/cache";
import { runFacts, runStep, type Adapter } from "../engine/runner";
import { validateScenario } from "../engine/validate";
import type { EngineId, Fact, Scenario } from "../engine/types";
import { NoKeyError } from "./jev";
import { LocalNotRunningError } from "./local";

export interface AppDeps {
  adapters: Record<EngineId, Adapter>;
  getScenario: (id: string) => Scenario | undefined;
  listScenarios: () => Scenario[];
  status: () => Promise<unknown>;
  /** Ports a browser page may call from (Vite dev, Vite preview, the API itself). */
  allowedPorts?: number[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for http(s)://localhost or 127.0.0.1 (or [::1]) on one of the allowed ports. */
export function isAllowedOrigin(origin: string, ports: number[]): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return LOOPBACK_HOSTS.has(u.hostname) && ports.includes(port);
  } catch {
    return false;
  }
}

/** The HTTP API. Every model call happens here; the browser only ever sees judgments. */
export function createApp(deps: AppDeps) {
  const caches: Record<EngineId, JudgmentCache> = { jev: new JudgmentCache(), local: new JudgmentCache() };
  const app = new Hono();
  const ports = deps.allowedPorts ?? [5173, 4173, 8787];

  // Only pages served from this machine may call the API (no Origin = curl or the Vite proxy's own requests).
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin, ports)) return c.json({ error: "Origin not allowed", code: "bad_origin" }, 403);
    await next();
  });

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
      return errorResponse(c, err);
    }
  });

  // Any scenario (edited in the UI) plus any list of facts (scripted and/or live).
  app.post("/api/:engine/facts", async (c) => {
    const engine = c.req.param("engine") as EngineId;
    const adapter = deps.adapters[engine];
    if (!adapter) return c.json({ error: `Unknown engine ${engine}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { scenario?: unknown; facts?: unknown };
    let scenario: Scenario;
    let facts: Fact[];
    try {
      scenario = validateScenario(body.scenario, "scenario");
      facts = parseFacts(body.facts);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), code: "bad_request" }, 400);
    }
    try {
      return c.json(await runFacts(scenario, facts, adapter, caches[engine]));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/api/cache/clear", (c) => {
    caches.jev.clear();
    caches.local.clear();
    return c.json({ ok: true });
  });

  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorResponse(c: any, err: unknown) {
  if (err instanceof NoKeyError) return c.json({ error: err.message, code: "no_key" }, 503);
  if (err instanceof LocalNotRunningError) return c.json({ error: err.message, code: "local_not_running" }, 503);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message, code: "engine_error" }, 502);
}

/** Validate a fact list from the browser. */
export function parseFacts(raw: unknown): Fact[] {
  if (!Array.isArray(raw)) throw new Error("facts must be an array");
  if (raw.length > 60) throw new Error("too many facts (max 60)");
  return raw.map((f, i) => {
    const x = f as Partial<Fact>;
    const str = (v: unknown, max: number, name: string) => {
      if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`fact ${i + 1}: ${name} must be text up to ${max} characters`);
      return v;
    };
    const source = x.source === "scripted" ? "scripted" : x.source === "live" ? "live" : null;
    if (!source) throw new Error(`fact ${i + 1}: source must be scripted or live`);
    const out: Fact = { id: str(x.id, 80, "id"), at: str(x.at, 40, "at"), title: str(x.title, 200, "title"), text: str(x.text, 2000, "text"), source };
    if (x.affects !== undefined) {
      if (!Array.isArray(x.affects) || x.affects.some((a) => typeof a !== "string")) throw new Error(`fact ${i + 1}: affects must be a list of ids`);
      out.affects = [...x.affects];
    }
    return out;
  });
}
