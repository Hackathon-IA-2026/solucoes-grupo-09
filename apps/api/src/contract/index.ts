/**
 * The canonical read contract — WattSteer's domain, exposed for reading.
 *
 * See `docs/contracts/canonical-reads.md` for the consumer-facing document.
 * The short version: the modelling side reads *this*, never a fact table, and
 * never ONS's conventions. Everything a source got wrong or said oddly — a
 * padded subsystem code, an average-power value, a national aggregate row, an
 * end-of-interval timestamp — was resolved at ingest and is unrepresentable
 * here.
 */

export {
  CANONICAL_BASE_PATH,
  CANONICAL_READ_BY_NAME,
  CANONICAL_READS,
  type CanonicalReadName,
  type CanonicalReadSpec,
  canonicalReadPath,
  type FactKind,
  type ForecastOrigin,
  type ForecastProducer,
  type ReadGrain,
} from "./manifest.js";
export { readOnly } from "./read-only.js";
export {
  type ConjuntoMembershipReadQuery,
  type CurtailmentReadQuery,
  type DayAheadBalanceReadQuery,
  type FactReadQuery,
  type InstalledCapacityReadQuery,
  type InstalledCapacityResult,
  type PlantMeasurementReadQuery,
  type RegistryReadQuery,
  readConjuntoMembership,
  readCurtailment,
  readDayAheadBalance,
  readInstalledCapacity,
  readPlantMeasurements,
  readSystemContext,
  readSystemExchange,
  readTrainingWindow,
  readWeatherForecast,
  type SystemContextReadQuery,
  type TrainingWindow,
  type TrainingWindowQuery,
  type WeatherReadQuery,
} from "./reads.js";
export type {
  CanonicalReadResult,
  ConjuntoMembershipAtDate,
  CurtailmentObservation,
  DayAheadBalanceForecast,
  ForecastRow,
  InstalledCapacityScope,
  MeasuredQuantity,
  PlantMeasurement,
  ResourceMeasurementValue,
  RowVintage,
  SystemContextObservation,
  SystemExchangeObservation,
  VintageReceipt,
  WeatherForecastAtCentroid,
} from "./types.js";
export {
  combineFidelity,
  combineGoLive,
  type VintageFidelity,
  type VintageSource,
  vintageFidelity,
} from "./vintage.js";
