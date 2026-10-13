// Shared types for the Callpoint engine. Pure data, safe for browser and server.

export interface Option {
  id: string;
  name: string;
  description: string;
}

export interface Criterion {
  id: string;
  name: string;
  /** The question, phrased about "the option". Levels run worst to best. */
  question: string;
  /** Ordered level descriptions, worst first. 2 to 10 entries. */
  levels: string[];
  weight: number;
}

export interface Constraint {
  id: string;
  name: string;
  /** A yes/no question about "the option". A yes means the option is blocked. */
  question: string;
  /** Block the option when P(yes) is at or above this value. */
  threshold: number;
}

export interface Update {
  id: string;
  at: string;
  title: string;
  text: string;
  /** Criterion or constraint ids this update can change. */
  affects: string[];
}

/** A fact on the incident timeline: a scripted update or a free-text fact added live. */
export interface Fact {
  id: string;
  /** Display time, e.g. "14:10" for scripted updates or the local clock time for live facts. */
  at: string;
  title: string;
  text: string;
  /** Scripted updates list the criteria/constraints they can change. Live facts have none. */
  affects?: string[];
  source: "scripted" | "live";
}

export interface Scenario {
  id: string;
  title: string;
  goal: string;
  /** The situation. `summary` is required (the UI and the receipt show it). */
  incident: Record<string, string>;
  /**
   * What kind of situation this is, in one plain word: "incident" (the default) or, say,
   * "decision". Used in copy and in the question wording, so a non-incident scenario reads right.
   */
  noun?: string;
  options: Option[];
  criteria: Criterion[];
  constraints: Constraint[];
  updates: Update[];
  /** Totals within this distance (chained) are "too close to call". Default 0.02. */
  nearTieMargin?: number;
}

/** A judgment, normalized across engines. */
export type Judgment =
  | {
      kind: "score";
      /** Expected level, 0..levels-1. */
      score: number;
      /** Probability per level, index = level. */
      probabilities: number[];
      confidence?: number;
    }
  | {
      kind: "noul";
      /** Probability of yes. */
      p: number;
    };

/** The result of one engine processing one step of a scenario. */
export interface StepResult {
  engine: EngineId;
  model: string;
  step: number;
  /** Judgment per question key (see questionKey). */
  judgments: Record<string, Judgment>;
  /** Questions sent to the model in this step (cache misses). */
  asked: number;
  /** Total questions in this step (hits + misses). */
  total: number;
  /** Number of model requests made (Jev: batched requests; local: one per question). */
  requests: number;
  /** Wall-clock milliseconds spent on model calls in this step. */
  ms: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export type EngineId = "jev" | "local";

export interface RankSettings {
  weights: Record<string, number>;
  /** Constraint id to enabled flag. Missing means enabled. */
  constraintsEnabled: Record<string, boolean>;
}

export interface RankedOption {
  optionId: string;
  rank: number;
  /** Weighted score 0..1. */
  total: number;
  blocked: boolean;
  blockedBy: string[];
  /**
   * True when this option is in a near-tie group: unblocked options whose totals chain within
   * the scenario's nearTieMargin. Inside a group the display order is scenario file order.
   */
  nearTie: boolean;
  /** Rank of the group's first position (equals rank when not in a near tie). */
  groupRank: number;
  /** Max minus min total inside the near-tie group (0 when not in one). */
  tieSpread: number;
  /** Normalized value 0..1 per criterion id. */
  parts: Record<string, number>;
}

export interface Recording {
  scenarioId: string;
  /** True for hand-made sample data that did not come from a real run. */
  synthetic: boolean;
  note?: string;
  recordedAt: string;
  engines: Partial<Record<EngineId, { model: string; steps: StepResult[] }>>;
}
