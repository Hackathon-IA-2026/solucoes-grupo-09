import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import {
  RETRAIN_JOB_ID,
  RETRAIN_PATTERN,
  retrainRunId,
  retrainSchedules,
} from "../src/jobs/retrain.js";

const ROOT = join(import.meta.dir, "..");

/**
 * `retrainRunId`'s docstring says the run instant is "floored to the day rather
 * than to the week so that a hand-submitted catch-up" resolves to a stable id —
 * so a hand-submitted retrain was anticipated by the design and then had no way
 * to be submitted. `scripts/ingest.ts task` reaches `IngestTask` kinds only, a
 * `WorkerTask` has to go on the queue, and the queue is on a private network by
 * design. The pattern override is the one lever that does not require exposing
 * Redis, the modelling service, or the unauthenticated jobs dashboard.
 */
describe("retrain · the schedule has an operator override", () => {
  it("defaults to the weekly pattern when nothing is set", () => {
    expect(config.retrainPattern).toBeUndefined();
    const [schedule] = retrainSchedules((payload) => payload);
    expect(schedule?.pattern).toBe(RETRAIN_PATTERN);
  });

  it("the override re-registers the same schedule rather than adding one", () => {
    // The id is what `upsertJobScheduler` is keyed on, so a changed pattern
    // replaces this schedule. If the id moved with the pattern, an override
    // would leave the weekly one behind and the lane would retrain twice.
    const schedules = retrainSchedules((payload) => payload);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.id).toBe(RETRAIN_JOB_ID);
    const source = readFileSync(join(ROOT, "src/jobs/retrain.ts"), "utf8");
    expect(source).toContain("config.retrainPattern ?? RETRAIN_PATTERN");
    // The id is a constant beside it, not derived from the pattern.
    expect(source).toContain("id: RETRAIN_JOB_ID");
  });

  it("the override is read from one place, so it cannot drift", () => {
    const source = readFileSync(join(ROOT, "src/config.ts"), "utf8");
    expect(source).toContain("WATTSTEER_RETRAIN_PATTERN");
    // Non-vacuity: the pattern is not also read from the environment anywhere
    // else, which is how two callers come to disagree about the cadence.
    const jobs = readFileSync(join(ROOT, "src/jobs/retrain.ts"), "utf8");
    expect(jobs).not.toContain("process.env");
  });
});

describe("retrain · the banner reports the schedule it registered", () => {
  it("prints the schedule's own pattern, not the constant", () => {
    const source = readFileSync(join(ROOT, "src/worker.ts"), "utf8");
    // Non-vacuity: the old line interpolated the constant directly, and that is
    // what made the banner able to disagree with the queue.
    expect(source).not.toContain("${RETRAIN_JOB_ID} ${RETRAIN_PATTERN}");
    expect(source).toContain("${schedule.id} ${schedule.pattern}");
  });

  it("the banner's source is the same function the queue is fed from", () => {
    const source = readFileSync(join(ROOT, "src/worker.ts"), "utf8");
    // `retrainScheduleForQueue` is what `runner.schedule` is called with, so
    // the printed cadence and the registered one cannot drift.
    expect(source).toContain("for (const schedule of retrainScheduleForQueue())");
    expect(source).toContain("await runner.schedule(schedule)");
  });
});

/**
 * Forecaster 44. The override above registers correctly and then could not
 * produce a run: `retrainRunId` floored to the constants `RETRAIN_PATTERN`
 * describes rather than to the pattern in force, so a catch-up on a day the
 * schedule had already run minted *that run's* id. Every lane short-circuited
 * as a retry, no lane reached a decision, and the modelling service turned the
 * idempotent no-op into an HTTP 500 the queue retried three times.
 *
 * Measured on the deployment of 2026-09-15: `WATTSTEER_RETRAIN_PATTERN=5 * * * *`
 * fired at 18:05Z and asked for `2026-09-15T03:10:00Z`.
 */
describe("retrain · the catch-up mints an id of its own", () => {
  it("floors to the pattern's fixed fields, so the weekly cadence is unmoved", () => {
    // The default, asserted through the same path the override uses: three
    // attempts of one Friday firing are one run.
    const friday = [
      new Date("2026-09-04T03:10:00.004Z"),
      new Date("2026-09-04T03:12:41.900Z"),
      new Date("2026-09-04T04:31:07.000Z"),
    ].map((at) => retrainRunId(at, { pattern: RETRAIN_PATTERN }));
    expect(new Set(friday).size).toBe(1);
    expect(friday[0]).toBe("2026-09-04T03:10:00Z");
  });

  it("does not collide with the morning's run when the hour is a wildcard", () => {
    // The defect, exactly. `5 * * * *` firing at 18:05Z must not ask for the id
    // the 03:10 schedule already used, or the lanes short-circuit as retries.
    const catchUp = retrainRunId(new Date("2026-09-15T18:05:02Z"), {
      pattern: "5 * * * *",
    });
    expect(catchUp).toBe("2026-09-15T18:05:00Z");
    expect(catchUp).not.toBe(
      retrainRunId(new Date("2026-09-15T03:10:00Z"), {
        pattern: RETRAIN_PATTERN,
      }),
    );
  });

  it("is still stable across the attempts of one hourly firing", () => {
    // Idempotency is the reason the id is floored at all, and a per-hour id
    // must keep it: a backoff retry seconds later is the same run.
    const ids = [
      new Date("2026-09-15T18:05:00.100Z"),
      new Date("2026-09-15T18:05:41.900Z"),
      new Date("2026-09-15T18:05:59.999Z"),
    ].map((at) => retrainRunId(at, { pattern: "5 * * * *" }));
    expect(new Set(ids).size).toBe(1);
  });

  it("belongs to the previous hour when an hourly firing is a hair early", () => {
    // The wildcard's analogue of the weekly pattern's previous-*day* step: the
    // run belongs to an occurrence that has happened, never to one that has not.
    expect(
      retrainRunId(new Date("2026-09-15T18:04:59.100Z"), {
        pattern: "5 * * * *",
      }),
    ).toBe("2026-09-15T17:05:00Z");
  });

  it("falls back to the clock when a field is not a bare number", () => {
    // A step or a list reads as "every", which floors to the firing. More
    // granular than the schedule is safe; coarser is the defect above.
    expect(
      retrainRunId(new Date("2026-09-15T18:17:30Z"), { pattern: "*/15 * * * *" }),
    ).toBe("2026-09-15T18:17:00Z");
  });

  it("survives being mapped over a list of dates", () => {
    // Non-vacuity, and not hypothetical: a positional second parameter took
    // `Array.prototype.map`'s index and threw on `.trim()`. An existing test
    // in `retrain-job.test.ts` maps this function, and that is how it was found.
    const ids = [new Date("2026-09-04T03:10:00Z")].map(retrainRunId);
    expect(ids[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
