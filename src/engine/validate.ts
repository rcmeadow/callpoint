import type { Scenario } from "./types";

/** Light structural check so a hand-written scenario fails with a readable message. */
export function validateScenario(s: unknown, source = "scenario"): Scenario {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  const x = s as Scenario;
  if (!x || typeof x !== "object") fail("not an object");
  if (typeof x.id !== "string" || !x.id) fail("missing id");
  if (typeof x.title !== "string") fail("missing title");
  if (typeof x.goal !== "string") fail("missing goal");
  if (!x.incident || typeof x.incident !== "object" || typeof x.incident.summary !== "string" || !x.incident.summary.trim())
    fail("needs incident.summary: one or two sentences on what is happening");
  if (x.noun !== undefined && (typeof x.noun !== "string" || !/^[a-z][a-z ]{0,29}$/.test(x.noun)))
    fail("noun must be one or two plain lowercase words, e.g. \"decision\"");
  if (!Array.isArray(x.options) || x.options.length < 2) fail("needs at least 2 options");
  if (!Array.isArray(x.criteria) || x.criteria.length < 1) fail("needs at least 1 criterion");
  if (!Array.isArray(x.constraints)) fail("constraints must be an array (can be empty)");
  if (!Array.isArray(x.updates)) fail("updates must be an array");
  if (x.nearTieMargin !== undefined && (typeof x.nearTieMargin !== "number" || x.nearTieMargin < 0 || x.nearTieMargin > 1)) fail("Near-tie margin (nearTieMargin) must be a number from 0 to 1");
  const ids = new Set<string>();
  for (const c of [...x.criteria, ...x.constraints]) {
    if (ids.has(c.id)) fail(`"${c.name}" uses the id "${c.id}", which another goal or constraint already has`);
    ids.add(c.id);
  }
  for (const c of x.criteria) {
    if (!Array.isArray(c.levels) || c.levels.length < 2 || c.levels.length > 10) fail(`Goal "${c.name ?? c.id}" needs 2 to 10 levels`);
  }
  for (const u of x.updates) {
    for (const a of u.affects ?? []) if (!ids.has(a)) fail(`Update "${u.title ?? u.id}" points at "${a}", which is not a goal or constraint`);
  }
  return x;
}
