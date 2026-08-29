/**
 * The feature layer: where stored facts become model inputs.
 *
 * The ingest layer's job ends at "this is what the source said, and when".
 * Everything here is a *derivation* — no table of its own, nothing written —
 * because the two central quantities are functions of a date rather than
 * columns: `InstalledCapacityAsOf` and, on top of it,
 * `CapacityWeight(centroid, technology, t)`.
 */

export {
  type CapacityAttribution,
  type CapacityWeightInput,
  type CapacityWeightQuery,
  type CapacityWeightSet,
  type CapacityWeightVector,
  computeCapacityWeights,
  gridCellKey,
  haversineKm,
  readCapacityWeightsAsOf,
  type WeightablePlant,
  type WeightedCell,
  weightMisallocation,
} from "./capacity-weights.js";
export {
  aggregateSubsystemHour,
  readSubsystemWeatherAsOf,
  type SubsystemWeatherHour,
  type SubsystemWeatherQuery,
  type SubsystemWeatherResult,
  type WeatherPoint,
  type WeightBasis,
} from "./weather-aggregate.js";
