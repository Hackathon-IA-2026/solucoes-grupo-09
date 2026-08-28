import type { SubsystemCode } from "./normalise.js";

/**
 * The canonical form. Nothing downstream of an adapter sees an ONS convention:
 * `validTime` is a UTC instant at the start of the interval it describes, the
 * subsystem is WattSteer's code, and every quantity is MWh.
 */
export interface EnergyBalanceHour {
  subsystem: SubsystemCode;
  /** Start of the hour, UTC. */
  validTime: Date;
  loadMwh: number;
  hydroGenerationMwh: number;
  thermalGenerationMwh: number;
  windGenerationMwh: number;
  solarGenerationMwh: number;
  netExchangeMwh: number;
}

/**
 * Why a source row did not become a canonical row.
 *
 * No adapter may silently coerce: where a rule cannot be applied the row is
 * rejected *with* a reason. These names are part of the contract — an operator
 * reading a run summary should be able to tell a data defect from a bug.
 */
export type RejectionReason =
  /** `id_subsistema` was neither a subsystem nor the `SIN` aggregate. */
  | "unknown_subsystem"
  /** `din_instante` was not a wall clock we could read. */
  | "unparsable_timestamp"
  /** A local time that never existed — DST spring forward. */
  | "dst_gap"
  /** A local time that happened twice — DST fall back, unrecoverable. */
  | "dst_ambiguous"
  /** A required column was present but empty. Never read as zero. */
  | "empty_value"
  /** A required column held something that is not a number. */
  | "unparsable_value";

/** A rejected source row, kept so a run can explain itself. */
export interface RejectedRow {
  reason: RejectionReason;
  /** 1-based index of the row within the source file, header excluded. */
  rowNumber: number;
  /** Human-readable specifics — the offending column and value. */
  detail: string;
}

/**
 * What an adapter produces from one source file.
 *
 * `aggregateRowsFiltered` is reported rather than silently dropped: if it ever
 * reaches zero for this dataset, ONS has changed something.
 */
export interface EnergyBalanceParse {
  rows: EnergyBalanceHour[];
  rejected: RejectedRow[];
  /** `SIN` rows removed at the boundary. */
  aggregateRowsFiltered: number;
  /** The header actually present in this file, read fresh on every ingest. */
  columns: string[];
}
