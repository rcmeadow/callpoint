import { describe, expect, it, vi } from "vitest";
import { JudgmentCache } from "../src/engine/cache";
import { runStep } from "../src/engine/runner";
import { createClefAdapter, versionAtLeast } from "../src/server/clef";
import { LocalNotRunningError } from "../src/server/local";
import { localConfigFromEnv } from "../src/server/local-engine";
import { loadFixture } from "./helpers";

const s = loadFixture();

/** Mock Ollama /v1/systemone. Uses array probabilities and a `probability` noul field to test tolerance. */
function mockOllama() {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      answers[id] = q.type === "noul" ? { type: "noul", probability: 0.2 } : { type: "score", score: 1.3, probabilities: [0, 0.7, 0.3, 0] };
    }
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f, calls };
}

describe("Clef adapter (System One via Ollama, mocked)", () => {
  it("sends one batched request to Ollama's /v1/systemone with the Clef model", async () => {
    const { f, calls } = mockOllama();
    const r = await runStep(s, 0, createClefAdapter({ fetch: f as any }), new JudgmentCache());
    expect(f).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/systemone");
    expect(calls[0]!.body.model).toBe("clef-flash:9b");
    expect(Object.keys(calls[0]!.body.questions)).toHaveLength(30);
    expect(calls[0]!.auth).toBe("Bearer ollama-local");
    expect(r.requests).toBe(1);
    expect(r.judgments["rollback__impact"]).toEqual({ kind: "score", score: 1.3, probabilities: [0, 0.7, 0.3, 0] });
    expect(r.judgments["rollback__data_loss"]).toEqual({ kind: "noul", p: 0.2 });
    expect(r.usage).toBeUndefined();
  });

  it("parses the live Clef response shape (same as Jev, plus prompt_eval_cached_count)", async () => {
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(body.questions))
        answers[id] = q.type === "noul"
          ? { type: "noul", noul: 0.91 }
          : { type: "score", score: 2.1, confidence: 0.55, legend: { "0": "a", "1": "b", "2": "c", "3": "d" }, probabilities: { "0": 0, "1": 0.1, "2": 0.7, "3": 0.2 } };
      return new Response(JSON.stringify({ model: "clef-flash:9b", answers, usage: { input_tokens: 900, output_tokens: 40 }, prompt_eval_cached_count: 512 }), { status: 200 });
    });
    const r = await runStep(s, 0, createClefAdapter({ fetch: f as any }), new JudgmentCache());
    expect(r.judgments["hotfix__ic_forbidden"]).toEqual({ kind: "noul", p: 0.91 });
    expect(r.judgments["hotfix__speed"]).toEqual({ kind: "score", score: 2.1, probabilities: [0, 0.1, 0.7, 0.2], confidence: 0.55 });
    expect(r.usage).toEqual({ input_tokens: 900, output_tokens: 40 });
  });

  it("maps a refused connection to 'local model not running'", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const adapter = createClefAdapter({ fetch: f as any });
    await expect(runStep(s, 0, adapter, new JudgmentCache())).rejects.toBeInstanceOf(LocalNotRunningError);
  }, 15000);

  it("explains a 404 as an Ollama version or missing model problem", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    await expect(runStep(s, 0, createClefAdapter({ fetch: f as any }), new JudgmentCache())).rejects.toThrow(/0\.35\.1\+/);
  });

  it("compares Ollama versions", () => {
    expect(versionAtLeast("0.30.8", "0.35.1")).toBe(false);
    expect(versionAtLeast("0.35.1", "0.35.1")).toBe(true);
    expect(versionAtLeast("0.36.0", "0.35.1")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.35.1")).toBe(true);
  });

  it("defaults LOCAL_ENGINE to clef with clef-flash:9b; llm keeps llama3.2:3b", () => {
    expect(localConfigFromEnv({})).toMatchObject({ kind: "clef", model: "clef-flash:9b" });
    expect(localConfigFromEnv({ LOCAL_ENGINE: "llm" })).toMatchObject({ kind: "llm", model: "llama3.2:3b" });
    expect(localConfigFromEnv({ LOCAL_ENGINE: "clef", LOCAL_MODEL: "clef-flash:other" }).model).toBe("clef-flash:other");
  });
});
