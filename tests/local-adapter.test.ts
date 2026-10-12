import { describe, expect, it, vi } from "vitest";
import { JudgmentCache } from "../src/engine/cache";
import { buildQuestions } from "../src/engine/questions";
import { runStep } from "../src/engine/runner";
import { createLocalAdapter, LocalNotRunningError, mapLimit, parseReply } from "../src/server/local";
import { loadFixture } from "./helpers";

const s = loadFixture();

describe("local adapter (mocked Ollama)", () => {
  it("parses levels one-hot and yes/no to 1/0", () => {
    const qs = buildQuestions(s, 0);
    const sq = qs.find((q) => q.kind === "score")!;
    const nq = qs.find((q) => q.kind === "noul")!;
    expect(parseReply('{"level": 2}', sq)).toEqual({ kind: "score", score: 2, probabilities: [0, 0, 1, 0] });
    expect(parseReply('{"answer":"yes"}', nq)).toEqual({ kind: "noul", p: 1 });
    expect(() => parseReply('{"level": 9}', sq)).toThrow(/bad level/);
    expect(() => parseReply("nope", sq)).toThrow(/non-JSON/);
  });

  it("runs one call per question with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const body = JSON.parse(String(init?.body));
      expect(body.options.temperature).toBe(0);
      const isScore = "level" in body.format.properties;
      return new Response(JSON.stringify({ message: { content: isScore ? '{"level":1}' : '{"answer":"no"}' } }));
    });
    const adapter = createLocalAdapter({ fetch: f as any, concurrency: 3 });
    const r = await runStep(s, 0, adapter, new JudgmentCache());
    expect(f).toHaveBeenCalledTimes(30);
    expect(r.requests).toBe(30);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("reports 'local model not running' when Ollama is down", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const adapter = createLocalAdapter({ fetch: f as any });
    await expect(runStep(s, 0, adapter, new JudgmentCache())).rejects.toBeInstanceOf(LocalNotRunningError);
  });

  it("mapLimit keeps order", async () => {
    expect(await mapLimit([3, 1, 2], 2, async (x) => x * 10)).toEqual([30, 10, 20]);
  });
});
