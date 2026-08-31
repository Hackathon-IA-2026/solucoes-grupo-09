import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createForecastRoutes } from "../src/api/forecast.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { readOnly } from "../src/contract/read-only.js";
import { applyAxes } from "../src/contract/scope.js";
import { canonicalForecastDay } from "../src/database/canonical-views.js";
import { createDatabase } from "../src/database/connection.js";
import { parseHoldoutBackfill, writeHoldoutBackfill } from "../src/forecast/backfill.js";
import {
  type ForecastPublication,
  parsePublication,
  writePublication,
} from "../src/forecast/publication.js";
import { readForecastDayAhead, readLatestPublished } from "../src/forecast/reads.js";

/**
 * The out-of-fold forecasts, in Postgres — replay ticket 01's seam.
 *
 * Gated exactly like the other database suites: `WATTSTEER_TEST_DATABASE_URL`
 * supplies the URL and the default `bun test` skips this file.
 *
 * Three things can only be proved here, and each is an acceptance line:
 *
 * 1. **Unservable.** A `backfilled_holdout` row sitting in the table is never
 *    returned by `/v1/forecast/day-ahead` — not by the reader, not by the HTTP
 *    route, at either gate, at any `as_of`, newest vintage or not. Asserted by
 *    writing the row and then trying every query shape the route accepts,
 *    rather than by reading the SQL and trusting it.
 * 2. **A vintage, not an overwrite.** A second backtest run over the same days
 *    appends a new `data_version` with a later `ingested_at`; an `AsOf` pinned
 *    before it still reconstructs the first run's numbers exactly.
 * 3. **The two kinds coexist on one key.** `origin_kind` is in the primary key,
 *    so a served record of a day and a reconstruction of the same day are two
 *    forecasts rather than two vintages of one — and the served one is
 *    untouched by the backtest that wrote beside it.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** The real backtest payload, from the modelling service's own shared fit. */
const VECTOR = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "forecast", "holdout-backfill.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const backfill = (mutate?: (payload: Record<string, unknown>) => void) => {
  const copy = structuredClone(VECTOR);
  mutate?.(copy);
  return parseHoldoutBackfill(copy);
};

/** The held-out day the vector reconstructs. */
const TARGET_DATE = (
  (VECTOR.publications as Record<string, unknown>[])[0] as Record<string, unknown>
).target_date as string;

/** Any instant after the day itself, so the gate has long passed. */
const NOW = new Date(`${TARGET_DATE}T23:00:00.000Z`);
const FIRST_RUN = new Date("2026-08-29T04:00:00.000Z");
const SECOND_RUN = new Date("2026-09-05T04:00:00.000Z");

/**
 * A served publication for the *same* subsystem-day, in the payload shape.
 *
 * Built from the backtest's own rows so the two differ only in the fields that
 * are supposed to differ — the discriminator and the numbers — and the served
 * one's day total is moved far away from the reconstruction's so a read that
 * returned the wrong row would be unmistakable rather than plausible.
 */
function servedForSameDay(): ForecastPublication {
  const payload = structuredClone(VECTOR);
  const publication = (payload.publications as Record<string, unknown>[])[0] as Record<
    string,
    unknown
  >;
  const origin = publication.forecast_origin as Record<string, unknown>;
  origin.origin_kind = "served";
  const days = publication.days as Record<string, unknown>[];
  for (const day of days) {
    day.day_total = { p10: 1, p50: 2, p90: 3 };
    day.peak_power = { p10: 1, p50: 2, p90: 3 };
  }
  return parsePublication(publication);
}

suite("the out-of-fold forecasts · persisted and unservable (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  const truncate = async () => {
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
  };

  beforeAll(truncate);
  beforeEach(truncate);
  afterAll(async () => {
    await truncate();
    await handle.close();
  });

  /**
   * The route as a client meets it, behind the error envelope.
   *
   * One instance, mounted once: the code a client is allowed to branch on only
   * exists because `errorHandler` is in front of the handler, and the whole
   * point of asking over HTTP rather than calling the reader is that this is
   * the path the product actually takes.
   */
  const routes = new Elysia()
    .use(errorHandler)
    .use(createForecastRoutes({ db, now: () => NOW }));

  const ask = (query: Record<string, string>) =>
    routes.handle(
      new Request(
        `http://localhost/v1/forecast/day-ahead?${new URLSearchParams(query).toString()}`,
      ),
    );

  it("persists a whole fold day at subsystem-valid-time grain", async () => {
    const written = await writeHoldoutBackfill(db, backfill(), {
      ingestedAt: FIRST_RUN,
    });
    expect(written.days).toBe(1);
    expect(written.hoursInserted).toBe(96);
    expect(written.daysInserted).toBe(4);

    const stored = await db.execute<{ origin_kind: string; rows: number }>(sql`
      select origin_kind, count(*)::int as rows
      from curtailment_forecast_hour group by origin_kind
    `);
    expect([...stored]).toEqual([{ origin_kind: "backfilled_holdout", rows: 96 }]);
  });

  it("stamps the counterfactual gate as published_at, unchanged by the write", async () => {
    await writeHoldoutBackfill(db, backfill(), { ingestedAt: FIRST_RUN });
    const expected = backfill().publications[0]?.publishedAt.toISOString();
    const rows = await db.execute<{ published_at: string; ingested_at: string }>(sql`
      select distinct published_at, ingested_at from curtailment_forecast_day
    `);
    const stored = [...rows];
    expect(stored.length).toBe(1);
    expect(new Date(stored[0]?.published_at as string).toISOString()).toBe(
      expected as string,
    );
    // `ingested_at` is the *real* instant — when the backtest ran — and it is
    // not the counterfactual one. That separation is what makes `AsOf` work.
    expect(new Date(stored[0]?.ingested_at as string).toISOString()).toBe(
      FIRST_RUN.toISOString(),
    );
  });

  it("is never returned by the day-ahead reader, under any query", async () => {
    await writeHoldoutBackfill(db, backfill(), { ingestedAt: FIRST_RUN });
    // Every shape the route can produce: four subsystems × two gates × three
    // as-ofs spanning before, between and after the write.
    for (const subsystem of ["N", "NE", "S", "SE"] as const) {
      for (const gateProfile of ["gate_early", "gate_late"] as const) {
        for (const asOf of [
          new Date("2026-08-28T00:00:00.000Z"),
          new Date("2026-08-29T12:00:00.000Z"),
          new Date("2030-01-01T00:00:00.000Z"),
        ]) {
          const back = await readForecastDayAhead(db, {
            subsystem,
            targetDate: TARGET_DATE,
            gateProfile,
            asOf,
          });
          expect(back).toBeNull();
        }
      }
    }
    // And it is not on `/v1/meta`'s listing of what has been published either.
    expect(
      await readLatestPublished(db, { asOf: new Date("2030-01-01T00:00:00.000Z") }),
    ).toEqual([]);
  });

  it("is answered by the HTTP route as an absence, not as a band", async () => {
    await writeHoldoutBackfill(db, backfill(), { ingestedAt: FIRST_RUN });
    const response = await ask({
      subsystem: "NE",
      target_date: TARGET_DATE,
      gate_profile: "gate_late",
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORECAST_UNAVAILABLE");
  });

  it("does not shadow the served record of the same day", async () => {
    // The reconstruction is written *after* the record and with different
    // numbers. `origin_kind` is in the primary key, so they are two forecasts
    // rather than two vintages, and the route still answers with the record.
    await writePublication(db, servedForSameDay(), { ingestedAt: FIRST_RUN });
    await writeHoldoutBackfill(db, backfill(), { ingestedAt: SECOND_RUN });

    const back = await readForecastDayAhead(db, {
      subsystem: "NE",
      targetDate: TARGET_DATE,
      gateProfile: "gate_late",
      asOf: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(back?.day.dayTotalMwh).toEqual({ p10: 1, p50: 2, p90: 3 });

    const counts = await db.execute<{ origin_kind: string; rows: number }>(sql`
      select origin_kind, count(*)::int as rows
      from curtailment_forecast_day group by origin_kind order by origin_kind
    `);
    expect([...counts]).toEqual([
      { origin_kind: "served", rows: 4 },
      { origin_kind: "backfilled_holdout", rows: 4 },
    ]);
    // Both keyed on the same (subsystem, target_date, gate_profile): the
    // discriminator is the only thing keeping them apart, and it does.
    const versions = await db.execute<{ max: number }>(
      sql`select max(data_version)::int as max from curtailment_forecast_day`,
    );
    expect([...versions][0]?.max).toBe(1);
  });

  it("appends a vintage on a second backtest run and keeps the first readable", async () => {
    await writeHoldoutBackfill(db, backfill(), { ingestedAt: FIRST_RUN });
    // A retrain moves the numbers. Same days, same fold, new artifact.
    const rerun = await writeHoldoutBackfill(
      db,
      backfill((payload) => {
        payload.artifact_id = "2026-09-05T04:00:00Z";
        for (const publication of payload.publications as Record<string, unknown>[]) {
          (publication.forecast_origin as Record<string, unknown>).run_label =
            "2026-09-05T04:00:00Z";
        }
      }),
      { ingestedAt: SECOND_RUN },
    );
    expect(rerun.hoursRevised).toBe(96);
    expect(rerun.hoursInserted).toBe(0);

    const rows = await db.execute<{
      data_version: number;
      run_label: string;
      ingested_at: string;
    }>(sql`
      select data_version, run_label, ingested_at
      from curtailment_forecast_day
      where subsystem = 'NE'::subsystem_code
      order by data_version
    `);
    const versions = [...rows];
    expect(versions.length).toBe(2);
    expect(versions[0]?.run_label).toBe(VECTOR.artifact_id as string);
    expect(versions[1]?.run_label).toBe("2026-09-05T04:00:00Z");
    // Nothing was overwritten: the older vintage is still there, with the
    // ingestion instant of the run that wrote it. An `AsOf` between the two
    // runs is therefore still a reconstruction of the first.
    expect(new Date(versions[0]?.ingested_at as string).toISOString()).toBe(
      FIRST_RUN.toISOString(),
    );
  });

  it("reconstructs the older run at an AsOf pinned before the newer one", async () => {
    await writeHoldoutBackfill(db, backfill(), { ingestedAt: FIRST_RUN });
    await writeHoldoutBackfill(
      db,
      backfill((payload) => {
        for (const publication of payload.publications as Record<string, unknown>[]) {
          for (const day of publication.days as Record<string, unknown>[]) {
            day.day_total = { p10: 900, p50: 950, p90: 999 };
          }
        }
      }),
      { ingestedAt: SECOND_RUN },
    );

    /**
     * The day band at one `as_of`, read through the canonical view.
     *
     * Through `applyAxes` and `canonical_forecast_day` rather than through a
     * hand-written `ingested_at <=` predicate: the point of the box is that the
     * the product's `AsOf` machinery supersedes these rows, not that a query
     * written for this test can be made to. The view raises when the axis is
     * unset, so there is no way to reach it here that forgets the pin.
     */
    const pinned = async (asOf: Date) =>
      readOnly(db, async (tx) => {
        await applyAxes(tx, { asOf });
        const rows = await tx.execute<{ day_total_p50_mwh: number }>(sql`
          select day_total_p50_mwh
          from ${canonicalForecastDay}
          where subsystem = 'NE'::subsystem_code
            and origin_kind = 'backfilled_holdout'::forecast_origin_kind
        `);
        return Number([...rows][0]?.day_total_p50_mwh);
      });

    const original = backfill().publications[0]?.days.find(
      (day) => day.subsystem === "NE",
    );
    expect(await pinned(SECOND_RUN)).toBe(950);
    // The older origin still returns the older values, to the bit. This is the
    // property that makes a shared replay link keep meaning what it meant.
    expect(await pinned(new Date("2026-09-01T00:00:00.000Z"))).toBe(
      original?.dayTotal.p50 as number,
    );
  });
});
