import { Elysia } from "elysia";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import {
  createPayloadArchive,
  type PayloadArchive,
  readIngestionHealth,
} from "../ingest/index.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

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
 *
 * **It is `no-store`, and that is the same argument.** A response with no
 * `Cache-Control` is subject to an intermediary's heuristic freshness, and a
 * heuristically cached 200 from this route is a monitor being told everything
 * is fine by a copy of an answer from before the outage — silence again, with
 * a cache producing it. Its 503 does not save it either: that status is set on
 * the handler's own body and never passes through `errors.ts`, so the error
 * row's `refuseToCache` never sees it. The row is `CACHE_POLICIES.ingestHealth`
 * and the argument is written there.
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
    async ({ set, request }) => {
      // Before the branches, so that every answer this route can give — the
      // healthy 200, the stale 503 and the unconfigured 503 — carries it.
      applyCachePolicy({ set, request }, CACHE_POLICIES.ingestHealth);
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
