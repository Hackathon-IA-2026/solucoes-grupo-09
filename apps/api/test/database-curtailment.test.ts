import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { explain, validate } from "@wattsteer/core/schema";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createCurtailmentRoutes } from "../src/api/curtailment.js";
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
 * `GET /v1/curtailment/{hours,episodes,reasons}` against a real database — the
 * claims that are only true of one, gated exactly as the other
 * `database-*.test.ts` suites are.
 *
 * What cannot be proved anywhere else:
 *
 * 1. All three compose the **canonical view**, so they answer only if the
 *    transaction-local `as_of` axis was set — `canonical_as_of()` raises
 *    `22023` otherwise.
 * 2. **Episodes are computed on read** by a parameterised SQL function: the
 *    same range under two thresholds and two gap tolerances returns three
 *    different answers, which nothing stored at episode grain could do.
 * 3. **An absent hour is an absence.** The fixture leaves one hour with no row
 *    at all. It is missing from the series rather than zero, it contributes
 *    nothing to an episode's energy, and with a gap tolerance it sits inside an
 *    episode's span without inventing a number.
 * 4. **Every reason row carries its grain**, and the fixture has one conjunto
 *    and one self-reporting plant, so a screen can tell them apart with no
 *    second call.
 * 5. **Every response carries the data version its rows were read at**, and the
 *    fixture restates one hour so the version actually moves.
 * 6. All three answer **200 with no modelling service and no promoted
 *    artifact** — there is no artifact table in this database.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/**
 * The civil day under test, and the hours that make it up.
 *
 * Brasília is UTC−3 with no DST since 2019, so `2026-05-10` in
 * `America/Sao_Paulo` is `[2026-05-10T03:00Z, 2026-05-11T03:00Z)`. Every hour
 * below is inside it.
 */
const DAY = "2026-05-10";
const hour = (utcHour: number) =>
  new Date(`2026-05-10T${String(utcHour).padStart(2, "0")}:00:00.000Z`);

/** The five observed hours, and the sixth that was never observed at all. */
const H06 = hour(6);
const H07 = hour(7);
const H08 = hour(8);
const H09 = hour(9);
/** No row exists for 10:00Z. It is an absence and every figure must treat it as one. */
const H10 = hour(10);
const H11 = hour(11);

const RANGE_FROM = new Date("2026-05-10T00:00:00.000Z");
const RANGE_TO = new Date("2026-05-11T00:00:00.000Z");

/** Ingested before the window, so the answers are honestly point-in-time. */
const GO_LIVE = new Date("2026-04-01T00:00:00.000Z");
const PUBLISHED = new Date("2026-05-11T00:00:00.000Z");
/** The restatement — ONS rewriting a settled hour in place, which it does. */
const RESTATED_AT = new Date("2026-05-14T00:00:00.000Z");

/** Between the two ingests: the first vintage, at version 1. */
const AS_OF_EARLY = new Date("2026-05-13T00:00:00.000Z");
/** After the restatement: the second vintage, at version 2. */
const AS_OF_LATE = new Date("2026-05-15T00:00:00.000Z");

const CONJUNTO = "CJU_OBS_NE";
const SELF_REPORTING = "USI_OBS_NE";
const ELSEWHERE = "CJU_OBS_S";

const CONJUNTO_LABEL = "CONJ. OBSERVADO NE";
const PLANT_LABEL = "USINA OBSERVADA NE";

/** ONS's own free text, in Portuguese. Verbatim in both locales, never translated. */
const DESCRIPTION_SMALL = "Restricao energetica - ordem ONS";
const DESCRIPTION_DOMINANT = "Restricao energetica - excedente de geracao";

const entities: ObservedReportingEntity[] = [
  {
    onsCode: CONJUNTO,
    kind: "CONJUNTO",
    cegCore: null,
    name: CONJUNTO_LABEL,
    subsystem: "NE",
    stateCode: "BA",
  },
  {
    onsCode: SELF_REPORTING,
    kind: "PLANT",
    cegCore: "EOL.CV.BA.000123",
    name: PLANT_LABEL,
    subsystem: "NE",
    stateCode: "BA",
  },
  {
    onsCode: ELSEWHERE,
    kind: "CONJUNTO",
    cegCore: null,
    name: "CONJ. OBSERVADO S",
    subsystem: "S",
    stateCode: "RS",
  },
];

const report = (
  entity: string,
  technology: "WIND" | "SOLAR",
  validTime: Date,
  constrainedOffMwh: number,
  cause: CurtailmentReportHour["cause"] = null,
  causeMixed = false,
): CurtailmentReportHour => ({
  reportingEntityCode: entity,
  technology,
  validTime,
  verifiedGenerationMwh: 100,
  constrainedOffMwh,
  referenceGenerationMwh: 150,
  finalReferenceGenerationMwh: null,
  availableCapacityMw: 200,
  halfHoursObserved: 2,
  cause,
  causeMixed,
});

/**
 * The fixture, written so every figure below is hand-checkable.
 *
 * NE's hourly totals: 06:00 → 10, 07:00 → 18, 08:00 → 2, 09:00 → 9, 10:00 →
 * nothing at all, 11:00 → 7.
 */
const rows: CurtailmentReportHour[] = [
  // 06:00 — 6 from the conjunto and 4 from the self-reporting plant.
  report(CONJUNTO, "WIND", H06, 6, {
    reason: "ENE",
    origin: "SIS",
    description: DESCRIPTION_SMALL,
  }),
  report(SELF_REPORTING, "WIND", H06, 4, {
    reason: "CNF",
    origin: "LOC",
    description: null,
  }),
  // 07:00 — the largest hour, and the one whose free text the day's ENE row
  // must carry: 12 MWh dominates the 6 MWh at 06:00.
  report(
    CONJUNTO,
    "WIND",
    H07,
    12,
    { reason: "ENE", origin: "SIS", description: DESCRIPTION_DOMINANT },
    // The hour changed cause mid-way. The stored reason is the dominant one,
    // and the flag is what says so.
    true,
  ),
  report(CONJUNTO, "SOLAR", H07, 6, {
    reason: "REL",
    origin: "LOC",
    description: null,
  }),
  // 08:00 — below the 5 MW threshold, and with no cause reported at all.
  report(CONJUNTO, "WIND", H08, 2),
  report(CONJUNTO, "WIND", H09, 9),
  report(CONJUNTO, "WIND", H11, 7),
  // Another subsystem entirely, at an hour NE also has. Nothing in an NE
  // answer may include it.
  report(ELSEWHERE, "WIND", H07, 500),
];

/** The restatement: 11:00 was 7 and ONS now says 8. Same key, new version. */
const restated: CurtailmentReportHour[] = [report(CONJUNTO, "WIND", H11, 8)];

suite("GET /v1/curtailment/* (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const app = new Elysia().use(errorHandler).use(createCurtailmentRoutes({ db }));

  const get = (path: string, headers?: Record<string, string>) =>
    app.handle(new Request(`http://localhost${path}`, { headers }));

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
        resourceUrl: "https://example.invalid/OBSERVED_2026_05.csv",
        format: "CSV",
        changeKey: `observed-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });

    await upsertReportingEntities(db, entities);
    await writeCurtailment(db, {
      rows,
      publishedAt: PUBLISHED,
      publishedAtPrecision: "file",
      sourceVersionId: version?.id ?? "",
      ingestedAt: GO_LIVE,
    });
    await writeCurtailment(db, {
      rows: restated,
      publishedAt: PUBLISHED,
      publishedAtPrecision: "file",
      sourceVersionId: version?.id ?? "",
      ingestedAt: RESTATED_AT,
    });
  });

  afterAll(() => handle.close());

  const hoursPath = (extra = "") =>
    `/v1/curtailment/hours?subsystem=NE&from=${RANGE_FROM.toISOString()}&to=${RANGE_TO.toISOString()}&as_of=${AS_OF_EARLY.toISOString()}${extra}`;
  const episodesPath = (extra = "") =>
    `/v1/curtailment/episodes?subsystem=NE&from=${RANGE_FROM.toISOString()}&to=${RANGE_TO.toISOString()}&as_of=${AS_OF_EARLY.toISOString()}${extra}`;
  const reasonsPath = (extra = "") =>
    `/v1/curtailment/reasons?subsystem=NE&date=${DAY}&as_of=${AS_OF_EARLY.toISOString()}${extra}`;

  describe("hours", () => {
    it("answers the schema's own shape, and the schema is the authority", async () => {
      const result = validate(
        "curtailment.schema.json#/$defs/hours",
        await body(hoursPath()),
      );
      expect(result.valid ? "" : explain(result)).toBe("");
    });

    it("returns one row per (subsystem, technology, hour), summed over entities", async () => {
      const payload = await body(hoursPath());
      const rowsOut = payload.rows as Record<string, unknown>[];
      // Six rows: five wind hours and one solar hour. 06:00 is one row of 10,
      // which is the conjunto's 6 plus the self-reporting plant's 4 — the
      // grain is the subsystem, so the two entities are one number.
      expect(rowsOut).toHaveLength(6);
      const wind = rowsOut.filter((row) => row.technology === "WIND");
      expect(wind.map((row) => row.constrained_off_mwh)).toEqual([10, 12, 2, 9, 7]);
      const solar = rowsOut.filter((row) => row.technology === "SOLAR");
      expect(solar).toHaveLength(1);
      expect(solar[0]?.constrained_off_mwh).toBe(6);
    });

    it("gives every row its local hour through the zone, not a fixed offset", async () => {
      const payload = await body(hoursPath());
      const first = (payload.rows as Record<string, unknown>[])[0];
      // 06:00Z is 03:00 in Brasília.
      expect(first?.valid_time).toBe(H06.toISOString());
      expect(first?.hour_local).toBe(3);
    });

    it("treats an unobserved hour as an absence, never as a zero", async () => {
      const payload = await body(hoursPath());
      const rowsOut = payload.rows as Record<string, unknown>[];
      // Nothing at 10:00Z, and no zero standing in for it.
      expect(rowsOut.some((row) => row.valid_time === H10.toISOString())).toBe(false);
      expect(rowsOut.some((row) => row.constrained_off_mwh === 0)).toBe(false);
    });

    it("filters by technology and echoes the filter, null when there was none", async () => {
      const filtered = await body(hoursPath("&technology=SOLAR"));
      expect(filtered.technology).toBe("SOLAR");
      expect(filtered.rows).toHaveLength(1);
      const unfiltered = await body(hoursPath());
      expect(unfiltered.technology).toBeNull();
    });

    it("excludes another subsystem's rows entirely", async () => {
      const payload = await body(hoursPath());
      const total = (payload.rows as Record<string, number>[]).reduce(
        (sum, row) => sum + row.constrained_off_mwh,
        0,
      );
      // 10 + 18 + 2 + 9 + 7 = 46. The S conjunto's 500 is in no figure.
      expect(total).toBe(46);
    });

    it("carries the data version its rows were read at, and it moves", async () => {
      const early = await body(hoursPath());
      expect(early.data_version).toBe("1");
      const late = await body(
        `/v1/curtailment/hours?subsystem=NE&from=${RANGE_FROM.toISOString()}&to=${RANGE_TO.toISOString()}&as_of=${AS_OF_LATE.toISOString()}`,
      );
      // ONS restated 11:00 in place: a second version of the same key.
      expect(late.data_version).toBe("2");
      const lateRows = late.rows as Record<string, unknown>[];
      expect(lateRows.at(-1)?.constrained_off_mwh).toBe(8);
    });

    it("says point_in_time only when the window post-dates go-live", async () => {
      const inside = await body(hoursPath());
      expect(inside.vintage_fidelity).toBe("point_in_time");
      const before = await body(
        `/v1/curtailment/hours?subsystem=NE&from=2026-03-01T00:00:00.000Z&to=${RANGE_TO.toISOString()}&as_of=${AS_OF_EARLY.toISOString()}`,
      );
      // One pre-go-live hour makes the whole series a restatement.
      expect(before.vintage_fidelity).toBe("revision_optimistic");
    });

    it("pages by hour, and an empty page has no version to claim", async () => {
      // 152 days, so the first 100-day page ends before the fixture's hours.
      const first = await body(
        `/v1/curtailment/hours?subsystem=NE&from=2026-01-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z&as_of=${AS_OF_EARLY.toISOString()}`,
      );
      expect(first.rows).toHaveLength(0);
      expect(first.data_version).toBe("none");
      const cursor = first.next_cursor as string;
      expect(cursor).not.toBeNull();
      // The echoed range is the range asked for, not the page served.
      expect(first.from).toBe("2026-01-01T00:00:00.000Z");
      expect(first.to).toBe("2026-06-01T00:00:00.000Z");

      const second = await body(
        `/v1/curtailment/hours?subsystem=NE&from=2026-01-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z&as_of=${AS_OF_EARLY.toISOString()}&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(second.rows).toHaveLength(6);
      expect(second.next_cursor).toBeNull();
    });

    it("validates on the data version, and revalidates a 304", async () => {
      const response = await get(hoursPath());
      const etag = response.headers.get("etag") ?? "";
      expect(etag).toContain('W/"1:NE');
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=3600, stale-while-revalidate=86400",
      );
      const again = await get(hoursPath(), { "if-none-match": etag });
      expect(again.status).toBe(304);
    });

    it("caches a range touching the settling tail for minutes, not an hour", async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 3 * 86_400_000);
      const response = await get(
        `/v1/curtailment/hours?subsystem=NE&from=${from.toISOString()}&to=${to.toISOString()}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    });
  });

  describe("episodes", () => {
    it("answers the schema's own shape", async () => {
      const result = validate(
        "curtailment.schema.json#/$defs/episodes",
        await body(episodesPath()),
      );
      expect(result.valid ? "" : explain(result)).toBe("");
    });

    it("computes runs at the committed defaults: 5 MW and no gap", async () => {
      const payload = await body(episodesPath());
      expect(payload.threshold_mw).toBe(5);
      expect(payload.max_gap_hours).toBe(0);
      const episodes = payload.episodes as Record<string, unknown>[];
      // Three runs: 06:00–08:00 (10 + 18), then 09:00, then 11:00. The
      // sub-threshold 08:00 and the unobserved 10:00 each end a run.
      expect(episodes).toHaveLength(3);
      expect(episodes[0]).toMatchObject({
        started_at: H06.toISOString(),
        ended_at: H08.toISOString(),
        duration_hours: 2,
        total_mwh: 28,
        peak_mw: 18,
      });
      expect(episodes[1]).toMatchObject({
        started_at: H09.toISOString(),
        duration_hours: 1,
        total_mwh: 9,
      });
      expect(episodes[2]).toMatchObject({
        started_at: H11.toISOString(),
        total_mwh: 7,
      });
    });

    it("answers the whole grid when no subsystem is asked for", async () => {
      /*
        **The case the `ELSEWHERE` fixture was always there for.**

        `CJU_OBS_S` puts 500 MWh in subsystem S at 07:00, at an hour NE also
        has, and the test above this one exists to prove an NE answer never
        includes it. This is the other direction: with no `subsystem` the
        answer is every subsystem's runs, so S's hour must be in it — and must
        be labelled S rather than inheriting the envelope's idea of where it
        happened, because the envelope no longer has one.
      */
      const path = `/v1/curtailment/episodes?from=${RANGE_FROM.toISOString()}&to=${RANGE_TO.toISOString()}&as_of=${AS_OF_EARLY.toISOString()}`;
      const payload = await body(path);
      expect(payload.subsystem).toBeUndefined();

      const episodes = payload.episodes as Record<string, unknown>[];
      // NE's three, plus S's one. Chronological, and S's 07:00 falls between
      // NE's 06:00–08:00 run and its 09:00 one — which is the whole point of
      // ordering in Postgres rather than concatenating four answers.
      expect(
        episodes.map((episode) => [
          episode.subsystem,
          episode.started_at,
          episode.total_mwh,
        ]),
      ).toEqual([
        ["NE", H06.toISOString(), 28],
        ["S", H07.toISOString(), 500],
        ["NE", H09.toISOString(), 9],
        ["NE", H11.toISOString(), 7],
      ]);
    });

    it("is a concatenation of the per-subsystem answers and not a new number", async () => {
      /*
        The honesty property, asserted rather than asserted *about*. An episode
        is a measured run of settled hours, so four subsystems' runs add
        exactly — unlike a band, which is why this route may answer for the
        whole grid and the forecast routes may not. If the whole-grid read ever
        summed, averaged or merged anything across subsystems, this fails.
      */
      const window = `from=${RANGE_FROM.toISOString()}&to=${RANGE_TO.toISOString()}&as_of=${AS_OF_EARLY.toISOString()}`;
      const all = (await body(`/v1/curtailment/episodes?${window}`)).episodes as Record<
        string,
        unknown
      >[];
      const perSubsystem: Record<string, unknown>[] = [];
      for (const code of ["N", "NE", "SE", "S"]) {
        const one = (await body(`/v1/curtailment/episodes?subsystem=${code}&${window}`))
          .episodes as Record<string, unknown>[];
        for (const episode of one) {
          expect(episode.subsystem).toBe(code);
          perSubsystem.push(episode);
        }
      }
      perSubsystem.sort((a, b) =>
        String(a.started_at) === String(b.started_at)
          ? String(a.subsystem).localeCompare(String(b.subsystem))
          : String(a.started_at).localeCompare(String(b.started_at)),
      );
      expect(all).toEqual(perSubsystem);
    });

    it("stamps the parameters that produced it on every episode", async () => {
      const payload = await body(episodesPath("&threshold_mw=8"));
      const episodes = payload.episodes as Record<string, unknown>[];
      expect(payload.threshold_mw).toBe(8);
      for (const episode of episodes) {
        expect(episode.threshold_mw).toBe(8);
        expect(episode.max_gap_hours).toBe(0);
      }
      // A different threshold is a different answer over the same rows, which
      // is the whole reason nothing is stored at episode grain: 06:00's 10,
      // 07:00's 18 and 09:00's 9 survive an 8 MW threshold, and 11:00's 7 does
      // not — so three runs at 5 MW become two at 8 MW.
      expect(episodes).toHaveLength(2);
      expect(episodes.map((episode) => episode.started_at)).toEqual([
        H06.toISOString(),
        H09.toISOString(),
      ]);
    });

    it("tolerates a gap, and the tolerated hours are inside the span", async () => {
      const payload = await body(episodesPath("&max_gap_hours=1"));
      const episodes = payload.episodes as Record<string, unknown>[];
      // One episode now: 08:00 is below threshold and 10:00 was never observed,
      // and one hour of either is inside the tolerance.
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({
        started_at: H06.toISOString(),
        ended_at: new Date(H11.getTime() + 3_600_000).toISOString(),
        duration_hours: 6,
        // 10 + 18 + 2 + 9 + 7. The sub-threshold hour's energy is inside the
        // span and counts; the unobserved hour contributes nothing and is not
        // a zero. Six hours of span, five of them observed.
        total_mwh: 46,
        peak_mw: 18,
        max_gap_hours: 1,
      });
    });

    it("labels a technology-filtered episode with that technology and no other", async () => {
      const both = await body(episodesPath());
      // With no filter the episode is over both technologies, so it is not a
      // wind episode and is not labelled as one.
      expect((both.episodes as Record<string, unknown>[])[0]?.technology).toBeUndefined();
      const solar = await body(episodesPath("&technology=SOLAR"));
      const episodes = solar.episodes as Record<string, unknown>[];
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({
        technology: "SOLAR",
        started_at: H07.toISOString(),
        total_mwh: 6,
      });
    });

    it("carries the version of the rows it was computed from", async () => {
      const payload = await body(episodesPath());
      expect(payload.data_version).toBe("1");
      expect(payload.vintage_fidelity).toBe("point_in_time");
    });
  });

  describe("reasons", () => {
    it("answers the schema's own shape", async () => {
      const result = validate(
        "curtailment.schema.json#/$defs/reasons",
        await body(reasonsPath()),
      );
      expect(result.valid ? "" : explain(result)).toBe("");
    });

    it("returns one row per (entity, reason, origin), largest first", async () => {
      const payload = await body(reasonsPath());
      const rowsOut = payload.rows as Record<string, unknown>[];
      expect(payload.date).toBe(DAY);
      // ENE at the conjunto (6 + 12), REL on its solar (6), CNF at the
      // self-reporting plant (4). The 08:00 hour reported no cause at all and
      // is no row here — not a row labelled "unknown".
      expect(rowsOut).toHaveLength(3);
      expect(rowsOut.map((row) => row.constrained_off_mwh)).toEqual([18, 6, 4]);
    });

    it("carries the grain on every row, conjunto and plant alike", async () => {
      const rowsOut = (await body(reasonsPath())).rows as Record<string, unknown>[];
      for (const row of rowsOut) {
        expect(["conjunto", "self_reporting_plant"]).toContain(row.grain);
      }
      const conjunto = rowsOut.find((row) => row.entity_code === CONJUNTO);
      const plant = rowsOut.find((row) => row.entity_code === SELF_REPORTING);
      // No second call: the grain and the label are both on the row.
      expect(conjunto?.grain).toBe("conjunto");
      expect(conjunto?.entity_label).toBe(CONJUNTO_LABEL);
      expect(plant?.grain).toBe("self_reporting_plant");
      expect(plant?.entity_label).toBe(PLANT_LABEL);
    });

    it("returns reason codes and no gloss", async () => {
      const rowsOut = (await body(reasonsPath())).rows as Record<string, unknown>[];
      expect(rowsOut.map((row) => row.reason)).toEqual(["ENE", "REL", "CNF"]);
      expect(rowsOut.map((row) => row.origin)).toEqual(["SIS", "LOC", "LOC"]);
      for (const row of rowsOut) {
        expect(Object.keys(row)).not.toContain("reason_label");
        expect(Object.keys(row)).not.toContain("reason_gloss");
      }
    });

    it("surfaces the mixed-cause flag on every row", async () => {
      const rowsOut = (await body(reasonsPath())).rows as Record<string, unknown>[];
      for (const row of rowsOut) {
        expect(typeof row.cause_mixed).toBe("boolean");
      }
      // 07:00 changed cause mid-way, and that hour is inside the conjunto's
      // ENE row — so the row says so rather than presenting the dominant cause
      // as if it were the whole hour.
      const conjunto = rowsOut.find((row) => row.entity_code === CONJUNTO);
      expect(conjunto?.cause_mixed).toBe(true);
      const plant = rowsOut.find((row) => row.entity_code === SELF_REPORTING);
      expect(plant?.cause_mixed).toBe(false);
    });

    it("passes ONS's free text through verbatim, in Portuguese", async () => {
      const rowsOut = (await body(reasonsPath())).rows as Record<string, unknown>[];
      const conjunto = rowsOut.find((row) => row.entity_code === CONJUNTO);
      // The dominant hour's note — 12 MWh at 07:00 outweighs 6 MWh at 06:00 —
      // and it is a source record, so it is not translated for an English
      // caller and it is not a gloss of `ENE`.
      expect(conjunto?.description).toBe(DESCRIPTION_DOMINANT);
      const plant = rowsOut.find((row) => row.entity_code === SELF_REPORTING);
      // ONS wrote nothing: null, not an empty string and not a stand-in.
      expect(plant?.description).toBeNull();
    });

    it("aggregates nothing to plant grain", async () => {
      const rowsOut = (await body(reasonsPath())).rows as Record<string, unknown>[];
      // The conjunto's ENE is never split across the plants inside it: the only
      // plant-grain row is the plant that reports for itself.
      const plantRows = rowsOut.filter((row) => row.grain === "self_reporting_plant");
      expect(plantRows).toHaveLength(1);
      expect(plantRows[0]?.entity_code).toBe(SELF_REPORTING);
    });

    it("honours the limit, largest first", async () => {
      const payload = await body(reasonsPath("&limit=1"));
      const rowsOut = payload.rows as Record<string, unknown>[];
      expect(rowsOut).toHaveLength(1);
      expect(rowsOut[0]?.constrained_off_mwh).toBe(18);
    });

    it("resolves the civil day rather than a UTC one", async () => {
      // 2026-05-09 in Brasília ends at 2026-05-10T03:00Z, so it contains none
      // of the fixture's hours. A UTC reading of the same date would have
      // swept up 06:00Z and 07:00Z.
      const payload = await body(
        `/v1/curtailment/reasons?subsystem=NE&date=2026-05-09&as_of=${AS_OF_EARLY.toISOString()}`,
      );
      expect(payload.rows).toHaveLength(0);
      expect(payload.data_version).toBe("none");
    });
  });

  it("serves all three with the modelling service unreachable and nothing promoted", async () => {
    expect(process.env.WATTSTEER_ML_URL ?? "").toBe("");
    for (const path of [hoursPath(), episodesPath(), reasonsPath()]) {
      const response = await get(path);
      expect(response.status).toBe(200);
    }
  });

  it("defaults the as-of to now and states it on every answer", async () => {
    for (const path of [
      `/v1/curtailment/hours?subsystem=NE&from=${RANGE_FROM.toISOString()}&to=${RANGE_TO.toISOString()}`,
      `/v1/curtailment/episodes?subsystem=NE&from=${RANGE_FROM.toISOString()}&to=${RANGE_TO.toISOString()}`,
      `/v1/curtailment/reasons?subsystem=NE&date=${DAY}`,
    ]) {
      const payload = await body(path);
      // The cut is on the payload, which is the honesty the default costs.
      expect(new Date(payload.as_of as string).getTime()).toBeGreaterThan(
        AS_OF_LATE.getTime(),
      );
    }
  });
});
