import type { Adapter, AdapterResult } from "../engine/runner";
import type { BuiltQuestion, JsonValue } from "../engine/questions";
import type { Judgment } from "../engine/types";

export const DEFAULT_LOCAL_MODEL = "llama3.2:3b";

export class LocalNotRunningError extends Error {
  constructor(url: string) {
    super(`Local model not running. Start Ollama (${url}) and pull the model, then try again.`);
    this.name = "LocalNotRunningError";
  }
}

export interface LocalOptions {
  url?: string;
  model?: string;
  concurrency?: number;
  fetch?: typeof fetch;
}

/** Run tasks with at most `limit` in flight, keeping result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export function promptFor(state: { [key: string]: JsonValue }, q: BuiltQuestion): { prompt: string; format: object } {
  const head = `STATE:\n${JSON.stringify(state, null, 2)}\n\nINSTRUCTIONS:\n${JSON.stringify(q.spec.instructions, null, 2)}\n\n`;
  if (q.spec.type === "score") {
    const levels = q.spec.criteria.map((d, i) => `${i}: ${d}`).join("\n");
    return {
      prompt: `${head}LEVELS:\n${levels}\n\nPick the one level that best fits. Reply with JSON {"level": <number>}.`,
      format: {
        type: "object",
        properties: { level: { type: "integer", enum: q.spec.criteria.map((_, i) => i) } },
        required: ["level"],
      },
    };
  }
  return {
    prompt: `${head}Answer yes or no. Reply with JSON {"answer": "yes" | "no"}.`,
    format: { type: "object", properties: { answer: { type: "string", enum: ["yes", "no"] } }, required: ["answer"] },
  };
}

/** Parse the model's JSON reply into a Judgment. The local path has no probabilities, so it is one-hot. */
export function parseReply(content: string, q: BuiltQuestion): Judgment {
  let parsed: { level?: unknown; answer?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Local model returned non-JSON for ${q.key}: ${content.slice(0, 120)}`);
  }
  if (q.spec.type === "score") {
    const n = q.spec.criteria.length;
    const level = Math.round(Number(parsed.level));
    if (!Number.isFinite(level) || level < 0 || level >= n) throw new Error(`Local model gave a bad level for ${q.key}: ${content}`);
    return { kind: "score", score: level, probabilities: Array.from({ length: n }, (_, i) => (i === level ? 1 : 0)) };
  }
  const a = String(parsed.answer ?? "").toLowerCase();
  if (a !== "yes" && a !== "no") throw new Error(`Local model gave a bad answer for ${q.key}: ${content}`);
  return { kind: "noul", p: a === "yes" ? 1 : 0 };
}

/** Ollama adapter: one chat call per question, bounded concurrency, temperature 0, fixed seed. */
export function createLocalAdapter(opts: LocalOptions = {}): Adapter {
  const url = (opts.url ?? "http://localhost:11434").replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_LOCAL_MODEL;
  const concurrency = opts.concurrency ?? 4;
  const f = opts.fetch ?? fetch;
  async function askOne(state: { [key: string]: JsonValue }, q: BuiltQuestion): Promise<Judgment> {
    const { prompt, format } = promptFor(state, q);
    let res: Response;
    try {
      res = await f(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format,
          options: { temperature: 0, seed: 7 },
          messages: [
            { role: "system", content: "You are a careful incident-response judge. Use only the facts in STATE. Reply only with the JSON asked for." },
            { role: "user", content: prompt },
          ],
        }),
      });
    } catch {
      throw new LocalNotRunningError(url);
    }
    if (res.status === 404) throw new Error(`Local model "${model}" is not pulled. Run: ollama pull ${model}`);
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return parseReply(body.message?.content ?? "", q);
  }
  return {
    engine: "local",
    model,
    async ask(state, questions): Promise<AdapterResult> {
      const js = await mapLimit(questions, concurrency, (q) => askOne(state, q));
      const answers: Record<string, Judgment> = {};
      questions.forEach((q, i) => (answers[q.key] = js[i]!));
      return { answers, requests: questions.length };
    },
  };
}

export interface LocalStatus {
  running: boolean;
  modelPulled: boolean;
  version?: string;
}

export async function localStatus(url = "http://localhost:11434", model = DEFAULT_LOCAL_MODEL): Promise<LocalStatus> {
  const base = url.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    let version: string | undefined;
    try {
      const v = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1500) });
      version = ((await v.json()) as { version?: string }).version;
    } catch {
      version = undefined;
    }
    if (!res.ok) return { running: true, modelPulled: false, ...(version ? { version } : {}) };
    const body = (await res.json()) as { models?: { name: string }[] };
    const want = model.includes(":") ? model : `${model}:latest`;
    return { running: true, modelPulled: !!body.models?.some((m) => m.name === want), ...(version ? { version } : {}) };
  } catch {
    return { running: false, modelPulled: false };
  }
}
