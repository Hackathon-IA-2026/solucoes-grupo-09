import { ReviewService } from "./api/reviews/service.js";
import { config } from "./config.js";
import { createBullMqRunner } from "./jobs/bullmq.js";

// Dedicated worker process: pulls scrape jobs off the BullMQ queue and runs
// them. Use this (with the API set to NOVIQ_ROLE=api) to scale scraping
// independently of the HTTP layer. Run several for more throughput.
if (!config.redisUrl) {
  console.error("worker requires REDIS_URL");
  process.exit(1);
}

const runner = createBullMqRunner(
  (query) => ReviewService.scrape(query),
  config.redisUrl,
  {
    concurrency: config.maxConcurrency,
    startWorker: true,
    completedRetentionSec: config.jobRetentionSec,
    failedRetentionSec: config.jobFailedRetentionSec,
    attempts: config.jobAttempts,
    backoffMs: config.jobBackoffMs,
  },
);

console.log(
  `👷 noviq worker started — concurrency ${config.maxConcurrency}, queue on Redis`,
);

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
