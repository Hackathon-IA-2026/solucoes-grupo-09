import { config } from "./config.js";
import { database } from "./database/connection.js";
import {
  createEnergyBalanceIngestor,
  type IngestEnergyBalancePayload,
  type IngestEnergyBalanceResult,
} from "./ingest/index.js";
import { createBullMqRunner } from "./jobs/bullmq.js";

// Dedicated worker process: pulls jobs off the BullMQ queue and runs them. Use
// this (with the API set to WATTSTEER_ROLE=api) to scale background work
// independently of the HTTP layer. Run several for more throughput.
//
// The one registered handler is ONS ingestion, which needs Postgres — a worker
// without it could only fail every job, so it refuses to start instead.
if (!config.redisUrl) {
  console.error("worker requires REDIS_URL");
  process.exit(1);
}
if (!database) {
  console.error("worker requires DATABASE_URL — ingestion writes to Postgres");
  process.exit(1);
}

const ingestEnergyBalance = createEnergyBalanceIngestor({ db: database.db });

const runner = createBullMqRunner<IngestEnergyBalancePayload, IngestEnergyBalanceResult>(
  (payload, report) => ingestEnergyBalance(payload, report),
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
console.log("   handlers: ONS balanco-energia-subsistema ingestion");

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
