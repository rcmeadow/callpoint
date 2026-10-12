import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createJevAdapter } from "../src/server/jev";
import { fakeAdapter, loadFixture, score } from "./helpers";

const s = loadFixture();

function app() {
  const { adapter } = fakeAdapter((q) => (q.kind === "noul" ? { kind: "noul", p: 0 } : score(1)));
  return createApp({
    adapters: { jev: createJevAdapter({ apiKey: undefined }), local: adapter },
    getScenario: (id) => (id === s.id ? s : undefined),
    listScenarios: () => [s],
    status: async () => ({ ok: true }),
  });
}

describe("server API", () => {
  it("returns a clear no-key error for Jev without a key", async () => {
    const res = await app().request("/api/jev/step", { method: "POST", body: JSON.stringify({ scenarioId: s.id, step: 0 }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("no_key");
    expect(body.error).toMatch(/No TypeSafe key/);
  });

  it("runs a local step and caches it", async () => {
    const a = app();
    const r1 = await (await a.request("/api/local/step", { method: "POST", body: JSON.stringify({ scenarioId: s.id, step: 0 }) })).json();
    expect(r1.asked).toBe(30);
    const r2 = await (await a.request("/api/local/step", { method: "POST", body: JSON.stringify({ scenarioId: s.id, step: 0 }) })).json();
    expect(r2.asked).toBe(0);
    await a.request("/api/cache/clear", { method: "POST" });
    const r3 = await (await a.request("/api/local/step", { method: "POST", body: JSON.stringify({ scenarioId: s.id, step: 0 }) })).json();
    expect(r3.asked).toBe(30);
  });

  it("rejects unknown scenarios and bad steps", async () => {
    const a = app();
    expect((await a.request("/api/local/step", { method: "POST", body: JSON.stringify({ scenarioId: "nope" }) })).status).toBe(404);
    expect((await a.request("/api/local/step", { method: "POST", body: JSON.stringify({ scenarioId: s.id, step: 99 }) })).status).toBe(400);
  });
});
