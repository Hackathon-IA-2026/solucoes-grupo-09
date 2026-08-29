/**
 * WattSteer's domain vocabulary — the single definition of the names the whole
 * product shares.
 *
 * `docs/domain-model.md` is the naming authority for the project. This module
 * is that vocabulary expressed in TypeScript, and it lives in `packages/core`
 * because it was briefly defined twice inside the web app alone: the landing
 * page and the product screens were built in parallel and each declared its own
 * `SubsystemCode`, `Band`, `ForecastOrigin` and `Driver`. They disagreed on two
 * of them — `Driver.contribution` against `Driver.share`, and a lowercase
 * `Technology` against the uppercase one the API and the database enum actually
 * use.
 *
 * Two definitions of a domain type is not duplication to be tidied later; it
 * is a contradiction, and the moment one surface talks to the API the two
 * stop agreeing about what the same word means. Promoting the module out of
 * `apps/web` is what lets the gateway import these names instead of forming a
 * second opinion about them.
 *
 * Two rules from `docs/domain-model.md` that this module encodes structurally
 * rather than merely documents, because both are lost by a rewrite that is
 * only reading the field lists:
 *
 *  - **`SIN` is not a `Subsystem`.** It is ONS's national aggregate row,
 *    filtered at the ingest boundary. A national total is a derived sum over
 *    the four, never a fifth member — which is what makes double counting
 *    impossible rather than merely discouraged.
 *  - **A lead time is derived and is never stored or returned.** It is
 *    `valid_time − published_at`, computable by anyone holding a
 *    `ForecastOrigin` and the hour it describes. A stored copy is a second
 *    number that can disagree with the two instants it came from. No exported
 *    type here carries one, and `packages/core/test/vocabulary.test.ts` asserts
 *    it of the source rather than trusting this paragraph.
 */

/** `Subsystem` — an enum, not a table. Exactly four. `SIN` is not a member. */
export type SubsystemCode = "N" | "NE" | "S" | "SE";

/**
 * `Technology` — the two variable renewable fleets.
 *
 * **The serialized form is uppercase, everywhere, including the `technology`
 * query parameter.** `docs/domain-model.md` writes the enum `wind | solar` and
 * the wire carries `wind_mwh` / `solar_mwh`, so the two authorities look like
 * they disagree; they do not, once you separate a *value* from a *field name*.
 * The domain model is naming the two members in prose, and `wind_mwh` is a
 * snake_case field name under the wire's own casing rule. Neither is a spelling
 * of the value that travels in `technology=`.
 *
 * The value is uppercase because it already is, in the three places that would
 * have to be migrated to change it: the `technology` Postgres enum
 * (`apps/api/src/database/schema.ts`), the rows the canonical read contract
 * already serves, and the `technology` query parameter Elysia already validates
 * on `/v1/canonical/*`. A lowercase wire would buy prose symmetry and cost a
 * translation at the one boundary — TypeScript to Python, over HTTP — where a
 * silent mismatch is hardest to see and where nothing type-checks across.
 *
 * It is also **case-sensitive**: `technology=wind` is a 422, not a synonym.
 * These responses are public and shared-cacheable with no `Authorization` to
 * `Vary` on, so a case-insensitive parameter would fragment one answer across
 * several cache entries and make a hit rate a function of how a caller typed.
 *
 * The vector in `fixtures/published-constants/constants.json` pins the casing
 * in both languages, so this decision cannot drift on one side only.
 */
export type Technology = "WIND" | "SOLAR";

/** The two members, in the order the screens offer them. */
export const TECHNOLOGIES: readonly Technology[] = ["WIND", "SOLAR"];

/**
 * Read a `technology` query parameter. `null` for anything else — including a
 * lowercase spelling, deliberately; see `Technology`.
 */
export function parseTechnology(raw: string | undefined | null): Technology | null {
  return raw === "WIND" || raw === "SOLAR" ? raw : null;
}

/** Read a `subsystem` query parameter. `SIN` is not a member, so it is `null`. */
export function parseSubsystem(raw: string | undefined | null): SubsystemCode | null {
  return raw === "N" || raw === "NE" || raw === "S" || raw === "SE" ? raw : null;
}

/** `ReasonCode`, verbatim from the ONS dictionary. `REL` is not "relaxamento". */
export type ReasonCode = "REL" | "CNF" | "ENE" | "PAR";

/** `RestrictionOrigin` — local to the entity, or systemic. */
export type RestrictionOrigin = "LOC" | "SIS";

/**
 * `VintageFidelity` — stamped on every backtest, replay and metric, and
 * product-visible by decision rather than by accident.
 */
export type VintageFidelity = "point_in_time" | "revision_optimistic";

/**
 * `ForecastOrigin` — the identity of the run that produced a forecast. Every
 * surface that shows a forecast must name it.
 */
export interface ForecastOrigin {
  /**
   * Identity, not copy. The display name is UI text — see `producerLabel`.
   *
   * The producer of a *curtailment* forecast is `wattsteer`. `open_meteo` is
   * the producer of the **weather** run that forecast consumed, which is a
   * different fact about a different artifact — see `weatherRunLabel`.
   */
  producer: ForecastProducer;
  /** The run's own label. For a `wattsteer` forecast, the artifact version. */
  runLabel: string;
  /** ISO instant — `published_at` in the domain model. */
  publishedAt: string;
  /**
   * The weather run the forecast was built on, e.g. "D−1 12Z".
   *
   * Two facts, two fields: `docs/specs/api-surface.md` carries
   * `weather_run_label` beside the WattSteer origin rather than making a
   * screen choose which of the two to call "the run". Optional, because an
   * origin that is not a WattSteer forecast has no weather run to name.
   */
  weatherRunLabel?: string;
}

export type ForecastProducer = "open_meteo" | "ons_dessem" | "wattsteer";

/**
 * Display names for producers.
 *
 * Separate from the identity because the identity is a stable key that a
 * fixture, an API response and a database row all agree on, while the label is
 * copy that will eventually be translated. A fixture once stored
 * "ECMWF IFS HRES via Open-Meteo" *as* the producer, which made the identity
 * unmatchable against anything.
 */
export const producerLabel: Record<ForecastProducer, string> = {
  open_meteo: "ECMWF IFS HRES via Open-Meteo",
  ons_dessem: "ONS DESSEM",
  wattsteer: "WattSteer",
};

/**
 * A P10 / P50 / P90 triple — the shape of every quantity the forecaster emits.
 *
 * Quantiles do not add. Two `Band`s must never be summed componentwise: the
 * P90 of a sum is not the sum of the P90s. Wherever the product needs a total,
 * the total carries its own joint band.
 */
export interface Band {
  /** 10th percentile — the low end of the forecast interval. */
  p10: number;
  /** Median. The figure a single-number UI would have shown alone. */
  p50: number;
  /** 90th percentile. */
  p90: number;
}

/**
 * How a forecast figure divides between the two fleets — **two scalars, and
 * nothing else**.
 *
 * The forecaster has no per-technology head. It produces one distribution per
 * subsystem-day and one per subsystem-hour; the wind/solar division is a
 * decomposition of the **expectation**, which is the only quantity that can be
 * divided honestly. Expectations add: `E[wind] + E[solar] = E[total]`, exactly.
 * Quantiles do not, so there is no P10 of the wind part that composes with
 * anything, and publishing one would invite a chart to draw a band the model
 * cannot support.
 *
 * That is why this is an interface with two `number`s rather than two `Band`s,
 * and why `common.schema.json`'s `technology_split` is
 * `additionalProperties: false` over exactly `wind_mwh` and `solar_mwh`: a
 * response that smuggles a `p10` under the split fails validation at the
 * boundary rather than reaching a fan chart that would happily render it.
 * `packages/core/test/vocabulary-rules.test.ts` asserts that rejection.
 *
 * The consequence for the UI is the point of the type: a technology selector
 * can only ever choose **which of these two scalars to emphasise**. It cannot
 * filter a forecast, because there is no per-technology forecast to filter.
 */
export interface TechnologySplit {
  /** `E[constrained_off]` attributable to wind, MWh. */
  windMwh: number;
  /** `E[constrained_off]` attributable to solar, MWh. */
  solarMwh: number;
}

/** The one scalar a technology selection picks out of a split. */
export function splitFor(split: TechnologySplit, technology: Technology): number {
  return technology === "WIND" ? split.windMwh : split.solarMwh;
}

/** The other one — what the selection is being read against. */
export function splitOther(split: TechnologySplit, technology: Technology): number {
  return technology === "WIND" ? split.solarMwh : split.windMwh;
}

/**
 * Why a published figure has no band — an identity, never a sentence.
 *
 * The sentence lives in the dictionaries keyed by this code, exactly as the
 * driver codes and the risk classes do, so a missing explanation is a compile
 * error rather than a blank line under a number.
 *
 * One member today, and a union rather than a `string` on purpose: the
 * national forecast has no band because the path ensemble is drawn per
 * subsystem, and a quantile of a sum needs a joint draw
 * (`docs/specs/api-surface.md`, "The national readout, and the band that
 * cannot be built"). A second reason has to be written down in both locales
 * before it can reach a screen.
 */
export type BandUnavailableReason = "no_joint_ensemble";

/**
 * A number the UI is allowed to render — and the reason the band survives.
 *
 * Every stat card and gauge in `reference/` takes a bare `number` and has
 * nowhere to put an interval, which is exactly how a band gets quietly
 * dropped: someone reaches for the component that exists, passes `p50`, and
 * the range is gone with no diff to notice.
 *
 * So the UI does not render numbers, it renders `Figure`s:
 *
 *   - `band` — a forecast. Carries all three quantiles, and every component
 *     that draws one has to decide what it does with the width.
 *   - `observed` — a measured actual. Has no band *because there is nothing to
 *     be uncertain about*, and says so on screen.
 *
 * There is no third variant, so no code path can render a forecast as a lone
 * number. The type system, not discipline, keeps the band on the page — the
 * same approach the domain model takes to illegal states.
 */
export type Figure =
  | { readonly kind: "band"; readonly band: Band }
  | { readonly kind: "observed"; readonly value: number };

/** A forecast figure. Quantile ordering is asserted, not assumed. */
export function band(p10: number, p50: number, p90: number): Figure {
  if (!(p10 <= p50 && p50 <= p90)) {
    throw new RangeError(`Band quantiles out of order: ${p10}, ${p50}, ${p90}`);
  }
  return { kind: "band", band: { p10, p50, p90 } };
}

/** A measured actual — no band, and the UI says why. */
export function observed(value: number): Figure {
  return { kind: "observed", value };
}

/** The figure a chart axis or a bar length should be scaled by. */
export function centre(figure: Figure): number {
  return figure.kind === "band" ? figure.band.p50 : figure.value;
}

/** The widest value a figure reaches — what an axis has to make room for. */
export function upper(figure: Figure): number {
  return figure.kind === "band" ? figure.band.p90 : figure.value;
}

/**
 * Interval width relative to the median: `(p90 − p10) / p50`. A plain-language
 * handle on how much the forecast actually knows, and the thing a reader loses
 * entirely when only the median is shown.
 */
export function spread(band_: Band): number {
  return band_.p50 === 0 ? 0 : (band_.p90 - band_.p10) / band_.p50;
}

/**
 * Driver attribution — SHAP plus domain rules, at subsystem grain.
 *
 * `share` rather than `contribution`: the value is a share of the total
 * attributed magnitude and the shares sum to one, which the name should say.
 */
/**
 * The drivers the Diagnosis engine can attribute to, as a closed set.
 *
 * Closed rather than `string` on purpose: the words for each of these live in
 * the dictionaries, keyed by the code, and a union makes "every driver has a
 * label in both locales" a compile error rather than a blank row on screen.
 * Adding a driver means adding its two words, which is the intended friction.
 */
export type DriverCode =
  | "vre_load_ratio"
  | "export_headroom"
  | "load_level"
  | "overnight_load_level"
  | "hub_wind_speed"
  | "day_of_week"
  | "midday_net_load"
  | "clear_sky_index"
  | "installed_pv"
  | "hydro_flexibility"
  | "import_position"
  | "other";

export interface Driver {
  /**
   * Stable identifier, and the **only** thing a fixture or an API response
   * carries. The label is copy: it lives in the dictionaries, keyed by this
   * code, exactly as the reason codes and the risk classes do. A `label`
   * field here would be an English string travelling through the data layer,
   * which is precisely how a bilingual product goes monolingual again.
   */
  code: DriverCode;
  /** Share of the total attributed magnitude, 0..1. Shares sum to 1. */
  share: number;
  /** Which way this driver pushed the forecast on this day. */
  direction: DriverDirection;
}

export type DriverDirection = "raises" | "lowers";

/**
 * A non-numeric feature reading — "the day was a weekend", "the subsystem was
 * importing". Held as a term rather than as a word so both locales can say it.
 */
export type DriverTerm = "weekend" | "weekday" | "importing" | "balanced";

/**
 * What a feature actually read, and what it usually reads.
 *
 * Structured rather than a preformatted string: `"1,900 MW"` bakes in en-US
 * grouping, and `"weekend"` bakes in English. A reading is a quantity or a
 * term, and the locale decides how either one is written.
 */
export type DriverReading =
  | {
      readonly kind: "quantity";
      readonly value: number;
      readonly decimals?: number;
      /** Appended verbatim — units are untranslated in both locales. */
      readonly unit?: string;
      /** Show a leading `+` for a positive value, where the sign is the point. */
      readonly signed?: boolean;
    }
  | { readonly kind: "term"; readonly term: DriverTerm }
  /** No meaningful reading — the residual bucket. The row is omitted. */
  | { readonly kind: "none" };

/** A driver with its feature readings attached, as the Explain screen shows it. */
export interface AttributedDriver extends Driver {
  readonly observed: DriverReading;
  readonly typical: DriverReading;
}
