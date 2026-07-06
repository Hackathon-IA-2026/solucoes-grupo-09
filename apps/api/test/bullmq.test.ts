import { afterAll, describe, expect, it } from "bun:test";
import { createBullMqRunner } from "../src/jobs/bullmq.js";
import type { JobRecord, JobRunner } from "../src/jobs/types.js";
import type { ScrapeResult } from "../src/types.js";

// Runs only when a test Redis is provided (the `test:redis` script sets it).
// Spin one up with: docker run -d -p 6390:6379 redis:7-alpine
const REDIS = process.env.NOVIQ_TEST_REDIS_URL;
const suite = REDIS ? describe : describe.skip;

const ok = (count: number): ScrapeResult => ({
  store: "apple",
  appId: "1",
  country: "us",
  count,
  partial: false,
  reviews: [],
});

async function waitFor(
  runner: JobRunner,
  id: string,
  want: JobRecord["status"],
  tries = 240,
): Promise<JobRecord | null> {
  for (let i = 0; i < tries; i++) {
    const r = await runner.status(id);
    if (r?.status === want) return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  return runner.status(id);
}

suite("jobs · bullmq runner (real Redis)", () => {
  // One shared runner for the whole suite: appId "FAIL" throws, anything else
  // returns ok(limit). Closed once in afterAll to avoid create/close churn.
  const runner = createBullMqRunner(
    async (q) => {
      if (q.appId === "FAIL") throw new Error("ECONN dsn=secret leak");
      return ok(q.limit ?? 0);
    },
    REDIS as string,
    { concurrency: 2 },
  );

  afterAll(() => runner.close());

  it("reports mode bullmq", () => {
    expect(runner.mode).toBe("bullmq");
  });

  it("processes a job end-to-end through Redis", async () => {
    const id = await runner.submit({ appId: "1", store: "apple", limit: 9 });
    const rec = await waitFor(runner, id, "completed");
    expect(rec?.status).toBe("completed");
    expect(rec?.result?.count).toBe(9);
  }, 30_000);

  it("records a failed job with a sanitized message (no leak)", async () => {
    const id = await runner.submit({ appId: "FAIL" });
    const rec = await waitFor(runner, id, "failed");
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toBe("Internal server error");
  }, 30_000);

  it("returns null for an unknown id", async () => {
    expect(await runner.status("999999")).toBeNull();
  });

  it("retries a transient failure and eventually completes (idempotent handler)", async () => {
    let attempts = 0;
    const retryRunner = createBullMqRunner(
      async (q) => {
        attempts++;
        if (attempts < 2) throw new Error("transient blip");
        return ok(q.limit ?? 0);
      },
      REDIS as string,
      { attempts: 3, backoffMs: 100, queueName: "noviq-test-retry" },
    );
    try {
      const id = await retryRunner.submit({ appId: "1", store: "apple", limit: 3 });
      const rec = await waitFor(retryRunner, id, "completed");
      expect(rec?.status).toBe("completed");
      expect(rec?.result?.count).toBe(3);
      expect(attempts).toBeGreaterThanOrEqual(2); // proves it retried
    } finally {
      await retryRunner.close();
    }
  }, 30_000);

  it("enqueue-only mode (startWorker:false) leaves jobs waiting for a worker", async () => {
    const enqueueOnly = createBullMqRunner(async () => ok(0), REDIS as string, {
      startWorker: false,
      queueName: "noviq-test-noworker",
    });
    try {
      const id = await enqueueOnly.submit({ appId: "1", store: "apple" });
      await new Promise((res) => setTimeout(res, 150));
      const rec = await enqueueOnly.status(id);
      expect(rec?.status).toBe("waiting"); // nothing processes it
    } finally {
      await enqueueOnly.close();
    }
  }, 15_000);
});
