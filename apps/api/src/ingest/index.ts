export {
  acquireBulkResource,
  BULK_STEPS,
  type BulkResource,
} from "./bulk-resource.js";
export {
  type ConstrainedOffIngestorDeps,
  createConstrainedOffIngestor,
  type IngestConstrainedOffPayload,
  type IngestConstrainedOffResult,
} from "./constrained-off-job.js";
export { parseDelimited, toRecord } from "./csv.js";
export {
  type CurtailmentAsOfQuery,
  type CurtailmentAsOfResult,
  type CurtailmentAsOfRow,
  type CurtailmentWrite,
  type CurtailmentWriteResult,
  curtailmentDigest,
  readCurtailmentAsOf,
  upsertReportingEntities,
  writeCurtailment,
} from "./curtailment-repository.js";
// The two remaining subsystem bulk series — ONS datasets 8 (`carga-energia`)
// and 9 (`intercambio-nacional`). Appended rather than merged into the blocks
// above so that two adapters landing at once cannot conflict on this file.
export {
  createDailyLoadIngestor,
  type DailyLoadIngestorDeps,
  type IngestDailyLoadPayload,
  type IngestDailyLoadResult,
} from "./daily-load-job.js";
export {
  dailyLoadDigest,
  readSubsystemLoadDaysAsOf,
  type SubsystemLoadDayAsOfQuery,
  type SubsystemLoadDayAsOfResult,
  type SubsystemLoadDayAsOfRow,
  type SubsystemLoadDayWrite,
  type SubsystemLoadDayWriteResult,
  writeSubsystemLoadDays,
} from "./daily-load-repository.js";
export {
  createInterchangeIngestor,
  type IngestInterchangePayload,
  type IngestInterchangeResult,
  type InterchangeIngestorDeps,
} from "./interchange-job.js";
export {
  exchangeDigest,
  readSubsystemExchangeAsOf,
  type SubsystemExchangeAsOfQuery,
  type SubsystemExchangeAsOfResult,
  type SubsystemExchangeAsOfRow,
  type SubsystemExchangeWrite,
  type SubsystemExchangeWriteResult,
  writeSubsystemExchange,
} from "./interchange-repository.js";
export {
  createEnergyBalanceIngestor,
  type IngestEnergyBalancePayload,
  type IngestEnergyBalanceResult,
} from "./job.js";
// The ONS carga REST API (datasets 6 & 7) — the one source with no bulk files.
// Appended rather than merged into the blocks above so that two adapters
// landing at once cannot conflict on this file.
export {
  createLoadIngestor,
  DEFAULT_AREA_CODES,
  type IngestLoadPayload,
  type IngestLoadResult,
} from "./load-job.js";
export {
  type LoadAsOfQuery,
  type LoadWriteResult,
  type ProgrammedLoadAsOfResult,
  type ProgrammedLoadAsOfRow,
  type ProgrammedLoadWrite,
  programmedLoadDigest,
  readProgrammedLoadAsOf,
  readVerifiedLoadAsOf,
  recordLoadApiRequest,
  type VerifiedLoadAsOfResult,
  type VerifiedLoadAsOfRow,
  type VerifiedLoadWrite,
  verifiedLoadDigest,
  writeProgrammedLoad,
  writeVerifiedLoad,
} from "./load-repository.js";
export {
  mwmedToMwh,
  parseDecimal,
  resolveSubsystem,
  type SubsystemCode,
  trimmed,
} from "./normalise.js";
export {
  AREA_CODE_FOR_SUBSYSTEM,
  CARGA_API_BASE,
  chunkDateRange,
  type DateRange,
  EmptyLoadResponseError,
  fetchLoadRange,
  isLoadAreaCode,
  LOAD_AREA_CODES,
  type LoadAreaCode,
  type LoadAreaKind,
  type LoadResponse,
  type LoadSeries,
  loadAreaKind,
  loadRequestUrl,
  MAX_RANGE_MONTHS,
  parseTolerantJson,
  type RawLoadRow,
  repairMissingJsonValues,
  resolveAreaCode,
  SERIES_COVERAGE_START,
  SERIES_PATH,
  subsystemForArea,
  TruncatedLoadResponseError,
} from "./ons/carga-api.js";
export {
  type CatalogueResource,
  fetchPackage,
  fingerprintFromHeaders,
  headResource,
  type ResourceFingerprint,
  type ResourceFormat,
  readResources,
  selectResourceForMonth,
  selectResourceForYear,
} from "./ons/catalogue.js";
export {
  cegCore,
  parseConstrainedOffCsv,
  SOLAR_DATASET_SLUG,
  WIND_DATASET_SLUG,
} from "./ons/constrained-off.js";
export {
  DAILY_LOAD_DATASET_SLUG,
  DAILY_LOAD_FORMATS,
  LOAD_METHODOLOGY_REGIMES,
  type LoadMethodologyBreak,
  parseDailyLoadCsv,
  regimeForDate,
} from "./ons/daily-load.js";
export {
  DATASET_SLUG,
  parseEnergyBalance,
  parseEnergyBalanceCsv,
  parseEnergyBalanceParquet,
} from "./ons/energy-balance.js";
export {
  INTERCHANGE_DATASET_SLUG,
  INTERCHANGE_FORMATS,
  parseInterchangeCsv,
} from "./ons/interchange.js";
export {
  intervalStartFromEnd,
  parseProgrammedLoad,
  parseUtcInstant,
  parseVerifiedLoad,
} from "./ons/load.js";
export {
  type AsOfQuery,
  type EnergyBalanceAsOfResult,
  type EnergyBalanceAsOfRow,
  type EnergyBalanceWrite,
  type EnergyBalanceWriteResult,
  readEnergyBalanceAsOf,
  type VintageFidelity,
  valueDigest,
  writeEnergyBalance,
} from "./repository.js";
export {
  markResourceFetched,
  recordResourceVersion,
} from "./resource-version.js";
export {
  type LocalDay,
  localDayInterval,
  ONS_TIME_ZONE,
  parseCalendarDate,
  zonedWallClockToUtc,
} from "./time.js";
export type {
  CurtailmentParse,
  CurtailmentReportHour,
  EnergyBalanceHour,
  EnergyBalanceParse,
  LoadMethodologyRegime,
  LoadParse,
  ObservedReportingEntity,
  ProgrammedLoadHalfHour,
  ReasonCode,
  RejectedRow,
  RejectionReason,
  ReportingEntityKind,
  RestrictionCause,
  RestrictionOrigin,
  SubsystemExchangeHour,
  SubsystemExchangeParse,
  SubsystemLoadDay,
  SubsystemLoadDayParse,
  Technology,
  VerifiedLoadHalfHour,
} from "./types.js";
export {
  digestValues,
  INSERT_CHUNK,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";
