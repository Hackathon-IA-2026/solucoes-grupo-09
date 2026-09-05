import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createForecastRoutes, toForecastDayAhead } from "../src/api/forecast.js";
import { createMetaRoutes } from "../src/api/meta.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { createDatabase } from "../src/database/connection.js";
import {
  type ForecastPublication,
  parsePublication,
  writePublication,
} from "../src/forecast/publication.js";
import { PUBLISH_PATH, publishForecast } from "../src/forecast/publish.js";
import { readForecastDayAhead, readLatestPublished } from "../src/forecast/reads.js";

/**
 * The published forecast against real Postgres — forecaster ticket 14's seam.
 *
 * Gated exactly like the other database suites: `WATTSTEER_TEST_DATABASE_URL`
 * supplies the URL and the default `bun test` skips this file.
 *
 * Four things can only be proved here, and each of them is an acceptance line
 * rather than an implementation detail:
 *
 * 1. **The round trip.** The rows a publication wrote come back through
 *    `AsOf` as *exactly* the numbers that were served — asserted with `toBe`
 *    on doubles, because "close enough" is the property a re-serve does not
 *    have.
 * 2. **The day grain is stored, not recomputed.** The day band that comes back
 *    is the one that was written, and it is deliberately *not* any
 *    componentwise reduction of the hours it sits beside.
 * 3. **The append-only vintage.** An identical republication writes nothing; a
 *    changed one appends a version; and an `as_of` before the second one still
 *    returns the first, which is what makes a replay reconstructible.
 * 4. **The constraints.** `published_at < valid_time`, the monotone band and
 *    the `path_ensemble` derivation are guarantees of the database rather than
 *    habits of the one writer that exists today, and the only way to show that
 *    is to try to violate them.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** A day far from any other suite's fixtures, so a repeated run cannot collide. */
const TARGET_DATE = "2024-04-05";
/** `gate_at('2024-04-05', 'gate_late')` — D−1 19:00 Brasília. */
const GATE_LATE = "2024-04-04T22:00:00.000Z";
const GATE_EARLY = "2024-04-04T12:00:00.000Z";
const ARTIFACT = "2024-04-04T03:11:07Z";
const REGIME = "conformal_v1_partial_upper";

/** The rows of a payload array, so a mutation reads without a non-null assertion. */
const rowsOf = (value: unknown): Record<string, unknown>[] =>
  value as Record<string, unknown>[];

/** The local day starts at 03:00Z while Brazil observes no summer time. */
const hourInstant = (hour: number): string =>
  new Date(Date.UTC(2024, 3, 5, 3 + hour)).toISOString();

interface PayloadOptions {
  gateProfile?: "gate_early" | "gate_late";
  originKind?: "served" | "backfilled_holdout";
  publishedAt?: string;
  artifactId?: string;
  correctionRegime?: string;
  /** Scales every magnitude, so a "revision" is one argument. */
  scale?: number;
  /** Mutate the finished payload — for the constraint tests. */
  mutate?: (payload: Record<string, unknown>) => void;
}

/**
 * One lane-day, in the modelling service's own payload shape.
 *
 * The day figures are chosen so that no componentwise reduction of the hours
 * produces them: the day P90 is far below the summed hourly P90 and the day P50
 * is far above the summed hourly P50. A read that reached for the hours would
 * have to return different numbers, which is what makes the assertion a
 * measurement rather than a restatement of intent.
 */
function payload(options: PayloadOptions = {}): Record<string, unknown> {
  const scale = options.scale ?? 1;
  const hours = Array.from({ length: 24 }, (_value, hour) => ({
    subsystem: "NE",
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
    correction_regime: options.correctionRegime ?? REGIME,
  }));
  const expected = hours.reduce((total, hour) => total + hour.expected_mwh, 0);
  const built: Record<string, unknown> = {
    lane: "dessem_free_v1__gate_late__thr5",
    feature_set: "dessem_free_v1",
    threshold_mw: 5,
    target_date: TARGET_DATE,
    correction_regime: options.correctionRegime ?? REGIME,
    forecast_origin: {
      producer: "wattsteer",
      run_label: options.artifactId ?? ARTIFACT,
      published_at:
        options.publishedAt ??
        (options.gateProfile === "gate_early" ? GATE_EARLY : GATE_LATE),
      origin_kind: options.originKind ?? "served",
      gate_profile: options.gateProfile ?? "gate_late",
    },
    artifact: {
      artifact_id: options.artifactId ?? ARTIFACT,
      feature_set: "dessem_free_v1",
      trained_through: "2024-03-31",
    },
    risk_bins: { low: [0, 0.25], elevated: [0.25, 0.6], high: [0.6, 1] },
    hours,
    days: [
      {
        subsystem: "NE",
        target_date: TARGET_DATE,
        threshold_mw: 5,
        day_total: { p10: 12.5 * scale, p50: 260.75 * scale, p90: 300.125 * scale },
        peak_power: { p10: 4.5 * scale, p50: 96.25 * scale, p90: 180.75 * scale },
        day_occurrence_probability: 0.89,
        expected_mwh: expected,
        expected_wind_mwh: hours.reduce(
          (total, hour) => total + hour.expected_wind_mwh,
          0,
        ),
        expected_solar_mwh: hours.reduce(
          (total, hour) => total + hour.expected_solar_mwh,
          0,
        ),
        hours_p50_nonzero: 1,
        derivation: "path_ensemble",
        ensemble_draws: 500,
        ensemble_seed: 20_260_828,
        ensemble_calibration_days: 90,
        correction_regime: options.correctionRegime ?? REGIME,
      },
    ],
  };
  options.mutate?.(built);
  return built;
}

const publication = (options: PayloadOptions = {}): ForecastPublication =>
  parsePublication(payload(options));

suite("the published forecast · persistence and AsOf (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const NOW = new Date("2024-04-04T23:00:00.000Z");

  beforeAll(async () => {
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
  });

  afterAll(async () => {
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
    await handle.close();
  });

  const read = (
    options: { gateProfile?: "gate_early" | "gate_late"; asOf?: Date } = {},
  ) =>
    readForecastDayAhead(db, {
      subsystem: "NE",
      targetDate: TARGET_DATE,
      gateProfile: options.gateProfile ?? "gate_late",
      asOf: options.asOf ?? NOW,
    });

  it("round-trips every served number exactly", async () => {
    const published = publication();
    const written = await writePublication(db, published, { ingestedAt: NOW });
    expect(written.hoursInserted).toBe(24);
    expect(written.daysInserted).toBe(1);

    const back = await read();
    expect(back).not.toBeNull();
    if (back === null) {
      return;
    }

    // Exact, not close: a served row that comes back rounded is a different
    // forecast wearing the same origin.
    for (const [index, hour] of published.hours.entries()) {
      const stored = back.hours[index];
      expect(stored?.validTime.toISOString()).toBe(hour.validTime.toISOString());
      expect(stored?.localHour).toBe(hour.localHour);
      expect(stored?.band.p10).toBe(hour.p10Mwh);
      expect(stored?.band.p50).toBe(hour.p50Mwh);
      expect(stored?.band.p90).toBe(hour.p90Mwh);
      expect(stored?.expectedMwh).toBe(hour.expectedMwh);
      expect(stored?.occurrenceProbability).toBe(hour.occurrenceProbability);
      expect(stored?.split.windMwh).toBe(hour.expectedWindMwh);
      expect(stored?.split.solarMwh).toBe(hour.expectedSolarMwh);
      expect(stored?.p50Split.windMwh).toBe(hour.p50WindMwh);
    }
    const day = published.days[0];
    expect(back.day.dayTotalMwh.p10).toBe(day?.dayTotal.p10 as number);
    expect(back.day.dayTotalMwh.p50).toBe(day?.dayTotal.p50 as number);
    expect(back.day.dayTotalMwh.p90).toBe(day?.dayTotal.p90 as number);
    expect(back.day.peakPowerMw.p50).toBe(day?.peakPower.p50 as number);
    expect(back.day.dayOccurrenceProbability).toBe(
      day?.dayOccurrenceProbability as number,
    );
    expect(back.day.dayExpectedMwh).toBe(day?.expectedMwh as number);
    expect(back.day.hoursP50Nonzero).toBe(1);
    expect(back.day.artifactId).toBe(ARTIFACT);
    expect(back.day.publishedAt.toISOString()).toBe(GATE_LATE);
    expect(back.day.trainedThrough).toBe("2024-03-31");
    expect(back.vintageFidelity).toBe("point_in_time");
  });

  it("stamps the correction regime on every row, at both grains", async () => {
    await writePublication(db, publication(), { ingestedAt: NOW });
    const back = await read();
    expect(back?.day.correctionRegime).toBe(REGIME);

    const regimes = await db.execute<{ correction_regime: string; rows: number }>(sql`
      select correction_regime, count(*)::int as rows
      from curtailment_forecast_hour
      group by correction_regime
    `);
    expect([...regimes]).toEqual([{ correction_regime: REGIME, rows: 24 }]);
  });

  it("tells a row from one regime apart from a row from another", async () => {
    // What forecaster ticket 21 makes necessary: the same lane, the same day,
    // the same gate, a *different* correction rule. The two are one query
    // apart, which is the difference between a re-servable row and a
    // misleading one.
    await writePublication(db, publication(), { ingestedAt: NOW });
    await writePublication(
      db,
      publication({
        scale: 1.4,
        artifactId: "2024-04-04T09:00:00Z",
        correctionRegime: "conformal_v2_full_upper",
      }),
      { ingestedAt: new Date("2024-04-04T23:30:00.000Z") },
    );

    const byRegime = await db.execute<{ correction_regime: string; versions: string }>(
      sql`
        select correction_regime, string_agg(distinct data_version::text, ',') as versions
        from curtailment_forecast_day
        group by correction_regime
        order by correction_regime
      `,
    );
    expect([...byRegime]).toEqual([
      { correction_regime: REGIME, versions: "1" },
      { correction_regime: "conformal_v2_full_upper", versions: "2" },
    ]);

    // The newer regime is what a reader at "now" gets, and it says so.
    const back = await read({ asOf: new Date("2024-04-05T00:00:00.000Z") });
    expect(back?.day.correctionRegime).toBe("conformal_v2_full_upper");
    // The older one is still there, at its own as-of, unchanged.
    const earlier = await read({ asOf: NOW });
    expect(earlier?.day.correctionRegime).toBe(REGIME);
    expect(earlier?.day.dayTotalMwh.p50).toBe(260.75);
  });

  it("reads the day figures from the day row and not from the hours", async () => {
    await writePublication(db, publication(), { ingestedAt: NOW });
    const back = await read();
    if (back === null) {
      throw new Error("the publication was not readable");
    }
    const summed = back.hours.reduce(
      (total, hour) => ({
        p10: total.p10 + hour.band.p10,
        p50: total.p50 + hour.band.p50,
        p90: total.p90 + hour.band.p90,
      }),
      { p10: 0, p50: 0, p90: 0 },
    );
    expect(back.day.dayTotalMwh.p50).toBe(260.75);
    expect(back.day.dayTotalMwh.p50).not.toBe(summed.p50);
    expect(back.day.dayTotalMwh.p90).not.toBe(summed.p90);
    expect(back.day.derivation).toBe("path_ensemble");

    // And the shaped response carries the stored figures through untouched.
    const shaped = toForecastDayAhead(back, NOW);
    expect(shaped.dayEnergyMwh.p50).toBe(260.75);
    expect(shaped.peakPowerMw.p90).toBe(180.75);
  });

  it("writes nothing on an identical republication", async () => {
    await writePublication(db, publication(), { ingestedAt: NOW });
    const again = await writePublication(db, publication(), {
      ingestedAt: new Date("2024-04-04T23:30:00.000Z"),
    });
    expect(again.hoursUnchanged).toBe(24);
    expect(again.daysUnchanged).toBe(1);
    expect(again.hoursInserted + again.hoursRevised).toBe(0);

    const versions = await db.execute<{ max: number }>(
      sql`select max(data_version)::int as max from curtailment_forecast_hour`,
    );
    expect([...versions][0]?.max).toBe(1);
  });

  it("appends a vintage on a revision and keeps the earlier one readable", async () => {
    await writePublication(db, publication(), { ingestedAt: NOW });
    const later = new Date("2024-04-04T23:45:00.000Z");
    const revised = await writePublication(db, publication({ scale: 2 }), {
      ingestedAt: later,
    });
    // Every hour changed: the scale moves the quiet hours' P90 as well as the
    // curtailed hour's whole band.
    expect(revised.hoursRevised).toBe(24);
    expect(revised.daysRevised).toBe(1);

    const now = await read({ asOf: new Date("2024-04-05T00:00:00.000Z") });
    expect(now?.day.dayTotalMwh.p50).toBe(521.5);
    // The as-of *before* the revision still returns what was said then. This is
    // the whole of "what did we say at D−1" being a query.
    const earlier = await read({ asOf: NOW });
    expect(earlier?.day.dayTotalMwh.p50).toBe(260.75);
    expect(earlier?.hours[14]?.band.p50).toBe(40.25);
  });

  it("never returns a backfilled_holdout row, even as the newest vintage", async () => {
    await writePublication(db, publication(), { ingestedAt: NOW });
    await writePublication(
      db,
      publication({ originKind: "backfilled_holdout", scale: 9 }),
      { ingestedAt: new Date("2024-04-04T23:59:00.000Z") },
    );
    const back = await read({ asOf: new Date("2024-04-05T00:00:00.000Z") });
    expect(back?.day.dayTotalMwh.p50).toBe(260.75);
    for (const hour of back?.hours ?? []) {
      expect(hour.band.p90).toBeLessThan(200);
    }
    // The reconstruction is in the table; it simply cannot leave this route.
    const stored = await db.execute<{ origin_kind: string; rows: number }>(sql`
      select origin_kind, count(*)::int as rows
      from curtailment_forecast_day group by origin_kind order by origin_kind
    `);
    // Ordered by the enum's own ordinal, which is declaration order.
    expect([...stored]).toEqual([
      { origin_kind: "served", rows: 1 },
      { origin_kind: "backfilled_holdout", rows: 1 },
    ]);
  });

  it("keeps the two gates apart rather than letting the late one supersede", async () => {
    await writePublication(db, publication({ gateProfile: "gate_early", scale: 3 }), {
      ingestedAt: new Date("2024-04-04T13:00:00.000Z"),
    });
    await writePublication(db, publication(), { ingestedAt: NOW });

    const late = await read();
    const early = await read({ gateProfile: "gate_early" });
    expect(late?.day.dayTotalMwh.p50).toBe(260.75);
    expect(early?.day.dayTotalMwh.p50).toBe(782.25);
    expect(early?.day.publishedAt.toISOString()).toBe(GATE_EARLY);
  });

  it("replays the vintage that was current at the pinned instant", async () => {
    // Forecaster 19: the evening view supersedes the morning one as a newer
    // vintage of the same valid hours, and a replay pinned between the two
    // publications must see the morning one — the only one that existed then.
    // The `asOf` axis is on `ingested_at`, so this is the bitemporal read doing
    // its job rather than a rule anybody wrote for two lanes.
    await writePublication(db, publication({ gateProfile: "gate_early", scale: 3 }), {
      ingestedAt: new Date("2024-04-04T12:10:00.000Z"),
    });
    await writePublication(db, publication(), {
      ingestedAt: new Date("2024-04-04T22:10:00.000Z"),
    });

    const midday = new Date("2024-04-04T15:00:00.000Z");
    expect(await read({ gateProfile: "gate_late", asOf: midday })).toBeNull();
    const thenEarly = await read({ gateProfile: "gate_early", asOf: midday });
    expect(thenEarly?.day.publishedAt.toISOString()).toBe(GATE_EARLY);
    expect(thenEarly?.day.dayTotalMwh.p50).toBe(782.25);

    // And afterwards both are still readable: superseding appended a row, it
    // did not overwrite one.
    expect((await read({ gateProfile: "gate_early" }))?.day.dayTotalMwh.p50).toBe(782.25);
    expect((await read())?.day.dayTotalMwh.p50).toBe(260.75);
  });

  it("lists the publication on the meta reader, with its subsystems", async () => {
    await writePublication(db, publication(), { ingestedAt: NOW });
    const published = await readLatestPublished(db, { asOf: NOW });
    expect(published).toEqual([
      {
        targetDate: TARGET_DATE,
        gateProfile: "gate_late",
        publishedAt: new Date(GATE_LATE),
        subsystems: ["NE"],
      },
    ]);
  });

  it("shows the publication on /v1/meta, with its age and its subsystems", async () => {
    await writePublication(db, publication(), { ingestedAt: NOW });
    const meta = createMetaRoutes({
      db,
      // No modelling service: the endpoint degrades, and the publication state
      // is the gateway's own knowledge rather than a proxied field.
      ml: { baseUrl: undefined, timeoutMs: 100 },
      now: () => new Date("2024-04-05T04:00:00.000Z"),
      environment: "test",
    });
    const response = await meta.handle(new Request("http://localhost/v1/meta"));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      model: { reachable: boolean };
      forecast: {
        latest_published: {
          target_date: string;
          gate_profile: string;
          published_at: string;
          age_hours: number;
          subsystems: string[];
        }[];
        next_publication_at: string;
      };
    };
    expect(parsed.model.reachable).toBe(false);
    expect(parsed.forecast.latest_published).toEqual([
      {
        target_date: TARGET_DATE,
        gate_profile: "gate_late",
        published_at: GATE_LATE,
        // The publication instant is the gate, so the age is measured from it
        // and not from when the job happened to run.
        age_hours: 6,
        subsystems: ["NE"],
      },
    ]);
    expect(parsed.forecast.next_publication_at).toBeTruthy();
  });

  it("answers an unpublished day as an absence and never as an empty band", async () => {
    const back = await readForecastDayAhead(db, {
      subsystem: "S",
      targetDate: TARGET_DATE,
      gateProfile: "gate_late",
      asOf: NOW,
    });
    expect(back).toBeNull();
  });

  it("round-trips the real modelling-service payload, all four subsystems", async () => {
    // The cross-language vector, end to end: what Python emitted, parsed by the
    // gateway, written to Postgres, and read back through `AsOf`. Every number
    // on the way out is the number that went in — which is what "the rows
    // round-trip returning exactly the numbers served" means.
    const vector = parsePublication(
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "fixtures", "forecast", "publication.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const written = await writePublication(db, vector, {
      ingestedAt: new Date("2025-04-07T22:10:00.000Z"),
    });
    expect(written.hoursInserted).toBe(96);
    expect(written.daysInserted).toBe(4);

    const asOf = new Date("2025-04-07T23:00:00.000Z");
    for (const day of vector.days) {
      const back = await readForecastDayAhead(db, {
        subsystem: day.subsystem,
        targetDate: vector.targetDate,
        gateProfile: vector.gateProfile,
        asOf,
      });
      expect(back?.hours.length).toBe(24);
      expect(back?.day.dayTotalMwh.p90).toBe(day.dayTotal.p90);
      expect(back?.day.peakPowerMw.p90).toBe(day.peakPower.p90);
      expect(back?.day.dayOccurrenceProbability).toBe(day.dayOccurrenceProbability);
      expect(back?.day.dayExpectedMwh).toBe(day.expectedMwh);
      expect(back?.day.correctionRegime).toBe(vector.correctionRegime);

      const hours = vector.hours.filter((hour) => hour.subsystem === day.subsystem);
      for (const [index, hour] of hours.entries()) {
        expect(back?.hours[index]?.band.p90).toBe(hour.p90Mwh);
        expect(back?.hours[index]?.expectedMwh).toBe(hour.expectedMwh);
        expect(back?.hours[index]?.occurrenceProbability).toBe(
          hour.occurrenceProbability,
        );
      }
      // And the day figure is not the componentwise sum of those hours.
      const summed = hours.reduce((total, hour) => total + hour.p90Mwh, 0);
      expect(back?.day.dayTotalMwh.p90).not.toBe(summed);
    }
  });

  describe("the HTTP route, with no modelling service at all", () => {
    /**
     * The route over these rows, with `WATTSTEER_ML_URL` unset for the length
     * of the block.
     *
     * api-surface ticket 11's first acceptance line, taken literally: the
     * modelling service's URL is removed from the environment and the
     * most-viewed screen's read still answers 200. `forecast-day-ahead.test.ts`
     * proves the same thing structurally — no import of `ml-proxy`, no
     * `callMl` — and structure is the stronger argument, but this is the one a
     * sceptic can run. It replaces a proxy route that could not have passed it
     * under any circumstances.
     */
    const priorMlUrl = process.env.WATTSTEER_ML_URL;

    beforeAll(() => {
      delete process.env.WATTSTEER_ML_URL;
    });

    afterAll(() => {
      if (priorMlUrl === undefined) {
        delete process.env.WATTSTEER_ML_URL;
      } else {
        process.env.WATTSTEER_ML_URL = priorMlUrl;
      }
    });

    /** `now` is pinned so `target_date` bounds and `age_hours` are arithmetic. */
    const askAt = (now: Date, query: string): Promise<Response> =>
      new Elysia()
        .use(errorHandler)
        .use(createForecastRoutes({ db, now: () => now }))
        .handle(new Request(`http://localhost/v1/forecast/day-ahead${query}`));

    it("answers 200 from Postgres with the modelling service's URL unset", async () => {
      expect(process.env.WATTSTEER_ML_URL).toBeUndefined();
      await writePublication(db, publication(), { ingestedAt: NOW });

      const response = await askAt(
        new Date("2024-04-04T23:00:00.000Z"),
        `?subsystem=NE&target_date=${TARGET_DATE}&gate_profile=gate_late`,
      );
      expect(response.status).toBe(200);
      const wire = (await response.json()) as {
        subsystem: string;
        target_date: string;
        forecast_origin: { origin_kind: string; gate_profile: string; age_hours: number };
        day_energy_mwh: { p10: number; p50: number; p90: number };
        peak_power_mw: { p90: number };
        hours: unknown[];
      };
      expect(wire.subsystem).toBe("NE");
      expect(wire.target_date).toBe(TARGET_DATE);
      // Every origin carries its kind, and this route filters to `served` in
      // the query — so the field is a statement, not a hope.
      expect(wire.forecast_origin.origin_kind).toBe("served");
      expect(wire.forecast_origin.gate_profile).toBe("gate_late");
      expect(wire.hours.length).toBe(24);
      // The day figures came off the day row: neither is the componentwise sum
      // of the hours beside it, and the fixture is built so that shows.
      const summed = (wire.hours as { constrained_off_mwh: { p90: number } }[]).reduce(
        (total, hour) => total + hour.constrained_off_mwh.p90,
        0,
      );
      expect(wire.day_energy_mwh.p90).not.toBe(summed);
    });

    it("serves an earlier gate's rows as a 200 carrying their real age", async () => {
      // The third absence state — **stale** — and the one that is not an
      // error. The early gate published; the late gate did not. An hour later
      // the route still answers, with the age on the origin and the gate that
      // produced it named, because a forecast from this morning is a real
      // forecast and hiding it is the same lie as inventing one.
      await writePublication(db, publication({ gateProfile: "gate_early" }), {
        ingestedAt: new Date(GATE_EARLY),
      });

      const response = await askAt(
        // Six hours after the early gate, and past the late gate's instant.
        new Date("2024-04-04T23:00:00.000Z"),
        `?subsystem=NE&target_date=${TARGET_DATE}&gate_profile=gate_early`,
      );
      expect(response.status).toBe(200);
      const wire = (await response.json()) as {
        forecast_origin: { age_hours: number; gate_profile: string };
        day_expected_mwh: number;
        hours: { expected_mwh: number }[];
      };
      // Derived server-side, so no screen differences two clocks.
      expect(wire.forecast_origin.age_hours).toBe(11);
      expect(wire.forecast_origin.gate_profile).toBe("gate_early");
      // And it is a real band, not a zeroed one: the standing rule is that a
      // 200 never zero-fills a field it does not have.
      expect(wire.day_expected_mwh).toBeGreaterThan(0);
      expect(wire.hours.length).toBe(24);

      // Meanwhile the *late* gate for the same day is a refusal and not a
      // silent fallback to these rows — the two gates stay two answers.
      const late = await askAt(
        new Date("2024-04-04T23:00:00.000Z"),
        `?subsystem=NE&target_date=${TARGET_DATE}&gate_profile=gate_late`,
      );
      expect(late.status).toBe(404);
      expect(((await late.json()) as { error: { code: string } }).error.code).toBe(
        "FORECAST_UNAVAILABLE",
      );
    });

    it("tells 'the gate has not passed' apart from 'the publication failed'", async () => {
      // The first two of the four absence states, on the same empty table and
      // the same target date — the only thing that differs is where `now` sits
      // relative to the gate. Two 404s with two codes, because "wait" and
      // "something went wrong" are two different sentences and a screen that
      // showed one spinner for both is the failure this ticket exists to
      // prevent. Both need a database that *works* and has no rows, which is
      // why they are here rather than beside the no-database case.
      const beforeGate = await askAt(
        new Date("2024-04-04T20:00:00.000Z"),
        `?subsystem=NE&target_date=${TARGET_DATE}&gate_profile=gate_late`,
      );
      expect(beforeGate.status).toBe(404);
      const waiting = (await beforeGate.json()) as {
        error: { code: string; details: { publishes_at: string } };
      };
      expect(waiting.error.code).toBe("FORECAST_NOT_YET_PUBLISHED");
      // The instant the Overview renders is the gate, computed and returned.
      expect(waiting.error.details.publishes_at).toBe(GATE_LATE);

      const afterGate = await askAt(
        new Date("2024-04-04T23:00:00.000Z"),
        `?subsystem=NE&target_date=${TARGET_DATE}&gate_profile=gate_late`,
      );
      expect(afterGate.status).toBe(404);
      expect(((await afterGate.json()) as { error: { code: string } }).error.code).toBe(
        "FORECAST_UNAVAILABLE",
      );
    });

    it("refuses a day with no rows rather than serving an empty band", async () => {
      const response = await askAt(
        new Date("2024-04-04T23:00:00.000Z"),
        `?subsystem=S&target_date=${TARGET_DATE}&gate_profile=gate_late`,
      );
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toContain("FORECAST_UNAVAILABLE");
      // Not an empty `hours: []` with zeroed day figures — the failure this
      // ticket exists to prevent.
      for (const field of ["p10", "p50", "p90", "day_energy_mwh"]) {
        expect(text).not.toContain(field);
      }
    });
  });

  describe("the publication job, worker to modelling service and back", () => {
    /** A stand-in for the modelling service, over a real socket. */
    const serving = (
      handler: (request: Request) => Response,
    ): { url: string; stop: () => void } => {
      const server = Bun.serve({ port: 0, fetch: handler });
      return {
        url: `http://localhost:${server.port}`,
        stop: () => {
          server.stop(true);
        },
      };
    };

    it("asks for a lane's day and writes what comes back", async () => {
      const vector = readFileSync(
        join(import.meta.dir, "fixtures", "forecast", "publication.json"),
        "utf8",
      );
      let asked: unknown = null;
      const service = serving(async (request) => {
        // `URL` is the database URL in this file; the global is reached for
        // explicitly rather than shadowed by accident.
        expect(new globalThis.URL(request.url).pathname).toBe(PUBLISH_PATH);
        asked = await request.json();
        return new Response(vector, {
          headers: { "content-type": "application/json" },
        });
      });
      try {
        const result = await publishForecast(db, {
          lane: "dessem_free_v1__gate_late__thr5",
          targetDate: "2025-04-08",
          endpoint: { baseUrl: service.url, timeoutMs: 10_000 },
          ingestedAt: new Date("2025-04-07T22:10:00.000Z"),
        });
        expect(asked).toEqual({
          lane: "dessem_free_v1__gate_late__thr5",
          target_date: "2025-04-08",
        });
        expect(result.hoursInserted).toBe(96);
        expect(result.daysInserted).toBe(4);
        expect(result.subsystems).toBe(4);
        expect(result.correctionRegime).toBe(REGIME);
        expect(result.publishedAt.toISOString()).toBe("2025-04-07T22:00:00.000Z");
      } finally {
        service.stop();
      }

      const back = await readForecastDayAhead(db, {
        subsystem: "NE",
        targetDate: "2025-04-08",
        gateProfile: "gate_late",
        asOf: new Date("2025-04-07T23:00:00.000Z"),
      });
      expect(back?.hours.length).toBe(24);
      expect(back?.day.derivation).toBe("path_ensemble");
    });

    it("surfaces a refusal as itself and writes nothing", async () => {
      // No promoted artifact. The code is in the gateway's closed enum, so it
      // survives the crossing as `MODEL_UNAVAILABLE` rather than as an outage,
      // and the lane state travels with it for the operator.
      const service = serving(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: "MODEL_UNAVAILABLE",
                message: "no artifact has been promoted in this lane",
                details: { lane_state: "present_unpromoted", volume_mounted: true },
              },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      );
      try {
        await publishForecast(db, {
          lane: "dessem_free_v1__gate_late__thr5",
          endpoint: { baseUrl: service.url, timeoutMs: 10_000 },
        });
        throw new Error("the refusal was not raised");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("MODEL_UNAVAILABLE");
      } finally {
        service.stop();
      }
      const counted = await db.execute<{ hours: number }>(
        sql`select count(*)::int as hours from curtailment_forecast_hour`,
      );
      expect([...counted][0]?.hours).toBe(0);
    });
  });

  describe("the database refuses what the writer refuses", () => {
    it("refuses a row whose publication does not precede the hour", async () => {
      const late = publication({ publishedAt: hourInstant(23) });
      expect(writePublication(db, late, { ingestedAt: NOW })).rejects.toThrow(
        /observation/,
      );
    });

    it("refuses a day figure that is not from the path ensemble", () => {
      expect(() =>
        parsePublication(
          payload({
            mutate: (built) => {
              Object.assign(rowsOf(built.days)[0] ?? {}, {
                derivation: "sum_of_hours",
              });
            },
          }),
        ),
      ).toThrow(/path_ensemble/);
    });

    it("leaves nothing behind when one hour breaks a constraint", async () => {
      // A local hour of 30 passes every check the writer makes and fails the
      // table's. What the transaction must leave behind is *nothing*: a day
      // band with no hours is the half-written publication the boundary
      // decision promises is not representable.
      const broken = publication({
        mutate: (built) => {
          Object.assign(rowsOf(built.hours)[3] ?? {}, { local_hour: 30 });
        },
      });
      expect(writePublication(db, broken, { ingestedAt: NOW })).rejects.toThrow();
      const counted = await db.execute<{ hours: number; days: number }>(sql`
        select
          (select count(*)::int from curtailment_forecast_hour) as hours,
          (select count(*)::int from curtailment_forecast_day) as days
      `);
      expect([...counted][0]).toEqual({ hours: 0, days: 0 });
    });
  });
});
