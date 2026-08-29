import type { Technology } from "@wattsteer/core/domain";
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
  | "misaligned_interval"
  /** A registry date column held something that is not a `YYYY-MM-DD`. */
  | "unparsable_date"
  /**
   * A column that is this row's identity was present but empty — a registry
   * row with no `ceg`, or a membership with no `id_ons_usina`. Nothing can be
   * keyed on it, so it is rejected rather than given a synthetic key.
   */
  | "missing_identity"
  /** `nom_tipousina` / `id_tipousina` was not a technology WattSteer models. */
  | "unknown_technology"
  /** `nom_modalidadeoperacao` was not one of the four dispatched modalities. */
  | "unknown_modality"
  /**
   * Two source rows claimed the same business key within one file. Not a
   * revision — a revision arrives in a later file — so neither row can be
   * trusted over the other and both are rejected.
   */
  | "duplicate_key"
  /** An interchange row whose origin and destination are the same subsystem. */
  | "self_directed_exchange"
  /**
   * A `_detail` row gave a measured wind speed / irradiance without its
   * invalid-data flag, or the flag without the measurement. The two are one
   * value object — blank together on all 480 such rows of the 2021-10 wind
   * file and populated together everywhere else — so half-populated is an
   * illegal state rather than a partial one.
   */
  | "half_populated_measurement";

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

/**
 * WattSteer's technology vocabulary for the two curtailed renewable fleets.
 *
 * Re-exported from `@wattsteer/core`, not declared. It was declared here while
 * the shared package held no vocabulary, and a second declaration of a closed
 * enum is the failure `packages/core/src/domain.ts` records: the web app and
 * the landing page once disagreed about this exact type's casing, one
 * lowercase and one upper, and nothing caught it because neither imported the
 * other. An ingest row and an API response now name the same two values by
 * construction.
 */
export type { Technology };

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
  verifiedGenerationMwh: number;
  constrainedOffMwh: number;
  referenceGenerationMwh: number | null;
  finalReferenceGenerationMwh: number | null;
  /** Mean over the hour — availability is a power, so it is not summed. */
  availableCapacityMw: number | null;
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
  /**
   * When ONS published the programme this half hour belongs to.
   *
   * **Derived from the row's own reference day, never from the fetch instant.**
   * The endpoint returns no update stamp of any kind, so the fetch instant was
   * the only thing to hand — and over a backfill that makes `published_at`
   * later than `valid_time` by up to five years, which is the shape
   * `docs/domain-model.md` §4 reserves for an `Observation`. See
   * `programmePublishedAt` in `ons/load.ts` for the instant and the argument.
   */
  publishedAt: Date;
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
/**
 * ONS's operation modality, and what determines which `ReportingEntity`
 * variant a plant participates in (`docs/domain-model.md` §3). Exactly four
 * members: `TIPO III` exists in `modalidade-usina` but describes distributed
 * generation ONS does not dispatch, and it is outside every dataset WattSteer
 * ingests — so it is unrepresentable here rather than tolerated.
 */
export type OperationModality = "TIPO_I" | "TIPO_II_A" | "TIPO_II_B" | "TIPO_II_C";

/**
 * A plant as ONS's registry describes it — one *usina*.
 *
 * Identity is `cegCore` rather than `onsPlantCode`, and that is a deviation
 * from `docs/domain-model.md` §3 forced by measurement: the live
 * `capacidade-geracao` file carries **no `id_ons` column at all** (the research
 * recorded it as added 2026-01-26; it is not there). `ceg` is on every row, so
 * the version-stripped core is the only identity this source offers. The ONS
 * plant code is recovered where `usina_conjunto` supplies it and is null
 * otherwise — which is honest, because for a Tipo I / II-B plant that never
 * joins a conjunto no ONS dataset in this ticket names one.
 *
 * Attribute ownership follows the plant-registry research: **ONS owns all of
 * these**. SIGA contributes coordinates, municipality and ownership share, and
 * nothing here.
 */
export interface RegistryPlant {
  /** ANEEL CEG with the version segment stripped. The identity. */
  cegCore: string;
  /** The CEG exactly as ONS rendered it — provenance survives normalisation. */
  cegRaw: string;
  /** ONS `id_ons`, from the conjunto bridge. Null when no source names one. */
  onsPlantCode: string | null;
  name: string;
  /**
   * From `id_subsistema` — the **electrical** assignment.
   *
   * Never derived from `id_estado`: twelve VRE units in Bahia are assigned to
   * `SE`, and five of the 1,614 curtailed plants disagree with SIGA's
   * "principal" UF outright. State is an attribute, not a subsystem key.
   */
  subsystem: SubsystemCode;
  /** ONS `id_estado`. An attribute; never a subsystem input. */
  stateCode: string;
  technology: Technology;
  operationModality: OperationModality;
  ownerName: string;
  operatorName: string;
}

/**
 * One turbine or inverter block — the true grain of `capacidade-geracao`, and
 * the entity that exists for exactly one reason: `InstalledCapacityAsOf`.
 *
 * A plant's capacity is the sum over its units at a date, never a stored
 * number. `decommissionedOn` is nullable and that nullability is correct: it
 * means "still running".
 */
export interface RegistryGeneratingUnit {
  plantCegCore: string;
  /** ONS `cod_equipamento` — unique within a plant across the whole live file. */
  equipmentCode: string;
  /** ONS `num_unidadegeradora`, the operational number. Display, not identity. */
  unitNumber: string;
  name: string;
  ratedPowerMw: number;
  /** `dat_entradateste` — release for commissioning. Null when absent. */
  testEntryOn: Date | null;
  /** `dat_entradaoperacao` — release for commercial operation. UTC midnight. */
  commissionedOn: Date;
  /** `dat_desativacao`. Null means still running — the honest reading. */
  decommissionedOn: Date | null;
}

/** What the `capacidade-geracao` adapter produces from one snapshot. */
export interface PlantRegistryParse {
  plants: RegistryPlant[];
  units: RegistryGeneratingUnit[];
  rejected: RejectedRow[];
  /**
   * Rows dropped because their technology is outside WattSteer's scope —
   * hydro, thermal and nuclear. Reported rather than silently discarded: if
   * this ever reaches zero, ONS has changed what the file covers.
   */
  outOfScopeRowsFiltered: number;
  /**
   * Units whose `dat_desativacao` precedes their `dat_entradaoperacao`.
   *
   * Real in the live file — all three BELMONTE 1-1 deactivations are stamped
   * 2023-05-03 against a 2023-12-05 commissioning. The rows are kept verbatim
   * (nothing is coerced) and `InstalledCapacityAsOf` naturally counts them in
   * no interval at all, but the count is surfaced so the contradiction is
   * visible rather than merely harmless.
   */
  inconsistentUnitDates: number;
  /** The header actually present in this snapshot, read fresh on every ingest. */
  columns: string[];
}

/**
 * A conjunto as the `usina_conjunto` bridge describes it.
 *
 * `technology` is null when `id_tipousina` is not one of the two VRE codes —
 * the bridge also carries `UTE` and `UHE` conjuntos. `sourceTypeCode` keeps
 * ONS's own value so the null is explainable.
 */
export interface RegistryConjunto {
  onsConjuntoCode: string;
  name: string;
  subsystem: SubsystemCode;
  stateCode: string;
  technology: Technology | null;
  /** `id_tipousina` verbatim: `UEE`, `UFV`, `UTE`, `UHE`. */
  sourceTypeCode: string;
}

/**
 * One SCD2 row of the plant-to-conjunto bridge.
 *
 * **`memberTo` is the inclusive last day of membership**, not an exclusive
 * bound. Measured, not assumed: of the 331 sequential memberships in the live
 * file, all 331 successors start on the day *after* their predecessor's
 * `dat_fimrelacionamento` and none starts on the same day. Reading it as
 * exclusive would leave a one-day hole in every plant that ever moved conjunto.
 */
export interface RegistryConjuntoMembership {
  /** `id_ons_usina`. The membership key — see the note on `plantCegCore`. */
  plantOnsCode: string;
  /**
   * The member plant's `ceg_core`, or null where ONS's own bridge leaves `ceg`
   * empty (it does, for `SPUD42`). Not the key: one `ceg_core` in the live file
   * carries two `id_ons` values (`RNST6` and `RNST06`), so keying membership on
   * the CEG would collapse two real rows into a false overlap.
   */
  plantCegCore: string | null;
  conjuntoCode: string;
  /** `dat_iniciorelacionamento`, UTC midnight. First day of membership. */
  memberFrom: Date;
  /** `dat_fimrelacionamento`, UTC midnight. **Inclusive** last day, or null. */
  memberTo: Date | null;
}

/** What the `usina_conjunto` adapter produces from one snapshot. */
export interface ConjuntoMembershipParse {
  conjuntos: RegistryConjunto[];
  memberships: RegistryConjuntoMembership[];
  rejected: RejectedRow[];
  /** The header actually present in this snapshot, read fresh on every ingest. */
  columns: string[];
}
/**
 * The canonical form of one DESSEM half-hour, per subsystem (ticket 08).
 *
 * Appended rather than merged into the blocks above so that two adapters
 * landing at once cannot conflict on this file.
 *
 * Three things differ from every type above, and all three are structural:
 *
 * - **This is a `Forecast`.** ONS creates the file for reference day D on the
 *   evening of D−1, so `published_at < valid_time` on every row — the shape
 *   `docs/domain-model.md` §4 uses to tell a forecast from an observation with
 *   no flag at all. `lead_time` is derived from the pair, never stored.
 * - **`referenceDay` is the run label**, the second component of the row's
 *   `ForecastOrigin` (`{ producer: ons_dessem, run_label, published_at }`).
 *   It is `din_programacaodia` verbatim, `YYYY-MM-DD`.
 * - **Quantities are MW, not MWh.** DESSEM publishes instantaneous power, not
 *   MWmed, so the conversion every other ONS adapter applies at its boundary
 *   would be a factual error here. The `_mw` suffix is the domain model's
 *   marker for exactly that (§1: "a column named `*_mw` holds instantaneous or
 *   nameplate power").
 *
 * `validTime` is the START of the half hour, UTC. The source labels the period
 * by `num_patamar`, which the research established denotes the half hour ending
 * at 00:00 + k×30 min Brasília — the same end-labelling as the carga API
 * and the opposite of the bulk files. The adapter removes it.
 */
export interface DessemBalanceHalfHour {
  subsystem: SubsystemCode;
  /** Start of the half hour the forecast is about, UTC. */
  validTime: Date;
  /** `din_programacaodia`, `YYYY-MM-DD`. The `ForecastOrigin` run label. */
  referenceDay: string;
  /** `val_demanda`. */
  demandMw: number;
  /** `val_ger_hidraulica` — the **published** header, not the dictionary's. */
  hydroGenerationMw: number;
  /** `val_ger_pch` — small hydro. */
  smallHydroGenerationMw: number;
  /** `val_ger_termica` — the published header, not the dictionary's. */
  thermalGenerationMw: number;
  /** `val_ger_pct` — small thermal. */
  smallThermalGenerationMw: number;
  /** `val_ger_eolica`. Half of why this dataset exists. */
  windGenerationMw: number;
  /** `val_ger_fotovoltaica` — utility-scale PV. The other half. */
  solarGenerationMw: number;
  /** `val_ger_mmgd` — micro and mini distributed generation, modelled by ONS. */
  mmgdGenerationMw: number;
  /** `val_cons_elevatoria` — pumping load, a consumption not a generation. */
  pumpingConsumptionMw: number;
}

/** What the DESSEM adapter produces from one reference day's file. */
export interface DessemBalanceParse {
  rows: DessemBalanceHalfHour[];
  rejected: RejectedRow[];
  /** The header actually present in this file, read fresh on every ingest. */
  columns: string[];
  /** `din_programacaodia`, which must be one single day for the whole file. */
  referenceDay: string;
  /**
   * How many patamares each subsystem carried — 48 for every day in scope, and
   * asserted against the length of the local civil day rather than hard-coded.
   */
  patamaresPerSubsystem: number;
  /** `SIN` rows removed at the boundary. Zero on every DESSEM file seen. */
  aggregateRowsFiltered: number;
}

/**
 * One canonical hour of directed exchange over one inter-subsystem link.
 *
 * **The pair is stated in one canonical orientation and the direction is the
 * sign.** `from` precedes `to` in the `SubsystemCode` declaration order, so the
 * four links are always `N→NE`, `N→SE`, `NE→SE` and `S→SE`; a positive value is
 * energy flowing that way, a negative one is energy flowing back.
 *
 * ONS itself changed basis mid-series — files up to 2025 fix the orientation and
 * sign the value, the 2026 file flips the row and keeps the verified value
 * non-negative — so a stored (origin, destination) taken verbatim from the file
 * would be two different series wearing one name. See `ons/interchange.ts`.
 */
export interface SubsystemExchangeHour {
  fromSubsystem: SubsystemCode;
  toSubsystem: SubsystemCode;
  /** Start of the hour, UTC. */
  validTime: Date;
  /** `val_intercambiomwmed`, positive from → to. */
  verifiedExchangeMwh: number;
  /**
   * `val_intercambioprogmwmed`, positive from → to.
   *
   * Null for every row of every file before 2026: ONS added the column in
   * 2026-05 and did **not** backfill it. Null is that absence, and is never a
   * zero — a programmed exchange of zero is a real and different statement.
   */
  programmedExchangeMwh: number | null;
}

/** What the interchange adapter produces from one source file. */
export interface SubsystemExchangeParse {
  rows: SubsystemExchangeHour[];
  rejected: RejectedRow[];
  /** The header actually present in this file, read fresh on every ingest. */
  columns: string[];
  /**
   * Whether `val_intercambioprogmwmed` was in this file's header at all.
   *
   * The mirror image of `CurtailmentParse.hasDescriptionColumn`, and the reason
   * both exist: ONS backfilled `dsc_restricao` into closed months and did not
   * backfill this one. Presence is a property of the file, emptiness a property
   * of a row, and only reporting both keeps the two distinguishable.
   */
  hasProgrammedColumn: boolean;
  /** Rows published in the reverse of the canonical orientation, and flipped. */
  reorientedRows: number;
}

/**
 * Which definition of "load" a `SubsystemLoadDay` was measured under.
 *
 * ONS changed the definition twice with no schema change to signal it, so the
 * regime is carried on the row: a level shift at a boundary is a methodology
 * break, not a change in the grid.
 */
export type LoadMethodologyRegime =
  /** Through 2021-02: plants ONS dispatches and/or programmes, only. */
  | "DISPATCHED_ONLY"
  /** 2021-03 → 2023-04-28: plus forecast generation of non-dispatched plants. */
  | "WITH_NON_DISPATCHED"
  /** From 2023-04-29: plus an estimate of MMGD from forecast weather. */
  | "WITH_MMGD";

/** One canonical day of load for one subsystem — ONS dataset 8. */
export interface SubsystemLoadDay {
  subsystem: SubsystemCode;
  /** First instant of the local day, UTC — start-of-interval, as everywhere. */
  validTime: Date;
  loadMwh: number;
  /**
   * Length of the local day the MWmed mean was converted over: 1380, 1440 or
   * 1500 minutes. Stored rather than derived so that a day whose energy dips by
   * a twenty-fourth explains itself.
   */
  dayMinutes: number;
  methodologyRegime: LoadMethodologyRegime;
}

/** What the daily-load adapter produces from one source file. */
export interface SubsystemLoadDayParse {
  rows: SubsystemLoadDay[];
  rejected: RejectedRow[];
  /** The header actually present in this file, read fresh on every ingest. */
  columns: string[];
  /** Rows whose local day was not 24 hours long. Zero from 2019 onward. */
  irregularDays: number;
}

// The plant-grain constrained-off `_detail` datasets (ONS 2 & 4) — the true
// per-usina view. Appended rather than merged into the constrained-off block
// above so that two adapters landing at once cannot conflict on this file.

/**
 * The measured resource behind a plant-hour: wind speed or irradiance, with the
 * flag saying whether the measurement can be trusted.
 *
 * **One value object, not two loose columns.** ONS blanks the measurement and
 * its flag together and fills them together — 480 rows of the 2021-10 wind file
 * blank both, and no row in 1,084,896 blanks one alone — so half-populated is
 * an illegal state and this shape removes it.
 *
 * `value` is **m/s** when the row's technology is `WIND` and **W/m²** when it is
 * `SOLAR`. Which one is fixed by the technology and never carried twice; the
 * database keeps them in separate, separately-named columns so a unit can never
 * be read off the wrong one.
 *
 * The ONS dictionary documents `val_ventoverificado` as `m3/s`, which is
 * dimensionally wrong for a wind speed. WattSteer stores m/s; see
 * `MEASURED_WIND_SPEED_UNIT_CORRECTION` in the adapter.
 */
export interface ResourceMeasurement {
  /** m/s (`WIND`) or W/m² (`SOLAR`). Negative values are real and kept. */
  value: number;
  /** `flg_dadoventoinvalido` / `flg_dadoirradianciainvalido`, unified. */
  invalid: boolean;
}

/**
 * A plant as observed in a constrained-off `_detail` file.
 *
 * These files are the only ONS source in scope that publishes `id_ons` and
 * `ceg` on the same row for an *individual plant* — `capacidade-geracao` has no
 * `id_ons`, and the entity-grain files carry a `CJU_` code for the 93% of rows
 * that are Tipo II-C. That makes this the identity bridge, which is why both
 * identifiers are carried and neither is derived from the other.
 *
 * `nom_conjuntousina` is deliberately absent. It is the one field from which a
 * plant's settling entity could be reconstructed by name, and that
 * reconstruction is the first step of the plant → conjunto → reason join this
 * grain must not enable. Membership is read from the time-resolved bridge or
 * not at all.
 */
export interface ObservedPlant {
  /** ONS `id_ons`. The identity, per `docs/domain-model.md` §3. */
  onsCode: string;
  /** ANEEL CEG, version segment stripped — the bridge to `plant` and SIGA. */
  cegCore: string;
  /** ONS's own rendering, zero-padded version segment and all. */
  cegRaw: string;
  name: string;
  subsystem: SubsystemCode;
  stateCode: string;
  technology: Technology;
  /** `nom_modalidadeoperacao` — what decides the plant's `ReportingEntity`. */
  operationModality: OperationModality;
}

/**
 * One canonical plant-grain row: a plant, a technology, one hour.
 *
 * **There is no cause on this type and there is no column for one.** The
 * `_detail` files carry no reason code and no reference generation, so
 * curtailment volume cannot be computed here and a reason cannot be attached
 * here. For a Tipo II-C plant the reason exists only at conjunto grain and
 * pushing it down is an allocation, which v1 does not compute
 * (`docs/domain-model.md` §3).
 */
export interface PlantDetailHour {
  plantOnsCode: string;
  technology: Technology;
  /** Start of the hour, UTC. */
  validTime: Date;
  /** From wind × power curve, or from history. Null where ONS published none. */
  estimatedGenerationMwh: number | null;
  verifiedGenerationMwh: number | null;
  /** Mean over the hour — a speed and an irradiance are intensive, not summed. */
  measurement: ResourceMeasurement | null;
  /** 1 or 2; below 2 the source hour was incomplete. */
  halfHoursObserved: number;
}

/** What the plant-grain constrained-off adapter produces from one source file. */
export interface PlantDetailParse {
  rows: PlantDetailHour[];
  plants: ObservedPlant[];
  rejected: RejectedRow[];
  /** The header actually present in this file, read fresh on every ingest. */
  columns: string[];
  /**
   * Rows where `nom_conjuntousina` was named without the plant being Tipo II-C,
   * or the reverse.
   *
   * Zero on every file scanned, and reported rather than stored: it is the
   * evidence that modality alone decides which `ReportingEntity` variant a
   * plant settles under. A non-zero count means that claim has stopped holding
   * upstream, which is worth knowing and is not worth guessing about.
   */
  modalityConjuntoMismatches: number;
}

/**
 * A point on the earth, as one value.
 *
 * A pair rather than two loose columns because `docs/domain-model.md` §3 makes
 * the whole coordinate optional: half a coordinate is not a partial location,
 * it is a corrupt one, and two nullable numbers make that state expressible.
 */
export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** Why a SIGA coordinate was refused. Never "it was null" alone. */
export type CoordinateRejection =
  /** The column was present but empty. */
  | "missing"
  /** Present and not a number the ANEEL decimal-comma reader could parse. */
  | "unparsable"
  /** Exactly (0, 0) — the Gulf of Guinea. 1.72% of operating EOL/UFV rows. */
  | "null_island"
  /** A number, outside the Brazil bounding box. A sign error or a transposition. */
  | "out_of_bounds";

/** A `Município - UF` entry from `DscMuninicpios`. The UF is what disambiguates. */
export interface Municipality {
  name: string;
  uf: string;
}

/** Where a plant's stored location actually came from. */
export type PlantLocationSource =
  /** SIGA's own `NumCoordN/E`, validated. */
  | "siga_coordinate"
  /** Mean of the valid SIGA coordinates registered in the same municipality. */
  | "siga_municipality_centroid"
  /** No usable coordinate and no municipality to fall back to. */
  | "unlocated";

/** One SIGA row, normalised. Capacity appears only as the size-filter input. */
export interface SigaRegistration {
  /** `CodCEG` with the version segment stripped — the join key, both sides. */
  cegCore: string;
  /** ANEEL's own rendering, unpadded version segment and all. */
  cegRaw: string;
  /** `IdeNucleoCEG`. Retained: the nucleus is the durable identity on rename. */
  nucleus: string;
  /** `NomEmpreendimento` — never a join key and never rendered raw. */
  name: string;
  /** `SigUFPrincipal`. "Principal" is load-bearing; never a subsystem input. */
  ufPrincipal: string;
  /** `SigTipoGeracao` verbatim: `EOL`, `UFV`, `UTE`, … */
  sourceTechnology: string;
  /** `DscFaseUsina`: `Operação`, `Construção`, `Construção não iniciada`. */
  phase: string;
  /**
   * `MdaPotenciaFiscalizadaKw`, read **only** as the input to the fleet size
   * filter. It is not a capacity WattSteer stores or aggregates: ONS owns
   * capacity, per unit, and SIGA retains the last operating value forever.
   */
  inspectedCapacityKw: number | null;
  /** The validated coordinate, or null when SIGA's pair was not usable. */
  coordinate: Coordinate | null;
  coordinateRejection: CoordinateRejection | null;
  /** The raw pair as parsed, kept so a refusal can be explained. */
  rawLatitude: number | null;
  rawLongitude: number | null;
  municipalities: Municipality[];
  /** `DscMuninicpios` verbatim — provenance survives normalisation. */
  municipalitiesRaw: string;
  /** `DscPropriRegimePariticipacao` verbatim: `100% para <agent> - <CNPJ> (<regime>)`. */
  ownership: string;
}

/** What the SIGA adapter produces from one daily extract. */
export interface SigaParse {
  /** `DatGeracaoConjuntoDados` — one value per file, asserted to be one. */
  snapshotDate: Date;
  rows: SigaRegistration[];
  rejected: RejectedRow[];
  /** Rows at exactly (0, 0). Counted separately from the bounding box. */
  nullIslandRows: number;
  /** Rows with a numeric pair outside Brazil. */
  outOfBoundsRows: number;
  /** Repeated `CodCEG` cores. Three exist in the live file, all hydro. */
  duplicateCegCores: number;
  /** Of those, the ones whose location or municipality disagreed. Should be 0. */
  conflictingDuplicates: number;
  /** The header actually present in this file, read fresh on every ingest. */
  columns: string[];
}

/** The identity columns the match rate is measured over. */
export interface RegistryPlantKey {
  cegCore: string;
  cegRaw: string;
}

/** Both match rates, measured. The verbatim one is a canary, not a fallback. */
export interface SigaMatchRate {
  /** Denominator: plants in the ONS registry, not rows in SIGA. */
  registryPlants: number;
  matched: number;
  rate: number;
  /** Raw `CodCEG` against raw ONS `ceg`. Measured at exactly zero. */
  verbatimMatched: number;
  verbatimRate: number;
  /** CEG cores in the registry that SIGA does not carry, ascending. */
  unmatched: string[];
}

/** One plant's location as resolved from a SIGA snapshot, ready to store. */
export interface ResolvedPlantLocation {
  cegCore: string;
  cegRaw: string;
  sigaName: string;
  coordinate: Coordinate | null;
  locationSource: PlantLocationSource;
  /** Why SIGA's own coordinate was refused, when it was. */
  coordinateRejection: CoordinateRejection | null;
  municipality: Municipality | null;
  municipalitiesRaw: string;
  ownership: string;
  /**
   * The snapshot date on which this plant stopped appearing in SIGA.
   *
   * Null on every row read from a file — a withdrawal is not in the data. SIGA
   * deletes rather than tombstones, so this is set only by diffing successive
   * snapshots, and it is the only representation of a retirement the source
   * offers.
   */
  withdrawnOn: Date | null;
}

// --- Weather from named model runs (Open-Meteo Single Runs, pinned ECMWF IFS).
// Appended rather than merged into the blocks above so that two adapters
// landing at once cannot conflict on this file.

/**
 * The twelve stored weather measures, in the order they are requested.
 *
 * Units are the API's own and are named in the field, because a silent unit is
 * how a wind speed in km/h gets fed to a power curve in m/s. Every one is
 * nullable: a hole in the middle of a series is a hole, and only a variable
 * that is null *everywhere* is a failure (see `UndefinedWeatherVariableError`).
 */
export interface WeatherValues {
  windSpeed100mKmh: number | null;
  windSpeed120mKmh: number | null;
  windDirection120mDeg: number | null;
  windGusts10mKmh: number | null;
  temperature2mC: number | null;
  surfacePressureHpa: number | null;
  relativeHumidity2mPct: number | null;
  precipitationMm: number | null;
  shortwaveRadiationWm2: number | null;
  directNormalIrradianceWm2: number | null;
  diffuseRadiationWm2: number | null;
  cloudCoverPct: number | null;
}

/**
 * One canonical forecast hour at one centroid, from one named model run.
 *
 * `runInitTime` is both the run's identity and the row's `published_at` — the
 * whole reason the D−1 12 Z run superseding the D−1 00 Z run needs no special
 * case. `runAgeHours` is zero on the normal path and 12 or 24 when the
 * scheduled run was missing from the archive and an older one was used.
 */
export interface WeatherForecastHour extends WeatherValues {
  centroidId: string;
  /** Start of the forecast hour, UTC. */
  validTime: Date;
  /** The model grid cell the query snapped to, as echoed by the API. */
  gridLatitude: number;
  gridLongitude: number;
  gridElevationM: number;
  runInitTime: Date;
  runCycle: "00Z" | "12Z";
  /** `run_init(scheduled) − run_init(used)` in hours. 0 on the normal path. */
  runAgeHours: number;
}

/** What the weather adapter produces from one model run. */
export interface WeatherRunParse {
  rows: WeatherForecastHour[];
  /**
   * Rows dropped because they were the run's own hour zero, where the
   * accumulated variables have no preceding accumulation window. One per
   * centroid per run on the normal path.
   */
  hourZeroRowsExcluded: number;
  /** Individual missing values in retained rows. A hole, not a failure. */
  nullValues: number;
}
