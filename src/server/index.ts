import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createJevAdapter, DEFAULT_JEV_MODEL } from "./jev";
import { loadKey } from "./key";
import { createLocalEngine, localConfigFromEnv, localEngineStatus } from "./local-engine";
import { getScenario, loadScenarios } from "./scenarios";

const { key, source } = loadKey();
const jevModel = process.env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
const localCfg = localConfigFromEnv();
const port = Number(process.env.PORT ?? 8787);

const app = createApp({
  adapters: {
    jev: createJevAdapter({ apiKey: key, model: jevModel }),
    local: createLocalEngine(localCfg),
  },
  getScenario: (id) => getScenario(id),
  listScenarios: () => loadScenarios(),
  status: async () => ({
    jev: { keyPresent: !!key, keySource: source, model: jevModel },
    local: await localEngineStatus(localCfg),
  }),
});

serve({ fetch: app.fetch, port }, () => {
  // Only the source is printed, never the key.
  console.log(`Callpoint API on http://localhost:${port}  (TypeSafe key: ${key ? `loaded from ${source}` : "not found"}; Jev model ${jevModel}; local engine ${localCfg.kind} ${localCfg.model})`);
});
