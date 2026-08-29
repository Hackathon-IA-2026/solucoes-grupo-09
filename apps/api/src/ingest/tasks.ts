import type { ingestionSource } from "../database/schema.js";
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
  | { kind: "interchange"; payload: IngestInterchangePayload }
  | { kind: "daily_load"; payload: IngestDailyLoadPayload }
  | { kind: "dessem_balance"; payload: IngestDessemPayload }
  | { kind: "load"; payload: IngestLoadPayload }
  | { kind: "plant_registry"; payload: IngestPlantRegistryPayload };

/** What one ingestion produced, tagged so a caller can narrow it back. */
export type IngestTaskResult =
  | { kind: "energy_balance"; result: IngestEnergyBalanceResult }
  | { kind: "constrained_off"; result: IngestConstrainedOffResult }
  | { kind: "interchange"; result: IngestInterchangeResult }
  | { kind: "daily_load"; result: IngestDailyLoadResult }
  | { kind: "dessem_balance"; result: IngestDessemResult }
  | { kind: "load"; result: IngestLoadResult }
  | { kind: "plant_registry"; result: IngestPlantRegistryResult };

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
      return `${task.payload.year}-${String(task.payload.month).padStart(2, "0")}`;
    case "dessem_balance":
      return `${task.payload.from ?? "start"}..${task.payload.to ?? "latest"}`;
    case "load":
      return `${task.payload.from}..${task.payload.to}`;
    default:
      // `plant_registry` — a snapshot of now, which has no period.
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
