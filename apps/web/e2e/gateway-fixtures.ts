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

/** The three reads that need no model, by the pathname they are served at. */
const OBSERVED_BY_PATH: Record<string, unknown> = {
  "/v1/grid/now": GRID_NOW,
  "/v1/curtailment/hours": CURTAILMENT_HOURS,
  "/v1/curtailment/episodes": CURTAILMENT_EPISODES,
};

/** The two reads a promoted artifact is a precondition for. */
const FORECAST_BY_PATH: Record<string, unknown> = {
  "/v1/grid/outlook": GRID_OUTLOOK,
  "/v1/forecast/day-ahead": FORECAST_DAY_AHEAD,
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
  { forecast }: { forecast: boolean },
): Promise<void> {
  await page.route("http://localhost:3000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
