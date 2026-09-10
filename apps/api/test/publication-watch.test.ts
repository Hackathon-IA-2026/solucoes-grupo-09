import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GATES, localWallClock } from "@wattsteer/core/schedule";
import { sql } from "drizzle-orm";
import { config } from "../src/config.js";
import { createDatabase } from "../src/database/connection.js";
import {
  parseAttributionPublication,
  writeAttributionPublication,
} from "../src/diagnosis/publication.js";
import { PUBLISH_DIAGNOSIS_TIMEOUT_MS } from "../src/diagnosis/publish.js";
import {
  DIAGNOSIS_REFUSAL_CONDITIONS,
  type DiagnosisRefusalCondition,
  type DiagnosisRefusalRecord,
  recordDiagnosisRefusal,
} from "../src/diagnosis/refusal.js";
import { gateAt } from "../src/forecast/gate.js";
import {
  type ForecastGateProfile,
  parsePublication,
  writePublication,
} from "../src/forecast/publication.js";
import {
  classifyDiagnosisWatch,
  classifyPublicationWatch,
  type DiagnosisWatchInputs,
  type DuePublication,
  diagnosisAnswerableAt,
  diagnosisRecoveryWindowMs,
  mostRecentDuePublication,
  PUBLICATION_GRACE_MS,
  readDiagnosisWatch,
  readPublicationWatch,
  watchDiagnosisPublications,
  watchPublications,
} from "../src/forecast/publication-watch.js";
import { PUBLISH_TIMEOUT_MS } from "../src/forecast/publish.js";
import type { PublishedOrigin } from "../src/forecast/reads.js";
import { FORECAST_PUBLICATIONS, PUBLICATION_LANES } from "../src/jobs/publication.js";
import { attributionOf, attributionPayload } from "./support/attribution-payload.js";
import { assertClaim, type Claim, measuring, publish } from "./support/conformance.js";

/**
 * The publication that did not happen — both halves of the chain.
 *
 * Suites in one file, because they are halves of one question and splitting
 * them would let some of them drift away from the rest:
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
 * 4. **The chain** — the *diagnosis* publication's due time, which is not a
 *    gate plus a margin: it hangs off the forecast publication's own commit
 *    instant, because the job table's one non-cron trigger is "on completion of
 *    each above". Two bounds, one of them the reason no second cron exists —
 *    the whole chain fits inside the margin the two crons already wait, so a
 *    scheduled run can actually reach a verdict rather than reporting
 *    `not_yet_due` forever.
 * 5. **The chained verdict** — six states, of which exactly one alarms. The
 *    two that are new in kind are `refused`, a typed refusal `apps/ml`
 *    declared, and `forecast_absent`, which belongs to the forecast half.
 * 6. **The refusal vocabulary** — the four conditions parsed out of
 *    `apps/ml`'s own `REFUSAL_CONDITIONS`, checked against this side's list and
 *    against `drizzle/0044`'s CHECK, with the one that was *removed* this wave
 *    asserted absent from all three.
 * 7. **The alarm itself** — gated on `WATTSTEER_PUBLICATION_WATCH`, pointed at
 *    a real deployment's Postgres, and reported in the same `Claim` vocabulary
 *    the other two scheduled suites use. Two claims now: the forecast
 *    publication's and the chained explanation's, which break differently.
 *
 * Two sections run against real Postgres under `WATTSTEER_TEST_DATABASE_URL`
 * and they are the ones that prove the *reads* — that the census, the origins,
 * the forecast's commit instant and the refusal ledger come back non-empty from
 * a database that has rows, so an empty result can never be mistaken for a
 * healthy one.
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

/**
 * The whole of the automatic-recovery window, computed rather than assumed:
 * the job's own offset past the gate, plus every attempt at its timeout,
 * plus the exponential waits between them. Below this an alarm reports a
 * job that has not finished trying; above it, nothing else is coming.
 *
 * At module scope because the chained half needs the same number: the diagnosis
 * publication's due time is measured from when the *forecast* publication
 * committed, so the latest it can honestly have committed is this window.
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

describe("the missed-publication watch · the margin", () => {
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

describe("the chained diagnosis watch · the chain", () => {
  /** The gate the chain hangs off, and the day it explains. */
  const TARGET = "2024-04-05";
  const GATE = gateAt(TARGET, "gate_late");
  const due = (): DuePublication =>
    mostRecentDuePublication(new Date(GATE.getTime() + PUBLICATION_GRACE_MS + 60_000));

  it("counts the chained task's own retries, and nothing it does not have", () => {
    const chained = diagnosisRecoveryWindowMs();
    // Non-vacuous twice over: the window is more than the attempts alone, so
    // the exponential waits are in it; and it is less than the forecast's, so
    // the cron offset a completion-triggered task does not have is *not* in it.
    expect(chained).toBeGreaterThan(config.jobAttempts * PUBLISH_DIAGNOSIS_TIMEOUT_MS);
    expect(chained).toBeLessThan(recoveryWindowMs());
    // Derived from the policy rather than stated: raise the attempts and the
    // window moves with them.
    expect(diagnosisRecoveryWindowMs(config.jobAttempts + 1)).toBeGreaterThan(chained);
  });

  it("fits the whole chain inside the margin, so the scheduled run can fire at all", () => {
    // The bound that makes a second cron and a second margin unnecessary — and
    // the one that matters most, because getting it wrong in this direction
    // gives a watch that is never able to alarm: every scheduled run would find
    // the chain still inside its budget and report `not_yet_due` forever.
    const chain = recoveryWindowMs() + diagnosisRecoveryWindowMs();
    expect(chain).toBeGreaterThan(recoveryWindowMs());
    expect(PUBLICATION_GRACE_MS).toBeGreaterThan(chain);
    publish("the chained diagnosis publication's margin", [
      `margin (shared with the forecast half) : ${PUBLICATION_GRACE_MS / MS_PER_HOUR} h`,
      `forecast recovery window              : ${(recoveryWindowMs() / 60_000).toFixed(2)} min`,
      `chained recovery window               : ${(
        diagnosisRecoveryWindowMs() / 60_000
      ).toFixed(2)} min`,
      `whole chain                           : ${(chain / 60_000).toFixed(2)} min`,
      `shortest gate-to-gate wait            : ${
        shortestGateIntervalMs() / MS_PER_HOUR
      } h`,
    ]);
  });

  it("stays below the next gate even on the latest chain start that is honest", () => {
    // The masking bound, one grain over: a diagnosis that became answerable
    // after the next gate had passed would be reported against a day the next
    // publication has already superseded.
    const interval = shortestGateIntervalMs();
    expect(interval).toBeGreaterThan(0);
    expect(recoveryWindowMs() + diagnosisRecoveryWindowMs()).toBeLessThan(interval);
  });

  it("measures the due time from the forecast publication, and states no hour", () => {
    // The ordinary case: the forecast committed minutes after its gate, so the
    // shared margin has already covered the chain and the answerable instant
    // *is* the margin — which is what the two existing crons ask at.
    const ordinary = diagnosisAnswerableAt(due(), new Date(GATE.getTime() + 10 * 60_000));
    expect(ordinary.getTime()).toBe(GATE.getTime() + PUBLICATION_GRACE_MS);
    // Derived, never restated: the same `gateAt` call the publisher, the table's
    // CHECK and the forecast half of this watch are written against.
    expect(ordinary.getTime()).toBe(
      gateAt(TARGET, "gate_late").getTime() + PUBLICATION_GRACE_MS,
    );

    // The pathological case, and the reason the due time is not simply the
    // gate plus the margin: a forecast published five hours late by hand starts
    // its chain five hours late, and a diagnosis is not owed before the
    // forecast it explains.
    const handRun = new Date(GATE.getTime() + 5 * MS_PER_HOUR);
    const slid = diagnosisAnswerableAt(due(), handRun);
    expect(slid.getTime()).toBe(handRun.getTime() + diagnosisRecoveryWindowMs());
    expect(slid.getTime()).toBeGreaterThan(ordinary.getTime());
  });
});

describe("the chained diagnosis watch · the verdict", () => {
  /** 21:30 BRT on 2024-04-04 — half an hour past the late gate's margin. */
  const NOW = new Date("2024-04-05T00:30:00.000Z");
  const due = (): DuePublication => mostRecentDuePublication(NOW);
  /** The forecast publication committed five minutes after its gate. */
  const COMMITTED = new Date(gateAt("2024-04-05", "gate_late").getTime() + 5 * 60_000);

  const refusal = (
    observedAt: Date,
    condition: DiagnosisRefusalCondition = "no_matched_background",
  ): DiagnosisRefusalRecord => ({
    targetDate: "2024-04-05",
    gateProfile: "gate_late",
    lane: PUBLICATION_LANES.gate_late,
    condition,
    reason: "the artifact carries no frozen background sample",
    observedAt,
  });

  const inputs = (over: Partial<DiagnosisWatchInputs> = {}): DiagnosisWatchInputs => ({
    attributionRows: 0,
    forecastIngestedAt: COMMITTED,
    attributedSubsystems: [],
    refusals: [],
    ...over,
  });

  it("owes nothing for a gate whose forecast never published", () => {
    // Today's real state: zero ingested rows. The forecast half says
    // `never_published` here and this half must not say it a second time — a
    // chained publication whose trigger never fired was never owed.
    const report = classifyDiagnosisWatch(
      due(),
      inputs({ forecastIngestedAt: null }),
      NOW,
    );
    expect(report.verdict).toBe("forecast_absent");
    expect(report.answerableAt).toBeNull();
    expect(report.hoursPastDue).toBeNull();
    expect(report.observed).toContain("no diagnosis publication was owed");
  });

  it("stays quiet when the gate has an attribution stamped at it", () => {
    const report = classifyDiagnosisWatch(
      due(),
      inputs({ attributionRows: 8, attributedSubsystems: ["NE", "S"] }),
      NOW,
    );
    expect(report.verdict).toBe("published");
    expect(report.hoursPastDue).toBeNull();
    expect(report.observed).toContain("NE, S");
  });

  it("stays quiet while the chained task is still inside its retry budget", () => {
    // One minute before the answerable instant, on a forecast that published
    // by hand well after its gate. An alarm here would alarm on a job that is
    // still allowed to be running — the same mistake the forecast half refuses
    // one gate earlier.
    const committed = new Date(NOW.getTime() - diagnosisRecoveryWindowMs() + 60_000);
    const report = classifyDiagnosisWatch(
      due(),
      inputs({ attributionRows: 8, forecastIngestedAt: committed }),
      NOW,
    );
    expect(report.verdict).toBe("not_yet_due");
    expect(report.observed).toContain("still allowed to be running");
  });

  it("fires when the forecast published, the budget ran out and nothing arrived", () => {
    // The alarm. The deployment has explained days before — the census is
    // non-zero — the forecast for this gate committed, its chain had its whole
    // retry budget, and no attribution and no refusal exist.
    const report = classifyDiagnosisWatch(due(), inputs({ attributionRows: 16 }), NOW);
    expect(report.verdict).toBe("late");
    expect(report.hoursPastDue).toBe(0.5);
    expect(report.observed).toContain("no refusal was declared");
    expect(report.observed).toContain("explained days before and stopped");
  });

  it("does not alarm on a publication the system correctly refused", () => {
    // The verdict this half exists for. `apps/ml` declared
    // `no_matched_background` after the forecast committed: the forecast is
    // serving, the explanation is honestly unavailable, and the repair is a
    // retrain. An alarm here would fire on correct behaviour, which is the
    // fastest way to have the alarm switched off.
    const report = classifyDiagnosisWatch(
      due(),
      inputs({
        attributionRows: 16,
        refusals: [refusal(new Date(COMMITTED.getTime() + 90_000))],
      }),
      NOW,
    );
    expect(report.verdict).toBe("refused");
    expect(report.hoursPastDue).toBeNull();
    expect(report.refusal?.condition).toBe("no_matched_background");
    expect(report.observed).toContain("declared refusal rather than a missed");
  });

  it("is not silenced by a refusal older than the forecast now serving", () => {
    // The sharp case, and the reason the ledger carries `observed_at`: the
    // lane-day was refused yesterday, the forecast has since been re-published,
    // and *that* chain left no statement at all. A watch keyed on "is there a
    // refusal for this lane-day" would be silent for good.
    const report = classifyDiagnosisWatch(
      due(),
      inputs({
        attributionRows: 16,
        refusals: [refusal(new Date(COMMITTED.getTime() - MS_PER_HOUR))],
      }),
      NOW,
    );
    expect(report.verdict).toBe("late");
    expect(report.observed).toContain("previous vintage");
  });

  it("says 'never diagnosed' rather than 'late' when no attribution has ever been written", () => {
    // The state this repository is in today: `apps/ml`'s half of the chain
    // landed this wave and no deployment has published an attribution. An
    // alarm that fired here would be screaming continuously.
    const report = classifyDiagnosisWatch(due(), inputs(), NOW);
    expect(report.verdict).toBe("never_diagnosed");
    expect(report.hoursPastDue).toBeNull();
    expect(report.observed).toContain("has never explained a day");
  });

  it("refuses a read whose census disagrees with the gate's own rows", () => {
    expect(() =>
      classifyDiagnosisWatch(
        due(),
        inputs({ attributionRows: 0, attributedSubsystems: ["NE"] }),
        NOW,
      ),
    ).toThrow(/incoherent/);
  });

  it("refuses an attribution standing on a forecast publication that is not there", () => {
    // `0041` makes the instant right and nothing makes the *pair* right. An
    // explanation of a forecast this deployment does not hold must not be
    // reported as a healthy publication.
    expect(() =>
      classifyDiagnosisWatch(
        due(),
        inputs({
          attributionRows: 8,
          attributedSubsystems: ["NE"],
          forecastIngestedAt: null,
        }),
        NOW,
      ),
    ).toThrow(/incoherent/);
  });

  it("counts every verdict, so a seventh state cannot be added silently", () => {
    // The roll call. Six verdicts, exactly one of which alarms; a state added
    // without a case above fails here.
    const verdicts = new Set(
      [
        classifyDiagnosisWatch(due(), inputs({ forecastIngestedAt: null }), NOW),
        classifyDiagnosisWatch(
          due(),
          inputs({ attributionRows: 8, attributedSubsystems: ["NE"] }),
          NOW,
        ),
        classifyDiagnosisWatch(
          due(),
          inputs({
            forecastIngestedAt: new Date(NOW.getTime() - 60_000),
          }),
          NOW,
        ),
        classifyDiagnosisWatch(
          due(),
          inputs({
            attributionRows: 16,
            refusals: [refusal(new Date(COMMITTED.getTime() + 90_000))],
          }),
          NOW,
        ),
        classifyDiagnosisWatch(due(), inputs(), NOW),
        classifyDiagnosisWatch(due(), inputs({ attributionRows: 16 }), NOW),
      ].map((report) => report.verdict),
    );
    expect([...verdicts].sort()).toEqual([
      "forecast_absent",
      "late",
      "never_diagnosed",
      "not_yet_due",
      "published",
      "refused",
    ]);
  });
});

describe("the chained diagnosis watch · the refusal vocabulary", () => {
  const PYTHON = join(
    import.meta.dir,
    "..",
    "..",
    "ml",
    "src",
    "wattsteer_ml",
    "diagnosis",
    "publish.py",
  );

  it("names the same conditions apps/ml refuses under", () => {
    /**
     * The cross-language seam, held the way `diagnosis-attribution.test.ts`
     * holds the rule codes: the conditions are parsed out of `apps/ml`'s source
     * rather than restated, so a fifth condition shipped upstream fails here on
     * the day it lands instead of arriving as a refusal this side declines to
     * record — which would read, to the watch, as a missed publication.
     */
    const source = readFileSync(PYTHON, "utf8");
    const declared = source.slice(
      source.indexOf("REFUSAL_CONDITIONS: tuple[str, ...] = ("),
    );
    const tuple = declared.slice(0, declared.indexOf(")"));
    const conditions = [...tuple.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    // Non-vacuous: the scan found the tuple at all, and found all of it.
    expect(conditions.length).toBe(DIAGNOSIS_REFUSAL_CONDITIONS.length);
    expect([...conditions].sort()).toEqual([...DIAGNOSIS_REFUSAL_CONDITIONS].sort());
  });

  it("does not admit the refusal that was removed this wave", () => {
    // `null_headline_feature` refused a whole day when any driver group's
    // headline feature was NULL, which at a weather block's real NULL rates is
    // most days. It is now a stated absence on the driver row and the ranking
    // publishes. Asserted on the Python source as well, so this stays true of
    // `apps/ml` rather than only of this list.
    const source = readFileSync(PYTHON, "utf8");
    expect(source).toContain("null_headline_feature");
    const declared = source.slice(
      source.indexOf("REFUSAL_CONDITIONS: tuple[str, ...] = ("),
    );
    expect(declared.slice(0, declared.indexOf(")"))).not.toContain(
      "null_headline_feature",
    );
    expect(DIAGNOSIS_REFUSAL_CONDITIONS as readonly string[]).not.toContain(
      "null_headline_feature",
    );
  });

  it("is the same closed set the table will accept", () => {
    // The ledger's CHECK is the storage half of the vocabulary. A condition the
    // watch understands and the table rejects would be a refusal that could not
    // be written down, and therefore an alarm on a correct refusal.
    //
    // Read from the *last* migration that defines the constraint rather than
    // from a named file. The first version of this test read
    // `0044_a_refusal_is_a_record.sql` by name and broke the moment forecaster
    // 31's fifth condition arrived and `0045` widened the CHECK — the test was
    // asserting the vocabulary as of one migration, not as of the schema. Since
    // `drizzle/` is applied history and a constraint is corrected by a later
    // migration rather than by an edit, the effective CHECK is the newest
    // definition, and that is what the table will actually accept.
    const dir = join(import.meta.dir, "..", "drizzle");
    const migrations = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const CONSTRAINT = 'CONSTRAINT "diagnosis_publication_refusal_condition"';
    const defining = migrations.filter((name) =>
      readFileSync(join(dir, name), "utf8").includes(CONSTRAINT),
    );
    // Non-vacuous three ways: the directory was read, the constraint was found
    // at all, and a listing that matched nothing cannot pass by leaving
    // `admitted` empty and comparing two empty sets.
    expect(migrations.length).toBeGreaterThan(40);
    expect(defining.length).toBeGreaterThan(0);

    const newest = readFileSync(join(dir, defining[defining.length - 1]), "utf8");
    const check = newest.slice(newest.lastIndexOf(CONSTRAINT));
    const admitted = [
      ...check.slice(0, check.indexOf("))")).matchAll(/'([a-z_]+)'/g),
    ].map((match) => match[1]);
    expect(admitted.length).toBe(DIAGNOSIS_REFUSAL_CONDITIONS.length);
    expect([...admitted].sort()).toEqual([...DIAGNOSIS_REFUSAL_CONDITIONS].sort());
  });
});

const DB_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const dbSuite = DB_URL ? describe : describe.skip;

const ARTIFACT = "2024-04-04T03:11:07Z";
const REGIME = "conformal_v1_partial_upper";

/**
 * One lane-day of forecast rows, stamped at its own gate so `0041` admits it.
 *
 * At module scope rather than inside one suite because both Postgres suites in
 * this file write the *same* forecast publication — the chained half's whole
 * question is what happened after one of these committed — and two fixtures
 * would let the chain be watched over a publication the forecast half never
 * sees.
 */
const forecastPayload = (targetDate: string, gateProfile: ForecastGateProfile) => {
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

dbSuite("the missed-publication watch · the read (real Postgres)", () => {
  const handle = createDatabase(DB_URL as string, 5);
  const { db } = handle;
  /** 21:30 BRT on 2024-04-04 — half an hour past the late gate's margin. */
  const NOW = new Date("2024-04-05T00:30:00.000Z");

  const write = (targetDate: string, gateProfile: ForecastGateProfile) =>
    writePublication(db, parsePublication(forecastPayload(targetDate, gateProfile)), {
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

dbSuite("the chained diagnosis watch · the read (real Postgres)", () => {
  const handle = createDatabase(DB_URL as string, 5);
  const { db } = handle;
  /** 21:30 BRT on 2024-04-04 — half an hour past the late gate's margin. */
  const NOW = new Date("2024-04-05T00:30:00.000Z");
  const TARGET = "2024-04-05";
  const YESTERDAY = "2024-04-04";
  /** The forecast publication commits five minutes after its gate. */
  const COMMITTED = new Date(gateAt(TARGET, "gate_late").getTime() + 5 * 60_000);

  const writeForecast = (targetDate: string, ingestedAt: Date) =>
    writePublication(db, parsePublication(forecastPayload(targetDate, "gate_late")), {
      ingestedAt,
    });

  /** One published attribution for a chosen day, stamped at that day's gate. */
  const writeAttribution = (targetDate: string, ingestedAt: Date) =>
    writeAttributionPublication(
      db,
      parseAttributionPublication(
        attributionPayload({
          publishedAt: gateAt(targetDate, "gate_late").toISOString(),
          mutate: (payload) => {
            payload.target_date = targetDate;
            attributionOf(payload).target_date = targetDate;
          },
        }),
      ),
      { ingestedAt },
    );

  const clear = async () => {
    await db.execute(sql`truncate table diagnosis_attribution_driver`);
    await db.execute(sql`truncate table diagnosis_attribution cascade`);
    await db.execute(sql`truncate table diagnosis_publication_refusal`);
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
  };

  beforeEach(clear);

  afterAll(async () => {
    await clear();
    await handle.close();
  });

  it("owes nothing on an empty deployment, and says so from measured emptiness", async () => {
    const due = mostRecentDuePublication(NOW);
    const inputs = await readDiagnosisWatch(db, { due, asOf: NOW });
    // Each half of the read asserted to *be* empty before the verdict is drawn,
    // so the quiet answer is a measurement rather than four queries that failed.
    expect(inputs.attributionRows).toBe(0);
    expect(inputs.forecastIngestedAt).toBeNull();
    expect(inputs.attributedSubsystems).toEqual([]);
    expect(inputs.refusals).toEqual([]);

    const report = await watchDiagnosisPublications(db, { now: NOW });
    expect(report.verdict).toBe("forecast_absent");
  });

  it("reads the forecast publication's own commit instant as the chain's start", async () => {
    const written = await writeForecast(TARGET, COMMITTED);
    expect(written.daysInserted).toBe(1);

    const due = mostRecentDuePublication(NOW);
    const inputs = await readDiagnosisWatch(db, { due, asOf: NOW });
    // The one fact the chained due time is derived from, out of real rows: the
    // `ingested_at` of the forecast publication, not its gate and not a clock.
    expect(inputs.forecastIngestedAt?.toISOString()).toBe(COMMITTED.toISOString());
    expect(inputs.attributedSubsystems).toEqual([]);

    const report = await watchDiagnosisPublications(db, { now: NOW });
    // A deployment that has never explained a day: quiet, and loudly reported.
    expect(report.verdict).toBe("never_diagnosed");
    expect(report.answerableAt?.getTime()).toBe(
      gateAt(TARGET, "gate_late").getTime() + PUBLICATION_GRACE_MS,
    );
  });

  it("stays quiet on a real attribution stamped at the same gate", async () => {
    await writeForecast(TARGET, COMMITTED);
    const written = await writeAttribution(
      TARGET,
      new Date(COMMITTED.getTime() + 90_000),
    );
    expect(written.attributionsInserted).toBe(1);

    const due = mostRecentDuePublication(NOW);
    const inputs = await readDiagnosisWatch(db, { due, asOf: NOW });
    // Non-empty inputs, asserted: the quiet verdict is drawn from rows that
    // came back rather than from a query that matched nothing.
    expect(inputs.attributionRows).toBe(1);
    expect(inputs.attributedSubsystems).toEqual(["NE"]);

    const report = await watchDiagnosisPublications(db, { now: NOW });
    expect(report.verdict).toBe("published");
    expect(report.hoursPastDue).toBeNull();
  });

  it("fires on a deployment that explained yesterday and not today", async () => {
    // The alarm, against real Postgres: yesterday's day has its explanation,
    // today's forecast published, its chain had its whole budget, and there is
    // neither an attribution nor a refusal behind it.
    await writeAttribution(YESTERDAY, new Date(COMMITTED.getTime() - 86_400_000));
    await writeForecast(TARGET, COMMITTED);

    const due = mostRecentDuePublication(NOW);
    const inputs = await readDiagnosisWatch(db, { due, asOf: NOW });
    expect(inputs.attributionRows).toBe(1);
    expect(inputs.attributedSubsystems).toEqual([]);
    expect(inputs.forecastIngestedAt).not.toBeNull();

    const report = await watchDiagnosisPublications(db, { now: NOW });
    expect(report.verdict).toBe("late");
    expect(report.hoursPastDue).toBe(0.5);
    expect(report.observed).toContain("no refusal was declared");
  });

  it("stays quiet on the same day once the refusal is on the ledger", async () => {
    // The same rows as the firing case above, plus the one row that makes the
    // absence a declared refusal. Nothing else changes, which is what makes
    // this pair a demonstration rather than two independent assertions.
    await writeAttribution(YESTERDAY, new Date(COMMITTED.getTime() - 86_400_000));
    await writeForecast(TARGET, COMMITTED);
    await recordDiagnosisRefusal(db, {
      targetDate: TARGET,
      gateProfile: "gate_late",
      lane: PUBLICATION_LANES.gate_late,
      condition: "no_matched_background",
      reason:
        "the artifact carries no frozen background sample and its base-fit " +
        "window cannot supply one at 128 rows per cell",
      observedAt: new Date(COMMITTED.getTime() + 60_000),
    });

    const due = mostRecentDuePublication(NOW);
    const inputs = await readDiagnosisWatch(db, { due, asOf: NOW });
    expect(inputs.refusals.length).toBe(1);
    expect(inputs.refusals[0]?.condition).toBe("no_matched_background");

    const report = await watchDiagnosisPublications(db, { now: NOW });
    expect(report.verdict).toBe("refused");
    expect(report.refusal?.lane).toBe(PUBLICATION_LANES.gate_late);
  });

  it("records one refusal per lane-day however many attempts refuse", async () => {
    // The queue makes `config.jobAttempts` attempts and each one refuses. Three
    // rows saying the same thing ten seconds apart are not three refusals, so
    // the ledger keeps the newest — and `observed_at` moves, which is what
    // keeps the freshness test against the forecast's commit instant honest.
    for (const minute of [1, 2, 3]) {
      await recordDiagnosisRefusal(db, {
        targetDate: TARGET,
        gateProfile: "gate_late",
        lane: PUBLICATION_LANES.gate_late,
        condition: minute === 3 ? "incomplete_day" : "no_matched_background",
        reason: `attempt ${minute}`,
        observedAt: new Date(COMMITTED.getTime() + minute * 60_000),
      });
    }
    const due = mostRecentDuePublication(NOW);
    const inputs = await readDiagnosisWatch(db, { due, asOf: NOW });
    expect(inputs.refusals.length).toBe(1);
    expect(inputs.refusals[0]?.condition).toBe("incomplete_day");
    expect(inputs.refusals[0]?.observedAt.toISOString()).toBe(
      new Date(COMMITTED.getTime() + 3 * 60_000).toISOString(),
    );
  });

  it("refuses a ledger row stamped at anything but its gate, or naming a condition apps/ml dropped", async () => {
    // The two constraints `0044` carries, checked against Postgres rather than
    // read off the migration: a refusal about some other instant is a statement
    // about a publication nobody can identify, and `null_headline_feature` is
    // no longer a refusal at all.
    const gate = gateAt(TARGET, "gate_late");
    const insert = async (expectedAt: Date, condition: string): Promise<string> => {
      try {
        await db.execute(sql`
          insert into diagnosis_publication_refusal
            (target_date, gate_profile, lane, expected_published_at, condition, reason)
          values (${TARGET}::date, 'gate_late'::forecast_gate_profile,
                  ${PUBLICATION_LANES.gate_late},
                  ${expectedAt.toISOString()}::timestamptz,
                  ${condition}, 'a refusal the table should not hold')
        `);
        return "accepted";
      } catch (error) {
        // Drizzle wraps the failure and Postgres names the constraint on the
        // cause, so both are read: the assertion is about *which* constraint
        // refused, not merely that something did.
        const cause = error instanceof Error ? error.cause : undefined;
        return [
          error instanceof Error ? error.message : String(error),
          cause instanceof Error ? cause.message : String(cause ?? ""),
        ].join(" — ");
      }
    };
    expect(
      await insert(new Date(gate.getTime() + MS_PER_HOUR), "incomplete_day"),
    ).toContain("expected_at_is_the_gate");
    expect(await insert(gate, "null_headline_feature")).toContain("refusal_condition");
    // Non-vacuous: the same insert with a real condition at the real gate is
    // accepted, so the two refusals above are the constraints and not a broken
    // statement.
    expect(await insert(gate, "incomplete_day")).toBe("accepted");
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

/**
 * The chained half of the same promise — the job table's one non-cron trigger.
 *
 * A separate `Claim` rather than a clause in the one above, because the two
 * break differently and the repair is not the same: a missed forecast
 * publication serves an older vintage to every screen, while a missed
 * diagnosis publication leaves the forecast correct and unexplained. Reported
 * as one claim, the second failure would arrive wearing the first's prose and
 * send an operator to the wrong job.
 */
const EXPLAINED_ON_COMPLETION: Claim = {
  note: "docs/specs/api-surface.md",
  section: 'Job table — publish-diagnosis, "on completion of each above"',
  claim:
    "A forecast publication that finished submits a diagnosis publication " +
    "carrying the day it wrote, so a served forecast whose chain has had its " +
    "whole retry budget has either an attribution stamped at the same gate or " +
    "a declared refusal saying why it has none.",
  breaks:
    "/v1/diagnosis/day-ahead answers its own absence for a day the forecast is " +
    "serving: the Overview renders a forecast nothing explains, the narration " +
    "has no drivers to stand on, and no rule was ever evaluated for that day. " +
    "The forecast half of this watch reports the publication as healthy, which " +
    "it is — one grain of it.",
  code:
    "apps/api/src/jobs/diagnosis-publication.ts, " +
    "apps/api/src/jobs/worker-tasks.ts, apps/api/src/diagnosis/refusal.ts",
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

  it(
    "has an explanation behind the forecast publication that gate chained off",
    measuring("the deployment's Postgres", async () => {
      const url = process.env.WATTSTEER_WATCH_DATABASE_URL;
      if (!url) {
        throw new Error(
          "WATTSTEER_WATCH_DATABASE_URL is not set, so no deployment was read.",
        );
      }
      const handle = createDatabase(url, 2);
      try {
        const now = new Date();
        const report = await watchDiagnosisPublications(handle.db, { now });
        publish(
          report.verdict === "never_diagnosed" || report.verdict === "forecast_absent"
            ? "NOT YET LIVE — the chained diagnosis watch"
            : "the chained diagnosis watch",
          [
            `as of        : ${now.toISOString()}`,
            `gate owed    : ${report.due.gateProfile} for ${report.due.targetDate}`,
            `gate at      : ${report.due.gateAt.toISOString()}`,
            `chain began  : ${report.chainStartedAt?.toISOString() ?? "no forecast publication"}`,
            `answerable   : ${report.answerableAt?.toISOString() ?? "nothing owed"}`,
            `chain budget : ${(diagnosisRecoveryWindowMs() / 60_000).toFixed(2)} min`,
            `attributions : ${report.attributionRows} rows, this gate covering ${
              report.attributedSubsystems.length === 0
                ? "nothing"
                : [...report.attributedSubsystems].join(", ")
            }`,
            `refusal      : ${
              report.refusal === null
                ? "none declared for this publication"
                : `${report.refusal.condition} at ${report.refusal.observedAt.toISOString()}`
            }`,
            `verdict      : ${report.verdict}`,
            `observed     : ${report.observed}`,
          ],
        );
        assertClaim(EXPLAINED_ON_COMPLETION, report.verdict !== "late", report.observed);
      } finally {
        await handle.close();
      }
    }),
  );
});
