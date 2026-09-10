import type { ingestionSource } from "../database/schema.js";
import type {
  IngestConstrainedOffDetailPayload,
  IngestConstrainedOffDetailResult,
} from "./constrained-off-detail-job.js";
import type {
  IngestConstrainedOffPayload,
  IngestConstrainedOffResult,
} from "./constrained-off-job.js";
import type { IngestDailyLoadPayload, IngestDailyLoadResult } from "./daily-load-job.js";
import type { IngestDessemPayload, IngestDessemResult } from "./dessem-job.js";
import type {
  IngestInterchangePayload,
  IngestInterchangeResult,
} from "./interchange-job.js";
import type { IngestEnergyBalancePayload, IngestEnergyBalanceResult } from "./job.js";
import type { IngestLoadPayload, IngestLoadResult } from "./load-job.js";
import type {
  IngestPlantRegistryPayload,
  IngestPlantRegistryResult,
} from "./registry-job.js";
import type { IngestSigaPayload, IngestSigaResult } from "./siga-job.js";
import type { IngestWeatherPayload, IngestWeatherResult } from "./weather-job.js";

/**
 * The unit of work the queue carries — one tagged payload per ingestor.
 *
 * There is one BullMQ queue and one handler, so the handler needs one payload
 * type. A tagged union is that type, and it also gives the refresh planner
 * something to *produce*: a plan is a list of these, which means the plan can
 * be computed, asserted against and printed without anything being ingested.
 */

/** `ingestion_run.source` — one member per ingestor, not per CKAN dataset. */
export type IngestionSource = (typeof ingestionSource.enumValues)[number];

/** One ingestion, ready to enqueue. */
export type IngestTask =
  | { kind: "energy_balance"; payload: IngestEnergyBalancePayload }
  | { kind: "constrained_off"; payload: IngestConstrainedOffPayload }
  | {
      kind: "constrained_off_detail";
      payload: IngestConstrainedOffDetailPayload;
    }
  | { kind: "interchange"; payload: IngestInterchangePayload }
  | { kind: "daily_load"; payload: IngestDailyLoadPayload }
  | { kind: "dessem_balance"; payload: IngestDessemPayload }
  | { kind: "load"; payload: IngestLoadPayload }
  | { kind: "plant_registry"; payload: IngestPlantRegistryPayload }
  | { kind: "siga"; payload: IngestSigaPayload }
  | { kind: "weather"; payload: IngestWeatherPayload };

/** What one ingestion produced, tagged so a caller can narrow it back. */
export type IngestTaskResult =
  | { kind: "energy_balance"; result: IngestEnergyBalanceResult }
  | { kind: "constrained_off"; result: IngestConstrainedOffResult }
  | { kind: "constrained_off_detail"; result: IngestConstrainedOffDetailResult }
  | { kind: "interchange"; result: IngestInterchangeResult }
  | { kind: "daily_load"; result: IngestDailyLoadResult }
  | { kind: "dessem_balance"; result: IngestDessemResult }
  | { kind: "load"; result: IngestLoadResult }
  | { kind: "plant_registry"; result: IngestPlantRegistryResult }
  | { kind: "siga"; result: IngestSigaResult }
  | { kind: "weather"; result: IngestWeatherResult };

/**
 * Which source a task belongs to.
 *
 * Not the same as `kind`: constrained-off is one ingestor over two datasets and
 * the carga job is one ingestor over two series, and an operator watching for a
 * source that went quiet needs solar to be visibly quiet even while wind is
 * running through the same code.
 */
export function sourceOf(task: IngestTask): IngestionSource {
  switch (task.kind) {
    case "constrained_off":
      return task.payload.technology === "WIND"
        ? "constrained_off_wind"
        : "constrained_off_solar";
    case "constrained_off_detail":
      return task.payload.technology === "WIND"
        ? "constrained_off_wind_detail"
        : "constrained_off_solar_detail";
    case "load":
      return task.payload.series === "VERIFIED" ? "verified_load" : "programmed_load";
    default:
      return task.kind;
  }
}

/** What the task covers, in the source's own unit — the run log's period. */
export function periodLabelOf(task: IngestTask): string | null {
  switch (task.kind) {
    case "energy_balance":
    case "interchange":
    case "daily_load":
      return String(task.payload.year);
    case "constrained_off":
    case "constrained_off_detail":
      return `${task.payload.year}-${String(task.payload.month).padStart(2, "0")}`;
    case "dessem_balance":
      return `${task.payload.from ?? "start"}..${task.payload.to ?? "latest"}`;
    case "load":
      return `${task.payload.from}..${task.payload.to}`;
    case "weather":
      // Target days, not run initialisations: the runs are always D−1 of each
      // day in the range, so the days are the shorter and the truer label.
      return `${task.payload.from}..${task.payload.to}`;
    default:
      // `plant_registry` and `siga` — snapshots of now, which have no period.
      // SIGA follows the registry exactly here: the extract is overwritten in
      // place and carries a generation date, not a period it covers.
      return null;
  }
}

/** Rows written by a task, however its result spells them. */
export function rowsOf(task: IngestTaskResult): {
  parsed: number;
  inserted: number;
  revised: number;
  unchanged: number;
  downloaded: number;
  probed: number;
} {
  if (task.kind === "plant_registry") {
    const { units, memberships, unitRowsParsed, membershipRowsParsed } = task.result;
    return {
      parsed: unitRowsParsed + membershipRowsParsed,
      inserted: units.inserted + memberships.inserted,
      revised: units.revised + memberships.revised,
      unchanged: units.unchanged + memberships.unchanged,
      downloaded: task.result.downloaded ? 2 : 0,
      probed: 2,
    };
  }
  if (task.kind === "siga") {
    const { locations } = task.result;
    return {
      parsed: task.result.sourceRows,
      inserted: locations.inserted,
      revised: locations.revised,
      unchanged: locations.unchanged,
      downloaded: task.result.downloaded ? 1 : 0,
      probed: 1,
    };
  }
  if (task.kind === "weather") {
    return {
      parsed: task.result.runs.reduce((total, run) => total + run.rows, 0),
      inserted: task.result.inserted,
      revised: task.result.revised,
      unchanged: task.result.unchanged,
      // One HTTP call per run tried. A slot the local probe answered is neither
      // downloaded nor probed remotely, which is exactly what the counters
      // should show for a sweep that spent nothing.
      downloaded: task.result.requests,
      probed: task.result.runsScheduled,
    };
  }
  if (task.kind === "dessem_balance") {
    return {
      parsed: task.result.rowsParsed,
      inserted: task.result.inserted,
      revised: task.result.revised,
      unchanged: task.result.unchanged,
      downloaded: task.result.daysDownloaded,
      probed: task.result.daysProcessed,
    };
  }
  if (task.kind === "load") {
    return {
      parsed: task.result.rowsParsed,
      inserted: task.result.inserted,
      revised: task.result.revised,
      unchanged: task.result.unchanged,
      // Every carga call is a download: there is no `HEAD` to stop at.
      downloaded: task.result.requests,
      probed: task.result.requests,
    };
  }
  return {
    parsed: task.result.rowsParsed,
    inserted: task.result.inserted,
    revised: task.result.revised,
    unchanged: task.result.unchanged,
    downloaded: task.result.downloaded ? 1 : 0,
    probed: 1,
  };
}
