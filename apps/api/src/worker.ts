import { config } from "./config.js";
import { createBullMqRunner } from "./jobs/bullmq.js";

// Dedicated worker process: pulls jobs off the BullMQ queue and runs them. Use
// this (with the API set to WATTSTEER_ROLE=api) to scale background work
// independently of the HTTP layer. Run several for more throughput.
//
// No job handlers are registered yet — WattSteer's ingestion jobs arrive with
// the data platform. Until then the worker connects and idles on an empty
// queue, which is the correct behaviour: nothing enqueues work.
if (!config.redisUrl) {
  console.error("worker requires REDIS_URL");
  process.exit(1);
}

const runner = createBullMqRunner<unknown, never>(
  async (payload) => {
    throw new Error(
      `No job handler is registered for this payload: ${JSON.stringify(payload)}`,
    );
  },
  config.redisUrl,
  {
    concurrency: config.jobConcurrency,
    startWorker: true,
    completedRetentionSec: config.jobRetentionSec,
    failedRetentionSec: config.jobFailedRetentionSec,
    attempts: config.jobAttempts,
    backoffMs: config.jobBackoffMs,
  },
);

console.log(
  `👷 WattSteer worker started — concurrency ${config.jobConcurrency}, queue on Redis`,
);
console.log("   (no job handlers registered yet — idling)");

const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, draining worker…`);
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  await runner.close().catch(() => {});
  console.log("✅ Worker closed");
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled rejection (continuing):", reason);
});

// After an uncaught exception the process state is undefined — drain in-flight
// jobs (runner.close() waits for them) and exit so the supervisor restarts us.
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception — shutting down:", err);
  void shutdown("uncaughtException");
});
