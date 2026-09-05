import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createGridRoutes } from "../src/api/grid.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { createDatabase } from "../src/database/connection.js";
import { parsePublication, writePublication } from "../src/forecast/publication.js";
import { readGridOutlook } from "../src/forecast/reads.js";

/**
 * `/v1/grid/outlook` against real Postgres — api-surface ticket 13's seam.
 *
 * Gated exactly like the other database suites: `WATTSTEER_TEST_DATABASE_URL`
 * supplies the URL and the default `bun test` skips this file.
 *
 * Four things can only be proved here:
 *
 * 1. **One request, four subsystems.** The hero's whole payload comes back from
 *    one call over rows four separate publications wrote.
 * 2. **The origin-kind filter applies here exactly as on the day-ahead route.**
 *    A `backfilled_holdout` republication is in the table and cannot leave this
 *    route, under this query or any other — there is no parameter that reaches
 *    the filter.
 * 3. **A partial publication is an absence.** Three subsystems is a refusal and
 *    never three bands beside a zeroed fourth.
 * 4. **The ETag is a provenance.** It is built from the artifact, the
 *    publication instant and the newest version behind the four rows, so a
 *    superseding run changes it by construction.
 *
 * Spin one up:
 *   docker run -d -p 5439:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** A day of this suite's own, so a parallel run cannot collide with another. */
const TARGET_DATE = "2024-05-14";
/** `gate_at('2024-05-14', 'gate_late')` — D−1 19:00 Brasília. */
const GATE_LATE = "2024-05-13T22:00:00.000Z";
const ARTIFACT = "2024-05-13T03:11:07Z";
const REGIME = "conformal_v1_partial_upper";

const SUBSYSTEMS = ["N", "NE", "SE", "S"] as const;
type Code = (typeof SUBSYSTEMS)[number];

/**
 * Per-subsystem figures, chosen so nothing about the national number could be
 * reconstructed by accident.
 *
 * `expected` is not any subsystem's `p50`, and the four `p50`s add to a
 * different total from the four expectations — so a national figure that had
 * been built from the medians would be a visibly different number rather than
 * the same one arrived at differently.
 */
const FIGURES: Record<Code, { p50: number; expected: number; occurrence: number }> = {
  N: { p50: 140.5, expected: 196.25, occurrence: 0.21 },
  NE: { p50: 2780.25, expected: 2960.5, occurrence: 0.89 },
  SE: { p50: 520.75, expected: 760.125, occurrence: 0.18 },
  S: { p50: 310.125, expected: 402.375, occurrence: 0.44 },
};

interface PayloadOptions {
  subsystem: Code;
  originKind?: "served" | "backfilled_holdout";
  scale?: number;
}

/** The local day starts at 03:00Z while Brazil observes no summer time. */
const hourInstant = (hour: number): string =>
  new Date(Date.UTC(2024, 4, 14, 3 + hour)).toISOString();

/**
 * One subsystem's lane-day, in the modelling service's own payload shape.
 *
 * One subsystem per publication because that is enough to build the four rows
 * the route reads, and because it makes the partial-publication case a matter
 * of writing three of them.
 */
function payload(options: PayloadOptions): Record<string, unknown> {
  const scale = options.scale ?? 1;
  const figures = FIGURES[options.subsystem];
  const hours = Array.from({ length: 24 }, (_value, hour) => ({
    subsystem: options.subsystem,
    valid_time: hourInstant(hour),
    target_date: TARGET_DATE,
    local_hour: hour,
    threshold_mw: 5,
    occurrence_probability: hour === 14 ? 0.72 : 0.08,
    p10_mwh: 0,
    p50_mwh: hour === 14 ? 40.25 * scale : 0,
    p90_mwh: hour === 14 ? 120.5 * scale : 10.125 * scale,
    expected_mwh: (hour === 14 ? 30.5 : 2.25) * scale,
    p50_wind_mwh: hour === 14 ? 32.2 * scale : 0,
    p50_solar_mwh: hour === 14 ? 8.05 * scale : 0,
    expected_wind_mwh: (hour === 14 ? 24.4 : 1.8) * scale,
    expected_solar_mwh: (hour === 14 ? 6.1 : 0.45) * scale,
    crossed: false,
    derivation: "hurdle_mixture",
    correction_regime: REGIME,
  }));
  const expected = figures.expected * scale;
  return {
    lane: "dessem_free_v1__gate_late__thr5",
    feature_set: "dessem_free_v1",
    threshold_mw: 5,
    target_date: TARGET_DATE,
    correction_regime: REGIME,
    forecast_origin: {
      producer: "wattsteer",
      run_label: ARTIFACT,
      published_at: GATE_LATE,
      origin_kind: options.originKind ?? "served",
      gate_profile: "gate_late",
    },
    artifact: {
      artifact_id: ARTIFACT,
      feature_set: "dessem_free_v1",
      trained_through: "2024-04-30",
    },
    risk_bins: { low: [0, 0.25], elevated: [0.25, 0.6], high: [0.6, 1] },
    hours,
    days: [
      {
        subsystem: options.subsystem,
        target_date: TARGET_DATE,
        threshold_mw: 5,
        day_total: {
          p10: 12.5 * scale,
          p50: figures.p50 * scale,
          p90: (figures.p50 + 1480) * scale,
        },
        peak_power: { p10: 4.5 * scale, p50: 96.25 * scale, p90: 180.75 * scale },
        day_occurrence_probability: figures.occurrence,
        expected_mwh: expected,
        // The split is of the expectation and adds back to it exactly.
        expected_wind_mwh: expected * 0.75,
        expected_solar_mwh: expected * 0.25,
        hours_p50_nonzero: 1,
        derivation: "path_ensemble",
        ensemble_draws: 500,
        ensemble_seed: 20_240_513,
        ensemble_calibration_days: 90,
        correction_regime: REGIME,
      },
    ],
  };
}

interface OutlookBody {
  target_date: string;
  threshold_mw: number;
  forecast_origin: Record<string, unknown>;
  risk_bins: Record<string, [number, number]>;
  subsystems: {
    subsystem: string;
    ons_display_name: string;
    risk_class: string;
    day_energy_mwh: { p10: number; p50: number; p90: number };
    peak_power_mw: { p10: number; p50: number; p90: number };
    day_expected_mwh: number;
    split: { wind_mwh: number; solar_mwh: number };
  }[];
  national: {
    expected_mwh: number;
    risk_class_counts: { low: number; elevated: number; high: number };
    band: null;
    band_unavailable_reason: string;
  };
}

suite("/v1/grid/outlook · four subsystems from Postgres (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  /** After the late gate for the target date, so the gate has passed. */
  const NOW = new Date("2024-05-13T23:00:00.000Z");

  const routes = new Elysia()
    .use(errorHandler)
    .use(createGridRoutes({ db, now: () => NOW }));

  const get = (query = "", headers: Record<string, string> = {}): Promise<Response> =>
    routes.handle(
      new Request(`http://localhost/v1/grid/outlook?target_date=${TARGET_DATE}${query}`, {
        headers,
      }),
    );

  const clear = async (): Promise<void> => {
    await db.execute(
      sql`delete from curtailment_forecast_hour where target_date = ${TARGET_DATE}::date`,
    );
    await db.execute(
      sql`delete from curtailment_forecast_day where target_date = ${TARGET_DATE}::date`,
    );
  };

  const publishAll = async (
    options: { originKind?: "served" | "backfilled_holdout"; scale?: number } = {},
  ): Promise<void> => {
    for (const subsystem of SUBSYSTEMS) {
      await writePublication(db, parsePublication(payload({ subsystem, ...options })), {
        ingestedAt: NOW,
      });
    }
  };

  beforeEach(clear);

  afterAll(async () => {
    await clear();
    await handle.close();
  });

  it("answers the whole hero from one request", async () => {
    await publishAll();
    const response = await get();
    expect(response.status).toBe(200);
    const outlook = (await response.json()) as OutlookBody;

    expect(outlook.target_date).toBe(TARGET_DATE);
    expect(outlook.threshold_mw).toBe(5);
    expect(outlook.subsystems.length).toBe(4);
    expect(outlook.subsystems.map((entry) => entry.subsystem)).toEqual([
      "N",
      "NE",
      "SE",
      "S",
    ]);
    expect(outlook.risk_bins).toEqual({
      low: [0, 0.25],
      elevated: [0.25, 0.6],
      high: [0.6, 1],
    });
    // ONS's own strings, from the published constant and never from a row.
    expect(outlook.subsystems.map((entry) => entry.ons_display_name)).toEqual([
      "NORTE",
      "NORDESTE",
      "SUDESTE/CENTRO-OESTE",
      "SUL",
    ]);
  });

  it("round-trips each subsystem's persisted band exactly", async () => {
    await publishAll();
    const outlook = (await (await get()).json()) as OutlookBody;
    for (const entry of outlook.subsystems) {
      const figures = FIGURES[entry.subsystem as Code];
      // `toBe` on doubles: "close enough" is the property a re-serve does not
      // have, and this route is a re-serve of what was published.
      expect(entry.day_energy_mwh.p50).toBe(figures.p50);
      expect(entry.day_expected_mwh).toBe(figures.expected);
      expect(entry.split.wind_mwh + entry.split.solar_mwh).toBeCloseTo(
        figures.expected,
        6,
      );
      // Read from the day row: the peak is the band of drawn maxima, identical
      // across subsystems here precisely because it is not derived from the
      // per-subsystem day totals.
      expect(entry.peak_power_mw.p50).toBe(96.25);
    }
  });

  it("publishes a national expectation that is not the sum of the medians", async () => {
    await publishAll();
    const outlook = (await (await get()).json()) as OutlookBody;

    const expectations = outlook.subsystems.reduce(
      (total, entry) => total + entry.day_expected_mwh,
      0,
    );
    const medians = outlook.subsystems.reduce(
      (total, entry) => total + entry.day_energy_mwh.p50,
      0,
    );

    expect(outlook.national.expected_mwh).toBeCloseTo(expectations, 6);
    expect(outlook.national.expected_mwh).not.toBeCloseTo(medians, 6);
    expect(outlook.national.band).toBeNull();
    expect(outlook.national.band_unavailable_reason).toBe("no_joint_ensemble");
    expect(outlook.national.risk_class_counts).toEqual({
      low: 2,
      elevated: 1,
      high: 1,
    });
  });

  it("carries the weather run label beside the artifact version", async () => {
    await publishAll();
    const outlook = (await (await get()).json()) as OutlookBody;
    expect(outlook.forecast_origin.run_label).toBe(ARTIFACT);
    expect(outlook.forecast_origin.weather_run_label).toBe("D−1 12Z");
    expect(outlook.forecast_origin.producer).toBe("wattsteer");
    expect(outlook.forecast_origin.origin_kind).toBe("served");
  });

  it("never returns a backfilled_holdout row, even as the newest vintage", async () => {
    await publishAll();
    await publishAll({ originKind: "backfilled_holdout", scale: 9 });
    const outlook = (await (await get()).json()) as OutlookBody;
    for (const entry of outlook.subsystems) {
      expect(entry.day_energy_mwh.p50).toBe(FIGURES[entry.subsystem as Code].p50);
    }
    // The reconstruction is in the table; it simply cannot leave this route.
    const stored = await db.execute<{ rows: number }>(sql`
      select count(*)::int as rows from curtailment_forecast_day
      where target_date = ${TARGET_DATE}::date
        and origin_kind = 'backfilled_holdout'::forecast_origin_kind
    `);
    expect([...stored][0]?.rows).toBe(4);
    // And no argument reaches the filter: the read takes three axes and none
    // of them is an origin kind.
    const read = await readGridOutlook(db, {
      targetDate: TARGET_DATE,
      gateProfile: "gate_late",
      asOf: new Date("2024-05-14T00:00:00.000Z"),
    });
    expect(read.subsystems.length).toBe(4);
    // These publications carry no national block — one subsystem each — so
    // there is nothing at the national grain either, and the absence is a
    // `null` rather than a band assembled from the four.
    expect(read.national).toBeNull();
  });

  it("refuses a partial publication rather than zeroing the fourth subsystem", async () => {
    for (const subsystem of ["N", "NE", "SE"] as Code[]) {
      await writePublication(db, parsePublication(payload({ subsystem })), {
        ingestedAt: NOW,
      });
    }
    const response = await get();
    expect(response.status).toBe(404);
    const answered = (await response.json()) as {
      error: { code: string; details: { missing: string } };
    };
    expect(answered.error.code).toBe("FORECAST_UNAVAILABLE");
    expect(answered.error.details.missing).toBe("S");
    expect(JSON.stringify(answered)).not.toContain("p10");
  });

  it("answers an unpublished day as an absence and never as an empty band", async () => {
    const response = await get();
    expect(response.status).toBe(404);
    const answered = (await response.json()) as { error: { code: string } };
    expect(answered.error.code).toBe("FORECAST_UNAVAILABLE");
  });

  it("keys the ETag on the provenance and answers 304 against it", async () => {
    await publishAll();
    const first = await get();
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toContain(ARTIFACT);
    expect(etag).toContain("2024-05-13T22:00:00.000Z");
    expect(first.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );

    const again = await get("", { "if-none-match": etag });
    expect(again.status).toBe(304);

    // A revision appends a vintage, and the validator moves with it.
    await publishAll({ scale: 2 });
    const revised = await get();
    expect(revised.headers.get("etag")).not.toBe(etag);
  });

  it("keeps the two gates apart", async () => {
    await publishAll();
    const early = await get("&gate_profile=gate_early");
    expect(early.status).toBe(404);
    // The late gate's rows are not the early gate's answer, and the early
    // gate's absence is an absence rather than the late gate's numbers.
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe(
      "FORECAST_UNAVAILABLE",
    );
  });
});
