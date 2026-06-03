/** Consecutive all-duplicate pages tolerated before assuming the feed wrapped. */
const MAX_DRY_PAGES = 2;

export type PaginatorState = "fetch" | "done";

/** What happened while processing one fetched page — fed back to the machine. */
export interface PageOutcome<C> {
  /** Reviews actually emitted from this page. */
  added: number;
  /** Next cursor the store handed back, or `null` if it says there's no more. */
  next: C | null;
  /** A pipeline stage asked to stop (limit reached or `since` cutoff hit). */
  halted: boolean;
}

/**
 * A small state machine that drives pagination. It owns the cursor and the
 * single "should we fetch another page?" decision — the store ran out (`next`
 * is null), a stage said stop (`halted`), or the feed has gone dry (only
 * duplicates for `MAX_DRY_PAGES` in a row). Keeping this here makes the engine
 * loop a flat `while (state === "fetch")` instead of tangled boolean flags.
 */
export class Paginator<C> {
  state: PaginatorState = "fetch";
  cursor: C;
  private dryPages = 0;

  constructor(initial: C) {
    this.cursor = initial;
  }

  advance(outcome: PageOutcome<C>): void {
    if (outcome.halted) {
      this.state = "done";
      return;
    }
    this.dryPages = outcome.added === 0 ? this.dryPages + 1 : 0;
    if (outcome.next === null || this.dryPages >= MAX_DRY_PAGES) {
      this.state = "done";
      return;
    }
    this.cursor = outcome.next;
  }
}
