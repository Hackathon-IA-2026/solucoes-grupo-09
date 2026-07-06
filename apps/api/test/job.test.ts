import { describe, expect, it } from "bun:test";
import { createInProcessRunner } from "../src/jobs/inprocess.js";
import type { JobRecord } from "../src/jobs/types.js";
import type { ScrapeResult } from "../src/types.js";

const ok = (count: number): ScrapeResult => ({
  store: "apple",
  appId: "1",
  country: "us",
  count,
  partial: false,
  reviews: [],
});

async function poll(
  get: () => Promise<JobRecord | null>,
  want: JobRecord["status"],
  tries = 100,
): Promise<JobRecord | null> {
  for (let i = 0; i < tries; i++) {
    const r = await get();
    if (r?.status === want) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  return get();
}

describe("jobs · in-process runner", () => {
  it("reports mode inprocess", () => {
    expect(createInProcessRunner(async () => ok(0)).mode).toBe("inprocess");
  });

  it("runs a submitted job to completion and returns the result", async () => {
    const runner = createInProcessRunner(async (q) => ok(q.limit ?? 0));
    const id = await runner.submit({ appId: "1", store: "apple", limit: 4 });
    expect(typeof id).toBe("string");
    const rec = await poll(() => runner.status(id), "completed");
    expect(rec?.status).toBe("completed");
    expect(rec?.result?.count).toBe(4);
  });

  it("records a failed job with a client-safe message (no leak)", async () => {
    const runner = createInProcessRunner(async () => {
      throw new Error("ECONN internal-db dsn=secret");
    });
    const id = await runner.submit({ appId: "1" });
    const rec = await poll(() => runner.status(id), "failed");
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toBe("Internal server error");
  });

  it("returns null for an unknown id", async () => {
    const runner = createInProcessRunner(async () => ok(0));
    expect(await runner.status("nope")).toBeNull();
  });
});
