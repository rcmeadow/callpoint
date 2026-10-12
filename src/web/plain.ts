import type { Outlook } from "../engine/insight";

/** How big a change (on the 0 to 1 scale) still counts as "small" in plain words. */
export const SMALL_CHANGE = 0.15;

/**
 * The call banner's one-liner for the simple view, in plain words with no numbers or engine
 * terms. The full view keeps the detailed whereWeAreGoing sentence.
 */
export function plainOutlook(o: Outlook, nameOf: (id: string) => string): string {
  switch (o.kind) {
    case "flip":
      // Stay honest: say "small" when a small change would flip it.
      return o.change < SMALL_CHANGE
        ? `Still the best option, but a small change in the facts could put ${nameOf(o.challengerId)} ahead.`
        : `Still the best option. It would take a big change in the facts to put ${nameOf(o.challengerId)} ahead.`;
    case "too-close":
      return "Neck and neck. Callpoint won't pick for you.";
    case "only-one":
      return o.challengerId ? `Still the best option. Nothing single in the facts would put ${nameOf(o.challengerId)} ahead.` : "The only option that doesn't break a hard rule.";
    case "all-blocked":
      return "Every option breaks a hard rule, so Callpoint won't pick one. This one is yours to decide.";
  }
}

/** Simple-view headline: the call with no scores or gap numbers. */
export function plainHeadline(kind: "call" | "tie" | "none", names: string[]): string {
  if (kind === "none") return "No call: every option breaks a hard rule.";
  if (kind === "tie") return `Too close to call: ${names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`}`;
  return `Current call: ${names[0] ?? ""}`;
}
