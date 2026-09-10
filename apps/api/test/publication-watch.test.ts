import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATES, localWallClock } from "@wattsteer/core/schedule";
import { sql } from "drizzle-orm";
import { config } from "../src/config.js";
import { createDatabase } from "../src/database/connection.js";
import { gateAt } from "../src/forecast/gate.js";
import {
  type ForecastGateProfile,
  parsePublication,
  writePublication,
} from "../src/forecast/publication.js";
import {
  classifyPublicationWatch,
  type DuePublication,
  mostRecentDuePublication,
  PUBLICATION_GRACE_MS,
  readPublicationWatch,
  watchPublications,
} from "../src/forecast/publication-watch.js";
import { PUBLISH_TIMEOUT_MS } from "../src/forecast/publish.js";
import type { PublishedOrigin } from "../src/forecast/reads.js";
import { FORECAST_PUBLICATIONS } from "../src/jobs/publication.js";
import { assertClaim, type Claim, measuring, publish } from "./support/conformance.js";

/**
 * The publication that did not happen.
 *
 * Four suites in one file, because they are four halves of one question and
 * splitting them would let three of them drift away from the fourth:
 *
 * 1. **The margin** — two derived bounds that keep `PUBLICATION_GRACE_MS`
 *    honest when a gate hour, a cron or a retry policy moves. Offline.
 * 2. **The verdict** — the classifier shown *firing* on a genuinely late
 *    publication and *staying quiet* on a healthy one, plus the no-data case
 *    that would otherwise scream from an empty database. Offline, because a
 *    guard whose failing case can only be produced by waiting two hours for a
 *    real gate to pass is a guard nobody re-checks.
 * 3. **The schedule** — the two crons in
 *    `.github/workflows/publication-watch.yml` derived from `GATES` and the
 *    margin, and asserted against the file. This repo found five places where
 *    a gate interval was stated wrongly; a workflow that fires two hours early
 *    against a schedule that moved would be the sixth.
 * 4. **The alarm itself** — gated on `WATTSTEER_PUBLICATION_WATCH`, pointed at
 *    a real deployment's Postgres, and reported in the same `Claim` vocabulary
 *    the other two scheduled suites use. This is what
 *    `.github/workflows/publication-watch.yml` runs.
 *
 * A fifth section runs against real Postgres under `WATTSTEER_TEST_DATABASE_URL`
 * and is the one that proves the *read* — that the census and the origins come
 * back non-empty from a database that has rows, so an empty result can never
 * be mistaken for a healthy one.
 *
 *   docker run -d -p 5436:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */

const MS_PER_HOUR = 3_600_000;

/** An origin, in the shape `/v1/meta`'s read returns. */
const origin = (
  targetDate: string,
  gateProfile: ForecastGateProfile,
  subsystems: string[] = ["NE"],
): PublishedOrigin => ({
  targetDate,
  gateProfile,
  publishedAt: gateAt(targetDate, gateProfile),
  subsystems: subsystems as PublishedOrigin["subsystems"],
});

describe("the missed-publication watch · the margin", () => {
  /**
   * The whole of the automatic-recovery window, computed rather than assumed:
   * the job's own offset past the gate, plus every attempt at its timeout,
   * plus the exponential waits between them. Below this an alarm reports a
   * job that has not finished trying; above it, nothing else is coming.
   */
  const recoveryWindowMs = (): number => {
    const offsets = FORECAST_PUBLICATIONS.map((schedule) => {
      const [minute, hour] = schedule.pattern.split(" ");
      const gate = GATES.find((entry) => entry.profile === schedule.payload.gateProfile);
      if (gate === undefined) {
        throw new Error(`${schedule.id} names no published gate`);
      }
      const [gateHour, gateMinute] = gate.publishesAtLocal.split(":");
      const jobMinutes = Number(hour) * 60 + Number(minute);
      const gateMinutes = Number(gateHour) * 60 + Number(gateMinute);
      return (jobMinutes - gateMinutes) * 60_000;
    });
    const backoffMs = Array.from(
      { length: Math.max(0, config.jobAttempts - 1) },
      (_value, index) => config.jobBackoffMs * 2 ** index,
    ).reduce((total, wait) => total + wait, 0);
    return Math.max(...offsets) + config.jobAttempts * PUBLISH_TIMEOUT_MS + backoffMs;
  };

  /** The shortest wait between two consecutive gates, off the gate table. */
  const shortestGateIntervalMs = (): number => {
    const instants = ["2026-01-14", "2026-01-15", "2026-01-16"]
      .flatMap((date) => GATES.map((gate) => localWallClock(date, gate.publishesAtLocal)))
      .map((instant) => instant.getTime())
      .sort((a, b) => a - b);
    return Math.min(
      ...instants.slice(1).map((instant, index) => instant - (instants[index] as number)),
    );
  };

  it("is above every automatic recovery the publication has", () => {
    const recovery = recoveryWindowMs();
    // Non-vacuous: the window is a real duration built out of a real offset,
    // not a zero that any margin would clear.
    expect(recovery).toBeGreaterThan(config.jobAttempts * PUBLISH_TIMEOUT_MS);
    expect(PUBLICATION_GRACE_MS).toBeGreaterThan(recovery);
  });

  it("is below the shortest interval between two gates, so a miss cannot be masked", () => {
    const interval = shortestGateIntervalMs();
    expect(interval).toBeGreaterThan(0);
    expect(PUBLICATION_GRACE_MS).toBeLessThan(interval);
    publish("the missed-publication margin", [
      `margin                     : ${PUBLICATION_GRACE_MS / MS_PER_HOUR} h`,
      `automatic-recovery window  : ${(recoveryWindowMs() / 60_000).toFixed(2)} min`,
      `shortest gate-to-gate wait : ${interval / MS_PER_HOUR} h`,
    ]);
  });
});

describe("the missed-publication watch · the verdict", () => {
  /** 21:30 BRT on 2024-04-04 — half an hour past the late gate's margin. */
  const NOW = new Date("2024-04-05T00:30:00.000Z");

  const due = (): DuePublication => mostRecentDuePublication(NOW);

  it("names the gate whose margin has just elapsed, and never an hour of its own", () => {
    const answer = due();
    expect(answer.gateProfile).toBe("gate_late");
    expect(answer.targetDate).toBe("2024-04-05");
    // Derived, not restated: the same call the publisher and the table's own
    // CHECK are written against.
    expect(answer.gateAt.getTime()).toBe(gateAt("2024-04-05", "gate_late").getTime());
    expect(answer.dueAt.getTime()).toBe(answer.gateAt.getTime() + PUBLICATION_GRACE_MS);
  });

  it("does not answer for a gate whose margin has not elapsed", () => {
    // One minute before the margin, the late gate is not yet answerable for
    // and the answer is the *previous* gate. An alarm that fired here would
    // be alarming on a job that is still allowed to be running.
    const early = new Date(
      gateAt("2024-04-05", "gate_late").getTime() + PUBLICATION_GRACE_MS - 60_000,
    );
    const answer = mostRecentDuePublication(early);
    expect(answer.gateProfile).toBe("gate_early");
    expect(answer.targetDate).toBe("2024-04-05");
  });

  it("stays quiet when the gate has an origin behind it", () => {
    const report = classifyPublicationWatch(
      due(),
      {
        servedDayRows: 96,
        origins: [origin("2024-04-05", "gate_late"), origin("2024-04-05", "gate_early")],
      },
      NOW,
    );
    expect(report.verdict).toBe("published");
    expect(report.matched?.subsystems).toEqual(["NE"]);
    expect(report.hoursPastDue).toBeNull();
  });

  it("fires when the gate passed and nothing published", () => {
    const report = classifyPublicationWatch(
      due(),
      {
        // The deployment has published before — yesterday, and the day before.
        servedDayRows: 96,
        origins: [origin("2024-04-04", "gate_late"), origin("2024-04-04", "gate_early")],
      },
      NOW,
    );
    expect(report.verdict).toBe("late");
    expect(report.hoursPastDue).toBe(0.5);
    expect(report.observed).toContain("has no served origin");
    expect(report.observed).toContain("published before and stopped");
  });

  it("is not satisfied by the other gate of the same day", () => {
    // The sharp case, and the reason the match is on the pair rather than on
    // the date: the early publication for 2024-04-05 exists and the late one
    // does not. A watch keyed on the target date alone would report the day
    // as covered by a vintage that is ten hours older than the one owed.
    const report = classifyPublicationWatch(
      due(),
      { servedDayRows: 48, origins: [origin("2024-04-05", "gate_early")] },
      NOW,
    );
    expect(report.verdict).toBe("late");
  });

  it("says 'never published' rather than 'late' when no row has ever been written", () => {
    // Today's real state: the database has zero ingested rows. An alarm that
    // fired here would be screaming continuously and would be switched off
    // inside a week, so it says the other true sentence instead.
    const report = classifyPublicationWatch(
      due(),
      { servedDayRows: 0, origins: [] },
      NOW,
    );
    expect(report.verdict).toBe("never_published");
    expect(report.observed).toContain("has never published");
    expect(report.hoursPastDue).toBeNull();
  });

  it("refuses a read whose two halves disagree, rather than reporting it as never live", () => {
    // The one way an empty answer could pass as a healthy one: a census that
    // came back zero beside origins that did not. That is a broken read, and
    // a broken read draws no verdict at all.
    expect(() =>
      classifyPublicationWatch(
        due(),
        { servedDayRows: 0, origins: [origin("2024-04-05", "gate_late")] },
        NOW,
      ),
    ).toThrow(/incoherent/);
  });
});

describe("the missed-publication watch · the schedule", () => {
  const WORKFLOW = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    ".github",
    "workflows",
    "publication-watch.yml",
  );

  /** The cron a gate's margin falls at, in UTC, derived and never typed. */
  const cronFor = (profile: ForecastGateProfile, referenceDate: string): string => {
    const targetDate = new Date(Date.parse(`${referenceDate}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const at = new Date(gateAt(targetDate, profile).getTime() + PUBLICATION_GRACE_MS);
    return `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`;
  };

  it("fires at each gate plus the margin, in January and in July alike", () => {
    // Both halves of the year, because a daily cron is a fixed UTC hour and
    // Brazil reinstating summer time would make one of the two wrong. Better
    // that this fails than that the watch quietly asks an hour early.
    for (const gate of GATES) {
      const profile = gate.profile as ForecastGateProfile;
      expect(cronFor(profile, "2026-07-15")).toBe(cronFor(profile, "2026-01-15"));
    }
  });

  it("is the schedule the workflow actually carries", () => {
    const yaml = readFileSync(WORKFLOW, "utf8");
    const declared = [...yaml.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);
    // Non-vacuous: the file has crons at all, and as many as there are gates.
    expect(declared.length).toBe(GATES.length);
    const derived = GATES.map((gate) =>
      cronFor(gate.profile as ForecastGateProfile, "2026-01-15"),
    );
    expect([...declared].sort()).toEqual([...derived].sort());
  });

  it("never runs on push, and asks the question on demand", () => {
    const yaml = readFileSync(WORKFLOW, "utf8");
    expect(yaml).toContain("workflow_dispatch");
    expect(yaml).toContain("Never on push");
    expect(yaml).not.toMatch(/^\s{2}push:/m);
    expect(yaml).not.toMatch(/^\s{2}pull_request:/m);
  });
});

const DB_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const dbSuite = DB_URL ? describe : describe.skip;

dbSuite("the missed-publication watch · the read (real Postgres)", () => {
  const handle = createDatabase(DB_URL as string, 5);
  const { db } = handle;
  /** 21:30 BRT on 2024-04-04 — half an hour past the late gate's margin. */
  const NOW = new Date("2024-04-05T00:30:00.000Z");
  const ARTIFACT = "2024-04-04T03:11:07Z";
  const REGIME = "conformal_v1_partial_upper";

  /** One lane-day, stamped at its own gate so `0041` admits it. */
  const payload = (targetDate: string, gateProfile: ForecastGateProfile) => {
    const dayStart = Date.parse(`${targetDate}T03:00:00.000Z`);
    const hours = Array.from({ length: 24 }, (_value, hour) => ({
      subsystem: "NE",
      valid_time: new Date(dayStart + hour * MS_PER_HOUR).toISOString(),
      target_date: targetDate,
      local_hour: hour,
      threshold_mw: 5,
      occurrence_probability: hour === 14 ? 0.72 : 0.08,
      p10_mwh: 0,
      p50_mwh: hour === 14 ? 40.25 : 0,
      p90_mwh: hour === 14 ? 120.5 : 10.125,
      expected_mwh: hour === 14 ? 30.5 : 2.25,
      p50_wind_mwh: hour === 14 ? 32.2 : 0,
      p50_solar_mwh: hour === 14 ? 8.05 : 0,
      expected_wind_mwh: hour === 14 ? 24.4 : 1.8,
      expected_solar_mwh: hour === 14 ? 6.1 : 0.45,
      crossed: false,
      derivation: "hurdle_mixture",
      correction_regime: REGIME,
    }));
    const expected = hours.reduce((total, hour) => total + hour.expected_mwh, 0);
    return {
      lane: `dessem_free_v1__${gateProfile}__thr5`,
      feature_set: "dessem_free_v1",
      threshold_mw: 5,
      target_date: targetDate,
      correction_regime: REGIME,
      forecast_origin: {
        producer: "wattsteer",
        run_label: ARTIFACT,
        // The gate, called rather than written down — which is also what makes
        // this fixture agree with the table's own CHECK.
        published_at: gateAt(targetDate, gateProfile).toISOString(),
        origin_kind: "served",
        gate_profile: gateProfile,
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
          target_date: targetDate,
          threshold_mw: 5,
          day_total: { p10: 12.5, p50: 260.75, p90: 300.125 },
          peak_power: { p10: 4.5, p50: 96.25, p90: 180.75 },
          day_occurrence_probability: 0.89,
          expected_mwh: expected,
          expected_wind_mwh: hours.reduce((t, h) => t + h.expected_wind_mwh, 0),
          expected_solar_mwh: hours.reduce((t, h) => t + h.expected_solar_mwh, 0),
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

  const write = (targetDate: string, gateProfile: ForecastGateProfile) =>
    writePublication(db, parsePublication(payload(targetDate, gateProfile)), {
      ingestedAt: new Date("2024-04-04T22:05:00.000Z"),
    });

  const clear = async () => {
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
  };

  beforeEach(clear);

  afterAll(async () => {
    await clear();
    await handle.close();
  });

  it("reports an empty deployment as never published, not as late", async () => {
    const inputs = await readPublicationWatch(db, { asOf: NOW });
    // The empty read is asserted to *be* empty before the verdict is drawn,
    // so "never published" is a measurement rather than a query that failed.
    expect(inputs.servedDayRows).toBe(0);
    expect(inputs.origins).toEqual([]);
    const report = await watchPublications(db, { now: NOW });
    expect(report.verdict).toBe("never_published");
  });

  it("stays quiet on a real publication stamped at the gate", async () => {
    const written = await write("2024-04-05", "gate_late");
    expect(written.daysInserted).toBe(1);
    expect(written.hoursInserted).toBe(24);

    const inputs = await readPublicationWatch(db, { asOf: NOW });
    // Non-empty inputs, asserted: the quiet verdict below is drawn from rows
    // that came back, not from a query that returned nothing.
    expect(inputs.servedDayRows).toBe(1);
    expect(inputs.origins.length).toBe(1);

    const report = await watchPublications(db, { now: NOW });
    expect(report.verdict).toBe("published");
    expect(report.matched?.targetDate).toBe("2024-04-05");
    expect(report.matched?.publishedAt.toISOString()).toBe(
      gateAt("2024-04-05", "gate_late").toISOString(),
    );
    expect(report.matched?.subsystems).toEqual(["NE"]);
  });

  it("fires on a deployment that published yesterday and not today", async () => {
    await write("2024-04-04", "gate_late");

    const inputs = await readPublicationWatch(db, { asOf: NOW });
    expect(inputs.servedDayRows).toBe(1);
    expect(inputs.origins.length).toBe(1);

    const report = await watchPublications(db, { now: NOW });
    expect(report.verdict).toBe("late");
    expect(report.hoursPastDue).toBe(0.5);
    expect(report.observed).toContain("2024-04-04");
    expect(report.observed).toContain("older vintage");
  });
});

/**
 * The claim the scheduled run measures. It is not a research note about a
 * source — it is the spec's own promise about this deployment, which is the
 * same kind of object: a sentence that is true until the world stops making it
 * true, with code behind it that breaks when it does.
 */
const PUBLISHED_ON_SCHEDULE: Claim = {
  note: "docs/specs/api-surface.md",
  section: 'Where this spec is weakest (1) — "a publication failure with no alarm"',
  claim:
    "Ten minutes after each gate the worker publishes tomorrow's forecast, so " +
    "every gate instant that has passed by more than the stated margin has a " +
    "served origin stamped at exactly that instant.",
  breaks:
    "The product serves an older vintage with an honest age and nobody is told: " +
    "/v1/forecast/day-ahead, /v1/grid/outlook and the Overview all render " +
    "yesterday's numbers, and /v1/diagnosis/day-ahead explains a day the " +
    "forecast no longer describes.",
  code: "apps/api/src/jobs/publication.ts, apps/api/src/forecast/publish.ts",
};

const WATCHING = process.env.WATTSTEER_PUBLICATION_WATCH === "1";
const liveSuite = WATCHING ? describe : describe.skip;

liveSuite("the missed-publication watch · the deployment", () => {
  it(
    "has an origin behind the last gate whose margin has elapsed",
    measuring("the deployment's Postgres", async () => {
      const url = process.env.WATTSTEER_WATCH_DATABASE_URL;
      if (!url) {
        // Reported as unreachable rather than skipped, because a watch that
        // did not look is not a watch that saw nothing wrong.
        throw new Error(
          "WATTSTEER_WATCH_DATABASE_URL is not set, so no deployment was read.",
        );
      }
      const handle = createDatabase(url, 2);
      try {
        const now = new Date();
        const report = await watchPublications(handle.db, { now });
        publish(
          report.verdict === "never_published"
            ? "NOT YET LIVE — the missed-publication watch"
            : "the missed-publication watch",
          [
            `as of      : ${now.toISOString()}`,
            `gate owed  : ${report.due.gateProfile} for ${report.due.targetDate}`,
            `gate at    : ${report.due.gateAt.toISOString()}`,
            `answerable : ${report.due.dueAt.toISOString()} (margin ${
              PUBLICATION_GRACE_MS / MS_PER_HOUR
            } h)`,
            `served rows: ${report.servedDayRows}`,
            `verdict    : ${report.verdict}`,
            `observed   : ${report.observed}`,
          ],
        );
        assertClaim(PUBLISHED_ON_SCHEDULE, report.verdict !== "late", report.observed);
      } finally {
        await handle.close();
      }
    }),
  );
});
