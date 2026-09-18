import { describe, expect, it } from "bun:test";
import type { MetricsRow } from "@wattsteer/core/api";
import { ladderDelta } from "../src/components/app/figures/use-ladder";

/**
 * The gain over the baseline, and the ways it could be flattered.
 *
 * `metrics.py` states the rule this file exists to hold: *"two rungs scored on
 * different rows are not a delta"*. The rows carry `fold_id` and
 * `vintage_fidelity` as group keys for that reason, and a pairing that crossed
 * either would produce a number that looks like measured added value and is
 * not.
 */

function row(over: Partial<MetricsRow> & { rungNumber: number }): MetricsRow {
  return {
    run: "weekly",
    rung: over.rungNumber === 4 ? "lightgbm" : "same_hour_7d",
    foldId: "fold-a",
    vintageFidelity: "point_in_time",
    rows: 1000,
    prevalence: 0.2,
    prAuc: 0.5,
    brier: 0.1,
    ece: 0.02,
    mce: 0.05,
    topBinGap: 0.01,
    maePositivesMwh: 42,
    pinball10: 1,
    pinball50: 2,
    pinball90: 3,
    ...over,
  } as MetricsRow;
}

describe("the ladder's delta is measured inside one group or not at all", () => {
  it("pairs the served rung with the mandatory baseline", () => {
    const delta = ladderDelta([
      row({ rungNumber: 1, prAuc: 0.41 }),
      row({ rungNumber: 4, prAuc: 0.67 }),
    ]);
    expect(delta?.baseline).toBe(0.41);
    expect(delta?.model).toBe(0.67);
    expect(delta?.delta).toBeCloseTo(0.26, 10);
    expect(delta?.rows).toBe(1000);
  });

  it("never pairs across folds", () => {
    // The flattering pairing: a strong model fold against a weak baseline fold.
    // Neither group is complete, so there is no delta at all.
    expect(
      ladderDelta([
        row({ rungNumber: 1, foldId: "fold-a", prAuc: 0.2 }),
        row({ rungNumber: 4, foldId: "fold-b", prAuc: 0.9 }),
      ]),
    ).toBeNull();
  });

  it("never pairs across vintage fidelity", () => {
    expect(
      ladderDelta([
        row({ rungNumber: 1, vintageFidelity: "point_in_time", prAuc: 0.2 }),
        row({ rungNumber: 4, vintageFidelity: "revision_optimistic", prAuc: 0.9 }),
      ]),
    ).toBeNull();
  });

  it("never pairs across runs", () => {
    expect(
      ladderDelta([
        row({ rungNumber: 1, run: "weekly", prAuc: 0.2 }),
        row({ rungNumber: 4, run: "ad-hoc", prAuc: 0.9 }),
      ]),
    ).toBeNull();
  });

  it("ignores the rungs that are not the claim", () => {
    // Prevalence and the linear rung are on the ladder to give PR-AUC a floor
    // and a shape. Neither is the baseline the claim is against.
    const delta = ladderDelta([
      row({ rungNumber: 0, prAuc: 0.05 }),
      row({ rungNumber: 1, prAuc: 0.4 }),
      row({ rungNumber: 2, prAuc: 0.5 }),
      row({ rungNumber: 4, prAuc: 0.6 }),
    ]);
    expect(delta?.baseline).toBe(0.4);
  });

  it("reports a negative delta rather than clamping it", () => {
    // A model that lost to the baseline on a fold is the single most important
    // thing this panel could say, and a `Math.max(0, …)` would delete it.
    const delta = ladderDelta([
      row({ rungNumber: 1, prAuc: 0.7 }),
      row({ rungNumber: 4, prAuc: 0.6 }),
    ]);
    expect(delta?.delta).toBeCloseTo(-0.1, 10);
  });

  it("picks the best-evidenced fold, not the first one sent", () => {
    // The gateway's row order is not a ranking. Weighting by rows makes the
    // figure on screen stable across reads.
    const delta = ladderDelta([
      row({ rungNumber: 1, foldId: "thin", rows: 10, prAuc: 0.1 }),
      row({ rungNumber: 4, foldId: "thin", rows: 10, prAuc: 0.9 }),
      row({ rungNumber: 1, foldId: "thick", rows: 5000, prAuc: 0.4 }),
      row({ rungNumber: 4, foldId: "thick", rows: 5000, prAuc: 0.6 }),
    ]);
    expect(delta?.foldId).toBe("thick");
    expect(delta?.rows).toBe(5000);
  });

  it("a table with no served rung is an absence, not a zero", () => {
    expect(ladderDelta([row({ rungNumber: 1 })])).toBeNull();
    expect(ladderDelta([])).toBeNull();
  });

  it("carries a withheld error through as null", () => {
    const delta = ladderDelta([
      row({ rungNumber: 1 }),
      row({ rungNumber: 4, maePositivesMwh: null }),
    ]);
    expect(delta?.maeMwh).toBeNull();
  });
});
