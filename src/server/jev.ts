import { TypeSafeClient, type Fetch, type Questions } from "@typesafe-ai/sdk";
import type { Adapter, AdapterResult } from "../engine/runner";
import type { BuiltQuestion, JsonValue } from "../engine/questions";
import type { EngineId, Judgment } from "../engine/types";

export const DEFAULT_JEV_MODEL = "jev-1.13.0";

export class NoKeyError extends Error {
  constructor() {
    super("No TypeSafe key. Set TYPESAFE_API_KEY in .env, or add a macOS Keychain item named TYPESAFE_API_KEY, then restart the server.");
    this.name = "NoKeyError";
  }
}

/** Convert the batched questions to the SDK's question map. */
export function toQuestions(questions: BuiltQuestion[]): Questions {
  const out: Questions = {};
  for (const q of questions) {
    if (q.spec.type === "score") {
      const [a, b, ...rest] = q.spec.criteria;
      if (a === undefined || b === undefined) throw new Error(`${q.key}: a Score needs at least two levels`);
      out[q.key] = { type: "score", instructions: q.spec.instructions, criteria: [a, b, ...rest] };
    } else {
      out[q.key] = { type: "noul", instructions: q.spec.instructions };
    }
  }
  return out;
}

/**
 * Convert one System One answer to the engine's Judgment. Tolerant of small shape differences
 * between servers (TypeSafe and Ollama's /v1/systemone): probabilities may be an object keyed
 * by level or an array, and a noul may arrive as `noul`, `probability`, or `p`.
 */
export function toJudgment(answer: unknown, levels: number, kind?: "score" | "noul"): Judgment {
  const a = answer as {
    type?: string;
    noul?: number;
    probability?: number;
    p?: number;
    score?: number;
    probabilities?: Record<string, number> | number[];
    confidence?: number;
  };
  const type = a?.type ?? kind;
  if (type === "noul") {
    const p = a.noul ?? a.probability ?? a.p;
    if (typeof p === "number") return { kind: "noul", p };
  }
  if (type === "score" && a && (typeof a.score === "number" || a.probabilities)) {
    const raw = a.probabilities;
    const probabilities = Array.from({ length: levels }, (_, i) =>
      Number(Array.isArray(raw) ? raw[i] ?? 0 : raw?.[String(i)] ?? 0),
    );
    const score = typeof a.score === "number" ? a.score : probabilities.reduce((s, p, i) => s + p * i, 0);
    return { kind: "score", score, probabilities, ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}) };
  }
  throw new Error(`Unexpected System One answer: ${JSON.stringify(answer)}`);
}

export interface SystemOneOptions {
  engine: EngineId;
  apiKey: string | undefined;
  model: string;
  baseURL?: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Map transport errors to engine-specific errors (e.g. "local model not running"). */
  mapError?: (err: unknown) => unknown;
}

/** System One adapter: one batched systemOne request per distinct state, model pinned. */
export function createSystemOneAdapter(opts: SystemOneOptions): Adapter {
  let client: TypeSafeClient | null = null;
  const getClient = () => {
    if (!opts.apiKey) throw new NoKeyError();
    client ??= new TypeSafeClient({
      apiKey: opts.apiKey,
      defaultModel: opts.model,
      logLevel: "error",
      timeout: opts.timeoutMs ?? 30000,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return client;
  };
  return {
    engine: opts.engine,
    model: opts.model,
    async ask(state: { [key: string]: JsonValue }, questions: BuiltQuestion[]): Promise<AdapterResult> {
      const c = getClient();
      let res;
      try {
        res = await c.systemOne({ state, questions: toQuestions(questions), model: opts.model });
      } catch (err) {
        throw opts.mapError ? opts.mapError(err) : err;
      }
      const answers: Record<string, Judgment> = {};
      for (const q of questions) {
        const levels = q.spec.type === "score" ? q.spec.criteria.length : 2;
        answers[q.key] = toJudgment((res.answers as Record<string, unknown>)[q.key], levels, q.spec.type);
      }
      const u = res.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        answers,
        requests: 1,
        ...(u && typeof u.input_tokens === "number" ? { usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens ?? 0 } } : {}),
      };
    },
  };
}

export interface JevOptions {
  apiKey: string | undefined;
  model?: string;
  /** For tests: a mocked fetch. */
  fetch?: Fetch;
  timeoutMs?: number;
}

/** Jev on api.typesafe.ai. The real key is only ever given to this adapter. */
export function createJevAdapter(opts: JevOptions): Adapter {
  return createSystemOneAdapter({
    engine: "jev",
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_JEV_MODEL,
    baseURL: "https://api.typesafe.ai",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
