import { APIConnectionError, APIError, type Fetch } from "@typesafe-ai/sdk";
import type { Adapter } from "../engine/runner";
import { createSystemOneAdapter } from "./jev";
import { LocalNotRunningError } from "./local";

export const DEFAULT_CLEF_MODEL = "clef-flash:9b";
export const MIN_OLLAMA_FOR_CLEF = "0.35.1";

/**
 * Ollama does not check this value. It exists only because the SDK requires a non-empty key.
 * The real TypeSafe key is never passed to the local engine.
 */
const LOCAL_PLACEHOLDER_KEY = "ollama-local";

export interface ClefOptions {
  url?: string;
  model?: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

/** Cloudflare Clef served by Ollama at /v1/systemone, through the same System One adapter as Jev. */
export function createClefAdapter(opts: ClefOptions = {}): Adapter {
  const url = (opts.url ?? "http://localhost:11434").replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_CLEF_MODEL;
  return createSystemOneAdapter({
    engine: "local",
    apiKey: LOCAL_PLACEHOLDER_KEY,
    model,
    baseURL: url,
    timeoutMs: opts.timeoutMs ?? 180000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    mapError: (err) => {
      if (err instanceof APIConnectionError && !(err.name === "APITimeoutError")) return new LocalNotRunningError(url);
      if (err instanceof APIError && err.status === 404)
        return new Error(`Clef not available at ${url}/v1/systemone. It needs Ollama ${MIN_OLLAMA_FOR_CLEF}+ and: ollama pull ${model}`);
      return err;
    },
  });
}

/** Compare dotted versions: true when `have` >= `need`. */
export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = need.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
