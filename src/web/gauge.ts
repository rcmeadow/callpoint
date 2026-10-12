// Layout for the threshold gauge in "What would change the call". Pure, so it can be unit tested.

export interface GaugeLabel {
  /** Position of the mark along the track, 0 to 100. */
  left: number;
  /**
   * How far to shift the label left, as a percent of its own width. Using the mark's own
   * position (0 at the left end, 100 at the right end) keeps the label inside the track.
   */
  shift: number;
  /** Row under the track: 0 or 1 (1 only when the marks are close). */
  row: 0 | 1;
}

export interface GaugeLayout {
  now: GaugeLabel;
  at: GaugeLabel;
  /** True when the two labels need two rows to avoid overlapping. */
  stacked: boolean;
}

/** Marks closer than this (on the 0 to 1 scale) get their labels on separate rows. */
export const CLOSE = 0.18;

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

export function gaugeLayout(now: number, at: number): GaugeLayout {
  const n = clamp01(now);
  const a = clamp01(at);
  const stacked = Math.abs(n - a) < CLOSE;
  const label = (v: number, row: 0 | 1): GaugeLabel => ({ left: v * 100, shift: v * 100, row });
  // When stacked, the current value keeps the first row and the flip point drops to the second.
  return { now: label(n, 0), at: label(a, stacked ? 1 : 0), stacked };
}
