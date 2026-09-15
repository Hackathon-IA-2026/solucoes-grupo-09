import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import {
  RETRAIN_JOB_ID,
  RETRAIN_PATTERN,
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
