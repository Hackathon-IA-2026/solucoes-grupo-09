import { config } from "./config.js";
import { database } from "./database/connection.js";
import {
  createIngestDispatcher,
  createPayloadArchive,
  type QueueTask,
  type QueueTaskResult,
  REFRESH_CADENCE,
} from "./ingest/index.js";
import { createBullMqRunner } from "./jobs/bullmq.js";

// Dedicated worker process: pulls jobs off the BullMQ queue and runs them. Use
// this (with the API set to WATTSTEER_ROLE=api) to scale background work
// independently of the HTTP layer. Run several for more throughput.
//
// The one registered handler dispatches every ingestor, the tiered refresh
// sweeps and the retention pass — one queue, one handler, no second scheduler.
// All of it needs Postgres, so a worker without it refuses to start rather than
// failing every job it is handed.
if (!config.redisUrl) {
  console.error("worker requires REDIS_URL");
  process.exit(1);
}
if (!database) {
  console.error("worker requires DATABASE_URL — ingestion writes to Postgres");
  process.exit(1);
}

const archive = createPayloadArchive({
  bucket: config.archiveBucket,
  bucketAccessKeyId: config.archiveAccessKeyId,
  bucketSecretAccessKey: config.archiveSecretAccessKey,
  bucketEndpoint: config.archiveEndpoint,
  bucketRegion: config.archiveRegion,
  directory: config.archiveDir,
});

const dispatch = createIngestDispatcher({
  db: database.db,
  archive,
  retention: {
    unproductiveDays: config.archiveRetentionDays,
    batchSize: 500,
  },
});

const runner = createBullMqRunner<QueueTask, QueueTaskResult>(
  (payload, report) => dispatch(payload, report),
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

// The heartbeat: three sweeps and a retention pass, registered on the queue
// itself. Registering is idempotent — the ids are stable, so N replicas
// starting at once converge on one schedule apiece rather than N.
if (config.refreshSchedules) {
  for (const tier of ["live", "recent", "history"] as const) {
    await runner.schedule({
      id: `refresh:${tier}`,
      pattern: REFRESH_CADENCE[tier],
      payload: { kind: "refresh_sweep", payload: { tier } },
    });
  }
  // Weekly, and after the weekly sweep rather than before it: retention should
  // never be the reason a payload the sweep was about to reprocess is gone.
  await runner.schedule({
    id: "custody:retention",
    pattern: "30 5 * * 1",
    payload: { kind: "retention", payload: {} },
  });
  // The centroid drift watch: weekly, after a week of daily SIGA and registry
  // snapshots have had a chance to move the fleet. It recomputes the
  // capacity-weighted mean plant-to-centroid distance against the frozen set's
  // freeze-time baseline and warns at a 25% increase. It never regenerates —
  // that is a new centroid set version, a new feature-set version and a
  // retrain, and it is a decision rather than a cron job.
  await runner.schedule({
    id: "centroid:drift",
    pattern: "0 6 * * 1",
    payload: { kind: "centroid_drift", payload: {} },
  });
}

console.log(
  `👷 WattSteer worker started — concurrency ${config.jobConcurrency}, queue on Redis`,
);
console.log(
  "   handlers: ONS ingestion (7 sources), refresh sweeps, retention, centroid drift",
);
if (archive) {
  console.log(`   custody: raw payloads retained in the ${archive.kind} archive`);
} else {
  // Loud, because a deployment that runs for a year without custody cannot be
  // repaired afterwards: the vintages it did not keep are gone from ONS too.
  console.warn(
    "⚠️  custody: NO ARCHIVE CONFIGURED — raw payloads are not retained and prior " +
      "vintages will be unrecoverable. Set WATTSTEER_ARCHIVE_BUCKET or WATTSTEER_ARCHIVE_DIR.",
  );
}
if (config.refreshSchedules) {
  console.log(
    `   refresh: live ${REFRESH_CADENCE.live} · recent ${REFRESH_CADENCE.recent} ` +
      `· history ${REFRESH_CADENCE.history} (UTC)`,
  );
} else {
  console.log("   refresh: schedules disabled (WATTSTEER_REFRESH=off)");
}

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
