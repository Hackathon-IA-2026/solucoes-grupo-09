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
// The DESSEM day-ahead balance (ONS dataset 11) — the platform's first
// bulk-file forecast, and its only daily-split source. Appended rather than
// merged into the blocks above so that two adapters landing at once cannot
// conflict on this file.
export {
  createDessemIngestor,
  type DessemDayResult,
  type IngestDessemPayload,
  type IngestDessemResult,
} from "./dessem-job.js";
export {
  type DessemBalanceAsOfQuery,
  type DessemBalanceAsOfResult,
  type DessemBalanceAsOfRow,
  type DessemBalanceWrite,
  type DessemBalanceWriteResult,
  dessemBalanceDigest,
  readDessemBalanceAsOf,
  writeDessemBalance,
} from "./dessem-repository.js";
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
  availableResourceDays,
  type CatalogueResource,
  fetchPackage,
  fingerprintFromHeaders,
  headResource,
  type ResourceFingerprint,
  type ResourceFormat,
  readResources,
  selectResourceForDay,
  selectResourceForMonth,
  selectResourceForYear,
} from "./ons/catalogue.js";
export {
  CONJUNTO_DATASET_SLUG,
  findMembershipOverlaps,
  type MembershipOverlap,
  type ParseConjuntoMembershipOptions,
  parseConjuntoMembershipCsv,
} from "./ons/conjunto-membership.js";
export {
  cegCore,
  parseConstrainedOffCsv,
  SOLAR_DATASET_SLUG,
  WIND_DATASET_SLUG,
} from "./ons/constrained-off.js";
export {
  DESSEM_COVERAGE_START,
  DESSEM_DETAIL_DATASET_SLUG,
  PATAMAR_MINUTES,
  parseDessemBalanceCsv,
  patamarStart,
  referenceDayAnchor,
} from "./ons/dessem-balance.js";
export {
  DATASET_SLUG,
  parseEnergyBalance,
  parseEnergyBalanceCsv,
  parseEnergyBalanceParquet,
} from "./ons/energy-balance.js";
export {
  intervalStartFromEnd,
  parseProgrammedLoad,
  parseUtcInstant,
  parseVerifiedLoad,
} from "./ons/load.js";
export {
  CAPACITY_DATASET_SLUG,
  findRenewableDeactivations,
  type ParsePlantRegistryOptions,
  parseCapacityRegistryCsv,
  type RenewableDeactivation,
  WINDOW_OPENS_ON,
} from "./ons/plant-registry.js";
export {
  createPlantRegistryIngestor,
  type IngestPlantRegistryPayload,
  type IngestPlantRegistryResult,
  type PlantRegistryIngestorDeps,
} from "./registry-job.js";
export {
  type ConjuntoMembershipQuery,
  type ConjuntoMembershipResult,
  type ConjuntoMembershipRow,
  type ConjuntoMembershipWrite,
  conjuntoMembershipDigest,
  type GeneratingUnitWrite,
  generatingUnitDigest,
  type InstalledCapacityGroup,
  type InstalledCapacityQuery,
  type InstalledCapacityResult,
  linkPlantOnsCodes,
  type PlantCapacityRow,
  type RegistryAsOfQuery,
  type RegistryWriteResult,
  readConjuntoMembershipAsOf,
  readInstalledCapacityAsOf,
  readPlantCapacityAsOf,
  upsertConjuntos,
  upsertPlants,
  writeConjuntoMemberships,
  writeGeneratingUnits,
} from "./registry-repository.js";
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
export { ONS_TIME_ZONE, zonedWallClockToUtc } from "./time.js";
export type {
  CurtailmentParse,
  CurtailmentReportHour,
  DessemBalanceHalfHour,
  DessemBalanceParse,
  EnergyBalanceHour,
  EnergyBalanceParse,
  LoadParse,
  ObservedReportingEntity,
  ProgrammedLoadHalfHour,
  ReasonCode,
  RejectedRow,
  RejectionReason,
  ReportingEntityKind,
  RestrictionCause,
  RestrictionOrigin,
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
