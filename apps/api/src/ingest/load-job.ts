import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import {
  recordLoadApiRequest,
  writeProgrammedLoad,
  writeVerifiedLoad,
} from "./load-repository.js";
import {
  AREA_CODE_FOR_SUBSYSTEM,
  chunkDateRange,
  type DateRange,
  fetchLoadRange,
  type LoadAreaCode,
  type LoadSeries,
  resolveAreaCode,
} from "./ons/carga-api.js";
import { parseProgrammedLoad, parseVerifiedLoad } from "./ons/load.js";

/**
 * Ingestion for the two carga series — the first source with **no bulk files**.
 *
 * Everything before the write is different from the bulk jobs and nothing after
 * it is. There is no catalogue to read, no `HEAD` to spend and no conditional
 * download, because there is no file: the unit of work is an HTTP call for one
 * area over one date range, and the only way to know whether anything changed
 * is to fetch the numbers and diff them. So this job shares
 * `versioned-write.ts` and skips `bulk-resource.ts` entirely.
 *
 * The cost of that is real and worth stating: a sweep over closed history here
 * is one call per area per quarter with no cheap "nothing moved" probe, where
 * the bulk sweep is one `HEAD` per file. The compensation is that
 * `/cargaverificada` carries `din_atualizacao`, so a revision is visible at row
 * rather than file granularity once the bytes are in hand.
 */

/** The four subsystem areas — the default ingest, in canonical order. */
export const DEFAULT_AREA_CODES: LoadAreaCode[] = [
  AREA_CODE_FOR_SUBSYSTEM.N,
  AREA_CODE_FOR_SUBSYSTEM.NE,
  AREA_CODE_FOR_SUBSYSTEM.S,
  // `SECO`, not `SE`. Sending `SE` returns HTTP 200 and an empty array.
  AREA_CODE_FOR_SUBSYSTEM.SE,
];

/** One series, one date range, one or more areas. */
export interface IngestLoadPayload {
  series: LoadSeries;
  /** `YYYY-MM-DD`, inclusive. Chunked to the documented three-month limit. */
  from: string;
  to: string;
  /**
   * Areas to fetch. Defaults to the four subsystems; pass geoelectric codes to
   * ingest the finer grain. `SE` is rejected by name rather than requested.
   */
  areaCodes?: string[];
  /** Today, UTC. Injected so the truncation check is deterministic in tests. */
  now?: string;
}

export interface IngestLoadResult {
  series: LoadSeries;
  areaCodes: LoadAreaCode[];
  /** Calls actually made — areas × three-month chunks. */
  requests: number;
  /** Chunks whose response was not valid JSON until it was repaired. */
  requestsRepaired: number;
  rowsFetched: number;
  rowsParsed: number;
  rowsRejected: number;
  /** Rows that arrived without `din_atualizacao`. Always the row count for programada. */
  rowsWithoutVintage: number;
  inserted: number;
  revised: number;
  unchanged: number;
}

export interface LoadIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
  /**
   * Where raw payloads are retained. Absent means the payload is ingested and
   * not kept — correct for a test, and visible in the health view otherwise.
   */
  archive?: PayloadArchive;
  /** Overridable so a test can point at a local server. */
  baseUrl?: string;
}

/**
 * Build the job handler.
 *
 * Chunking happens before the first call rather than as a retry on a failure:
 * the API answers an over-long range with HTTP 200 and a silently truncated
 * body (measured at 103 days), so there is no failure to retry on.
 */
export function createLoadIngestor(
  deps: LoadIngestorDeps,
): Execute<IngestLoadPayload, IngestLoadResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const areaCodes = (payload.areaCodes ?? DEFAULT_AREA_CODES).map(resolveAreaCode);
    const chunks: DateRange[] = chunkDateRange({ from: payload.from, to: payload.to });
    const total = areaCodes.length * chunks.length;
    const now = payload.now ? new Date(`${payload.now}T00:00:00Z`) : undefined;

    const result: IngestLoadResult = {
      series: payload.series,
      areaCodes,
      requests: 0,
      requestsRepaired: 0,
      rowsFetched: 0,
      rowsParsed: 0,
      rowsRejected: 0,
      rowsWithoutVintage: 0,
      inserted: 0,
      revised: 0,
      unchanged: 0,
    };

    for (const areaCode of areaCodes) {
      for (const range of chunks) {
        const response = await fetchLoadRange({
          series: payload.series,
          areaCode,
          range,
          fetch: fetchImpl,
          baseUrl: deps.baseUrl,
          now,
        });

        // Provenance first: the fact rows carry a foreign key to it, and the
        // row is also the only record that this range was asked for at all.
        const sourceVersionId = await recordLoadApiRequest(
          deps.db,
          {
            series: payload.series,
            areaCode,
            rangeStart: range.from,
            rangeEnd: range.to,
            response,
          },
          deps.archive,
        );

        result.requests += 1;
        result.requestsRepaired += response.repaired ? 1 : 0;
        result.rowsFetched += response.rows.length;

        // The response's fetch time is the fallback vintage. Verified rows
        // override it with their own `din_atualizacao`; programmed rows have
        // none and keep it, marked `file` for the coarseness it is.
        const vintage = {
          publishedAt: response.fetchedAt,
          publishedAtPrecision: "file" as const,
          sourceVersionId,
        };

        if (payload.series === "VERIFIED") {
          const parsed = parseVerifiedLoad(response.rows);
          const written = await writeVerifiedLoad(deps.db, {
            rows: parsed.rows,
            ...vintage,
          });
          result.rowsParsed += parsed.rows.length;
          result.rowsRejected += parsed.rejected.length;
          result.rowsWithoutVintage += parsed.rowsWithoutVintage;
          result.inserted += written.inserted;
          result.revised += written.revised;
          result.unchanged += written.unchanged;
        } else {
          const parsed = parseProgrammedLoad(response.rows);
          const written = await writeProgrammedLoad(deps.db, {
            rows: parsed.rows,
            ...vintage,
          });
          result.rowsParsed += parsed.rows.length;
          result.rowsRejected += parsed.rejected.length;
          result.rowsWithoutVintage += parsed.rowsWithoutVintage;
          result.inserted += written.inserted;
          result.revised += written.revised;
          result.unchanged += written.unchanged;
        }

        report({ done: result.requests, total });
      }
    }

    return result;
  };
}
