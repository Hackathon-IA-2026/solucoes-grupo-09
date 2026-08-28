import { afterAll, describe, expect, it } from "bun:test";
import { createBullMqRunner } from "../src/jobs/bullmq.js";
import type { JobRecord, JobRunner } from "../src/jobs/types.js";

// Runs only when a test Redis is provided (the `test:redis` script sets it).
// Spin one up with: docker run -d -p 6390:6379 redis:7-alpine
const REDIS = process.env.WATTSTEER_TEST_REDIS_URL;
const suite = REDIS ? describe : describe.skip;

interface Payload {
  units?: number;
  fail?: boolean;
}
interface Result {
  count: number;
}

const ok = (count: number): Result => ({ count });

async function waitFor(
  runner: JobRunner<Payload, Result>,
  id: string,
  want: JobRecord["status"],
  tries = 240,
): Promise<JobRecord<Result> | null> {
  for (let i = 0; i < tries; i++) {
    const r = await runner.status(id);
    if (r?.status === want) {
      return r;
    }
    await new Promise((res) => setTimeout(res, 25));
  }
  return runner.status(id);
}

suite("jobs · bullmq runner (real Redis)", () => {
  // One shared runner for the whole suite: `fail` throws, anything else returns
  // ok(units). Closed once in afterAll to avoid create/close churn.
  const runner = createBullMqRunner<Payload, Result>(
    async (p) => {
      if (p.fail) {
        throw new Error("ECONN dsn=secret leak");
      }
      return ok(p.units ?? 0);
    },
    REDIS as string,
    { concurrency: 2 },
  );

  afterAll(() => runner.close());

  it("reports mode bullmq", () => {
    expect(runner.mode).toBe("bullmq");
  });

  it("processes a job end-to-end through Redis", async () => {
    const id = await runner.submit({ units: 9 });
    const rec = await waitFor(runner, id, "completed");
    expect(rec?.status).toBe("completed");
    expect(rec?.result?.count).toBe(9);
  }, 30_000);

  it("records a failed job with a sanitized message (no leak)", async () => {
    const id = await runner.submit({ fail: true });
    const rec = await waitFor(runner, id, "failed");
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toBe("Internal server error");
  }, 30_000);

  it("returns null for an unknown id", async () => {
    expect(await runner.status("999999")).toBeNull();
  });

  it("retries a transient failure and eventually completes (idempotent handler)", async () => {
    let attempts = 0;
    const retryRunner = createBullMqRunner<Payload, Result>(
      async (p) => {
        attempts++;
        if (attempts < 2) {
          throw new Error("transient blip");
        }
        return ok(p.units ?? 0);
      },
      REDIS as string,
      { attempts: 3, backoffMs: 100, queueName: "wattsteer-test-retry" },
    );
    try {
      const id = await retryRunner.submit({ units: 3 });
      const rec = await waitFor(retryRunner, id, "completed");
      expect(rec?.status).toBe("completed");
      expect(rec?.result?.count).toBe(3);
      expect(attempts).toBeGreaterThanOrEqual(2); // proves it retried
    } finally {
      await retryRunner.close();
    }
  }, 30_000);

  it("enqueue-only mode (startWorker:false) leaves jobs waiting for a worker", async () => {
    const enqueueOnly = createBullMqRunner<Payload, Result>(
      async () => ok(0),
      REDIS as string,
      { startWorker: false, queueName: "wattsteer-test-noworker" },
    );
    try {
      const id = await enqueueOnly.submit({});
      await new Promise((res) => setTimeout(res, 150));
      const rec = await enqueueOnly.status(id);
      expect(rec?.status).toBe("waiting"); // nothing processes it
    } finally {
      await enqueueOnly.close();
    }
  }, 15_000);
});
