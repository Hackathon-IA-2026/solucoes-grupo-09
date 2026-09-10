import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createDiagnosisRoutes } from "../src/api/diagnosis.js";
import { dailyCap } from "../src/api/plugins/daily-cap.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { memoryStore } from "../src/api/plugins/limit-store.js";
import { memoryLockedCache } from "../src/api/plugins/locked-cache.js";
import { createDatabase } from "../src/database/connection.js";
import {
  type AttributionPublication,
  EVALUABLE_RULE_CODES,
  parseAttributionPublication,
  writeAttributionPublication,
} from "../src/diagnosis/publication.js";
import { groupingHasChanged, readAttributionDayAhead } from "../src/diagnosis/reads.js";
import { parsePublication, writePublication } from "../src/forecast/publication.js";
import {
  ARTIFACT,
  type AttributionPayloadOptions,
  attributionPayload,
  GATE_LATE,
  GROUP_HASH,
  REGIME,
  TARGET_DATE,
} from "./support/attribution-payload.js";

/**
 * The published attribution against real Postgres — diagnosis ticket 06.
 *
 * Gated exactly like the other database suites: `WATTSTEER_TEST_DATABASE_URL`
 * supplies the URL and the default `bun test` skips this file.
 *
 * Five things can only be proved here, and each is an acceptance line rather
 * than an implementation detail:
 *
 * 1. **The round trip.** The rows a publication wrote come back through `AsOf`
 *    as exactly the numbers that were served — `toBe` on doubles, because
 *    "close enough" is the property a re-serve does not have — **and the read
 *    loads no model artifact**, draws no background and solves no game.
 * 2. **The append-only vintage.** An identical republication writes nothing; a
 *    changed one appends a version; and an `as_of` before the second still
 *    returns the first, which is what makes a replay reconstructible.
 * 3. **The publication is one transaction.** A driver row the database refuses
 *    takes the whole publication with it, so a half-written explanation — an
 *    attribution row with seven bars — is not representable.
 * 4. **The valve.** A withheld narration stores its drivers untouched, and the
 *    read returns all eight of them beside the rule that withheld.
 * 5. **The map and the background are on the row**, so a stored attribution
 *    whose grouping has since changed is identifiable rather than silently
 *    re-rendered under a new one.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const publication = (options: AttributionPayloadOptions = {}): AttributionPublication =>
  parseAttributionPublication(attributionPayload(options));

suite("the published attribution · persistence and AsOf (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const NOW = new Date("2024-05-06T23:00:00.000Z");

  const truncate = async () => {
    await db.execute(sql`truncate table diagnosis_attribution_driver`);
    await db.execute(sql`truncate table diagnosis_attribution cascade`);
  };

  beforeAll(truncate);
  beforeEach(truncate);
  afterAll(async () => {
    await truncate();
    await handle.close();
  });

  const read = (
    options: { gateProfile?: "gate_early" | "gate_late"; asOf?: Date } = {},
  ) =>
    readAttributionDayAhead(db, {
      subsystem: "NE",
      targetDate: TARGET_DATE,
      gateProfile: options.gateProfile ?? "gate_late",
      asOf: options.asOf ?? NOW,
    });

  it("round-trips every published number exactly", async () => {
    const published = publication();
    const written = await writeAttributionPublication(db, published, {
      ingestedAt: NOW,
    });
    expect(written.attributionsInserted).toBe(1);
    expect(written.driversInserted).toBe(16);

    const back = await read();
    expect(back).not.toBeNull();
    if (back === null) {
      return;
    }
    const [attribution] = published.attributions;
    if (attribution === undefined) {
      throw new Error("the fixture published nothing");
    }

    expect(back.baselineExpectedMwh).toBe(attribution.baselineExpectedMwh);
    expect(back.dayExpectedMwh).toBe(attribution.dayExpectedMwh);
    expect(back.totalAttributedMwh).toBe(attribution.totalAttributedMwh);
    expect(back.sumAbsAttributedMwh).toBe(attribution.sumAbsAttributedMwh);
    expect(back.attributionStderrMwh).toBe(attribution.attributionStderrMwh);
    expect(back.baselineStderrMwh).toBe(attribution.baselineStderrMwh);
    expect(back.topTwoShare).toBe(attribution.topTwoShare);
    expect(back.hoursAttributed).toBe(24);
    expect(back.target).toBe("expected_mwh_day");
    expect(back.artifactId).toBe(ARTIFACT);
    expect(back.publishedAt.toISOString()).toBe(GATE_LATE);
    expect(back.vintageFidelity).toBe("point_in_time");

    // The eight, ranked, with their φ and their share to the bit.
    const expectedDay = attribution.drivers.filter((one) => one.grain === "day");
    expect(back.drivers).toHaveLength(8);
    for (const [index, stored] of back.drivers.entries()) {
      const source = expectedDay[index];
      expect(stored.code).toBe(source?.driverGroup as string);
      expect(stored.rank).toBe(source?.rank as number);
      expect(stored.phiMwh).toBe(source?.phiMwh as number);
      expect(stored.share).toBe(source?.share as number);
      expect(stored.direction).toBe(source?.direction as "raises" | "lowers");
      expect(stored.hourDisagreement).toBe(source?.hourDisagreement as number);
      expect(stored.observed).toBe(source?.observed as number);
      expect(stored.typical).toBe(source?.typical as number);
      expect(stored.unit).toBe(source?.unit as string);
    }
  });

  it("stores an absent reading as an absence, and never as a zero", async () => {
    // api-surface 10's last box, at the storage layer. `observed` and `typical`
    // used to be NOT NULL, so a driver group whose headline feature was NULL
    // for the day had no publishable pair and the whole day's diagnosis was
    // refused — on 99% of days at real weather-null rates. The absence is now a
    // value, and the property that makes it safe is that it comes back *as* an
    // absence: `Number(null)` is 0, and a 0 here is a reading the screen would
    // format and the reader would compare against `typical`.
    const absent = publication({
      mutate: (payload) => {
        const groups = (payload.attributions as Record<string, unknown>[])[0]
          ?.groups as Record<string, unknown>[];
        const first = groups[0] as Record<string, unknown>;
        first.observed = null;
        first.observed_absent_reason = "null_in_day";
        const second = groups[1] as Record<string, unknown>;
        second.typical = null;
        second.typical_absent_reason = "null_in_background";
      },
    });
    const written = await writeAttributionPublication(db, absent, { ingestedAt: NOW });
    // The whole publication landed: sixteen bars, not fifteen and not none.
    expect(written.driversInserted).toBe(16);

    const back = await read();
    const [first, second, ...rest] = back?.drivers ?? [];
    expect(first?.observed).toBeNull();
    expect(first?.observedAbsentReason).toBe("null_in_day");
    // The other half of the same pair is untouched, and so is the bar itself:
    // φ, sign, share and rank are the model's and a missing subtitle does not
    // reach them.
    expect(first?.typical).not.toBeNull();
    expect(first?.typicalAbsentReason).toBeNull();
    expect(first?.phiMwh).toBe(absent.attributions[0]?.drivers[0]?.phiMwh as number);
    expect(first?.rank).toBe(1);

    expect(second?.typical).toBeNull();
    expect(second?.typicalAbsentReason).toBe("null_in_background");
    expect(second?.observed).not.toBeNull();

    // And nothing else moved.
    for (const one of rest) {
      expect(one.observed).not.toBeNull();
      expect(one.typical).not.toBeNull();
      expect(one.observedAbsentReason).toBeNull();
      expect(one.typicalAbsentReason).toBeNull();
    }
  });

  it("refuses a NULL reading with no reason, and a reason beside a number", async () => {
    // The parse refuses both shapes too; this is the *table* refusing them,
    // which is what makes them unrepresentable rather than merely unwritten by
    // the one path that writes today. A NULL with no reason is a dropped field
    // by another name, and a number beside a reason leaves the reader to pick a
    // half to believe.
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });

    // `db.execute` returns a lazy thenable rather than a promise, so the
    // statement is awaited and the refusal caught rather than handed to
    // `.rejects` — which would pass on a query that never ran.
    // The constraint *name* is the assertion, off `error.cause` exactly as the
    // roll-call tests below read it: a message match would pass on any refusal,
    // including the wrong one.
    const refusedBy = async (statement: SQL): Promise<string | undefined> => {
      try {
        await db.execute(statement);
      } catch (error) {
        return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;
      }
      throw new Error("the statement was accepted");
    };

    expect(
      await refusedBy(sql`
        update diagnosis_attribution_driver
           set observed = null
         where grain = 'day' and rank = 1
      `),
    ).toBe("diagnosis_attribution_driver_observed_or_its_absence");
    expect(
      await refusedBy(sql`
        update diagnosis_attribution_driver
           set typical_absent_reason = 'null_in_background'
         where grain = 'day' and rank = 1
      `),
    ).toBe("diagnosis_attribution_driver_typical_or_its_absence");

    // The positive case beside them, so neither refusal above is the plumbing:
    // the pair moves together and the row is accepted.
    await db.execute(sql`
      update diagnosis_attribution_driver
         set observed = null, observed_absent_reason = 'null_in_day'
       where grain = 'day' and rank = 1
    `);
    const back = await read();
    expect(back?.drivers[0]?.observed).toBeNull();
    expect(back?.drivers[0]?.observedAbsentReason).toBe("null_in_day");
  });

  it("stores the peak hour's own eight beside the day's, not instead of them", async () => {
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });
    const back = await read();
    expect(back?.peakHourLocal).toBe(13);
    expect(back?.peakHourExpectedMwh).toBe(30.5);
    expect(back?.peakHourDrivers).toHaveLength(8);
    // The headline ranking is the day's, and the two blocks are different
    // numbers about the same publication.
    expect(back?.peakHourDrivers.map((one) => one.phiMwh)).not.toEqual(
      back?.drivers.map((one) => one.phiMwh) ?? [],
    );
    // A day figure on an hour row would be a fiction, and the constraint says so.
    for (const driver of back?.peakHourDrivers ?? []) {
      expect(driver.hourDisagreement).toBeNull();
    }
  });

  it("keeps the shares a share of all eight groups", async () => {
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });
    const back = await read();
    const shares = (back?.drivers ?? []).reduce((total, one) => total + one.share, 0);
    expect(shares).toBeCloseTo(1, 12);
    const sumAbs = (back?.drivers ?? []).reduce(
      (total, one) => total + Math.abs(one.phiMwh),
      0,
    );
    expect(sumAbs).toBe(back?.sumAbsAttributedMwh as number);
  });

  it("records the map and the background that produced the row", async () => {
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });
    const back = await read();
    expect(back?.driverGroupHash).toBe(GROUP_HASH);
    expect(back?.driverGroupVersion).toBe("3");
    expect(back?.backgroundSource).toBe("base_fit");
    expect(back?.backgroundSeed).toBe(20_260_828);
    expect(back?.backgroundRows).toBe(128);
    expect(back?.coalitions).toBe(256);
    expect(back?.stderrResamples).toBe(200);

    // The comparison the column exists for: the grouping has moved, the row is
    // still the truth about what was said, and it is identifiable as a row
    // today's labels no longer describe.
    expect(groupingHasChanged(back as { driverGroupHash: string }, "sha256:beef")).toBe(
      true,
    );
  });

  it("tells a row measured against one background apart from another", async () => {
    // The `correction_regime` argument, applied to "typical": the artifact's
    // frozen sample and a seeded draw from the base-fit block are two
    // definitions of a typical hour, and a row that did not name its own could
    // not be told apart from a row that meant something else.
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });
    await writeAttributionPublication(
      db,
      publication({ backgroundSource: "artifact", scale: 1.25 }),
      { ingestedAt: new Date("2024-05-06T23:30:00.000Z") },
    );

    const bySource = await db.execute<{ background_source: string; versions: string }>(
      sql`
        select background_source, string_agg(distinct data_version::text, ',') as versions
        from diagnosis_attribution
        group by background_source
        order by background_source
      `,
    );
    expect([...bySource]).toEqual([
      { background_source: "artifact", versions: "2" },
      { background_source: "base_fit", versions: "1" },
    ]);

    const now = await read({ asOf: new Date("2024-05-07T00:00:00.000Z") });
    expect(now?.backgroundSource).toBe("artifact");
    const earlier = await read({ asOf: NOW });
    expect(earlier?.backgroundSource).toBe("base_fit");
    expect(earlier?.dayExpectedMwh).toBe(412);
  });

  it("appends a vintage on re-publication and writes nothing when nothing changed", async () => {
    const first = await writeAttributionPublication(db, publication(), {
      ingestedAt: NOW,
    });
    expect(first.attributionsInserted).toBe(1);

    const again = await writeAttributionPublication(db, publication(), {
      ingestedAt: new Date("2024-05-06T23:10:00.000Z"),
    });
    expect(again.attributionsUnchanged).toBe(1);
    expect(again.driversInserted).toBe(0);

    const revised = await writeAttributionPublication(
      db,
      publication({ scale: 1.5, artifactId: "2024-05-06T09:00:00Z" }),
      { ingestedAt: new Date("2024-05-06T23:20:00.000Z") },
    );
    expect(revised.attributionsRevised).toBe(1);

    const versions = await db.execute<{ data_version: number; run_label: string }>(sql`
      select data_version, run_label from diagnosis_attribution order by data_version
    `);
    expect([...versions].map((row) => Number(row.data_version))).toEqual([1, 2]);

    // The older vintage is still there, at its own as-of, unchanged — which is
    // the whole of "a model that has since been retrained cannot be asked what
    // it used to think".
    const before = await read({ asOf: NOW });
    expect(before?.dataVersion).toBe(1);
    expect(before?.dayExpectedMwh).toBe(412);
    expect(before?.artifactId).toBe(ARTIFACT);
    const after = await read({ asOf: new Date("2024-05-07T00:00:00.000Z") });
    expect(after?.dataVersion).toBe(2);
    expect(after?.dayExpectedMwh).toBe(618);
    // Every driver of the newer vintage is the newer one's — the join is on the
    // version, so two vintages cannot be read as one ranking.
    expect(after?.drivers).toHaveLength(8);
    expect(after?.drivers[0]?.phiMwh).toBe(192);
    expect(before?.drivers[0]?.phiMwh).toBe(128);
  });

  it("returns the drivers untouched when a rule withheld the narration", async () => {
    await writeAttributionPublication(
      db,
      publication({
        ruleFlags: [
          {
            code: "attribution_is_noise",
            action: "withhold",
            facts: { sum_abs_attributed_mwh: 404, stderr_mwh: 300 },
          },
        ],
        demoted: ["data_conditions"],
      }),
      { ingestedAt: NOW },
    );
    const back = await read();
    expect(back?.drivers).toHaveLength(8);
    expect(back?.peakHourDrivers).toHaveLength(8);
    expect(back?.governingRuleAction).toBe("withhold");
    expect(back?.ruleFlags).toEqual([
      {
        code: "attribution_is_noise",
        action: "withhold",
        facts: { sum_abs_attributed_mwh: 404, stderr_mwh: 300 },
      },
    ]);
    // A demoted bar keeps its contribution, its sign and its share.
    const demoted = back?.drivers.find((one) => one.code === "data_conditions");
    expect(demoted?.demoted).toBe(true);
    expect(demoted?.phiMwh).toBe(-4);
    expect(demoted?.direction).toBe("lowers");
  });

  it("never returns a reconstruction from the day-ahead read", async () => {
    await writeAttributionPublication(
      db,
      publication({ originKind: "backfilled_holdout", scale: 2 }),
      { ingestedAt: NOW },
    );
    expect(await read()).toBeNull();

    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });
    const back = await read();
    expect(back?.dayExpectedMwh).toBe(412);
  });

  it("keeps the early and the late gate as two explanations of one day", async () => {
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });
    await writeAttributionPublication(
      db,
      publication({ gateProfile: "gate_early", scale: 0.5 }),
      { ingestedAt: NOW },
    );
    const late = await read();
    const early = await read({ gateProfile: "gate_early" });
    expect(late?.dayExpectedMwh).toBe(412);
    expect(early?.dayExpectedMwh).toBe(206);
    expect(early?.dataVersion).toBe(1);
  });

  it("writes the whole publication or none of it", async () => {
    // A driver row the database refuses — `rank` outside 1–8 — must take the
    // attribution row with it. The alternative is an explanation with seven
    // bars, which is exactly what the valve says cannot exist.
    const torn = publication();
    const [attribution] = torn.attributions;
    if (attribution?.drivers[0] === undefined) {
      throw new Error("the fixture published nothing");
    }
    attribution.drivers[0].rank = 99;

    await expect(
      writeAttributionPublication(db, torn, { ingestedAt: NOW }),
    ).rejects.toThrow();

    const rows = await db.execute<{ rows: number }>(
      sql`select count(*)::int as rows from diagnosis_attribution`,
    );
    expect([...rows][0]?.rows).toBe(0);
    const drivers = await db.execute<{ rows: number }>(
      sql`select count(*)::int as rows from diagnosis_attribution_driver`,
    );
    expect([...drivers][0]?.rows).toBe(0);
  });

  it("refuses a driver row that belongs to no publication", async () => {
    // The foreign key, stated as a test: sixteen bars with nothing saying what
    // they decompose is the other half of a torn write.
    const orphan = async () =>
      db.execute(sql`
        insert into diagnosis_attribution_driver (
          subsystem, target_date, origin_kind, gate_profile, data_version, grain,
          driver_group, label_code, rank, phi_mwh, share, direction,
          hour_disagreement, headline_feature, observed, typical, unit, demoted
        ) values (
          'NE', ${TARGET_DATE}::date, 'served', 'gate_late', 1, 'day',
          'net_surplus', 'driver.net_surplus', 1, 128, 0.31, 'raises',
          1.1, 'proxy_renewable_load_ratio', 1.42, 0.96, 'ratio', false
        )
      `);
    await expect(orphan()).rejects.toThrow();
  });

  it("refuses an explanation published after the day it explains", async () => {
    const late = publication({ publishedAt: "2024-05-07T12:00:00.000Z" });
    await expect(
      writeAttributionPublication(db, late, { ingestedAt: NOW }),
    ).rejects.toThrow(/explains/);
  });

  it("refuses a stored attribution that names no grouping", async () => {
    // The hash is what a changed grouping is recognised by, so a row carrying
    // an empty one carries nothing. Set past the parser, which only asks for a
    // string, and stopped by the constraint, which is the guarantee.
    const anonymous = publication();
    const [attribution] = anonymous.attributions;
    if (attribution === undefined) {
      throw new Error("the fixture published nothing");
    }
    attribution.driverGroupHash = "";
    await expect(
      writeAttributionPublication(db, anonymous, { ingestedAt: NOW }),
    ).rejects.toThrow();
  });

  it("refuses a stored attribution that names no evaluated rules", async () => {
    // `.scratch/api-surface/issues/10-forecast-publication.md`'s third box, at
    // the layer that is the guarantee rather than the diagnosis. Set past the
    // parser — which refuses the same thing — so what is measured here is the
    // table's own answer to a second writer that never ran the rules.
    //
    // Non-vacuity first: the same publication with its roll call intact lands.
    const quiet = publication();
    const landed = await writeAttributionPublication(db, quiet, { ingestedAt: NOW });
    expect(landed.attributionsInserted).toBe(1);
    const stored = await db.execute<{ roll: string[]; flags: unknown }>(sql`
      select rules_evaluated as roll, rule_flags as flags from diagnosis_attribution
    `);
    // A quiet day: four rules looked, none fired. Two different facts, and now
    // two different columns.
    expect([...stored][0]?.roll).toEqual([...EVALUABLE_RULE_CODES]);
    expect([...stored][0]?.flags).toEqual([]);

    const skipped = publication({ subsystem: "S" });
    const [attribution] = skipped.attributions;
    if (attribution === undefined) {
      throw new Error("the fixture published nothing");
    }
    attribution.rulesEvaluated = [];
    const refusal = await writeAttributionPublication(db, skipped, {
      ingestedAt: NOW,
    }).then(
      () => undefined,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause,
    );
    expect(refusal?.constraint_name).toBe("diagnosis_attribution_the_rules_ran");
  });

  it("refuses a stored attribution whose flags were never evaluated", async () => {
    // The other half of the record. A flag list from one run beside a roll call
    // from another is a record of nothing, and the constraint says so through
    // `rule_flags_were_evaluated` — a function because a CHECK may not hold the
    // subquery this test needs.
    const mismatched = publication({
      ruleFlags: [
        {
          code: "stale_inputs",
          action: "annotate",
          facts: { weather_run_age_hours: 12 },
        },
      ],
    });
    const [attribution] = mismatched.attributions;
    if (attribution === undefined) {
      throw new Error("the fixture published nothing");
    }
    attribution.rulesEvaluated = ["nothing_to_explain"];
    const refusal = await writeAttributionPublication(db, mismatched, {
      ingestedAt: NOW,
    }).then(
      () => undefined,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause,
    );
    expect(refusal?.constraint_name).toBe("diagnosis_attribution_flags_were_evaluated");
    // Non-vacuity: the same flag with an honest roll call lands.
    const honest = await writeAttributionPublication(
      db,
      publication({
        subsystem: "N",
        ruleFlags: [
          {
            code: "stale_inputs",
            action: "annotate",
            facts: { weather_run_age_hours: 12 },
          },
        ],
      }),
      { ingestedAt: NOW },
    );
    expect(honest.attributionsInserted).toBe(1);
  });

  it("stores a payload the modelling service actually emitted", async () => {
    // The cross-language seam, all the way to the table:
    // `test/fixtures/diagnosis/attribution.json` is a real payload from
    // `wattsteer_ml.diagnosis.publication`, and what is asserted is that it
    // lands — every column, every constraint — rather than that a fixture
    // written in TypeScript does.
    const vector = parseAttributionPublication(
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "fixtures", "diagnosis", "attribution.json"),
          "utf8",
        ),
      ),
    );
    const written = await writeAttributionPublication(db, vector, {
      ingestedAt: new Date("2026-03-03T22:30:00.000Z"),
    });
    expect(written.attributionsInserted).toBe(1);
    expect(written.driversInserted).toBe(16);

    const back = await readAttributionDayAhead(db, {
      subsystem: "NE",
      targetDate: vector.targetDate,
      gateProfile: "gate_late",
      asOf: new Date("2026-03-04T00:00:00.000Z"),
    });
    expect(back?.drivers).toHaveLength(8);
    expect(back?.peakHourDrivers).toHaveLength(8);
    expect(back?.dayExpectedMwh).toBe(vector.attributions[0]?.dayExpectedMwh as number);
    expect(back?.backgroundSource).toBe("base_fit");
  });

  it("reads a past day back without anything that could load a model", async () => {
    // The acceptance line, as a mechanism rather than a claim: the read path
    // imports the canonical views and nothing else, and the numbers it returns
    // are the stored ones. There is no artifact on this machine and the read
    // does not notice.
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });
    const back = await read({ asOf: new Date("2026-01-01T00:00:00.000Z") });
    expect(back?.dayExpectedMwh).toBe(412);
    expect(back?.drivers.map((one) => one.code)).toEqual([
      "net_surplus",
      "renewable_resource",
      "demand_level",
      "export_stress",
      "ramp_shape",
      "calendar_season",
      "recent_history",
      "data_conditions",
    ]);
  });
});

/**
 * The route over the two stored rows — api-surface ticket 15's first line.
 *
 * `.scratch/api-surface/issues/15-diagnosis-endpoint.md`: *"The route returns a
 * 200 with the modelling service's URL unset, resolving the attribution from
 * Postgres alone."* `diagnosis-day-ahead.test.ts` proves the shaping and the
 * single-flight against injected rows; what only this file can prove is that
 * the rows a publication wrote come back **through the route**, with no
 * modelling service configured and none reachable.
 *
 * The language model is stood in for by a call that throws. That is not a
 * weaker test, it is the honest one: this suite's subject is the attribution
 * half, and the paragraph is the other half's. An outage renders the template,
 * which is a 200 with the drivers untouched — so what is asserted here is that
 * the eight bars survive a day on which nothing else worked.
 */
const forecastFor = (): Record<string, unknown> => {
  // The local day starts at 03:00Z while Brazil observes no summer time.
  const hours = Array.from({ length: 24 }, (_value, hour) => ({
    subsystem: "NE",
    valid_time: new Date(Date.UTC(2024, 4, 7, 3 + hour)).toISOString(),
    target_date: TARGET_DATE,
    local_hour: hour,
    threshold_mw: 5,
    occurrence_probability: hour === 14 ? 0.72 : 0.08,
    p10_mwh: 0,
    p50_mwh: hour === 14 ? 40 : 0,
    p90_mwh: hour === 14 ? 120 : 10,
    // Whole numbers, so the day's expectation is 412 exactly and the
    // attribution's `day_expected_mwh` and this one are one publication rather
    // than two numbers that nearly agree.
    expected_mwh: hour === 14 ? 366 : 2,
    p50_wind_mwh: hour === 14 ? 32 : 0,
    p50_solar_mwh: hour === 14 ? 8 : 0,
    expected_wind_mwh: hour === 14 ? 300 : 1,
    expected_solar_mwh: hour === 14 ? 66 : 1,
    crossed: false,
    derivation: "hurdle_mixture",
    correction_regime: REGIME,
  }));
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
      origin_kind: "served",
      gate_profile: "gate_late",
    },
    artifact: {
      artifact_id: ARTIFACT,
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
        day_total: { p10: 12, p50: 260, p90: 300 },
        peak_power: { p10: 4, p50: 96, p90: 180 },
        day_occurrence_probability: 0.89,
        expected_mwh: 412,
        expected_wind_mwh: 323,
        expected_solar_mwh: 89,
        hours_p50_nonzero: 1,
        derivation: "path_ensemble",
        ensemble_draws: 500,
        ensemble_seed: 20_260_828,
        ensemble_calibration_days: 90,
        correction_regime: REGIME,
      },
    ],
  };
};

suite("/v1/diagnosis/day-ahead · over the stored rows (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const NOW = new Date("2024-05-06T23:00:00.000Z");
  const ASK_AT = new Date("2024-05-07T02:00:00.000Z");
  let priorMlUrl: string | undefined;

  const truncate = async () => {
    await db.execute(sql`truncate table diagnosis_attribution_driver`);
    await db.execute(sql`truncate table diagnosis_attribution cascade`);
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
  };

  beforeAll(async () => {
    priorMlUrl = process.env.WATTSTEER_ML_URL;
    delete process.env.WATTSTEER_ML_URL;
    await truncate();
  });
  beforeEach(truncate);
  afterAll(async () => {
    await truncate();
    await handle.close();
    if (priorMlUrl === undefined) {
      delete process.env.WATTSTEER_ML_URL;
    } else {
      process.env.WATTSTEER_ML_URL = priorMlUrl;
    }
  });

  const ask = (query: string): Promise<Response> =>
    new Elysia()
      .use(errorHandler)
      .use(
        createDiagnosisRoutes({
          db,
          now: () => ASK_AT,
          narration: {
            store: memoryLockedCache(),
            cap: dailyCap({ name: "narration", limit: 200, store: memoryStore() }),
            messages: {
              create: async () => {
                throw new Error("no model is reachable from this suite");
              },
            },
          },
        }),
      )
      .handle(new Request(`http://localhost/v1/diagnosis/day-ahead${query}`));

  it("answers 200 from Postgres with the modelling service's URL unset", async () => {
    expect(process.env.WATTSTEER_ML_URL).toBeUndefined();
    await writePublication(db, parsePublication(forecastFor()), { ingestedAt: NOW });
    await writeAttributionPublication(db, publication(), { ingestedAt: NOW });

    const response = await ask(`?subsystem=NE&date=${TARGET_DATE}`);
    expect(response.status).toBe(200);
    const wire = (await response.json()) as {
      subsystem: string;
      target_date: string;
      vintage_fidelity: string;
      forecast_origin: { origin_kind: string; gate_profile: string };
      attribution: {
        day_expected_mwh: number;
        drivers: { code: string; share: number }[];
        peak_hour_drivers: unknown[];
      };
      withheld_by: string[];
      narration: { source: string; locale: string };
    };
    expect(wire.subsystem).toBe("NE");
    expect(wire.target_date).toBe(TARGET_DATE);
    expect(wire.vintage_fidelity).toBe("point_in_time");
    expect(wire.forecast_origin.origin_kind).toBe("served");
    expect(wire.attribution.day_expected_mwh).toBe(412);
    // All eight, ranked, exactly as they were stored: the display cut is the
    // client's and this route has no branch that could apply it.
    expect(wire.attribution.drivers).toHaveLength(8);
    expect(wire.attribution.drivers[0]?.code).toBe("net_surplus");
    expect(wire.attribution.peak_hour_drivers).toHaveLength(8);
    expect(wire.withheld_by).toEqual([]);
    // The model was unreachable, so the deterministic surface rendered — and
    // the response says so rather than pretending otherwise.
    expect(wire.narration.source).toBe("template");
    expect(wire.narration.locale).toBe("pt-BR");
    expect(response.headers.get("vary")).toBe("Accept-Language");
  });

  it("answers the distinct code when the forecast exists and the attribution does not", async () => {
    await writePublication(db, parsePublication(forecastFor()), { ingestedAt: NOW });
    const response = await ask(`?subsystem=NE&date=${TARGET_DATE}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "DIAGNOSIS_UNAVAILABLE" },
    });
  });

  it("carries a withheld day's drivers untouched, as a 200", async () => {
    await writePublication(db, parsePublication(forecastFor()), { ingestedAt: NOW });
    await writeAttributionPublication(
      db,
      publication({
        ruleFlags: [
          {
            code: "attribution_is_noise",
            action: "withhold",
            facts: { sum_abs_attributed_mwh: 289.5, attribution_stderr_mwh: 4.1 },
          },
        ],
      }),
      { ingestedAt: NOW },
    );
    const response = await ask(`?subsystem=NE&date=${TARGET_DATE}`);
    expect(response.status).toBe(200);
    const wire = (await response.json()) as {
      withheld_by: string[];
      attribution: { drivers: unknown[] };
      narration: { source: string };
    };
    expect(wire.withheld_by).toEqual(["attribution_is_noise"]);
    expect(wire.attribution.drivers).toHaveLength(8);
    expect(wire.narration.source).toBe("template");
  });
});
