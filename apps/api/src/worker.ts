import { config } from "./config.js";
import { database } from "./database/connection.js";
import { loggableError } from "./errors.js";
import {
  createPayloadArchive,
  ONS_SOURCES,
  REFRESH_CADENCE,
  TRACKED_SOURCES,
} from "./ingest/index.js";
import { createBullMqRunner } from "./jobs/bullmq.js";
import { FORECAST_PUBLICATIONS, PUBLICATION_TIME_ZONE } from "./jobs/publication.js";
import { RAG_EVIDENCE_SCHEDULE } from "./jobs/rag-evidence.js";
import { RAG_REFRESH_SCHEDULE } from "./jobs/rag-refresh.js";
import {
  REPLAY_REFRESH_JOB_PREFIX,
  REPLAY_REFRESH_PATTERN,
  REPLAY_REFRESH_TIME_ZONE,
  replayRefreshTargets,
} from "./jobs/replay-refresh.js";
import { RETRAIN_TIME_ZONE } from "./jobs/retrain.js";
import type { JobSchedule } from "./jobs/types.js";
import {
  createWorkerDispatch,
  forecastPublicationSchedules,
  holdoutBackfillScheduleForQueue,
  replayRefreshSchedulesForQueue,
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

// The forecast publication's follow-on, and the one knot in this file.
//
// `docs/specs/api-surface.md` gives `publish-diagnosis` the trigger "on
// completion of each" forecast publication, so the dispatcher has to be able to
// put a task back on the queue — and the queue is constructed *from* the
// dispatcher, so the dispatcher cannot hold it. This closes the loop in the one
// place that can: the dispatcher is handed a thunk, the runner is built, and the
// thunk is bound to it. A task that somehow arrived in the window between the
// two gets a named error rather than a `TypeError` on `undefined`.
let queue: ((task: WorkerTask) => Promise<string>) | undefined;

const dispatch = createWorkerDispatch({
  db: database.db,
  archive,
  retention: {
    unproductiveDays: config.archiveRetentionDays,
    batchSize: 500,
  },
  submit: async (task) => {
    if (queue === undefined) {
      throw new Error(
        "the queue is not ready yet: a follow-on task cannot be submitted " +
          "before the runner it would go on has been constructed",
      );
    }
    return queue(task);
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
    lockDurationMs: config.jobLockDurationMs,
  },
);

queue = (task) => runner.submit(task);

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
  // The RAG's daily catch-up, ten past four Brasília: after the day's bulletin
  // is published and well before the morning gate.
  //
  // Skipped loudly without a URL, exactly as the publication is without
  // `mlUrl`, and for a sharper reason: a corpus that stops moving looks
  // identical to a healthy one from every other signal. `/ready` is green,
  // `/internal/rag/status` returns numbers, queries answer — and the newest
  // document quietly ages. A warning at boot is the only place that can say so
  // before somebody asks about a day nobody fetched.
  if (config.ragUrl) {
    await runner.schedule(RAG_REFRESH_SCHEDULE);
    // Twenty minutes after it, so a lookup cites the documents this morning
    // fetched rather than yesterday's.
    await runner.schedule(RAG_EVIDENCE_SCHEDULE);
  } else {
    console.warn(
      "⚠️  rag: WATTSTEER_RAG_URL is unset — the evidence corpus will not be " +
        "refreshed, and the date it covers stops moving while every other " +
        "signal keeps reporting healthy.",
    );
  }

  /*
    The four schedules that need a modelling service, and the sentence each
    owes an operator when there is none.

    Written as a table because the *shape* was written four times and the
    **sentences** are the only part that differs. Each block was
    `if (config.mlUrl) { for (…) await runner.schedule(…) } else { warn(…) }`,
    and the fifth producer would have been a fifth copy — which is how
    `refresh_replay_caches` came to be a schedule nobody registered until
    replay 08 (`test/reachability.ts` records that incident at length).

    The sentences stay four, deliberately, and none is generated from a name.
    They are not the same absence: without a modelling service the publications
    keep serving the last origin with its real age, the retrain leaves whatever
    is promoted serving indefinitely, the backfill makes `/v1/replay` refuse
    every walk-forward test day with a product refusal rather than a stale
    model, and the refresh leaves `/v1/replay/days` and `/v1/backtest` on a
    stated `pending`. An operator reading the log needs to be told which of
    those they are looking at, so a single "ml is unset" warning would be four
    different diagnoses collapsed into one.

    Each entry calls its producer rather than holding a reference to it, which
    is also what `test/reachability.ts` reads as the registration: a producer
    nobody calls from outside the module declaring it is a function that
    manufactures schedules nobody registers.
  */
  const MODEL_BACKED: readonly {
    readonly schedules: () => JobSchedule<WorkerTask>[];
    readonly absence: string;
  }[] = [
    {
      // The publication: ten minutes after each gate, in Brasília civil time.
      //
      // Registered here and only here — `docs/specs/api-surface.md`'s boundary
      // decision is that the forecast is a row this schedule wrote, so the API
      // process (WATTSTEER_ROLE=api) has no path to the modelling service for a
      // forecast and needs none.
      //
      // Skipped, loudly: a schedule that fires twice a day into an unconfigured
      // `mlUrl` is two guaranteed job failures a day, and `ml-proxy` is right
      // to call that a misconfiguration rather than an outage.
      schedules: () => forecastPublicationSchedules(),
      absence:
        "⚠️  publication: WATTSTEER_ML_URL is unset — the day-ahead forecast will " +
        "not be published, and /v1/forecast/day-ahead will keep serving the last " +
        "origin with its real age.",
    },
    {
      // The weekly retrain: Fridays at 03:10 UTC, `docs/specs/forecaster.md`'s
      // seam 11. Forecaster 19 gated both lanes in one pass and left nothing
      // calling it; this is the cron entry, and it is the only one.
      //
      // Its own sentence because it needs the modelling service for a different
      // thing than the publications do — they ask it for a day, this asks it to
      // spend forty minutes fitting.
      schedules: () => retrainScheduleForQueue(),
      absence:
        "⚠️  retrain: WATTSTEER_ML_URL is unset — no lane will be retrained or " +
        "gated, and whatever is promoted today goes on serving indefinitely.",
    },
    {
      // The holdout backfill: Fridays at 03:40 UTC, half an hour behind the
      // retrain, `docs/specs/replay.md`'s one storage requirement. The retrain
      // is what mints the fold artifacts; this is what stops their out-of-fold
      // predictions being thrown away.
      //
      // Its own sentence because what is lost is a *product* absence rather
      // than a stale model.
      schedules: () => holdoutBackfillScheduleForQueue(),
      absence:
        "⚠️  holdout backfill: WATTSTEER_ML_URL is unset — no fold's out-of-fold " +
        "forecasts will be persisted, and /v1/replay will refuse every " +
        "walk-forward test day with REPLAY_FORECAST_UNAVAILABLE.",
    },
    {
      // The Replay caches: 03:30 in Brasília, nightly, one schedule per
      // (subsystem, served lane). `docs/specs/api-surface.md`'s scheduled-jobs
      // table has listed `refresh-featured-days | 30 3 * * *` since replay 07
      // landed the endpoint, and until this entry existed that row described a
      // cron in no file: the shortlist and the Backtest aggregate were computed
      // by tests and by nothing else.
      //
      // Its own sentence because the absence a reader then meets is a stated
      // `pending` rather than a stale number.
      schedules: () => replayRefreshSchedulesForQueue(),
      absence:
        "⚠️  replay refresh: WATTSTEER_ML_URL is unset — the featured-days " +
        "shortlist and the Backtest aggregate will not be computed, and " +
        "/v1/replay/days and /v1/backtest will keep serving pending.",
    },
  ];

  for (const entry of MODEL_BACKED) {
    if (config.mlUrl) {
      for (const schedule of entry.schedules()) {
        await runner.schedule(schedule);
      }
    } else {
      console.warn(entry.absence);
    }
  }
}

console.log(
  `👷 WattSteer worker started — concurrency ${config.jobConcurrency}, queue on Redis`,
);
// Counted from the registry, never written here. This line said "7 sources"
// against a table of seventeen, and it could: a literal in a `console.log` is
// rendered by nothing, returned by no route, and therefore checked by no test.
console.log(
  `   handlers: ONS ingestion (${ONS_SOURCES} sources, ${TRACKED_SOURCES} tracked ` +
    "with the weather feed), refresh sweeps, retention, centroid drift, " +
    "forecast publication, diagnosis publication",
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
/*
  Printed for the reason every other schedule here is: a registered job that
  says nothing at boot is a job an operator can only discover by noticing its
  absence, and the absence of this one is silent by construction — the corpus
  simply stops moving while `/ready` stays green.
*/
if (config.refreshSchedules && config.ragUrl) {
  console.log(
    `   rag: ${RAG_REFRESH_SCHEDULE.id} ${RAG_REFRESH_SCHEDULE.pattern} ` +
      `(${RAG_REFRESH_SCHEDULE.timeZone})`,
  );
}
if (config.refreshSchedules && config.mlUrl) {
  console.log(
    `   publication: ${FORECAST_PUBLICATIONS.map(
      (publication) => `${publication.payload.gateProfile} ${publication.pattern}`,
    ).join(" · ")} (${PUBLICATION_TIME_ZONE})`,
  );
  // Printed from the schedules that were *registered*, not from the constant.
  // The banner used to read `RETRAIN_PATTERN` directly, so an operator who set
  // `WATTSTEER_RETRAIN_PATTERN` was told the weekly cadence by a process that
  // was keeping a different one — a schedule that exists only in the log, which
  // is the inverse of what `test/phantom-schedules.test.ts` was written about.
  for (const schedule of retrainScheduleForQueue()) {
    console.log(`   retrain: ${schedule.id} ${schedule.pattern} (${RETRAIN_TIME_ZONE})`);
  }
  // No pattern of its own, and saying so is the point: the diagnosis
  // publication is the one row of the spec's job table whose trigger is a
  // completion rather than a cron, so an operator reading this banner and
  // looking for a third time is told where to look instead.
  console.log(
    "   diagnosis: on completion of each forecast publication (no cron of its own)",
  );
  console.log(
    `   replay refresh: ${REPLAY_REFRESH_JOB_PREFIX} ${REPLAY_REFRESH_PATTERN} ` +
      `(${REPLAY_REFRESH_TIME_ZONE}) × ${replayRefreshTargets().length} ` +
      "(subsystem, lane) pairs — the featured-days shortlist and the Backtest",
  );
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
  console.error("⚠️  Unhandled rejection (continuing):", loggableError(reason));
});

// After an uncaught exception the process state is undefined — drain in-flight
// jobs (runner.close() waits for them) and exit so the supervisor restarts us.
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception — shutting down:", loggableError(err));
  void shutdown("uncaughtException");
});
