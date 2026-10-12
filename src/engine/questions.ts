import type { Constraint, Criterion, Option, Scenario } from "./types";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ScoreSpec {
  type: "score";
  instructions: { [key: string]: JsonValue };
  criteria: string[];
}

export interface NoulSpec {
  type: "noul";
  instructions: { [key: string]: JsonValue };
}

export interface BuiltQuestion {
  /** Stable key, also used as the question id in API requests. */
  key: string;
  kind: "score" | "noul";
  optionId: string;
  /** Criterion id (score) or constraint id (noul). */
  targetId: string;
  /** The state this question is judged against. Only includes updates that affect targetId. */
  state: { [key: string]: JsonValue };
  spec: ScoreSpec | NoulSpec;
}

export function questionKey(optionId: string, targetId: string): string {
  return `${optionId}__${targetId}`;
}

/** The state for one target (criterion or constraint) after `step` updates have landed. */
export function stateFor(scenario: Scenario, step: number, targetId: string): { [key: string]: JsonValue } {
  const timeline = scenario.updates
    .slice(0, step)
    .filter((u) => u.affects.includes(targetId))
    .map((u) => ({ at: u.at, title: u.title, text: u.text }));
  return {
    goal: scenario.goal,
    incident: { ...scenario.incident },
    timeline,
  };
}

function optionBlock(option: Option): { [key: string]: JsonValue } {
  return { name: option.name, description: option.description };
}

/**
 * Score question. Question ids are not sent to the model, so the instructions name the
 * option and the criterion explicitly.
 */
export function scoreSpec(option: Option, criterion: Criterion): ScoreSpec {
  return {
    type: "score",
    instructions: {
      option_under_evaluation: optionBlock(option),
      criterion: criterion.name,
      question: `${criterion.question} The option is \`option_under_evaluation\` ("${option.name}"). Judge it against the goal, incident, and timeline in the state.`,
    },
    criteria: [...criterion.levels],
  };
}

export function noulSpec(option: Option, constraint: Constraint): NoulSpec {
  return {
    type: "noul",
    instructions: {
      option_under_evaluation: optionBlock(option),
      rule: constraint.name,
      question: `${constraint.question} The option is \`option_under_evaluation\` ("${option.name}"). Answer from the goal, incident, and timeline in the state.`,
    },
  };
}

/** Every question for a step: one Score per option x criterion, one Noul per option x constraint. */
export function buildQuestions(scenario: Scenario, step: number): BuiltQuestion[] {
  const out: BuiltQuestion[] = [];
  for (const option of scenario.options) {
    for (const criterion of scenario.criteria) {
      out.push({
        key: questionKey(option.id, criterion.id),
        kind: "score",
        optionId: option.id,
        targetId: criterion.id,
        state: stateFor(scenario, step, criterion.id),
        spec: scoreSpec(option, criterion),
      });
    }
    for (const constraint of scenario.constraints) {
      out.push({
        key: questionKey(option.id, constraint.id),
        kind: "noul",
        optionId: option.id,
        targetId: constraint.id,
        state: stateFor(scenario, step, constraint.id),
        spec: noulSpec(option, constraint),
      });
    }
  }
  return out;
}

/** Keys of the questions whose state changes when update `step` (1-based) lands. */
export function affectedKeys(scenario: Scenario, step: number): string[] {
  const update = scenario.updates[step - 1];
  if (!update) return [];
  const keys: string[] = [];
  for (const option of scenario.options) {
    for (const t of update.affects) keys.push(questionKey(option.id, t));
  }
  return keys;
}
