import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BACKFILLED_HOLDOUT,
  HoldoutBackfillError,
  parseHoldoutBackfill,
} from "../src/forecast/backfill.js";
import { gateAt } from "../src/forecast/gate.js";

/**
 * The backtest's rows: parsed, and unable to become records — replay ticket 01.
 *
 * This file holds the half that needs no database. The Postgres half — that a
 * `backfilled_holdout` row cannot leave `/v1/forecast/day-ahead` under any
 * query, and that a second backtest run appends a vintage rather than
 * overwriting one — is `database-holdout-forecast.test.ts`.
 *
 * The property under test is *structural*, and the distinction matters: the
 * point is not that this code declines to write a served row, it is that there
 * is no argument to it that produces one. Both sides of the seam are checked:
 * the Python that mints the payload names the discriminator as a constant, and
 * the parser here refuses a payload whose envelope and rows disagree.
 */

const VECTOR = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "forecast", "holdout-backfill.json"),
    "utf8",
  ),
) as Record<string, unknown>;

/** A deep copy, so a mutation in one test cannot reach another. */
const vector = (mutate?: (payload: Record<string, unknown>) => void) => {
  const copy = structuredClone(VECTOR);
  mutate?.(copy);
  return copy;
};

const publicationsOf = (payload: Record<string, unknown>): Record<string, unknown>[] =>
  payload.publications as Record<string, unknown>[];

const originOf = (payload: Record<string, unknown>): Record<string, unknown> =>
  publicationsOf(payload)[0]?.forecast_origin as Record<string, unknown>;

describe("the cross-language vector, from the backtest side", () => {
  /**
   * `test/fixtures/forecast/holdout-backfill.json` is a real payload, produced
   * by `wattsteer_ml.evaluation.holdout.fold_holdout_publications` on the
   * modelling side's own shared fit and trimmed to one held-out day.
   * `apps/ml/tests/test_holdout_forecasts.py` asserts the other direction —
   * that the payload the code emits still has exactly this file's keys.
   */
  it("is accepted by the gateway's backfill parser, whole", () => {
    const parsed = parseHoldoutBackfill(vector());
    expect(parsed.foldId).toBe("F1");
    expect(parsed.publications.length).toBe(1);
    const [publication] = parsed.publications;
    expect(publication?.originKind).toBe(BACKFILLED_HOLDOUT);
    expect(publication?.hours.length).toBe(96);
    expect(publication?.days.length).toBe(4);
    expect(publication?.artifactId).toBe(parsed.artifactId);
  });

  it("carries the counterfactual gate, and it is the gate function's own answer", () => {
    // `published_at` is `gate_at(target_date, gate_profile)` — computed on the
    // Python side by the *database*, and compared here against this gateway's
    // independent spelling of the same rule. The instant a forecast that was
    // never published would have been published at.
    const parsed = parseHoldoutBackfill(vector());
    const [publication] = parsed.publications;
    expect(publication).toBeDefined();
    if (publication === undefined) {
      return;
    }
    expect(publication.publishedAt.toISOString()).toBe(
      gateAt(publication.targetDate, publication.gateProfile).toISOString(),
    );
    // And it is still shaped like a forecast rather than an observation.
    for (const hour of publication.hours) {
      expect(publication.publishedAt.getTime()).toBeLessThan(hour.validTime.getTime());
    }
  });

  it("stamps the correction regime on the run and on every row", () => {
    // Forecaster ticket 21 is open on the upper tail. A holdout row records its
    // regime the same way a served one does, so rows written under two rules
    // are one `group by` apart rather than silently mixed.
    const parsed = parseHoldoutBackfill(vector());
    const regime = VECTOR.correction_regime;
    expect(typeof regime).toBe("string");
    for (const publication of parsed.publications) {
      expect(publication.correctionRegime).toBe(regime as string);
    }
  });
});

describe("a backfill cannot mint a record", () => {
  it("refuses an envelope claiming served", () => {
    expect(() =>
      parseHoldoutBackfill(
        vector((payload) => {
          payload.origin_kind = "served";
        }),
      ),
    ).toThrow(HoldoutBackfillError);
  });

  it("refuses a publication whose origin disagrees with the envelope", () => {
    // The envelope is what this writer refuses on; the per-publication field is
    // what reaches the row. A payload where they disagree would write rows the
    // envelope does not describe.
    expect(() =>
      parseHoldoutBackfill(
        vector((payload) => {
          originOf(payload).origin_kind = "served";
        }),
      ),
    ).toThrow(/mints no records/);
  });

  it("refuses a run whose rows name a different artifact", () => {
    expect(() =>
      parseHoldoutBackfill(
        vector((payload) => {
          originOf(payload).run_label = "2026-01-01T00:00:00Z";
        }),
      ),
    ).toThrow(/one fold's holdout is one artifact's/);
  });

  it("refuses a run with no publications rather than writing an absence", () => {
    expect(() =>
      parseHoldoutBackfill(
        vector((payload) => {
          payload.publications = [];
        }),
      ),
    ).toThrow(/never written as an empty forecast/);
  });

  it("refuses an origin kind that is not one", () => {
    expect(() =>
      parseHoldoutBackfill(
        vector((payload) => {
          payload.origin_kind = "fold_holdout";
        }),
      ),
    ).toThrow(HoldoutBackfillError);
  });
});

describe("unservability is a property of the code, not of a caller", () => {
  const SOURCE = (relative: string) =>
    readFileSync(join(import.meta.dir, "..", "src", relative), "utf8");

  it("gives the backfill writer no way to spell a served row", () => {
    const backfill = SOURCE("forecast/backfill.ts");
    // The constant is compared against, never assigned from an argument: there
    // is no parameter, option or default in this module that selects an origin
    // kind, so every row it writes carries the discriminator the day-ahead
    // filter is looking for.
    expect(backfill).not.toContain('originKind = "served"');
    expect(backfill).not.toContain("originKind:");
    expect(backfill).toContain(
      'BACKFILLED_HOLDOUT: ForecastOriginKind = "backfilled_holdout"',
    );
  });

  it("writes through the one append-only writer rather than inserting", () => {
    // No second insert path: `writePublication` owns the transaction, the
    // digest-based idempotency and the `data_version` walk, so a backfill gets
    // the vintage discipline rather than a copy of it.
    const backfill = SOURCE("forecast/backfill.ts");
    expect(backfill).not.toContain(".insert(");
    expect(backfill).not.toContain("curtailmentForecastHour");
    expect(backfill).not.toContain("curtailmentForecastDay");
    expect(backfill).toContain("writePublication(");
  });

  it("keeps the backfill out of the read path", () => {
    // The route reads; nothing that writes a reconstruction is reachable from
    // it. The complementary assertion — that `reads.ts` filters `served` in the
    // query — lives in `forecast-day-ahead.test.ts`.
    for (const module of ["api/forecast.ts", "forecast/reads.ts"]) {
      expect(SOURCE(module)).not.toContain("writeHoldoutBackfill");
      expect(SOURCE(module)).not.toContain("parseHoldoutBackfill");
    }
    // And the read still filters the discriminator in the SQL, at both grains
    // and on the meta listing — the complementary count lives next door.
    const reads = SOURCE("forecast/reads.ts");
    expect(
      (reads.match(/origin_kind = 'served'::forecast_origin_kind/g) ?? []).length,
    ).toBe(3);
    expect(reads).not.toContain("'backfilled_holdout'::forecast_origin_kind");
  });
});
