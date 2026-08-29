/**
 * WattSteer's client-side domain vocabulary — the single definition of the
 * names the whole web app shares.
 *
 * `docs/domain-model.md` is the naming authority for the project. This module
 * is that vocabulary expressed in TypeScript for the frontend, and it exists
 * because it was briefly defined twice: the landing page and the product
 * screens were built in parallel and each declared its own `SubsystemCode`,
 * `Band`, `ForecastOrigin` and `Driver`. They disagreed on two of them —
 * `Driver.contribution` against `Driver.share`, and a lowercase `Technology`
 * against the uppercase one the API and the database enum actually use.
 *
 * Two definitions of a domain type is not duplication to be tidied later; it
 * is a contradiction, and the moment one surface talks to the API the two
 * stop agreeing about what the same word means.
 */

/** `Subsystem` — an enum, not a table. Exactly four. `SIN` is not a member. */
export type SubsystemCode = "N" | "NE" | "S" | "SE";

/**
 * `Technology` — the two variable renewable fleets.
 *
 * Uppercase to match the `technology` Postgres enum and the API's canonical
 * form. The screens once used lowercase, which would have needed a translation
 * layer at exactly the boundary where a silent mismatch is hardest to see.
 */
export type Technology = "WIND" | "SOLAR";

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
  /** Identity, not copy. The display name is UI text — see `producerLabel`. */
  producer: ForecastProducer;
  /** The run's own label, e.g. "D−1 12Z". */
  runLabel: string;
  /** ISO instant — `published_at` in the domain model. */
  publishedAt: string;
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
