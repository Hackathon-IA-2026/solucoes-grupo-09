/**
 * Which restriction reason accounted for most of a settled day's curtailment.
 *
 * ## What this is, and what it is careful not to be
 *
 * The operator brief asks question 5 as "causa **provável** (REL/CNF/ENE)" —
 * a *predicted* cause. WattSteer does not predict one. The forecaster has a
 * single head per subsystem and produces a quantity, not a reason; REL, CNF and
 * ENE are codes ONS publishes about days that have already happened.
 *
 * So this answers the question with the thing that is true: the reason that
 * carried most of the energy on the **last settled day**. The screen says which
 * day, and never lets it sit unlabelled beside a forecast — a reason printed
 * next to tomorrow's band, with no date on it, is a claim the model cannot
 * make and would be read as one.
 *
 * ## Why energy and not row count
 *
 * A day can have forty rows of a code that moved almost nothing and two rows of
 * one that moved most of the day. Counting rows would make the record look like
 * whatever ONS happened to itemise most finely.
 */

import type { ObservedReason } from "@/lib/fixtures";

export interface DominantReason {
  reason: ObservedReason["reason"];
  /** Energy attributed to it, MWh. */
  mwh: number;
  /** Its share of the day's attributed energy, 0..1. */
  share: number;
}

/**
 * Every reason the day attributed energy to, largest first.
 *
 * The dominant one is this list's head. It exists because "why?" is often not
 * one answer: ONS frequently splits a day between two codes at, say, 55/40, and
 * naming only the first tells a reader the day had one cause when it had two.
 * A card can then decide how many to speak — the rule belongs to the card,
 * because it is about how much room a sentence has, not about the data.
 *
 * Shares are of the day's **attributed** energy, `conjunto` rows only, for the
 * reason the header gives.
 */
export function rankedReasons(rows: readonly ObservedReason[]): DominantReason[] {
  const byReason = new Map<ObservedReason["reason"], number>();
  let total = 0;
  for (const row of rows) {
    if (row.grain !== "conjunto") {
      continue;
    }
    byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + row.constrainedOffMwh);
    total += row.constrainedOffMwh;
  }
  if (total <= 0) {
    // A day with no attributed energy has no reason at all, and saying
    // "REL, 0%" would be worse than saying nothing.
    return [];
  }
  return [...byReason.entries()]
    .map(([reason, mwh]) => ({ reason, mwh, share: mwh / total }))
    .sort((a, b) => b.mwh - a.mwh);
}

export function dominantReason(rows: readonly ObservedReason[]): DominantReason | null {
  /*
    **`conjunto` rows only**, and that rule lives in `rankedReasons` now:
    `self_reporting_plant` rows are a plant's own account of itself, and mixing
    the two double-counts a plant that sits inside a conjunto ONS also reported.
    Delegating rather than repeating the loop is what keeps the head of the list
    and the "dominant" reason from ever disagreeing.
  */
  return rankedReasons(rows)[0] ?? null;
}
