import { describe, expect, it } from "vitest";
import type { Outlook } from "../src/engine/insight";
import { plainHeadline, plainOutlook } from "../src/web/plain";

const names: Record<string, string> = { a: "Roll back to v2.30", b: "Fail over" };
const nameOf = (id: string) => names[id] ?? id;
const flip = (change: number): Outlook => ({
  kind: "flip", text: "x", via: "gate", optionId: "a", leaderId: "a", challengerId: "b",
  targetId: "t", targetName: "No payment data loss", from: 0.13, to: 0.13 + change, change,
});
const noJargon = (s: string) => {
  expect(s).not.toMatch(/\d\.\d|margin|gap|constraint|criterion|P\(|Jev|Clef|TypeSafe/i);
};

describe("plain copy for the simple view", () => {
  it("flip, big change", () => {
    const t = plainOutlook(flip(0.37), nameOf);
    expect(t).toBe("Still the best option. It would take a big change in the facts to put Fail over ahead.");
    noJargon(t);
  });
  it("flip, small change stays honest", () => {
    expect(plainOutlook(flip(0.07), nameOf)).toBe("Still the best option, but a small change in the facts could put Fail over ahead.");
  });
  it("near tie", () => {
    const t = plainOutlook({ kind: "too-close", text: "x", optionIds: ["a", "b"], totals: [0.5, 0.49], gap: 0.01, margin: 0.02 }, nameOf);
    expect(t).toBe("Neck and neck. Callpoint won't pick for you.");
    noJargon(t);
  });
  it("only one left", () => expect(plainOutlook({ kind: "only-one", text: "x", leaderId: "a" }, nameOf)).toBe("The only option that doesn't break a hard rule."));
  it("all blocked has no 'below'", () => {
    const t = plainOutlook({ kind: "all-blocked", text: "x" }, nameOf);
    expect(t).not.toMatch(/below/i);
    noJargon(t);
  });
  it("headlines carry no numbers", () => {
    expect(plainHeadline("call", ["Roll back to v2.30"])).toBe("Current call: Roll back to v2.30");
    expect(plainHeadline("tie", ["Roll back to v2.30", "Disable the smart-retries flag"])).toBe("Too close to call: Roll back to v2.30 or Disable the smart-retries flag");
    expect(plainHeadline("none", [])).not.toMatch(/below|constraint/i);
  });
});
