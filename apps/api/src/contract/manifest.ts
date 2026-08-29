/**
 * The canonical read manifest — what the modelling side is allowed to know.
 *
 * This is the whole of the contract's *vocabulary*, as data. It exists as a
 * value rather than as prose because it is consumed in two languages: the
 * TypeScript reads in `reads.ts` are built from it, `apps/ml` mirrors it, and
 * `packages/core/fixtures/canonical-contract/manifest.json` is the shared
 * fixture both sides assert against. A read that is not in here is not part of
 * the contract, in either language.
 *
 * Dependency-free on purpose — see the header of `vintage.ts`.
 *
 * ## What the names are, and what they are not
 *
 * Every name here is `docs/domain-model.md`'s. None is ONS's: no source dataset
 * name, no source column name, no ingest table name. That is the acceptance
 * criterion the ticket states first; `apps/api/test/contract.test.ts` checks it
 * over this file's own text, which is why the forbidden tokens are enumerated
 * there and deliberately not repeated here.
 *
 * The one deliberate exception is `conjunto`, which `docs/domain-model.md`
 * naming rule 2 keeps as a Portuguese proper noun because it names a specific
 * ONS settlement construct that has no English equivalent.
 */

/**
 * Observation or forecast, decided structurally rather than by a flag.
 *
 * `docs/domain-model.md` §4: an `Observation` always has
 * `published_at > valid_time`; a `Forecast` always has
 * `published_at < valid_time`, and additionally carries a `ForecastOrigin`
 * naming the run that produced it. The contract carries the discriminator on
 * the read itself, so a consumer distinguishes the two *before* it looks at a
 * single row — which is what stops a forecast being read as an actual.
 */
export type FactKind = "observation" | "forecast";

/** The producers whose runs the platform stores. `docs/domain-model.md` §4. */
export type ForecastProducer = "open_meteo" | "ons_dessem" | "wattsteer";

/**
 * The identity of the run that produced a forecast row.
 *
 * Present on every row of a `forecast` read and structurally absent from every
 * row of an `observation` read: there is no run that produced an observation,
 * so there is no field in which to put one.
 */
export interface ForecastOrigin {
  producer: ForecastProducer;
  /** `00Z` / `12Z` for weather; the reference day for the day-ahead balance. */
  runLabel: string;
  /** The run initialisation. Identical to the row's `publishedAt`. */
  publishedAt: Date;
}

/**
 * There is deliberately **no `leadTime` here**.
 *
 * `docs/domain-model.md` §4 makes it derived and never stored; the
 * `docs/specs/api-surface.md` vocabulary rules go one step further and make it
 * never *returned*, because a consumer holding `validTime` and
 * `origin.publishedAt` can subtract them and a second copy on the wire can
 * disagree with the pair it was computed from. The contract carries the two
 * timestamps and stops there.
 */

/**
 * The grain a read is keyed at.
 *
 * `reporting_entity` and `plant` are two grains and not one, and the difference
 * is the whole reason `restrictionCause` is reachable from one and not the
 * other.
 */
export type ReadGrain =
  | "subsystem_hour"
  | "subsystem_link_hour"
  | "subsystem_half_hour"
  | "reporting_entity_hour"
  | "plant_hour"
  | "centroid_hour"
  | "fleet_scope_day"
  | "plant_day";

/** The names of the reads. A closed set — this is the contract's surface. */
export type CanonicalReadName =
  | "curtailment-by-reporting-entity"
  | "curtailment-by-plant"
  | "system-context"
  | "system-exchange"
  | "day-ahead-balance"
  | "weather-forecast"
  | "installed-capacity"
  | "conjunto-membership";

/** One read, described completely enough that a consumer never guesses. */
export interface CanonicalReadSpec {
  name: CanonicalReadName;
  /** Observation or forecast. See `FactKind`. */
  kind: FactKind;
  /** Absent for observations; the producer whose runs fill a forecast read. */
  producer: ForecastProducer | null;
  grain: ReadGrain;
  /**
   * The business key. Exactly one row per key comes back from an as-of read,
   * or none — `docs/domain-model.md` §1.
   */
  key: readonly string[];
  /**
   * Whether a `restrictionCause` is reachable from this read's rows.
   *
   * True for exactly one read. `docs/domain-model.md` §3: a restriction reason
   * is a property of a `ReportingEntity`, and there is no path in the type
   * system from a `Plant` to a reason. The plant-grain read has no cause field
   * and no parameter by which one could be requested; deriving one would be an
   * allocation, and v1 computes none.
   */
  carriesRestrictionCause: boolean;
  /**
   * Which axis the read's `VintageFidelity` is decided on.
   *
   * `valid_time` for the fact tables: fidelity is about the window being
   * described. `as_of` for the registry snapshots, where the question is when
   * WattSteer looked rather than which hour it is looking at — SIGA has no
   * archive, so before the first snapshot there is only today's extract.
   * `fleet_date` for the capacity and membership reads, whose second axis *is*
   * the date the fleet is being asked about.
   */
  fidelityAxis: "valid_time" | "as_of" | "fleet_date";
  /** One line, in domain vocabulary, for the generated docs and `/v1/canonical`. */
  summary: string;
}

/**
 * Every read, in the order the modelling side meets them.
 *
 * The five families the platform owes the modelling side — curtailment
 * observations, system context, the operational day-ahead balance, weather, and
 * the registry with as-of capacity — expand to eight reads because two of them
 * are genuinely two grains: curtailment is settled at reporting-entity grain and
 * measured at plant grain, and the registry answers both "how much capacity" and
 * "whose conjunto".
 */
export const CANONICAL_READS: readonly CanonicalReadSpec[] = [
  {
    name: "curtailment-by-reporting-entity",
    kind: "observation",
    producer: null,
    grain: "reporting_entity_hour",
    key: ["reportingEntityCode", "technology", "validTime"],
    carriesRestrictionCause: true,
    fidelityAxis: "valid_time",
    summary:
      "Constrained-off energy as settled, at the grain ONS settles it — and " +
      "therefore the only grain at which a restriction cause exists.",
  },
  {
    name: "curtailment-by-plant",
    kind: "observation",
    producer: null,
    grain: "plant_hour",
    key: ["plantOnsCode", "technology", "validTime"],
    carriesRestrictionCause: false,
    fidelityAxis: "valid_time",
    summary:
      "Per-plant generation and the measured resource. No restriction cause " +
      "and no reference generation exist at this grain, so neither is offered.",
  },
  {
    name: "system-context",
    kind: "observation",
    producer: null,
    grain: "subsystem_hour",
    key: ["subsystem", "validTime"],
    carriesRestrictionCause: false,
    fidelityAxis: "valid_time",
    summary: "Load and generation by technology per subsystem-hour, with net exchange.",
  },
  {
    name: "system-exchange",
    kind: "observation",
    producer: null,
    grain: "subsystem_link_hour",
    key: ["fromSubsystem", "toSubsystem", "validTime"],
    carriesRestrictionCause: false,
    fidelityAxis: "valid_time",
    summary:
      "Interchange per directed subsystem link — the corridor grain, which the " +
      "net figure in system-context cannot reconstruct.",
  },
  {
    name: "day-ahead-balance",
    kind: "forecast",
    producer: "ons_dessem",
    grain: "subsystem_half_hour",
    key: ["subsystem", "validTime"],
    carriesRestrictionCause: false,
    fidelityAxis: "valid_time",
    summary:
      "The operational day-ahead balance published D−1, at half-hour × " +
      "subsystem grain. A forecast, in its own read, never merged with actuals.",
  },
  {
    name: "weather-forecast",
    kind: "forecast",
    producer: "open_meteo",
    grain: "centroid_hour",
    key: ["centroidId", "validTime"],
    carriesRestrictionCause: false,
    fidelityAxis: "valid_time",
    summary:
      "Weather at capacity-weighted cluster centroids from a named run. Never " +
      "at plants, and never from a stitched or model-substituting archive.",
  },
  {
    name: "installed-capacity",
    kind: "observation",
    producer: null,
    grain: "fleet_scope_day",
    key: ["subsystem", "technology"],
    carriesRestrictionCause: false,
    fidelityAxis: "fleet_date",
    summary:
      "Installed capacity as a function of the fleet date, per subsystem and " +
      "technology, summed over live generating units. Never a stored scalar.",
  },
  {
    name: "conjunto-membership",
    kind: "observation",
    producer: null,
    grain: "plant_day",
    key: ["plantOnsCode"],
    carriesRestrictionCause: false,
    fidelityAxis: "fleet_date",
    summary:
      "Which conjunto a plant belonged to on a date — the only path between " +
      "the plant and reporting-entity grains, and it is time-resolved.",
  },
];

/** Index by name, so a route or a consumer can look one up without a scan. */
export const CANONICAL_READ_BY_NAME: ReadonlyMap<CanonicalReadName, CanonicalReadSpec> =
  new Map(CANONICAL_READS.map((spec) => [spec.name, spec]));

/** The path the contract is served under. Mirrored by `apps/ml`. */
export const CANONICAL_BASE_PATH = "/v1/canonical";

/** The URL path of one read. The single place the shape is written down. */
export function canonicalReadPath(name: CanonicalReadName): string {
  return `${CANONICAL_BASE_PATH}/${name}`;
}
