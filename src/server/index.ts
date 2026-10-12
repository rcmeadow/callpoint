import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createJevAdapter, DEFAULT_JEV_MODEL } from "./jev";
import { loadKey } from "./key";
import { createLocalAdapter, DEFAULT_LOCAL_MODEL, localStatus } from "./local";
import { getScenario, loadScenarios } from "./scenarios";

const { key, source } = loadKey();
const jevModel = process.env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
const ollamaUrl = process.env.OLLAMA_URL?.trim() || "http://localhost:11434";
const localModel = process.env.LOCAL_MODEL?.trim() || DEFAULT_LOCAL_MODEL;
const port = Number(process.env.PORT ?? 8787);

const app = createApp({
  adapters: {
    jev: createJevAdapter({ apiKey: key, model: jevModel }),
    local: createLocalAdapter({ url: ollamaUrl, model: localModel, concurrency: Number(process.env.LOCAL_CONCURRENCY ?? 4) }),
  },
  getScenario: (id) => getScenario(id),
  listScenarios: () => loadScenarios(),
  status: async () => ({
    jev: { keyPresent: !!key, keySource: source, model: jevModel },
    local: { ...(await localStatus(ollamaUrl, localModel)), model: localModel },
  }),
});

serve({ fetch: app.fetch, port }, () => {
  // Only the source is printed, never the key.
  console.log(`Reflex API on http://localhost:${port}  (TypeSafe key: ${key ? `loaded from ${source}` : "not found"}; Jev model ${jevModel}; local model ${localModel})`);
});
