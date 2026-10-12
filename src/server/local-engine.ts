import type { Adapter } from "../engine/runner";
import { createClefAdapter, DEFAULT_CLEF_MODEL, MIN_OLLAMA_FOR_CLEF, versionAtLeast } from "./clef";
import { createLocalAdapter, DEFAULT_LOCAL_MODEL, localStatus } from "./local";

export type LocalEngineKind = "clef" | "llm";

export interface LocalConfig {
  kind: LocalEngineKind;
  url: string;
  model: string;
  concurrency: number;
}

/** LOCAL_ENGINE=clef (default, Clef via Ollama /v1/systemone) or llm (llama3.2 chat adapter). */
export function localConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const kind: LocalEngineKind = env.LOCAL_ENGINE?.trim().toLowerCase() === "llm" ? "llm" : "clef";
  return {
    kind,
    url: env.OLLAMA_URL?.trim() || "http://localhost:11434",
    model: env.LOCAL_MODEL?.trim() || (kind === "clef" ? DEFAULT_CLEF_MODEL : DEFAULT_LOCAL_MODEL),
    concurrency: Number(env.LOCAL_CONCURRENCY ?? 4),
  };
}

export function createLocalEngine(cfg: LocalConfig): Adapter {
  return cfg.kind === "clef"
    ? createClefAdapter({ url: cfg.url, model: cfg.model })
    : createLocalAdapter({ url: cfg.url, model: cfg.model, concurrency: cfg.concurrency });
}

export async function localEngineStatus(cfg: LocalConfig) {
  const st = await localStatus(cfg.url, cfg.model);
  const versionOk = cfg.kind !== "clef" || (st.version ? versionAtLeast(st.version, MIN_OLLAMA_FOR_CLEF) : false);
  return { ...st, engine: cfg.kind, model: cfg.model, versionOk, ready: st.running && st.modelPulled && versionOk, minVersion: cfg.kind === "clef" ? MIN_OLLAMA_FOR_CLEF : undefined };
}
