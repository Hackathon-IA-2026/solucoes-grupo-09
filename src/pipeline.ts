import type { Review } from "./types.js";

/**
 * A stage's decision about one review:
 * - `accept` — pass to the next stage (emitted only if every stage accepts)
 * - `drop`   — skip this review, keep scraping
 * - `stop`   — end the whole scrape now (don't emit this review)
 */
export type Verdict = "accept" | "drop" | "stop";

/** A pipeline stage. May be stateful (e.g. dedupe/limit keep counters). */
export type Stage = (review: Review) => Verdict;

/**
 * A Pipeline of review Stages with Chain-of-Responsibility short-circuiting:
 * stages run in order and the first non-`accept` verdict wins. This keeps the
 * "what to keep / when to stop" policy out of the fetch/pagination loop and
 * makes each rule independently unit-testable.
 */
export class ReviewPipeline {
  constructor(private readonly stages: Stage[]) {}

  run(review: Review): Verdict {
    for (const stage of this.stages) {
      const verdict = stage(review);
      if (verdict !== "accept") return verdict;
    }
    return "accept";
  }
}

// --- stage factories ---

/** Drop reviews whose id was already seen (offset/token paging can repeat). */
export function dedupe(): Stage {
  const seen = new Set<string>();
  return (review) => {
    if (seen.has(review.id)) return "drop";
    seen.add(review.id);
    return "accept";
  };
}

/** Stop the scrape once a review older than `cutoff` appears (mostRecent feeds). */
export function notOlderThan(cutoff: Date | null): Stage {
  const ms = cutoff ? cutoff.getTime() : null;
  return (review) => {
    if (ms === null || Number.isNaN(ms) || !review.date) return "accept";
    return new Date(review.date).getTime() < ms ? "stop" : "accept";
  };
}

/** Emit at most `max` reviews, then stop. `null`/`0`/`undefined` means unlimited. */
export function limit(max: number | null | undefined): Stage {
  if (!max) return () => "accept";
  let emitted = 0;
  return () => {
    if (emitted >= max) return "stop";
    emitted++;
    return "accept";
  };
}
