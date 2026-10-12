import { TypeSafeClient, type Fetch, type Questions } from "@typesafe-ai/sdk";
import type { Adapter, AdapterResult } from "../engine/runner";
import type { BuiltQuestion, JsonValue } from "../engine/questions";
import type { Judgment } from "../engine/types";

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

/** Convert one API answer to the engine's Judgment. */
export function toJudgment(answer: unknown, levels: number): Judgment {
  const a = answer as { type?: string; noul?: number; score?: number; probabilities?: Record<string, number>; confidence?: number };
  if (a?.type === "noul" && typeof a.noul === "number") return { kind: "noul", p: a.noul };
  if (a?.type === "score" && typeof a.score === "number") {
    const probabilities = Array.from({ length: levels }, (_, i) => Number(a.probabilities?.[String(i)] ?? 0));
    return { kind: "score", score: a.score, probabilities, ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}) };
  }
  throw new Error(`Unexpected Jev answer: ${JSON.stringify(answer)}`);
}

export interface JevOptions {
  apiKey: string | undefined;
  model?: string;
  /** For tests: a mocked fetch. */
  fetch?: Fetch;
  timeoutMs?: number;
}

/** Jev adapter: one batched systemOne request per distinct state, model pinned. */
export function createJevAdapter(opts: JevOptions): Adapter {
  const model = opts.model ?? DEFAULT_JEV_MODEL;
  let client: TypeSafeClient | null = null;
  const getClient = () => {
    if (!opts.apiKey) throw new NoKeyError();
    client ??= new TypeSafeClient({
      apiKey: opts.apiKey,
      defaultModel: model,
      logLevel: "error",
      timeout: opts.timeoutMs ?? 30000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return client;
  };
  return {
    engine: "jev",
    model,
    async ask(state: { [key: string]: JsonValue }, questions: BuiltQuestion[]): Promise<AdapterResult> {
      const res = await getClient().systemOne({ state, questions: toQuestions(questions), model });
      const answers: Record<string, Judgment> = {};
      for (const q of questions) {
        const levels = q.spec.type === "score" ? q.spec.criteria.length : 2;
        answers[q.key] = toJudgment((res.answers as Record<string, unknown>)[q.key], levels);
      }
      return { answers, requests: 1, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
    },
  };
}
