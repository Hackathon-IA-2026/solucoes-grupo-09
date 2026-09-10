import { config } from "../config.js";
import { createDatabase } from "../database/connection.js";
import type { QueueTask } from "../ingest/dispatch.js";
import {
  createIngestDispatcher,
  createPayloadArchive,
  type IngestTaskResult,
  runRecordedIngestion,
} from "../ingest/index.js";
import type { ReportProgress } from "../jobs/index.js";

/**
 * Drive one ingestion — or one tiered sweep — without Redis.
 *
 *     bun run src/scripts/ingest.ts task '{"kind":"dessem_balance","payload":{"from":"2025-05-23","to":"2025-05-27"}}'
 *     bun run src/scripts/ingest.ts sweep history
 *     bun run src/scripts/ingest.ts sweep history --now 2026-09-10T00:00:00Z --history-slice 3
 *
 * This is **not** a second ingestion path: it constructs the very handler the
 * worker registers (`createIngestDispatcher`) and hands it one `QueueTask`. The
 * worker takes its tasks off BullMQ; a backfill operator does not have a queue
 * and should not need Redis, a scheduler and a fake cron to fill a window that
 * `planRefresh` already knows how to plan.
 *
 * Everything downstream is unchanged: the same fingerprint probe, the same
 * versioned write, the same `ingestion_run` row per ingestion — a bare task is
 * recorded through `runRecordedIngestion`, the sweep's own bookkeeping, at the
 * `manual` tier. A backfill that wrote a million rows and left no run row would
 * be invisible to the view whose whole job is to say what has run.
 */

function usage(): never {
  console.error(
    "usage: ingest.ts task '<IngestTask JSON>'\n" +
      "       ingest.ts sweep <live|recent|history> [--now <ISO>] [--history-slice <n>] [--force]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const mode = args[0];
if (mode !== "task" && mode !== "sweep") {
  usage();
}

if (!config.databaseUrl) {
  console.error("DATABASE_URL is required — ingestion writes to Postgres");
  process.exit(1);
}

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

let task: QueueTask;
if (mode === "task") {
  const json = args[1];
  if (!json) {
    usage();
  }
  task = JSON.parse(json) as QueueTask;
} else {
  const tier = args[1];
  if (tier !== "live" && tier !== "recent" && tier !== "history") {
    usage();
  }
  const slice = flag("--history-slice");
  task = {
    kind: "refresh_sweep",
    payload: {
      tier,
      now: flag("--now"),
      force: args.includes("--force"),
      historySlice: slice === undefined ? undefined : Number(slice),
    },
  };
}

const database = createDatabase(config.databaseUrl);
const archive = createPayloadArchive({
  bucket: config.archiveBucket,
  bucketAccessKeyId: config.archiveAccessKeyId,
  bucketSecretAccessKey: config.archiveSecretAccessKey,
  bucketEndpoint: config.archiveEndpoint,
  bucketRegion: config.archiveRegion,
  directory: config.archiveDir,
});
if (!archive) {
  // Same sentence the worker says, and for the same reason: a backfill run
  // without custody keeps no prior vintage, and upstream will not keep it either.
  console.warn(
    "⚠️  custody: NO ARCHIVE CONFIGURED — raw payloads are not retained. " +
      "Set WATTSTEER_ARCHIVE_DIR or WATTSTEER_ARCHIVE_BUCKET.",
  );
}

const dispatch = createIngestDispatcher({ db: database.db, archive });
const report: ReportProgress = (progress) => {
  if (progress.total) {
    console.log(`   … ${progress.done}/${progress.total}`);
  }
};
const startedAt = Date.now();
try {
  // A sweep records its own runs; a bare task is recorded here, at the `manual`
  // tier the enum has always had and nothing used. Without it a hand-driven
  // backfill writes rows that `/v1/ingest/health` cannot see.
  const outcome =
    task.kind === "refresh_sweep" ||
    task.kind === "retention" ||
    task.kind === "centroid_drift"
      ? await dispatch(task, report)
      : (
          await runRecordedIngestion(
            database.db,
            "manual",
            task,
            (ingestion, progress) =>
              dispatch(ingestion, progress) as Promise<IngestTaskResult>,
            { report },
          )
        ).outcome;
  console.log(JSON.stringify(outcome, null, 2));
  console.log(`⏱  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} finally {
  await database.close();
}
