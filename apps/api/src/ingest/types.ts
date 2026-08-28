import type { SubsystemCode } from "./normalise.js";
import type { LoadAreaCode, LoadAreaKind } from "./ons/carga-api.js";

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
  | "unparsable_value"
  /**
   * Reason and origin were not both present. They are one value object and are
   * populated together on every file scanned, so half-populated is an illegal
   * state rather than a partial one.
   */
  | "half_populated_cause"
  /** `cod_areacarga` was outside the carga API's published 33-code domain. */
  | "unknown_load_area"
  /**
   * `din_referenciautc` arrived without its `Z`. ONS documents the field as
   * UTC and every observed response carries the designator, so a bare wall
   * clock means the convention moved — and guessing which way is precisely the
   * silent three-hour error this layer exists to refuse.
   */
  | "non_utc_timestamp"
  /** A half-hourly label that fell on neither `:00` nor `:30`. */
  | "misaligned_interval";

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

/** WattSteer's technology vocabulary for the two curtailed renewable fleets. */
export type Technology = "WIND" | "SOLAR";

/** Which variant of `ReportingEntity` an ONS `id_ons` denotes. */
export type ReportingEntityKind = "CONJUNTO" | "PLANT";

/** ONS restriction reason codes. `REL` is grid unavailability, not "relaxamento". */
export type ReasonCode = "REL" | "CNF" | "ENE" | "PAR";

/** Whether a restriction was local to the entity or systemic. */
export type RestrictionOrigin = "LOC" | "SIS";

/**
 * Why generation was restricted — one value object, never three loose columns.
 * Absent (rather than blank) when the entity was not restricted at all, which
 * is the ordinary case in these files.
 */
export interface RestrictionCause {
  reason: ReasonCode;
  origin: RestrictionOrigin;
  /** `dsc_restricao`. Free text; null when the column is absent or empty. */
  description: string | null;
}

/**
 * A reporting entity as observed in a constrained-off file.
 *
 * `cegCore` is null exactly when `kind` is `CONJUNTO`: ONS writes `"-"` there,
 * and a conjunto genuinely has no CEG. That is structural absence, not an
 * empty string.
 */
export interface ObservedReportingEntity {
  onsCode: string;
  kind: ReportingEntityKind;
  cegCore: string | null;
  name: string;
  subsystem: SubsystemCode;
  stateCode: string;
}

/** One canonical constrained-off row: an entity, a technology, one hour. */
export interface CurtailmentReportHour {
  reportingEntityCode: string;
  technology: Technology;
  /** Start of the hour, UTC. */
  validTime: Date;
  generationMwh: number;
  constrainedOffMwh: number;
  referenceGenerationMwh: number | null;
  finalReferenceGenerationMwh: number | null;
  /** Mean over the hour — availability is a power, so it is not summed. */
  availabilityMw: number | null;
  /** 1 or 2; below 2 the source hour was incomplete. */
  halfHoursObserved: number;
  cause: RestrictionCause | null;
  /** The two half-hours disagreed on cause; the dominant one is carried. */
  causeMixed: boolean;
}

/** What the constrained-off adapter produces from one source file. */
export interface CurtailmentParse {
  rows: CurtailmentReportHour[];
  entities: ObservedReportingEntity[];
  rejected: RejectedRow[];
  /** The header actually present in this file, read fresh on every ingest. */
  columns: string[];
  /**
   * Whether `dsc_restricao` was in this file's header at all.
   *
   * Column *presence* is a property of the file; emptiness is a property of a
   * row. ONS backfilled this column into already-closed months, so a file from
   * 2024-12 lacks it while 2025-01 has it — and 2025-03 has it present and
   * empty on every row. Reporting presence here is what keeps "absent" and
   * "empty" distinguishable, which a nullable string alone cannot do.
   */
  hasDescriptionColumn: boolean;
}

/**
 * The canonical form of one carga API half-hour.
 *
 * Three conventions are resolved before a row gets here, and none of them is
 * visible downstream:
 *
 * - **`validTime` is the START of the half hour, UTC.** ONS labels these rows
 *   with the *end* (`din_referenciautc`, documented "final do intervalo da
 *   semi-hora"), which is the opposite of the bulk datasets. The half-hour
 *   ending `03:30Z` is stored as `03:00Z`.
 * - **The instant is read as UTC and converted no further.** These two datasets
 *   are the only ones in scope with a documented timezone, and it is already
 *   UTC — running them through `America/Sao_Paulo` like `din_instante` would be
 *   a three-hour error in the one place ONS got it right.
 * - **Quantities are MWh.** ONS publishes MWmed, so a 30-minute row's MWh is
 *   half its MWmed.
 */
export interface VerifiedLoadHalfHour {
  areaCode: LoadAreaCode;
  areaKind: LoadAreaKind;
  /**
   * Populated only when the area *is* a whole subsystem. ONS publishes no
   * geoelectric-area → subsystem assignment, so one is never inferred.
   */
  subsystem: SubsystemCode | null;
  /** Start of the half hour, UTC. */
  validTime: Date;
  /** `val_cargaglobal` — the headline series. */
  loadMwh: number;
  /** `val_cargaglobalcons`, the consisted series ONS feeds its own models. */
  consistedLoadMwh: number | null;
  /**
   * `val_cargaglobalsmmgd` — load net of distributed generation.
   *
   * The live field name wins over the dictionary's `val_cargaglobalsmmg`
   * (no trailing `d`); the dictionary spelling is a documentation defect and is
   * not read, so a rename would surface as a null rather than as wrong data.
   */
  loadNetOfMmgdMwh: number | null;
  /** `val_cargasupervisionada` — the part ONS itself supervises. */
  supervisedLoadMwh: number | null;
  /** `val_carganaosupervisionada` — the part from CCEE metering. */
  unsupervisedLoadMwh: number | null;
  /** `val_cargammgd` — the part met by micro and mini distributed generation. */
  mmgdLoadMwh: number | null;
  /** `val_consistencia` — ONS's correction for measurement faults. */
  consistencyAdjustmentMwh: number | null;
  /**
   * `din_atualizacao` — **the one true row-level vintage marker in ONS open
   * data**. Null when the response omitted it, in which case the caller stamps
   * the row with the coarser request time and says so.
   */
  publishedAt: Date | null;
}

/**
 * The canonical form of one `/cargaprogramada` half-hour.
 *
 * A separate type, and a separate table, because this is a **forecast**: ONS
 * publishes it D−1 for the day ahead. `docs/domain-model.md` rejects a
 * `horizon` column on a shared fact table precisely so that reading a
 * programmed value as an actual is a type error rather than a query bug.
 *
 * It also carries no `din_atualizacao`: programada revisions are detectable
 * only by diffing values, which is what the shared versioned write does anyway.
 */
export interface ProgrammedLoadHalfHour {
  areaCode: LoadAreaCode;
  areaKind: LoadAreaKind;
  subsystem: SubsystemCode | null;
  /** Start of the half hour, UTC. */
  validTime: Date;
  /** `val_cargaglobalprogramada`. */
  programmedLoadMwh: number;
}

/** What the carga adapter produces from one API response. */
export interface LoadParse<TRow> {
  rows: TRow[];
  rejected: RejectedRow[];
  /**
   * Rows that arrived without `din_atualizacao`.
   *
   * Reported rather than shrugged off: the field is undocumented — found only
   * in the OpenAPI spec and live responses — so it is observed, not guaranteed,
   * and a run in which it disappeared should be able to say so.
   */
  rowsWithoutVintage: number;
}
