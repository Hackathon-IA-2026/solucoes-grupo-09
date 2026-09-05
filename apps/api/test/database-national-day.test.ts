import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createGridRoutes } from "../src/api/grid.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { createDatabase } from "../src/database/connection.js";
import { parsePublication, writePublication } from "../src/forecast/publication.js";
import { readGridOutlook } from "../src/forecast/reads.js";

/**
 * The national day grain against real Postgres — forecaster ticket 22.
 *
 * `grid-outlook.test.ts` proves the shaping and `database-grid-outlook.test.ts`
 * proves the four subsystem rows. Five things can only be proved here:
 *
 * 1. **The national row is its own grain and `SIN` is nowhere in it.** The
 *    table has no `subsystem` column, and the `subsystem_code` enum it does use
 *    — for the coverage array — has no `SIN` member to put there.
 * 2. **It is append-only and reads through `AsOf`.** A revision writes a second
 *    `data_version`; a cut before it still returns the numbers that were
 *    served, to the bit.
 * 3. **It lands in the same transaction as the four subsystem rows.** A rolled
 *    back publication leaves neither, so a national band without its components
 *    is not a state the route can encounter.
 * 4. **The served band is strictly narrower than the componentwise sum**, which
 *    is the measurable consequence of a joint draw and the reason this grain
 *    exists at all.
 * 5. **The `null` branch is alive.** A day published without a national block —
 *    an artifact trained before the shared draw index landed — still answers
 *    with `band_unavailable_reason` rather than with a zero or a synthesised
 *    band.
 *
 * Spin one up:
 *   docker run -d -p 5439:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** A day of this suite's own, so a parallel run cannot collide with another. */
const TARGET_DATE = "2024-06-11";
/** `gate_at('2024-06-11', 'gate_late')` — D−1 19:00 Brasília. */
const GATE_LATE = "2024-06-10T22:00:00.000Z";
const ARTIFACT = "2024-06-10T03:11:07Z";
const REGIME = "conformal_v1_partial_upper";

const SUBSYSTEMS = ["N", "NE", "SE", "S"] as const;
type Code = (typeof SUBSYSTEMS)[number];

/**
 * The four subsystems' day bands, and the national one drawn jointly.
 *
 * The relations are the point: the joint band (2180 … 5120) sits **inside** the
 * componentwise sum (1720 … 7260), its median is not the sum of the four
 * medians (3750), and the national peak is a peak of the sum — below the sum of
 * the four peaks. Nothing here could be arrived at by adding the subsystem
 * figures, which is what makes a round trip through `AsOf` a real assertion.
 */
const FIGURES: Record<Code, { p10: number; p50: number; p90: number }> = {
  N: { p10: 0, p50: 140.5, p90: 610.25 },
  NE: { p10: 1720.75, p50: 2780.25, p90: 4260.5 },
  SE: { p10: 0, p50: 520.125, p90: 1410.375 },
  S: { p10: 0, p50: 310.625, p90: 980.875 },
};

const EXPECTED: Record<Code, number> = {
  N: 196.25,
  NE: 2960.5,
  SE: 760.125,
  S: 402.375,
};

const OCCURRENCE: Record<Code, number> = { N: 0.21, NE: 0.89, SE: 0.18, S: 0.44 };

const NATIONAL = {
  day_total: { p10: 2180.5, p50: 3410.25, p90: 5120.75 },
  peak_power: { p10: 140.125, p50: 246.5, p90: 410.875 },
  day_occurrence_probability: 0.93,
};

/** The local day starts at 03:00Z while Brazil observes no summer time. */
const hourInstant = (hour: number): string =>
  new Date(Date.UTC(2024, 5, 11, 3 + hour)).toISOString();

interface PayloadOptions {
  originKind?: "served" | "backfilled_holdout";
  scale?: number;
  /** Drop the national block, as an artifact with no shared draw index would. */
  withoutNational?: boolean;
}

/**
 * One lane-day covering all four subsystems, in the modelling service's shape.
 *
 * All four in one publication, unlike `database-grid-outlook.test.ts`: a
 * national figure is a derived sum over the four and a publication short of one
 * cannot carry it, so the whole grid is what makes the block legal.
 */
function payload(options: PayloadOptions = {}): Record<string, unknown> {
  const scale = options.scale ?? 1;
  const hours = SUBSYSTEMS.flatMap((subsystem) =>
    Array.from({ length: 24 }, (_value, hour) => ({
      subsystem,
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
    })),
  );
  const days = SUBSYSTEMS.map((subsystem) => ({
    subsystem,
    target_date: TARGET_DATE,
    threshold_mw: 5,
    day_total: {
      p10: FIGURES[subsystem].p10 * scale,
      p50: FIGURES[subsystem].p50 * scale,
      p90: FIGURES[subsystem].p90 * scale,
    },
    peak_power: { p10: 4.5 * scale, p50: 96.25 * scale, p90: 180.75 * scale },
    day_occurrence_probability: OCCURRENCE[subsystem],
    expected_mwh: EXPECTED[subsystem] * scale,
    expected_wind_mwh: EXPECTED[subsystem] * scale * 0.75,
    expected_solar_mwh: EXPECTED[subsystem] * scale * 0.25,
    hours_p50_nonzero: 1,
    derivation: "path_ensemble",
    ensemble_draws: 500,
    ensemble_seed: 20_240_610,
    ensemble_calibration_days: 90,
    correction_regime: REGIME,
  }));
  const national = options.withoutNational
    ? null
    : {
        target_date: TARGET_DATE,
        grain: "national",
        threshold_mw: 5,
        day_total: {
          p10: NATIONAL.day_total.p10 * scale,
          p50: NATIONAL.day_total.p50 * scale,
          p90: NATIONAL.day_total.p90 * scale,
        },
        peak_power: {
          p10: NATIONAL.peak_power.p10 * scale,
          p50: NATIONAL.peak_power.p50 * scale,
          p90: NATIONAL.peak_power.p90 * scale,
        },
        day_occurrence_probability: NATIONAL.day_occurrence_probability,
        expected_mwh:
          SUBSYSTEMS.reduce((total, code) => total + EXPECTED[code], 0) * scale,
        subsystems: [...SUBSYSTEMS],
        ensemble_draws: 500,
        ensemble_seed: 20_240_610,
        ensemble_calibration_days: 90,
        derivation: "joint_path_ensemble",
        correction_regime: REGIME,
      };
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
      trained_through: "2024-05-31",
    },
    risk_bins: { low: [0, 0.25], elevated: [0.25, 0.6], high: [0.6, 1] },
    hours,
    days,
    national,
  };
}

interface OutlookBody {
  subsystems: { subsystem: string; day_energy_mwh: { p10: number; p90: number } }[];
  national: {
    expected_mwh: number;
    band: { p10: number; p50: number; p90: number } | null;
    band_unavailable_reason: string | null;
  };
}

suite("the national day grain, persisted (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  /** After the late gate for the target date, so the gate has passed. */
  const NOW = new Date("2024-06-10T23:00:00.000Z");

  /**
   * The constraint a write tripped, or a failure saying it tripped none.
   *
   * Drizzle wraps the driver's error, so the constraint name is on the cause
   * rather than the message — and the *name* is what these assertions are
   * about: "the write failed" is satisfied by a typo.
   */
  const refusalOf = async (write: () => Promise<unknown>): Promise<string> => {
    try {
      await write();
    } catch (error) {
      return `${String(error)} ${String((error as { cause?: unknown }).cause ?? "")}`;
    }
    throw new Error("the write was expected to be refused and was not");
  };

  const routes = new Elysia()
    .use(errorHandler)
    .use(createGridRoutes({ db, now: () => NOW }));

  const get = (): Promise<Response> =>
    routes.handle(
      new Request(`http://localhost/v1/grid/outlook?target_date=${TARGET_DATE}`),
    );

  const clear = async (): Promise<void> => {
    for (const table of [
      "curtailment_forecast_hour",
      "curtailment_forecast_day",
      "curtailment_forecast_national_day",
    ]) {
      await db.execute(
        sql`delete from ${sql.identifier(table)} where target_date = ${TARGET_DATE}::date`,
      );
    }
  };

  const publish = async (
    options: PayloadOptions = {},
    ingestedAt: Date = NOW,
  ): Promise<void> => {
    await writePublication(db, parsePublication(payload(options)), { ingestedAt });
  };

  beforeEach(clear);

  afterAll(async () => {
    await clear();
    await handle.close();
  });

  it("serves the persisted national band and drops the stated reason", async () => {
    await publish();
    const outlook = (await (await get()).json()) as OutlookBody;
    expect(outlook.national.band).toEqual(NATIONAL.day_total);
    expect(outlook.national.band_unavailable_reason).toBeNull();
  });

  it("serves a band strictly narrower than the componentwise sum", async () => {
    await publish();
    const outlook = (await (await get()).json()) as OutlookBody;
    const summed = outlook.subsystems.reduce(
      (band, entry) => ({
        p10: band.p10 + entry.day_energy_mwh.p10,
        p90: band.p90 + entry.day_energy_mwh.p90,
      }),
      { p10: 0, p90: 0 },
    );
    const band = outlook.national.band;
    if (band === null) {
      throw new Error("the national band is the subject of this test");
    }
    // The summed band is the day on which all four subsystems simultaneously
    // landed at their own ninetieth percentile — far rarer than one in ten, so
    // it is not a 10–90 interval of anything. The joint band is.
    expect(band.p10).toBeGreaterThan(summed.p10);
    expect(band.p90).toBeLessThan(summed.p90);
    expect(band.p90 - band.p10).toBeLessThan(summed.p90 - summed.p10);
  });

  it("keeps the null branch for a publication with no national block", async () => {
    await publish({ withoutNational: true });
    const outlook = (await (await get()).json()) as OutlookBody;
    expect(outlook.national.band).toBeNull();
    expect(outlook.national.band_unavailable_reason).toBe("no_joint_ensemble");
    // And the four subsystem bands are still served: the absence is the
    // national figure's, not the day's.
    expect(outlook.subsystems.length).toBe(4);
  });

  it("has no SIN and no subsystem column anywhere in the grain", async () => {
    await publish();
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name = 'curtailment_forecast_national_day'
    `);
    const names = [...columns].map((row) => row.column_name);
    expect(names).not.toContain("subsystem");
    expect(names).toContain("subsystems");
    // `SIN` is not a member of the enum the coverage array is typed on, so it
    // is not merely absent from the rows — it is unwritable.
    const labels = await db.execute<{ enumlabel: string }>(sql`
      select enumlabel from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      where t.typname = 'subsystem_code'
    `);
    expect([...labels].map((row) => row.enumlabel).sort()).toEqual([
      "N",
      "NE",
      "S",
      "SE",
    ]);
  });

  it("is append-only and returns what was served at the earlier cut", async () => {
    const first = new Date("2024-06-10T22:30:00.000Z");
    const second = new Date("2024-06-10T22:45:00.000Z");
    await publish({}, first);
    await publish({ scale: 2 }, second);

    const versions = await db.execute<{ data_version: number; day_total: number }>(sql`
      select data_version, day_total_p50_mwh as day_total
      from curtailment_forecast_national_day
      where target_date = ${TARGET_DATE}::date
      order by data_version
    `);
    expect([...versions].map((row) => Number(row.data_version))).toEqual([1, 2]);

    // The earlier vintage, at its own instant, to the bit. `toBe` on doubles:
    // "close enough" is exactly the property a re-serve does not have.
    const before = await readGridOutlook(db, {
      targetDate: TARGET_DATE,
      gateProfile: "gate_late",
      asOf: first,
    });
    expect(before.national?.dayTotalMwh.p50).toBe(NATIONAL.day_total.p50);
    expect(before.national?.peakPowerMw.p90).toBe(NATIONAL.peak_power.p90);
    expect(before.national?.dayOccurrenceProbability).toBe(
      NATIONAL.day_occurrence_probability,
    );
    expect(before.national?.dataVersion).toBe(1);
    expect(before.national?.derivation).toBe("joint_path_ensemble");
    expect(before.national?.subsystems.sort()).toEqual(["N", "NE", "S", "SE"]);

    const after = await readGridOutlook(db, {
      targetDate: TARGET_DATE,
      gateProfile: "gate_late",
      asOf: second,
    });
    expect(after.national?.dayTotalMwh.p50).toBe(NATIONAL.day_total.p50 * 2);
    expect(after.national?.dataVersion).toBe(2);
  });

  it("writes nothing at all for an identical republication", async () => {
    await publish();
    await publish();
    const rows = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from curtailment_forecast_national_day
      where target_date = ${TARGET_DATE}::date
    `);
    expect([...rows][0]?.count).toBe(1);
  });

  it("never lets a backfilled_holdout national row out of the route", async () => {
    await publish();
    await publish({ originKind: "backfilled_holdout", scale: 9 });
    const outlook = (await (await get()).json()) as OutlookBody;
    expect(outlook.national.band).toEqual(NATIONAL.day_total);
    // The reconstruction is in the table; it simply cannot leave this route.
    const stored = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from curtailment_forecast_national_day
      where target_date = ${TARGET_DATE}::date
        and origin_kind = 'backfilled_holdout'::forecast_origin_kind
    `);
    expect([...stored][0]?.count).toBe(1);
  });

  it("refuses a national row that claims the per-subsystem derivation", async () => {
    // A property of the database, not a habit of the one writer that exists
    // today: `path_ensemble` names a draw over one subsystem's whole days, and
    // a national figure standing on one is a sum of quantiles under a
    // legitimate derivation's name.
    const refusal = await refusalOf(() =>
      db.execute(sql`
      insert into curtailment_forecast_national_day (
        target_date, origin_kind, gate_profile, threshold_mw, forecast_producer,
        run_label, feature_set, correction_regime, subsystems,
        day_total_p10_mwh, day_total_p50_mwh, day_total_p90_mwh,
        peak_power_p10_mw, peak_power_p50_mw, peak_power_p90_mw,
        day_occurrence_probability, expected_mwh, derivation,
        ensemble_draws, ensemble_seed, ensemble_calibration_days,
        trained_through, risk_bin_elevated_from, risk_bin_high_from,
        data_version, published_at, ingested_at, value_digest
      ) values (
        ${TARGET_DATE}::date, 'served', 'gate_late', 5, 'wattsteer',
        ${ARTIFACT}, 'dessem_free_v1', ${REGIME},
        array['N','NE','SE','S']::subsystem_code[],
        1, 2, 3, 1, 2, 3, 0.5, 10, 'path_ensemble',
        500, 1, 90, '2024-05-31'::date, 0.25, 0.6,
        1, ${GATE_LATE}::timestamptz, ${NOW.toISOString()}::timestamptz, 'x'
      )
    `),
    );
    expect(refusal).toContain("from_the_joint_ensemble");
  });

  it("lands with the four subsystem rows or with neither", async () => {
    // The transaction is the unit. `ensemble_draws: 0` passes the parser — a
    // number is a number — and is refused by the table, so the write fails
    // after the hour and day inserts were queued. Neither set survives, and the
    // route never meets four bands whose national companion silently did not
    // land.
    const broken = payload();
    Object.assign(broken.national as Record<string, unknown>, { ensemble_draws: 0 });
    const refusal = await refusalOf(() =>
      writePublication(db, parsePublication(broken), { ingestedAt: NOW }),
    );
    expect(refusal).toContain("drew_something");

    for (const table of [
      "curtailment_forecast_day",
      "curtailment_forecast_hour",
      "curtailment_forecast_national_day",
    ]) {
      const rows = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from ${sql.identifier(table)}
            where target_date = ${TARGET_DATE}::date`,
      );
      expect([...rows][0]?.count).toBe(0);
    }
  });
});
