import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SUBSYSTEMS } from "@wattsteer/core/constants";
import { explain, validate } from "@wattsteer/core/schema";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createGridRoutes } from "../src/api/grid.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  type CurtailmentReportHour,
  type ObservedReportingEntity,
  upsertReportingEntities,
  writeCurtailment,
} from "../src/ingest/index.js";

/**
 * `GET /v1/grid/now` against a real database — the claims that are only true of
 * one, gated exactly as the other `database-*.test.ts` suites are.
 *
 * Four of them cannot be proved anywhere else:
 *
 * 1. The readout composes the **canonical view**, which means it only answers
 *    at all if the transaction-local `as_of` axis was set — `canonical_as_of()`
 *    raises `22023` otherwise, so a route that forgot it fails loudly here.
 * 2. **An absent hour is an absence, never a zero.** The fixture gives one
 *    subsystem an hour the other three have not settled, and the readout steps
 *    back to the hour all four share rather than reporting three zeroes.
 * 3. The **national total is the sum of the four**, exactly, and says so.
 * 4. It answers **200 with no modelling service and no promoted artifact** —
 *    there is no artifact table in this database and `WATTSTEER_ML_URL` is
 *    unset, which is `api-surface.md`'s degradation table for this row.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/**
 * Hours after go-live, so the window is honestly `point_in_time`.
 *
 * `HOUR_C` belongs to `NE` alone: it is the hour the other three have not
 * settled, and the reason the readout's latest settled hour is `HOUR_B`.
 */
const HOUR_A = new Date("2026-05-10T02:00:00.000Z");
const HOUR_B = new Date("2026-05-10T03:00:00.000Z");
const HOUR_C = new Date("2026-05-10T04:00:00.000Z");

const GO_LIVE = new Date("2026-04-01T00:00:00.000Z");
const PUBLISHED = new Date("2026-05-11T00:00:00.000Z");
/** The cut every assertion is made at, so `lag_hours` is arithmetic and not a clock. */
const AS_OF = new Date("2026-05-12T09:06:00.000Z");

/** One conjunto per subsystem, so the view's join carries the subsystem across. */
const ENTITY: Record<string, string> = {
  N: "CJU_NOW_N",
  NE: "CJU_NOW_NE",
  SE: "CJU_NOW_SE",
  S: "CJU_NOW_S",
};

const entities: ObservedReportingEntity[] = SUBSYSTEMS.map((meta) => ({
  onsCode: ENTITY[meta.code] as string,
  kind: "CONJUNTO" as const,
  cegCore: null,
  name: `CONJ. NOW ${meta.code}`,
  subsystem: meta.code,
  stateCode: meta.code === "S" ? "RS" : "BA",
}));

const report = (
  subsystem: string,
  technology: "WIND" | "SOLAR",
  validTime: Date,
  constrainedOffMwh: number,
): CurtailmentReportHour => ({
  reportingEntityCode: ENTITY[subsystem] as string,
  technology,
  validTime,
  verifiedGenerationMwh: 100,
  constrainedOffMwh,
  referenceGenerationMwh: 150,
  finalReferenceGenerationMwh: null,
  availableCapacityMw: 200,
  halfHoursObserved: 2,
  cause: null,
  causeMixed: false,
});

/**
 * The fixture, written so every figure in the assertions is hand-checkable.
 *
 * Per subsystem: wind in both settled hours, solar in `HOUR_B` only. `NE` also
 * has the unsettled `HOUR_C`, which no figure may include.
 */
const WIND_A: Record<string, number> = { N: 10, NE: 20, SE: 30, S: 40 };
const WIND_B: Record<string, number> = { N: 1, NE: 2, SE: 3, S: 4 };
const SOLAR_B: Record<string, number> = { N: 0.5, NE: 1.5, SE: 2.5, S: 3.5 };
/** Not in any figure: the hour only `NE` has settled. */
const NE_HOUR_C = 999;

const last24h = (code: string): number =>
  (WIND_A[code] as number) + (WIND_B[code] as number) + (SOLAR_B[code] as number);

suite("GET /v1/grid/now (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const app = new Elysia().use(errorHandler).use(createGridRoutes({ db }));

  const get = (path: string, headers?: Record<string, string>) =>
    app.handle(new Request(`http://localhost${path}`, { headers }));

  beforeAll(async () => {
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_conj",
        resourceName: "Restricoes_coff_eolicas-2026-05",
        resourceUrl: "https://example.invalid/GRID_NOW_2026_05.csv",
        format: "CSV",
        changeKey: `grid-now-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });

    await upsertReportingEntities(db, entities);

    const rows: CurtailmentReportHour[] = [];
    for (const { code } of SUBSYSTEMS) {
      rows.push(report(code, "WIND", HOUR_A, WIND_A[code] as number));
      rows.push(report(code, "WIND", HOUR_B, WIND_B[code] as number));
      rows.push(report(code, "SOLAR", HOUR_B, SOLAR_B[code] as number));
    }
    // The hour only one subsystem has settled. Nothing in the readout may see
    // it, and the other three must not be given a zero in its place.
    rows.push(report("NE", "WIND", HOUR_C, NE_HOUR_C));

    await writeCurtailment(db, {
      rows,
      publishedAt: PUBLISHED,
      publishedAtPrecision: "file",
      sourceVersionId: version?.id ?? "",
      ingestedAt: GO_LIVE,
    });
  });

  afterAll(() => handle.close());

  const readout = async (): Promise<Record<string, unknown>> => {
    const response = await get(`/v1/grid/now?as_of=${AS_OF.toISOString()}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  it("answers the schema's own shape, and the schema is the authority", async () => {
    const body = await readout();
    const result = validate("grid-now.schema.json", body);
    // The failure message is the schema's own, so a drift says which field.
    expect(result.valid ? "" : explain(result)).toBe("");
  });

  it("returns the latest settled hour, the lag and its as-of", async () => {
    const body = await readout();
    // HOUR_B, not HOUR_C: the hour all four subsystems have settled.
    expect(body.latest_settled_hour).toBe(HOUR_B.toISOString());
    expect(body.as_of).toBe(AS_OF.toISOString());
    // 2026-05-12T09:06Z − 2026-05-10T03:00Z = 54.1 h. The screen never computes
    // this from its own clock; the lag is the headline when ingestion is behind.
    expect(body.lag_hours).toBeCloseTo(54.1, 5);
  });

  it("carries its vintage fidelity", async () => {
    const body = await readout();
    // The whole window post-dates go-live, so the answer is honestly
    // point-in-time rather than a restatement of ONS's current belief.
    expect(body.vintage_fidelity).toBe("point_in_time");
  });

  it("gives all four subsystems their totals and their scalar split", async () => {
    const body = await readout();
    const subsystems = body.subsystems as Record<string, unknown>[];
    expect(subsystems).toHaveLength(4);
    expect(subsystems.map((entry) => entry.subsystem)).toEqual(
      SUBSYSTEMS.map((meta) => meta.code),
    );

    for (const [index, meta] of SUBSYSTEMS.entries()) {
      const entry = subsystems[index] as Record<string, unknown>;
      const split = entry.split as Record<string, number>;
      expect(entry.ons_display_name).toBe(meta.onsDisplayName);
      expect(entry.last_24h_constrained_off_mwh).toBeCloseTo(last24h(meta.code), 6);
      expect(entry.latest_hour_constrained_off_mwh).toBeCloseTo(
        (WIND_B[meta.code] as number) + (SOLAR_B[meta.code] as number),
        6,
      );
      // A scalar split, and it adds to the 24-hour total exactly.
      expect(split.wind_mwh).toBeCloseTo(
        (WIND_A[meta.code] as number) + (WIND_B[meta.code] as number),
        6,
      );
      expect(split.solar_mwh).toBeCloseTo(SOLAR_B[meta.code] as number, 6);
      expect(split.wind_mwh + split.solar_mwh).toBeCloseTo(last24h(meta.code), 6);
    }
  });

  it("names the national total's derivation, and it is the sum of the four", async () => {
    const body = await readout();
    const national = body.national as Record<string, unknown>;
    const subsystems = body.subsystems as Record<string, number>[];
    const sum = subsystems.reduce(
      (total, entry) => total + entry.last_24h_constrained_off_mwh,
      0,
    );
    // Observations add exactly, which is what makes this national number
    // legitimate where the forecast's is not.
    expect(national.last_24h_constrained_off_mwh).toBeCloseTo(sum, 6);
    expect(national.derived).toBe("sum_of_four");
  });

  it("treats an hour three subsystems have not settled as an absence, not a zero", async () => {
    const body = await readout();
    const subsystems = body.subsystems as Record<string, number>[];

    // Nothing is zero: the readout stepped back to the hour that exists for
    // all four rather than reporting the newest hour with three zeroes in it.
    for (const entry of subsystems) {
      expect(entry.latest_hour_constrained_off_mwh).toBeGreaterThan(0);
    }
    // And NE's unsettled hour is in no figure at all.
    const ne = subsystems.find(
      (entry) => (entry as unknown as { subsystem: string }).subsystem === "NE",
    );
    expect(ne?.last_24h_constrained_off_mwh).toBeCloseTo(last24h("NE"), 6);
    expect(ne?.last_24h_constrained_off_mwh).toBeLessThan(NE_HOUR_C);
  });

  /**
   * The equivalence the fast path rests on, asserted against a real planner.
   *
   * `canonical_latest_complete_settled_hour` answers "the newest hour settled in
   * every subsystem" by reading `curtailment_report_hour` in `valid_time`
   * order and stopping at the first qualifying hour — **without** going through
   * `canonical_curtailment_by_reporting_entity`'s `DISTINCT ON`, whose ordering
   * no index serves and which therefore sorted the whole table. Deployed, that
   * sort was 8.4-9.7 s on the Overview's first call.
   *
   * The claim licensing the shortcut is that `DISTINCT ON` picks one row per
   * business key and never drops a key, so the set of (`valid_time`,
   * `subsystem`) pairs — and hence `count(distinct subsystem)` per hour — is
   * identical either side of it. This runs both formulations against the same
   * fixture and demands the same answer.
   *
   * **Non-vacuity.** The fixture's `HOUR_C` belongs to `NE` alone, so an
   * implementation that forgot the `having` clause would answer `HOUR_C` and
   * fail here; the assertion pins the answer to `HOUR_B` rather than merely
   * pinning the two queries to each other, which two identically-broken
   * queries would satisfy.
   */
  it("the fast read and the grouped view agree on the latest settled hour", async () => {
    const answers = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('wattsteer.as_of', ${AS_OF.toISOString()}, true)`,
      );
      const fast = await tx.execute<{ valid_time: string }>(
        sql`select valid_time from canonical_latest_complete_settled_hour`,
      );
      const grouped = await tx.execute<{ valid_time: string }>(sql`
        select valid_time
        from canonical_curtailment_by_reporting_entity
        group by valid_time
        having count(distinct subsystem) = ${SUBSYSTEMS.length}::int
        order by valid_time desc
        limit 1
      `);
      return {
        fast: [...fast][0]?.valid_time ?? null,
        grouped: [...grouped][0]?.valid_time ?? null,
      };
    });
    const asIso = (value: string | null) =>
      value === null ? null : new Date(value).toISOString();
    expect(asIso(answers.fast)).toBe(asIso(answers.grouped));
    // The hour all four settled — not `HOUR_C`, which only `NE` has.
    expect(asIso(answers.fast)).toBe(HOUR_B.toISOString());
  });

  it("serves with the modelling service unreachable and no promoted artifact", async () => {
    // Nothing in this database is an artifact and nothing in the path is the ML
    // service: the 200 is a property of the dependency graph, not a fallback.
    expect(process.env.WATTSTEER_ML_URL ?? "").toBe("");
    const response = await get(`/v1/grid/now?as_of=${AS_OF.toISOString()}`);
    expect(response.status).toBe(200);
  });

  it("defaults its as-of to now rather than refusing", async () => {
    const response = await get("/v1/grid/now");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { as_of: string; lag_hours: number };
    // The cut is stated on the payload, which is the honesty the default costs.
    expect(new Date(body.as_of).getTime()).toBeGreaterThan(AS_OF.getTime());
    expect(body.lag_hours).toBeGreaterThan(0);
  });

  it("validates on ingestion rather than on a clock", async () => {
    const response = await get(`/v1/grid/now?as_of=${AS_OF.toISOString()}`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = response.headers.get("etag");
    expect(etag).toBe(`W/"${GO_LIVE.toISOString()}"`);

    const revalidated = await get(`/v1/grid/now?as_of=${AS_OF.toISOString()}`, {
      "if-none-match": etag as string,
    });
    expect(revalidated.status).toBe(304);
  });

  it("refuses a malformed as-of rather than defaulting past it", async () => {
    const response = await get("/v1/grid/now?as_of=yesterday");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_INPUT");
  });

  it("answers an absence as an absence when nothing is settled", async () => {
    // An as-of before anything was ingested: the view is empty, so there is no
    // settled hour. Four zeroes under an invented hour would read as "no
    // curtailment anywhere", which is a different and much worse statement.
    const before = new Date(GO_LIVE.getTime() - 3_600_000).toISOString();
    const response = await get(`/v1/grid/now?as_of=${before}`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DATA_UNAVAILABLE");
  });
});
