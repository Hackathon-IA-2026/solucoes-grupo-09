import { describe, expect, it } from "bun:test";
import { createInProcessRunner } from "../src/jobs/inprocess.js";
import type { JobRecord } from "../src/jobs/types.js";

// The runner is generic over payload and result — these stand in for whatever
// WattSteer eventually queues (ingestion runs, backfills).
interface Payload {
  units?: number;
}
interface Result {
  count: number;
}

const ok = (count: number): Result => ({ count });

async function poll(
  get: () => Promise<JobRecord<Result> | null>,
  want: JobRecord["status"],
  tries = 100,
): Promise<JobRecord<Result> | null> {
  for (let i = 0; i < tries; i++) {
    const r = await get();
    if (r?.status === want) {
      return r;
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  return get();
}

describe("jobs · in-process runner", () => {
  it("reports mode inprocess", () => {
    expect(createInProcessRunner<Payload, Result>(async () => ok(0)).mode).toBe(
      "inprocess",
    );
  });

  it("runs a submitted job to completion and returns the result", async () => {
    const runner = createInProcessRunner<Payload, Result>(async (p) => ok(p.units ?? 0));
    const id = await runner.submit({ units: 4 });
    expect(typeof id).toBe("string");
    const rec = await poll(() => runner.status(id), "completed");
    expect(rec?.status).toBe("completed");
    expect(rec?.result?.count).toBe(4);
  });

  it("records a failed job with a client-safe message (no leak)", async () => {
    const runner = createInProcessRunner<Payload, Result>(async () => {
      throw new Error("ECONN internal-db dsn=secret");
    });
    const id = await runner.submit({});
    const rec = await poll(() => runner.status(id), "failed");
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toBe("Internal server error");
  });

  it("returns null for an unknown id", async () => {
    const runner = createInProcessRunner<Payload, Result>(async () => ok(0));
    expect(await runner.status("nope")).toBeNull();
  });
});

describe("in-process runner · progress", () => {
  it("exposes live progress on the record while active", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createInProcessRunner<Payload, Result>(async (payload, report) => {
      // Two units of work, then hold until the test has observed the progress.
      report({ done: 20, total: payload.units });
      report({ done: 40, total: payload.units });
      await gate;
      return ok(40);
    });

    const id = await runner.submit({ units: 100 });
    // Poll until the progress write is visible (the job runs on a microtask).
    let record: JobRecord<Result> | null = null;
    for (let i = 0; i < 50; i++) {
      record = await runner.status(id);
      if (record?.progress) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(record?.status).toBe("active");
    expect(record?.progress).toEqual({ done: 40, total: 100 });

    release();
    for (let i = 0; i < 50; i++) {
      record = await runner.status(id);
      if (record?.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Completed records don't carry stale progress.
    expect(record?.status).toBe("completed");
    expect(record?.progress).toBeUndefined();
  });
});
