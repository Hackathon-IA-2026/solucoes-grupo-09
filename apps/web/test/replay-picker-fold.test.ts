/**
 * The picker folds, and the selected day is never folded away.
 *
 * Asking the gateway rather than naming four dates took this control from four
 * pills to eighty-one on the event's instance — seventeen rows above the
 * screen's own headline. The fold is what makes that list usable, and the one
 * property it must not break is that a link to an older day opens onto a picker
 * that visibly contains it.
 *
 * Source-level for the reason `answer-feedback.test.ts` gives: `test:web` does
 * not mount react-native-web screens, and what is at stake is a decision rather
 * than a rendering. The fold's arithmetic is asserted directly below.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/app/app/replay.tsx"), "utf8");

/** The fold, as the screen computes it. Kept in step by the guard below. */
function folded(
  offered: readonly string[],
  selected: string,
  showAll: boolean,
  size = 10,
): string[] {
  if (showAll) {
    return [...offered];
  }
  const head = offered.slice(0, size);
  return head.includes(selected) ? head : [selected, ...offered.slice(0, size - 1)];
}

const days = Array.from(
  { length: 81 },
  (_, i) => `2026-09-${String(19 - (i % 19)).padStart(2, "0")}-${i}`,
);

describe("the day picker's fold", () => {
  it("shows ten of eighty-one, and says how many are left", () => {
    const shown = folded(days, days[0], false);
    expect(shown).toHaveLength(10);
    expect(days.length - shown.length).toBe(71);
  });

  it("keeps the selected day visible when it is deep in the list", () => {
    // The property that matters: a shared link to the fortieth day must not
    // open onto a picker that appears not to contain it.
    const deep = days[40];
    const shown = folded(days, deep, false);
    expect(shown).toContain(deep);
    expect(shown[0]).toBe(deep);
    expect(shown).toHaveLength(10);
  });

  it("shows everything once the reader asks", () => {
    expect(folded(days, days[40], true)).toHaveLength(81);
  });

  it("is the arithmetic the screen runs", () => {
    // The guard against this file drifting from the component: both the size
    // and the selected-day branch are named in the source.
    expect(source).toContain("const FOLDED_DAYS = 10");
    expect(source).toContain("[day, ...offered.slice(0, FOLDED_DAYS - 1)]");
    expect(source).toContain("copy.app.replay.moreDays");
  });
});
