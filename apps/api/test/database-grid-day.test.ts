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
 * `GET /v1/grid/day` against a real database, which is where its behaviour is.
 *
 * The gate cannot run this suite — `bun run check` leaves
 * `WATTSTEER_TEST_DATABASE_URL` unset — so `grid-day.test.ts` holds the
 * structural claims and this holds the arithmetic. Every figure below is
 * hand-checkable from the fixture, because a plausible-looking fixture is
 * exactly the one that hides a field read into the wrong slot.
 *
 * Run it with `bun run --cwd apps/api test:db`, which is the only way it runs
 * at all — the instruction lives here rather than only in a README because the
 * moment anybody wants it is the moment they are looking at a skipped file
 * wondering why.
 *
 * **The day is a Brasília civil day**, which is the whole reason this route
 * exists rather than a `date` on `/v1/grid/now`. The fixture straddles the
 * boundary on purpose: `2026-05-10T02:00Z` is 23:00 on the **9th** in São
 * Paulo, so a UTC reading of "the 10th" would sweep it in and a civil one must
 * not.
 */

const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** 23:00 BRT on the 9th. In the *previous* civil day, and the trap. */
const EVE = new Date("2026-05-10T02:00:00.000Z");
/** 00:00, 07:00 and 08:00 BRT on the 10th. */
const H00 = new Date("2026-05-10T03:00:00.000Z");
const H07 = new Date("2026-05-10T10:00:00.000Z");
const H08 = new Date("2026-05-10T11:00:00.000Z");

const DAY = "2026-05-10";
const GO_LIVE = new Date("2026-04-01T00:00:00.000Z");
const PUBLISHED = new Date("2026-05-11T00:00:00.000Z");
const AS_OF = new Date("2026-05-12T09:06:00.000Z");

const ENTITY: Record<string, string> = {
  N: "CJU_DAY_N",
  NE: "CJU_DAY_NE",
  SE: "CJU_DAY_SE",
  S: "CJU_DAY_S",
};

const entities: ObservedReportingEntity[] = SUBSYSTEMS.map((meta) => ({
  onsCode: ENTITY[meta.code] as string,
  kind: "CONJUNTO" as const,
  cegCore: null,
  name: `CONJ. DAY ${meta.code}`,
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

suite("GET /v1/grid/day (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const app = new Elysia().use(errorHandler).use(createGridRoutes({ db }));

  const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

  const body = async (path: string): Promise<Record<string, unknown>> => {
    const response = await get(path);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  beforeAll(async () => {
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_conj",
        resourceName: "Restricoes_coff_eolicas-2026-05",
        resourceUrl: "https://example.invalid/GRID_DAY_2026_05.csv",
        format: "CSV",
        changeKey: `grid-day-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });

    await upsertReportingEntities(db, entities);

    /*
      NE: 07:00 is the day's largest hour only once wind and solar are summed —
      40 wind + 30 solar = 70, against 08:00's 60 of wind alone. A `max` over
      the raw rows would answer 60 and look entirely plausible.

      N: one hour, one technology.
      SE: only the eve, which is the 9th — so the 10th settles nothing for it,
          and its peak must be `null` rather than 0.
      S: nothing at all anywhere.
    */
    const rows: CurtailmentReportHour[] = [
      report("NE", "WIND", H07, 40),
      report("NE", "SOLAR", H07, 30),
      report("NE", "WIND", H08, 60),
      report("N", "WIND", H00, 5),
      report("SE", "WIND", EVE, 900),
    ];

    await writeCurtailment(db, {
      rows,
      publishedAt: PUBLISHED,
      publishedAtPrecision: "file",
      sourceVersionId: version?.id ?? "",
      ingestedAt: GO_LIVE,
    });
  });

  afterAll(() => handle.close());

  const day = () => body(`/v1/grid/day?date=${DAY}&as_of=${AS_OF.toISOString()}`);

  it("answers the schema's own shape, and the schema is the authority", async () => {
    const result = validate("grid-day.schema.json", await day());
    expect(result.valid ? "" : explain(result)).toBe("");
  });

  it("reads a Brasília civil day, so the eve of it is another day", async () => {
    // `EVE` is 23:00 on the 9th in São Paulo and 02:00 on the 10th in UTC. It
    // carries 900 MWh — larger than everything else in the fixture put
    // together — so a UTC day would be unmissable here.
    const payload = await day();
    const rows = payload.subsystems as Record<string, unknown>[];
    const se = rows.find((row) => row.subsystem === "SE");
    expect(se?.constrained_off_mwh).toBe(0);
    expect(payload.date).toBe(DAY);
  });

  it("sums the hour before it takes the largest", async () => {
    const rows = (await day()).subsystems as Record<string, unknown>[];
    const ne = rows.find((row) => row.subsystem === "NE");
    // 40 + 30 + 60, and the peak is 07:00's 70 rather than 08:00's 60.
    expect(ne?.constrained_off_mwh).toBe(130);
    expect(ne?.peak_hour_mwh).toBe(70);
    expect(ne?.split).toEqual({ wind_mwh: 100, solar_mwh: 30 });
  });

  it("states a subsystem that settled nothing as null with a reason", async () => {
    // `honesty.md`: a zero would say the subsystem settled hours that happened
    // to be empty. It settled none, which is a different measurement.
    const rows = (await day()).subsystems as Record<string, unknown>[];
    for (const code of ["SE", "S"]) {
      const row = rows.find((entry) => entry.subsystem === code);
      expect({ code, peak: row?.peak_hour_mwh }).toEqual({ code, peak: null });
      expect(row?.peak_hour_unavailable_reason).toBe("no_settled_curtailment");
      expect(row?.constrained_off_mwh).toBe(0);
    }
  });

  it("carries all four in display order, and names each one", async () => {
    const rows = (await day()).subsystems as Record<string, unknown>[];
    expect(rows.map((row) => row.subsystem)).toEqual(["N", "NE", "SE", "S"]);
    expect(rows.map((row) => row.ons_display_name)).toEqual([
      "NORTE",
      "NORDESTE",
      "SUDESTE/CENTRO-OESTE",
      "SUL",
    ]);
  });

  it("derives the national total as the four added, and says so", async () => {
    const payload = await day();
    // 5 + 130 + 0 + 0. Observations add exactly, which is why this route may
    // carry a national number at all and the forecast's may not.
    expect(payload.national).toEqual({
      constrained_off_mwh: 135,
      derived: "sum_of_four",
    });
  });

  it("counts the hours that settled, over the day rather than per subsystem", async () => {
    // 00:00, 07:00 and 08:00 — three distinct hours across the grid. Counting
    // per subsystem would make a quiet Sunday indistinguishable from a day
    // that has not settled, and they are different sentences.
    expect((await day()).settled_hours).toBe(3);
  });

  it("answers a day that settled nothing at all with zeros, not a refusal", async () => {
    /*
      The departure from `/v1/grid/now` that this route exists for. `now`
      refuses when no hour is settled in all four, and is right to: an invented
      "now" under four zeroes reads as *no curtailment anywhere*. A named day
      cannot make that mistake — the caller said which day — and `settled_hours`
      is what tells "tomorrow" from "a quiet Sunday".
    */
    const payload = await body(
      `/v1/grid/day?date=2026-05-01&as_of=${AS_OF.toISOString()}`,
    );
    expect(payload.settled_hours).toBe(0);
    expect(payload.national).toEqual({ constrained_off_mwh: 0, derived: "sum_of_four" });
    const rows = payload.subsystems as Record<string, unknown>[];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.peak_hour_mwh === null)).toBe(true);
  });

  it("caches on a provenance and never on a clock", async () => {
    const response = await get(`/v1/grid/day?date=${DAY}&as_of=${AS_OF.toISOString()}`);
    expect(response.headers.get("etag")).toBeTruthy();
    // A settled past day, so the long row rather than the settling tail.
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
  });
});
