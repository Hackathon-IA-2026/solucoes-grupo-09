import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import {
  type AttributionPublication,
  parseAttributionPublication,
  writeAttributionPublication,
} from "../src/diagnosis/publication.js";
import { groupingHasChanged, readAttributionDayAhead } from "../src/diagnosis/reads.js";
import {
  ARTIFACT,
  type AttributionPayloadOptions,
  attributionPayload,
  GATE_LATE,
  GROUP_HASH,
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
