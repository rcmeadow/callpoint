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

describe("facts endpoint", () => {
  it("runs a live fact against an edited scenario", async () => {
    const a = app();
    const edited = { ...s, title: "Edited", options: s.options.slice(0, 3) };
    const body = { scenario: edited, facts: [{ id: "l1", at: "16:40", title: "Live fact", text: "New info.", source: "live" }] };
    const res = await a.request("/api/local/facts", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.total).toBe(3 * 4 + 3 * 2);
    expect(r.asked).toBe(18);
    expect(r.step).toBe(1);
  });

  it("rejects an invalid scenario or fact", async () => {
    const a = app();
    const bad1 = await a.request("/api/local/facts", { method: "POST", body: JSON.stringify({ scenario: { ...s, options: [] }, facts: [] }) });
    expect(bad1.status).toBe(400);
    const bad2 = await a.request("/api/local/facts", { method: "POST", body: JSON.stringify({ scenario: s, facts: [{ id: "x", at: "1", title: "t", text: "", source: "live" }] }) });
    expect(bad2.status).toBe(400);
  });
});

describe("origin check", () => {
  it("allows no Origin and loopback dev origins, rejects others", async () => {
    const { isAllowedOrigin } = await import("../src/server/app");
    const ports = [5173, 4173, 8787];
    expect(isAllowedOrigin("http://localhost:5173", ports)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4173", ports)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:8787", ports)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", ports)).toBe(false);
    expect(isAllowedOrigin("http://192.168.1.20:5173", ports)).toBe(false);
    expect(isAllowedOrigin("https://evil.example", ports)).toBe(false);
    expect(isAllowedOrigin("null", ports)).toBe(false);
    const a = app();
    expect((await a.request("/api/status")).status).toBe(200);
    expect((await a.request("/api/status", { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
    const bad = await a.request("/api/local/step", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ scenarioId: s.id, step: 0 }) });
    expect(bad.status).toBe(403);
  });
});
