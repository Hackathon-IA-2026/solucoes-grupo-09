import { config } from "./config.js";
import { database } from "./database/connection.js";
import { createPayloadArchive, REFRESH_CADENCE } from "./ingest/index.js";
import { createBullMqRunner } from "./jobs/bullmq.js";
import { FORECAST_PUBLICATIONS, PUBLICATION_TIME_ZONE } from "./jobs/publication.js";
import { RETRAIN_JOB_ID, RETRAIN_PATTERN, RETRAIN_TIME_ZONE } from "./jobs/retrain.js";
import {
  createWorkerDispatch,
  forecastPublicationSchedules,
  retrainScheduleForQueue,
  type WorkerTask,
  type WorkerTaskResult,
} from "./jobs/worker-tasks.js";

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

const dispatch = createWorkerDispatch({
  db: database.db,
  archive,
  retention: {
    unproductiveDays: config.archiveRetentionDays,
    batchSize: 500,
  },
});

const runner = createBullMqRunner<WorkerTask, WorkerTaskResult>(
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
  // The publication: ten minutes after each gate, in Brasília civil time.
  //
  // Registered here and only here — `docs/specs/api-surface.md`'s boundary
  // decision is that the forecast is a row this schedule wrote, so the API
  // process (WATTSTEER_ROLE=api) has no path to the modelling service for a
  // forecast and needs none.
  //
  // Skipped, loudly, without a modelling service to ask: a schedule that fires
  // twice a day into an unconfigured `mlUrl` is two guaranteed job failures a
  // day, and `ml-proxy` is right to call that a misconfiguration rather than an
  // outage. What the reader sees either way is the last published origin with
  // its real age.
  if (config.mlUrl) {
    for (const publication of forecastPublicationSchedules()) {
      await runner.schedule(publication);
    }
  } else {
    console.warn(
      "⚠️  publication: WATTSTEER_ML_URL is unset — the day-ahead forecast will " +
        "not be published, and /v1/forecast/day-ahead will keep serving the last " +
        "origin with its real age.",
    );
  }
  // The weekly retrain: Fridays at 03:10 UTC, `docs/specs/forecaster.md`'s
  // seam 11. Forecaster 19 gated both lanes in one pass and left nothing
  // calling it; this is the cron entry, and it is the only one.
  //
  // Registered here and only here, beside the publications and for the same
  // reason: one queue, one scheduler. It is a separate `if` from theirs because
  // the two need the modelling service for different things — they ask it for
  // a day, this asks it to spend forty minutes fitting — and a deployment
  // without `WATTSTEER_ML_URL` should be told about each in its own sentence.
  //
  // Skipped, loudly, without one: a schedule firing weekly into an unconfigured
  // `mlUrl` is a guaranteed job failure every Friday. What an operator sees
  // instead is the incumbent going on serving, ageing, with no new decision
  // line — which is exactly what the promotion log is for.
  if (config.mlUrl) {
    for (const schedule of retrainScheduleForQueue()) {
      await runner.schedule(schedule);
    }
  } else {
    console.warn(
      "⚠️  retrain: WATTSTEER_ML_URL is unset — no lane will be retrained or " +
        "gated, and whatever is promoted today goes on serving indefinitely.",
    );
  }
}

console.log(
  `👷 WattSteer worker started — concurrency ${config.jobConcurrency}, queue on Redis`,
);
console.log(
  "   handlers: ONS ingestion (7 sources), refresh sweeps, retention, centroid " +
    "drift, forecast publication",
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
if (config.refreshSchedules && config.mlUrl) {
  console.log(
    `   publication: ${FORECAST_PUBLICATIONS.map(
      (publication) => `${publication.payload.gateProfile} ${publication.pattern}`,
    ).join(" · ")} (${PUBLICATION_TIME_ZONE})`,
  );
  console.log(`   retrain: ${RETRAIN_JOB_ID} ${RETRAIN_PATTERN} (${RETRAIN_TIME_ZONE})`);
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
