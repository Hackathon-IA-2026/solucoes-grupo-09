import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { REFRESH_CADENCE } from "../src/ingest/refresh.js";

const ROOT = join(import.meta.dir, "..");

/**
 * The claim BullMQ's lock encodes is "this job will not run longer than
 * `lockDuration`". Set it below the truth and BullMQ does not slow down or warn
 * — it declares the job stalled, hands the same payload to a second processor,
 * and then refuses the original's `moveToFinished` with a lock mismatch. The
 * job is run twice and recorded never.
 *
 * Production ran exactly that on 2026-09-14: `repeat:refresh:live` started at
 * 16:17:00 UTC, lost its 30 s claim at 16:17:42, and was still emitting
 * `Lock mismatch … Cmd moveToFinished from active` at 16:29:57.
 */
const MEASURED_LIVE_SWEEP_MS = 12 * 60_000 + 57_000;

/** The ceiling, derived from the cadence rather than restated beside it. */
function periodMs(cron: string): number {
  const [minute, hour] = cron.split(" ");
  if (hour === "*") {
    expect(minute).not.toBe("*"); // a per-minute sweep would have no headroom
    return 3_600_000;
  }
  return 86_400_000;
}

describe("jobs · the lock outlives the job it is a claim about", () => {
  it("the default claim covers the measured live sweep", () => {
    expect(config.jobLockDurationMs).toBeGreaterThan(MEASURED_LIVE_SWEEP_MS);
  });

  // Non-vacuity: BullMQ's own default is what this exists to reject, and it
  // must be on the failing side of the same assertion.
  it("BullMQ's 30 s default does not, which is why this guard exists", () => {
    expect(30_000).toBeLessThan(MEASURED_LIVE_SWEEP_MS);
  });

  it("the claim still expires inside the sweep's own period", () => {
    // Above the period, a wedged worker holds the queue past the next due run.
    expect(config.jobLockDurationMs).toBeLessThanOrEqual(periodMs(REFRESH_CADENCE.live));
  });

  it("the runner hands the value to the worker, not only to the options type", () => {
    const source = readFileSync(join(ROOT, "src/jobs/bullmq.ts"), "utf8");
    // Both, and from the same option: a checker that sweeps faster than the
    // claim can lapse reclaims jobs that are merely slow.
    expect(source).toContain("lockDuration: opts.lockDurationMs");
    expect(source).toContain("stalledInterval: opts.lockDurationMs");
  });

  it("every process that starts a worker passes it", () => {
    for (const file of ["src/worker.ts", "src/jobs/index.ts"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).toContain("lockDurationMs: config.jobLockDurationMs");
    }
  });
});
