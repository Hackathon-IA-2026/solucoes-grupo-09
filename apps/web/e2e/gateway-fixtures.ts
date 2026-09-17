/**
 * Wire-shaped bodies for the five reads the Grid Overview makes, and the
 * `page.route` handler that answers them.
 *
 * **Why wire-shaped and not the generated interfaces.** `packages/core`'s
 * `ApiClient` is the only translator between the gateway's `snake_case` and the
 * app's `camelCase` (`packages/core/src/wire.ts` owns the table, and
 * `one-translator.test.ts` is the standing guard that nothing else renames a
 * field). A fixture written in `camelCase` would be a body the real client has
 * never seen: `decodeWire` would carry every unknown key through unrenamed and
 * the screen would read `undefined` off fields that are present. So these are
 * the bytes the gateway sends, and the app under test decodes them through the
 * same table production uses — which is what makes a stub here able to fail
 * when a field is renamed in the schema.
 *
 * **Why it is one file and not a fixture per spec.** The five reads are one
 * screen's worth of state, and the state only means anything if the numbers
 * agree with each other: the same four subsystems, the same threshold, the
 * observed day exactly two days before the forecast day (which is how
 * `use-network.ts` derives it), the national expectation actually equal to the
 * sum of the four. A spec that assembles its own half of that will eventually
 * assemble a screen that cannot exist.
 *
 * **The two states these drive.** `routeGateway(page, { forecast: true })`
 * gives the screen its `read` state — settled grid *and* a forecast.
 * `{ forecast: false }` refuses the two forecast reads with
 * `FORECAST_UNAVAILABLE` (404) while the three observed reads still answer 200,
 * which is `observedOnly` and, per `apps/web/src/lib/absence.ts`, the state
 * production is actually in: nothing promoted on either lane, so the gate
 * passed and the publication job wrote no rows.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/**
 * The day being forecast, and the settled day behind it.
 *
 * `use-network.ts` derives the observed day as `target - 2`: settled data lags
 * ONS by hours, so the most recent day that can have settled is the one before
 * today, which is two before tomorrow's forecast. The two constants are written
 * out rather than computed so a reader can check a `valid_time` in the fixtures
 * against them by eye.
 */
export const TARGET_DATE = "2026-09-16";
export const SETTLED_DATE = "2026-09-14";

/** The subsystem the app defaults to (`parseAppParams`), so the stub echoes it. */
export const SUBSYSTEM = "NE";

/** `SUBSYSTEM_THRESHOLD_MW` from `@wattsteer/core`. Stamped on everything it produced. */
const THRESHOLD_MW = 5;

/** `MAX_GAP_HOURS` default: one sub-threshold hour ends an episode. */
const MAX_GAP_HOURS = 0;

/** The vintage cut every observed body is stamped with. */
const AS_OF = "2026-09-15T09:00:00Z";

/**
 * The cut points a `risk_class` was read off, published beside it so the class
 * is checkable rather than asserted. These are the product's bins; every
 * `risk_class` below is the class its own probability falls in.
 */
const RISK_BINS = {
  low: [0, 0.25],
  elevated: [0.25, 0.6],
  high: [0.6, 1],
};

/** One decimal place, so a fixture number reads like a published one. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The UTC instant that starts Brasília hour `hourLocal` on `civilDate`.
 *
 * Brasília is UTC-3 with no DST since 2019, so the local day starts at 03:00Z
 * and hours 21-23 land on the following UTC date. `observedHours` in
 * `lib/network.ts` cuts the civil day back out of the response by exactly this
 * arithmetic, so a fixture that got it wrong would hand the profile chart an
 * empty array rather than fail loudly.
 */
function validTime(civilDate: string, hourLocal: number): string {
  const ms = Date.parse(`${civilDate}T00:00:00Z`) + (hourLocal + 3) * 3_600_000;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** The 24 Brasília clock hours of a day. */
const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

/**
 * Solar curtailment: a midday hump, zero in the dark.
 *
 * Shaped rather than random because the screen draws it: a flat line or noise
 * would make a broken profile chart indistinguishable from a working one.
 */
function solarMwh(hourLocal: number): number {
  if (hourLocal < 8 || hourLocal > 17) {
    return 0;
  }
  return round1(120 * Math.sin((Math.PI * (hourLocal - 8)) / 9) ** 2);
}

/** Wind curtailment: the overnight and late-evening trough-load hours. */
function windMwh(hourLocal: number): number {
  if (hourLocal >= 6 && hourLocal <= 18) {
    return 0;
  }
  const distance = hourLocal <= 5 ? 3 - Math.abs(hourLocal - 2) : hourLocal - 19;
  return round1(40 + 18 * Math.max(distance, 0));
}

/**
 * `GET /v1/grid/now` — the settled grid, and the one read that needs no model
 * at all.
 *
 * `national.derived` is on the wire rather than implied: it names which four
 * rows were added, so `last_24h_constrained_off_mwh` cannot be mistaken for an
 * ONS `SIN` row. The national total here is the exact sum of the four
 * subsystems, because observations add.
 */
export const GRID_NOW = {
  as_of: AS_OF,
  latest_settled_hour: "2026-09-15T05:00:00Z",
  lag_hours: 4,
  vintage_fidelity: "point_in_time",
  subsystems: [
    {
      subsystem: "N",
      ons_display_name: "NORTE",
      last_24h_constrained_off_mwh: 311.4,
      latest_hour_constrained_off_mwh: 12.8,
      split: { wind_mwh: 208.1, solar_mwh: 103.3 },
    },
    {
      subsystem: "NE",
      ons_display_name: "NORDESTE",
      last_24h_constrained_off_mwh: 1842.6,
      latest_hour_constrained_off_mwh: 74.2,
      split: { wind_mwh: 1188.4, solar_mwh: 654.2 },
    },
    {
      subsystem: "SE",
      ons_display_name: "SUDESTE/CENTRO-OESTE",
      last_24h_constrained_off_mwh: 274.9,
      latest_hour_constrained_off_mwh: 6.1,
      split: { wind_mwh: 41.3, solar_mwh: 233.6 },
    },
    {
      subsystem: "S",
      ons_display_name: "SUL",
      last_24h_constrained_off_mwh: 96.2,
      latest_hour_constrained_off_mwh: 3.4,
      split: { wind_mwh: 88.7, solar_mwh: 7.5 },
    },
  ],
  national: {
    // 311.4 + 1842.6 + 274.9 + 96.2, added here so the screen's national figure
    // is checkable against the four rows beside it.
    last_24h_constrained_off_mwh: 2525.1,
    derived: "sum_of_four",
  },
};

/**
 * `GET /v1/curtailment/hours` — the settled profile, at the route's real grain.
 *
 * **Two rows per hour, wind and solar**, because that is what the route
 * returns: the grain is (subsystem, technology, valid_time) and `observedHours`
 * in `lib/network.ts` adds the technologies to get the one line the chart
 * draws. A fixture with one row per hour would pass through that function
 * unchanged and would therefore never exercise the only arithmetic in it.
 *
 * `technology` is `null` at the top level because the range was not filtered;
 * `next_cursor` is `null` because one civil day fits in one page. Both are
 * explicit nulls rather than omissions — the app reads them.
 *
 * The rows cover only the settled civil day even though `use-network.ts` asks
 * for a two-UTC-day window: `observedHours` filters to the civil day anyway,
 * and rows outside it would assert nothing extra.
 */
export const CURTAILMENT_HOURS = {
  subsystem: SUBSYSTEM,
  technology: null,
  from: `${SETTLED_DATE}T00:00:00Z`,
  to: "2026-09-16T00:00:00Z",
  as_of: AS_OF,
  data_version: "ons-2026-09-15T09:00Z",
  vintage_fidelity: "point_in_time",
  rows: HOURS.flatMap((hourLocal) => [
    {
      subsystem: SUBSYSTEM,
      technology: "WIND",
      valid_time: validTime(SETTLED_DATE, hourLocal),
      hour_local: hourLocal,
      constrained_off_mwh: windMwh(hourLocal),
    },
    {
      subsystem: SUBSYSTEM,
      technology: "SOLAR",
      valid_time: validTime(SETTLED_DATE, hourLocal),
      hour_local: hourLocal,
      constrained_off_mwh: solarMwh(hourLocal),
    },
  ]),
  next_cursor: null,
};

/**
 * `GET /v1/curtailment/episodes` — a fortnight of episodes, the window
 * `EPISODE_WINDOW_DAYS` asks for.
 *
 * Every episode repeats the `threshold_mw` and `max_gap_hours` that produced
 * it, and the response repeats them at the top level: an episode duration is
 * meaningless without the threshold that cut it, and a screen renders the
 * parameters in force beside the rows rather than the ones it assumed.
 *
 * `ended_at` is **exclusive** — the `valid_time` of the first hour back below
 * the threshold — so a six-hour episode starting at 03:00Z ends at 09:00Z.
 * Three episodes rather than one, so a list that renders only its first row is
 * visibly wrong.
 */
export const CURTAILMENT_EPISODES = {
  subsystem: SUBSYSTEM,
  from: "2026-08-31T00:00:00Z",
  to: `${SETTLED_DATE}T00:00:00Z`,
  as_of: AS_OF,
  data_version: "ons-2026-09-15T09:00Z",
  vintage_fidelity: "point_in_time",
  threshold_mw: THRESHOLD_MW,
  max_gap_hours: MAX_GAP_HOURS,
  episodes: [
    {
      subsystem: SUBSYSTEM,
      technology: "WIND",
      started_at: "2026-09-13T03:00:00Z",
      ended_at: "2026-09-13T09:00:00Z",
      duration_hours: 6,
      total_mwh: 402.6,
      peak_mw: 94,
      threshold_mw: THRESHOLD_MW,
      max_gap_hours: MAX_GAP_HOURS,
    },
    {
      subsystem: SUBSYSTEM,
      technology: "SOLAR",
      started_at: "2026-09-09T14:00:00Z",
      ended_at: "2026-09-09T20:00:00Z",
      duration_hours: 6,
      total_mwh: 518.3,
      peak_mw: 120,
      threshold_mw: THRESHOLD_MW,
      max_gap_hours: MAX_GAP_HOURS,
    },
    {
      subsystem: SUBSYSTEM,
      technology: "WIND",
      started_at: "2026-09-04T02:00:00Z",
      ended_at: "2026-09-04T11:00:00Z",
      duration_hours: 9,
      total_mwh: 731.9,
      peak_mw: 112,
      threshold_mw: THRESHOLD_MW,
      max_gap_hours: MAX_GAP_HOURS,
    },
  ],
};

/**
 * The identity of the run that produced both forecast bodies.
 *
 * Shared between them deliberately: the map and the profile are two views of
 * one publication, and a screen that stamped two different origins on them
 * would be telling the reader something untrue about where the numbers came
 * from. `gate_late` is D-1 19:00 BRT on the 12Z weather run, which is the
 * app's default run.
 */
const FORECAST_ORIGIN = {
  producer: "wattsteer",
  run_label: "ws-curtail-2026.09.1",
  published_at: "2026-09-15T22:00:00Z",
  age_hours: 3.5,
  origin_kind: "served",
  gate_profile: "gate_late",
  weather_run_label: "D-1 12Z",
};

/**
 * `GET /v1/grid/outlook` — four subsystems, one target date, no hourly detail.
 *
 * Each row carries its own `risk_class` beside the `risk_bins` it was cut with,
 * because `lib/network.ts` reads the class rather than recomputing it from the
 * probability: a second opinion about the same number, held against a local
 * copy of the bins, is the defect that split off.
 *
 * `day_expected_mwh` is a **sibling** of `day_energy_mwh`, never its `p50`.
 * Each row's expectation sits above its median here, which is what a mixture
 * with an occurrence probability below a half actually looks like — a fixture
 * where expectation equalled the median would let a screen conflate the two and
 * still pass.
 *
 * The national figure is the exact sum of the four expectations (expectations
 * add; quantiles do not), and `national.band` is a *joint* band read as if from
 * the persisted national row rather than the four subsystem bands added — it is
 * narrower than their componentwise sum, as a non-comonotone sum is.
 */
export const GRID_OUTLOOK = {
  target_date: TARGET_DATE,
  threshold_mw: THRESHOLD_MW,
  forecast_origin: FORECAST_ORIGIN,
  vintage_fidelity: "point_in_time",
  risk_bins: RISK_BINS,
  subsystems: [
    {
      subsystem: "N",
      ons_display_name: "NORTE",
      day_occurrence_probability: 0.18,
      risk_class: "low",
      day_energy_mwh: { p10: 0, p50: 46, p90: 288 },
      peak_power_mw: { p10: 0, p50: 18, p90: 61 },
      day_expected_mwh: 94.5,
      split: { wind_mwh: 61.4, solar_mwh: 33.1 },
    },
    {
      subsystem: "NE",
      ons_display_name: "NORDESTE",
      day_occurrence_probability: 0.72,
      risk_class: "high",
      day_energy_mwh: { p10: 412, p50: 1486, p90: 3140 },
      peak_power_mw: { p10: 84, p50: 214, p90: 402 },
      day_expected_mwh: 1622.8,
      split: { wind_mwh: 1051.3, solar_mwh: 571.5 },
    },
    {
      subsystem: "SE",
      ons_display_name: "SUDESTE/CENTRO-OESTE",
      day_occurrence_probability: 0.41,
      risk_class: "elevated",
      day_energy_mwh: { p10: 0, p50: 183, p90: 742 },
      peak_power_mw: { p10: 0, p50: 46, p90: 118 },
      day_expected_mwh: 267.4,
      split: { wind_mwh: 39.8, solar_mwh: 227.6 },
    },
    {
      subsystem: "S",
      ons_display_name: "SUL",
      day_occurrence_probability: 0.09,
      risk_class: "low",
      day_energy_mwh: { p10: 0, p50: 0, p90: 96 },
      peak_power_mw: { p10: 0, p50: 0, p90: 24 },
      day_expected_mwh: 31.2,
      split: { wind_mwh: 28.9, solar_mwh: 2.3 },
    },
  ],
  national: {
    // 94.5 + 1622.8 + 267.4 + 31.2 — exact, because expectations add.
    expected_mwh: 2015.9,
    risk_class_counts: { low: 2, elevated: 1, high: 1 },
    // Narrower than the four bands added componentwise (whose p90 would be
    // 4266), because the four subsystems' curtailment is not comonotone.
    band: { p10: 486, p50: 1794, p90: 3628 },
    band_unavailable_reason: null,
  },
};

/**
 * The hourly shape of tomorrow's forecast for the selected subsystem.
 *
 * Built from the same diurnal functions as the observed day, scaled up: a
 * forecast that looked nothing like the settled profile beside it would make an
 * axis or a series swapped between the two charts invisible. The band widens
 * with the level and `expected_mwh` is a sibling of that band, sitting above
 * its median rather than inside it.
 */
const FORECAST_HOURS = HOURS.map((hourLocal) => {
  const wind = round1(windMwh(hourLocal) * 1.15);
  const solar = round1(solarMwh(hourLocal) * 1.1);
  const p50 = round1(wind + solar);
  return {
    valid_time: validTime(TARGET_DATE, hourLocal),
    hour_local: hourLocal,
    constrained_off_mwh: {
      p10: round1(p50 * 0.45),
      p50,
      p90: round1(p50 * 2.1 + 14),
    },
    expected_mwh: round1(p50 * 1.18 + 6),
    occurrence_probability:
      p50 === 0 ? 0.07 : Math.min(0.94, Math.round((0.35 + p50 / 260) * 100) / 100),
    split: { wind_mwh: wind, solar_mwh: solar },
  };
});

/**
 * `GET /v1/forecast/day-ahead` — one subsystem, one day, one gate.
 *
 * The day-grain figures are **the NE row of `GRID_OUTLOOK`, verbatim**: they
 * are the same persisted day row read by two routes, so a screen showing the
 * map and the profile disagreeing about tomorrow's NE total would be showing a
 * bug. They are deliberately *not* the componentwise sum of `hours`, because
 * quantiles do not add — `test/no-summed-bands.test.ts` guards the app side of
 * that and this fixture is the wire side.
 *
 * `hours_p50_nonzero` is counted off the hours rather than asserted, so the two
 * cannot drift apart when the profile above is retuned.
 */
export const FORECAST_DAY_AHEAD = {
  subsystem: SUBSYSTEM,
  ons_display_name: "NORDESTE",
  target_date: TARGET_DATE,
  threshold_mw: THRESHOLD_MW,
  forecast_origin: FORECAST_ORIGIN,
  vintage_fidelity: "point_in_time",
  artifact: {
    artifact_id: "ne-late-2026.09.1",
    feature_set: "fs-v3",
    trained_through: "2026-08-31",
  },
  risk_bins: RISK_BINS,
  day_occurrence_probability: 0.72,
  risk_class: "high",
  day_energy_mwh: { p10: 412, p50: 1486, p90: 3140 },
  peak_power_mw: { p10: 84, p50: 214, p90: 402 },
  day_expected_mwh: 1622.8,
  split: { wind_mwh: 1051.3, solar_mwh: 571.5 },
  hours_p50_nonzero: FORECAST_HOURS.filter((hour) => hour.constrained_off_mwh.p50 > 0)
    .length,
  hours: FORECAST_HOURS,
};

/**
 * The refusal the forecast half gets with nothing promoted.
 *
 * `FORECAST_UNAVAILABLE` (404) and not `MODEL_UNAVAILABLE` (503), which is the
 * point of stubbing it at all: `apps/web/src/lib/absence.ts` documents that
 * `/v1/grid/outlook` and `/v1/forecast/day-ahead` resolve from Postgres and are
 * structurally unable to know a lane state, so with the gate passed and the
 * publication job having written nothing they answer *this* code — not the one
 * `api-surface.md` predicted. `message` is developer prose the app is forbidden
 * to render; a spec asserting the screen's sentence is asserting the `t()` key
 * for the code, never this string.
 */
export const FORECAST_REFUSAL = {
  error: {
    code: "FORECAST_UNAVAILABLE",
    message:
      "No forecast rows for target_date=2026-09-16 subsystem=NE gate_profile=gate_late. See /v1/meta for the artifact lane state.",
    request_id: "e2e-forecast-refusal",
  },
};

/** The status `FORECAST_UNAVAILABLE` is answered with, from the error table. */
const FORECAST_REFUSAL_STATUS = 404;

/**
 * What an unmatched gateway path gets.
 *
 * A stub that let unknown requests through would hang against an origin nothing
 * is serving in e2e, and a hung `/v1/meta` looks exactly like a slow screen. So
 * everything else is refused immediately, in the same envelope, with the code
 * the gateway uses when no route matched.
 */
const ROUTE_NOT_FOUND = {
  error: { code: "ROUTE_NOT_FOUND", message: "No route matched.", request_id: "e2e" },
};

/**
 * `GET /v1/curtailment/reasons` — the observed causes Explain shows beside the
 * diagnosis, and the one read on that screen a model is *not* a precondition
 * for. Empty `rows` is the state the screen has to draw on most days: the ONS
 * registered no restriction for this subsystem on this date, which is a fact
 * and not an absence of data.
 */
const CURTAILMENT_REASONS = {
  subsystem: SUBSYSTEM,
  date: TARGET_DATE,
  as_of: AS_OF,
  data_version: "ons-2026.09.1",
  vintage_fidelity: "point_in_time",
  rows: [],
};

/**
 * The same read with a day that *did* have restrictions, for the screens that
 * summarise them.
 *
 * Opt-in rather than the default, because the empty day above is the state the
 * product is in most of the time and the one the Explain screen most has to
 * draw. A summary of a settled cause is a different question — it has nothing
 * to say about an empty day and needs a day with something in it to say
 * anything at all.
 *
 * Two `conjunto` rows and one `self_reporting_plant`, deliberately: the plant
 * row carries the largest number and must not win, because a plant inside a
 * conjunto ONS also reported would be counted twice. `dominant-reason.test.ts`
 * holds that rule as arithmetic; this holds it as a rendered screen.
 */
/**
 * `GET /v1/curtailment/evidence` — the passage a schedule retrieved for that
 * day's restriction.
 *
 * Served only with `reasons`, because a citation annotates a reason and there
 * is nothing to annotate on a day that had none. The shape is the retrieval
 * service's audit record, narrowed by `lib/evidence.ts` to the one line a card
 * states; the fields here are the ones measured off production.
 */
const CURTAILMENT_EVIDENCE = {
  subsystem: SUBSYSTEM,
  target_date: TARGET_DATE,
  rows: [
    {
      verdict: "found",
      payload: {
        items: [
          {
            supports: "ENE",
            citations: [
              {
                external_id: "IO-ON.NE.5NE",
                revision: "Rev.61",
                title: "IO-ON.NE.5NE - Operação Normal da Área 500 kV da Região Nordeste",
                url: "https://www.ons.org.br/MPO/IO-ON.NE.5NE_Rev.61.pdf",
                locator: { page: 12, row: null, table: null, section: "5.2" },
              },
            ],
          },
        ],
      },
    },
  ],
};

const CURTAILMENT_REASONS_WITH_ROWS = {
  ...CURTAILMENT_REASONS,
  rows: [
    {
      grain: "conjunto",
      entity_label: "CJ VENTOS DO ARARIPE",
      reason: "ENE",
      origin: "SIS",
      constrained_off_mwh: 780,
      description: "Restrição energética por sobreoferta.",
    },
    {
      grain: "conjunto",
      entity_label: "CJ SERRA DO SELTINHO",
      reason: "CNF",
      origin: "LOC",
      constrained_off_mwh: 220,
      description: null,
    },
    {
      grain: "self_reporting_plant",
      entity_label: "UEE ARARIPE III",
      reason: "REL",
      origin: "LOC",
      constrained_off_mwh: 9000,
      description: null,
    },
  ],
};

/** Every card window in this fixture, so the folds cannot disagree by accident. */
const CARD_WINDOW = { start: "2024-04-01", end: "2026-08-27" };

/**
 * `GET /v1/model/card?lane=` — the reliability curve on Explain.
 *
 * Hand-written in the wire's own `snake_case` for the reason this file exists:
 * `packages/core/src/wire.ts` owns the only rename table, and a fixture written
 * in `camelCase` would be a body the real client has never seen. The eight
 * groups are all required — a card missing one is not a partially valid card,
 * and `apps/api/src/api/model-card.ts` refuses it — so they are all here.
 *
 * The reliability points are the shape a calibrated classifier actually has:
 * `mean_predicted` tracks `observed_frequency` within a few points, with the
 * top bin thinner than the rest and marked `merged`, which is what the curve is
 * drawn to show.
 */
const MODEL_CARD = {
  lane: "dessem_free_v1__gate_late__thr5",
  lane_state: "promoted",
  artifact: {
    artifact_id: "2026-09-11T03:11:07Z",
    created_at: "2026-09-11T03:44:02Z",
    estimator_family: "lightgbm",
    model_config_version: "hurdle-v0.4",
    feature_set: "ws-curtail",
    feature_set_version: "2026.09.1",
    gate_profile: "gate_late",
    threshold_mw: THRESHOLD_MW,
    feature_hash: "f4c1a9e2b7d05386",
    git_sha_ml: "0ac31d9",
    git_sha_api: "0ac31d9",
  },
  fold: {
    fold_id: "2026Q3",
    fold_hash: "9b2e71c4",
    rules_digest: "3f8a01de",
  },
  windows: {
    training: { start: "2024-04-01", end: "2026-05-31" },
    base_fit: { start: "2024-04-01", end: "2026-04-30" },
    calibration: { start: "2026-05-01", end: "2026-05-31" },
    test: { start: "2026-06-01", end: "2026-08-27" },
    rows_by_vintage_fidelity: { point_in_time: 1843, revision_optimistic: 17_206 },
  },
  reliability: {
    points: [
      {
        bin_lower: 0,
        bin_upper: 0.2,
        bin_centre: 0.1,
        mean_predicted: 0.08,
        observed_frequency: 0.07,
        hour_count: 6120,
        merged: false,
      },
      {
        bin_lower: 0.2,
        bin_upper: 0.4,
        bin_centre: 0.3,
        mean_predicted: 0.29,
        observed_frequency: 0.32,
        hour_count: 2980,
        merged: false,
      },
      {
        bin_lower: 0.4,
        bin_upper: 0.6,
        bin_centre: 0.5,
        mean_predicted: 0.5,
        observed_frequency: 0.47,
        hour_count: 1760,
        merged: false,
      },
      {
        bin_lower: 0.6,
        bin_upper: 0.8,
        bin_centre: 0.7,
        mean_predicted: 0.69,
        observed_frequency: 0.73,
        hour_count: 1145,
        merged: false,
      },
      {
        bin_lower: 0.8,
        bin_upper: 1,
        bin_centre: 0.9,
        mean_predicted: 0.88,
        observed_frequency: 0.84,
        hour_count: 612,
        merged: true,
      },
    ],
    sample_hours: 12_617,
    window: CARD_WINDOW,
    vintage_fidelity: "revision_optimistic",
    folds: ["2026Q3"],
    excluded_calibration_hours: 744,
    ece: 0.021,
    mce: 0.043,
    top_bin_gap: 0.04,
  },
  risk_bins: { low: [0, 0.25], elevated: [0.25, 0.66], high: [0.66, 1] },
  band: {
    correction_regime: "spread_normalised",
    delta_lo: 0.184,
    delta_hi: 0.212,
    method: "split_conformal",
    miscoverage: 0.1,
    target_coverage: 0.9,
    calibration_rows: 3487,
    rank: 3140,
    window: { start: "2026-05-01", end: "2026-05-31" },
    guarantee: "marginal",
    /*
      Measured, and shaped as production's is.

      This was `null` with "coverage is written by the gate, not by the fit" —
      true of the *fit* and no longer true of the card, which now carries what
      the gate wrote. A fixture that modelled a card predating the group left
      the one screen showing coverage asserting only its absence.

      `nominal_claim: true` with both marginals inside the guardrail is the
      case a reader meets; the withheld branch is driven by this flag and a
      fixture cannot hold both at once.
    */
    coverage: {
      fold_id: "F6",
      population: "curtailed_hours",
      rows: 3541,
      target: 0.9,
      guardrail: [0.85, 0.97],
      guardrail_satisfied: true,
      nominal_claim: true,
      claim_note: "Auditor prose. Never rendered — asserted by the spec below.",
      lower: { coverage_p10: 0.9548, coverage_p10_where_stated: 0.8836 },
      upper: { coverage_p90: 0.9189, coverage_p90_where_stated: 0.9255 },
      p50_unbiasedness: 0.5082,
      crossing_rate: 0,
    },
    coverage_absent_reason: null,
  },
  ensemble: {
    ensemble_draws: 500,
    pit_rows: 11_904,
    pit_dropped_days: 6,
    pit_columns: 24,
    pit_window: { start: "2026-06-01", end: "2026-08-27" },
    pit_dropped_days_rule: "a day with any missing hour is dropped whole",
    pit_max_ks: 0.011,
    pit_ks_tolerance: 0.0125,
    pit_uniform_within_tolerance: true,
    day_grain: null,
    day_grain_absent_reason: "Day-grain coverage is a gate measurement.",
  },
  metrics: null,
  metrics_absent_reason: "No metrics group on this card.",
  decision: null,
  card_url: "/v1/model/card.json?lane=dessem_free_v1__gate_late__thr5",
};

/**
 * The spec's own published bodies, read rather than restated.
 *
 * `packages/core/fixtures/spec-examples/` is the set `spec-examples.test.ts`
 * validates against the schema on every run, so these two are wire-correct by
 * construction and cannot drift from the contract without that suite failing
 * first. Writing a second copy here would be a second thing to keep in step.
 */
const SPEC_EXAMPLES = join(
  // `process.cwd()`, not `import.meta.dir`: Playwright transpiles this file to
  // CommonJS, where `import.meta` is a syntax error, and the runner already
  // starts in `apps/web`. `bun` reads it from there too.
  process.cwd(),
  "..",
  "..",
  "packages",
  "core",
  "fixtures",
  "spec-examples",
);

function specExample(file: string): unknown {
  return JSON.parse(readFileSync(join(SPEC_EXAMPLES, file), "utf8"));
}

const DIAGNOSIS_DAY_AHEAD = specExample("05-diagnosis-day-ahead.json");
const OPTIMIZATION_RESULT = specExample("11-optimization-result.json");
/*
  **The Time Machine's own read, which nothing was stubbing.**

  Without it `/v1/replay` 404s and the screen renders its refusal, so every
  spec that opened the Time Machine was asserting the *absence* of a replay
  while believing it had one. The whole `Replayed` branch — the accuracy panel,
  the floor, the avoidability, the plan against the executed — had no browser
  coverage at all.

  The spec example is the same one `packages/core` validates the contract
  against, so its band (402–548–731) and its settlement (612) are the
  contract's numbers rather than numbers invented here: a day that settled
  inside its band, which is the case the accuracy panel's `inside` placement
  is about.
*/
const REPLAY = specExample("12-replay.json");

/** The three reads that need no model, by the pathname they are served at. */
const OBSERVED_BY_PATH: Record<string, unknown> = {
  "/v1/grid/now": GRID_NOW,
  "/v1/curtailment/hours": CURTAILMENT_HOURS,
  "/v1/curtailment/episodes": CURTAILMENT_EPISODES,
  "/v1/curtailment/reasons": CURTAILMENT_REASONS,
};

/** The two reads a promoted artifact is a precondition for. */
const FORECAST_BY_PATH: Record<string, unknown> = {
  "/v1/grid/outlook": GRID_OUTLOOK,
  "/v1/forecast/day-ahead": FORECAST_DAY_AHEAD,
  "/v1/model/card": MODEL_CARD,
  "/v1/diagnosis/day-ahead": DIAGNOSIS_DAY_AHEAD,
  "/v1/optimize": OPTIMIZATION_RESULT,
  "/v1/replay": REPLAY,
};

/**
 * Stub the gateway for one page, in one of the screen's two honest states.
 *
 * `forecast: true` drives `read`; `forecast: false` drives `observedOnly` — the
 * three observed reads still answer 200 and the two forecast reads refuse,
 * which is the split `use-network.ts` is built around and the state production
 * is in today.
 *
 * **Matched on pathname, never on the whole URL.** The query strings are the
 * client's business — `use-network.ts` derives the settled day, a fortnight
 * window and an exclusive two-UTC-day range, and `ApiClient` drops `undefined`
 * values — so a matcher that named them would break the day any of those
 * change, and would be asserting the client's arithmetic in the wrong place. A
 * spec that wants to assert the query reads it off `route.request()`.
 *
 * The origin is `http://localhost:3000`, which is `API_URL`'s default in
 * `apps/web/src/lib/config.ts` when neither the runtime override nor
 * `EXPO_PUBLIC_API_URL` is set.
 */
export async function routeGateway(
  page: Page,
  {
    forecast,
    /**
     * Serve a settled day that had restrictions on it.
     *
     * Off by default so every existing spec keeps the empty day it was written
     * against — that is the common state and the one Explain must draw.
     */
    reasons = false,
  }: { forecast: boolean; reasons?: boolean },
): Promise<void> {
  await page.route("http://localhost:3000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (reasons && path === "/v1/curtailment/reasons") {
      await route.fulfill({ json: CURTAILMENT_REASONS_WITH_ROWS });
      return;
    }
    if (path === "/v1/curtailment/evidence") {
      // Empty unless the day had restrictions: a citation annotates a reason,
      // and `firstCitation` treats an empty list as "no citation" rather than
      // as a failure, which is the case most days are.
      await route.fulfill({
        json: reasons ? CURTAILMENT_EVIDENCE : { ...CURTAILMENT_EVIDENCE, rows: [] },
      });
      return;
    }
    const observed = OBSERVED_BY_PATH[path];
    if (observed !== undefined) {
      await route.fulfill({ json: observed });
      return;
    }
    const forecastBody = FORECAST_BY_PATH[path];
    if (forecastBody !== undefined) {
      await route.fulfill(
        forecast
          ? { json: forecastBody }
          : { status: FORECAST_REFUSAL_STATUS, json: FORECAST_REFUSAL },
      );
      return;
    }
    await route.fulfill({ status: 404, json: ROUTE_NOT_FOUND });
  });
}
