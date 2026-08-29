import { Elysia } from "elysia";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import {
  createPayloadArchive,
  type PayloadArchive,
  readIngestionHealth,
} from "../ingest/index.js";

/**
 * `GET /ingest/health` — the per-source view.
 *
 * A public read rather than a metrics scrape or a log line, because the
 * question it answers is one a human asks: is anything stale, did the last run
 * work, is the archive growing, and are the registry joins still matching? A
 * monitor can poll it too — `stale` is a boolean, on purpose, so an alert rule
 * is a field lookup rather than a threshold someone has to re-derive.
 *
 * It reports **503 when any source is stale**. Silence is the failure this
 * whole ticket is about, and a health endpoint that returns 200 while a source
 * has not moved in a week is a participant in it.
 *
 * The route is built by a factory over its database and archive so that the
 * 503 can be asserted end-to-end against a real database, rather than only the
 * view underneath it. A rule that lives in a handler and is only ever tested
 * one layer down is a rule nothing checks.
 */

/** The archive is read-only here: the API never writes custody. */
const archive = createPayloadArchive({
  bucket: config.archiveBucket,
  bucketAccessKeyId: config.archiveAccessKeyId,
  bucketSecretAccessKey: config.archiveSecretAccessKey,
  bucketEndpoint: config.archiveEndpoint,
  bucketRegion: config.archiveRegion,
  directory: config.archiveDir,
});

export function createIngestHealthRoute(deps: {
  db: Database | undefined;
  archive?: PayloadArchive;
}) {
  return new Elysia().get(
    "/ingest/health",
    async ({ set }) => {
      if (!deps.db) {
        set.status = 503;
        return { error: "Persistence is not configured" };
      }
      const health = await readIngestionHealth(deps.db, deps.archive);
      const stale = health.sources.filter((source) => source.stale).map((s) => s.source);
      if (stale.length > 0) {
        set.status = 503;
      }
      return { ...health, stale };
    },
    {
      detail: {
        summary: "Ingestion health — freshness, runs, custody and join match rates",
        description:
          "Per-source freshness and row counts, last successful run, re-publication " +
          "activity, raw-payload custody and registry join match rates. 503 when any " +
          "source has gone stale.",
      },
    },
  );
}

/** The wired route, over the process-wide handle. */
export const ingestHealth = createIngestHealthRoute({ db: database?.db, archive });
