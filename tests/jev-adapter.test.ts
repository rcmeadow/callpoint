import { describe, expect, it, vi } from "vitest";
import { JudgmentCache } from "../src/engine/cache";
import { buildQuestions } from "../src/engine/questions";
import { runStep } from "../src/engine/runner";
import { createJevAdapter, NoKeyError, toJudgment } from "../src/server/jev";
import { loadFixture } from "./helpers";

const s = loadFixture();
const FAKE_KEY = "test-key-not-real";

/** A mocked fetch that answers every question in the request body. */
function mockFetch() {
  const bodies: any[] = [];
  const headers: Record<string, string>[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push({ url, body });
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      answers[id] =
        q.type === "noul"
          ? { type: "noul", noul: 0.12 }
          : {
              type: "score",
              score: 2.2,
              confidence: 0.6,
              legend: Object.fromEntries(q.criteria.map((c: string, i: number) => [String(i), c])),
              probabilities: { "0": 0, "1": 0.1, "2": 0.6, "3": 0.3 },
            };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1000, output_tokens: 50 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { f, bodies, headers };
}

describe("Jev adapter (mocked fetch, real SDK)", () => {
  it("sends one batched systemOne request with the pinned model", async () => {
    const { f, bodies, headers } = mockFetch();
    const adapter = createJevAdapter({ apiKey: FAKE_KEY, fetch: f as any });
    const r = await runStep(s, 0, adapter, new JudgmentCache());
    expect(f).toHaveBeenCalledTimes(1);
    expect(bodies[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(bodies[0].body.model).toBe("jev-1.13.0");
    expect(Object.keys(bodies[0].body.questions)).toHaveLength(30);
    expect(headers[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const q = Object.values<any>(bodies[0].body.questions).find((x) => x.type === "score");
    expect(Array.isArray(q.criteria)).toBe(true);
    expect(r.asked).toBe(30);
    expect(r.requests).toBe(1);
    expect(r.usage).toEqual({ input_tokens: 1000, output_tokens: 50 });
    expect(r.judgments["disable_flag__impact"]).toEqual({ kind: "score", score: 2.2, probabilities: [0, 0.1, 0.6, 0.3], confidence: 0.6 });
    expect(r.judgments["disable_flag__data_loss"]).toEqual({ kind: "noul", p: 0.12 });
  });

  it("sends the scoped state and self-contained instructions", async () => {
    const { f, bodies } = mockFetch();
    const adapter = createJevAdapter({ apiKey: FAKE_KEY, fetch: f as any });
    const cache = new JudgmentCache();
    await runStep(s, 0, adapter, cache);
    await runStep(s, 1, adapter, cache);
    expect(f).toHaveBeenCalledTimes(2);
    const second = bodies[1].body;
    expect(Object.keys(second.questions)).toHaveLength(10);
    expect(second.state.timeline).toHaveLength(1);
    expect(second.state.timeline[0].title).toBe("Deploy diff reviewed");
    const built = buildQuestions(s, 1).find((x) => x.key === "rollback__impact")!;
    expect(second.questions["rollback__impact"].instructions).toEqual(built.spec.instructions);
  });

  it("throws NoKeyError without calling fetch when there is no key", async () => {
    const { f } = mockFetch();
    const adapter = createJevAdapter({ apiKey: undefined, fetch: f as any });
    await expect(runStep(s, 0, adapter, new JudgmentCache())).rejects.toBeInstanceOf(NoKeyError);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects malformed answers", () => {
    expect(() => toJudgment({ type: "choice" }, 4)).toThrow(/Unexpected/);
  });
});
