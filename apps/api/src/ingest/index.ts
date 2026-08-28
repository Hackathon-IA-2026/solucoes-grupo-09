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
export {
  createEnergyBalanceIngestor,
  type IngestEnergyBalancePayload,
  type IngestEnergyBalanceResult,
} from "./job.js";
export {
  mwmedToMwh,
  parseDecimal,
  parseSourceDate,
  resolveSubsystem,
  type SubsystemCode,
  toUtcDay,
  trimmed,
} from "./normalise.js";
// --- ONS fleet registry (ticket 04): plants, generating units, conjunto
// --- membership, and the as-of reads built on them.
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
  selectSingleResource,
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
  DATASET_SLUG,
  parseEnergyBalance,
  parseEnergyBalanceCsv,
  parseEnergyBalanceParquet,
} from "./ons/energy-balance.js";
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
  ConjuntoMembershipParse,
  CurtailmentParse,
  CurtailmentReportHour,
  EnergyBalanceHour,
  EnergyBalanceParse,
  ObservedReportingEntity,
  OperationModality,
  PlantRegistryParse,
  ReasonCode,
  RegistryConjunto,
  RegistryConjuntoMembership,
  RegistryGeneratingUnit,
  RegistryPlant,
  RejectedRow,
  RejectionReason,
  ReportingEntityKind,
  RestrictionCause,
  RestrictionOrigin,
  Technology,
} from "./types.js";
export {
  digestValues,
  INSERT_CHUNK,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";
