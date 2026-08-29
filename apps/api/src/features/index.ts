/**
 * The feature layer: where stored facts become model inputs.
 *
 * The ingest layer's job ends at "this is what the source said, and when".
 * Everything here is a *derivation* — no table of its own, nothing written —
 * because the two central quantities are functions of a date rather than
 * columns: `InstalledCapacityAsOf` and, on top of it,
 * `CapacityWeight(centroid, technology, t)`.
 *
 * The **model's** feature rows are not derived here at all. They are
 * `feature_rows(...)`, a set-returning function in the migration tree, and
 * `feature-rows.ts` only calls it — one definition, owned by the schema
 * authority, called identically from TypeScript and from Python.
 */

export {
  CALENDAR_GENERATOR,
  CALENDAR_VERSION,
  type CalendarArtifact,
  type CalendarDay,
  type CalendarHolidayCategory,
  calendarDigest,
  loadCalendarArtifact,
  NATIONAL_SCOPE,
  parseCalendarArtifact,
} from "./calendar/calendar.js";
export {
  CalendarImmutableError,
  type LoadCalendarResult,
  loadCalendar,
  readCalendarGeneration,
  storedCalendarDigest,
} from "./calendar/calendar-repository.js";
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
  FEATURE_ROW_COLUMNS,
  FEATURE_ROW_STAMP_COLUMNS,
  FEATURE_SETS,
  type FeatureRow,
  type FeatureRowsQuery,
  type FeatureSet,
  GATE_PROFILES,
  type GateProfile,
  isFeatureColumn,
  isLabelColumn,
  readFeatureRows,
  readServingRows,
  type ServingQuery,
  servingTargetDate,
} from "./feature-rows.js";
export {
  aggregateSubsystemHour,
  readSubsystemWeatherAsOf,
  type SubsystemWeatherHour,
  type SubsystemWeatherQuery,
  type SubsystemWeatherResult,
  type WeatherPoint,
  type WeightBasis,
} from "./weather-aggregate.js";
