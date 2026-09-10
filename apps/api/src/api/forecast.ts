import type { ForecastDayAhead } from "@wattsteer/core/api";
import { SUBSYSTEMS, subsystemMeta } from "@wattsteer/core/constants";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { CodedError } from "../errors.js";
import { gateAt } from "../forecast/gate.js";
import { type PublishedForecast, readForecastDayAhead } from "../forecast/reads.js";
import { riskClass } from "../forecast/risk-class.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import {
  gateProfile as parseGateProfile,
  targetDate as parseTargetDate,
} from "./params.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

/**
 * `GET /v1/forecast/day-ahead?subsystem=&target_date=&gate_profile=`.
 *
 * **The forecast is a row a schedule wrote, not an inference a page view
 * triggered.** This route resolves entirely from Postgres: with
 * `WATTSTEER_ML_URL` unset and the modelling service gone, it still answers 200
 * from the last publication, carrying that publication's real age. That is
 * `docs/specs/api-surface.md`'s boundary decision, and for this route it is a
 * property of the dependency graph rather than a fallback anyone has to
 * remember — there is no import of `ml-proxy.js` in this file and there is
 * nothing for one to do.
 *
 * ### The five decisions inside the shape
 *
 * 1. **`day_energy_mwh` and `peak_power_mw` are read from the persisted
 *    day-grain row**, never computed from `hours`. They are path-ensemble
 *    quantiles; quantiles do not add. `reads.ts` has no aggregate that could
 *    produce them, so the prohibition is structural rather than remembered.
 * 2. **`expected_mwh` appears at both grains and is never inside the band.**
 *    For a mixture it exceeds the P50 whenever `p < 0.5`, so publishing it as a
 *    sibling is not a layout preference — it is the forecaster's rule made
 *    structural by the field list.
 * 3. **`split` is two scalars at both grains**, and it splits the
 *    expectation: `wind_mwh + solar_mwh == expected_mwh`. There is no split
 *    band, and `common.schema.json` rejects an object carrying a `p10` under a
 *    split.
 * 4. **`origin_kind = 'served'` is filtered in the query**, unconditionally,
 *    inside `reads.ts`. No parameter reaches it, so a `backfilled_holdout` row
 *    cannot leave this route under any query — including one naming its
 *    counterfactual publication instant exactly.
 * 5. **`age_hours` is derived and returned**, because "is this stale?" is a
 *    question every screen asks and none of them should answer by differencing
 *    against a clock the server has and the client may not.
 *
 * ### The absence states, and which of them this route can say
 *
 * `docs/specs/api-surface.md` names four, and they are four different
 * sentences. Three of them are decided here, from the schedule and the rows:
 *
 * - **Not yet published** — the gate for this target date has not passed:
 *   `FORECAST_NOT_YET_PUBLISHED`, 404. Not an error on screen; the Overview
 *   shows today's forecast beside the next publication instant, which it reads
 *   from `/v1/meta` so the sentence is data.
 * - **Stale** — rows from an earlier gate or an earlier day: a **200**, with
 *   `forecast_origin.age_hours` and `gate_profile` on it. Nothing is hidden and
 *   nothing is refused; a forecast from this morning is a real forecast.
 * - **The gateway or the database is down** — `DATA_UNAVAILABLE`, 503.
 *
 * The fourth — **no promoted artifact** — is not decidable here, and saying so
 * is more honest than guessing. Which lane state holds is a fact about the
 * artifact volume, which is mounted into the modelling service; this route
 * reaching for it would be the per-request crossing the boundary decision
 * closed. It is reported in two places that can know it: the publication route
 * on the modelling service refuses with `MODEL_UNAVAILABLE` and the lane state
 * in its details, and `/v1/meta` carries `model.lanes[].state` for the screens.
 * When the gate has passed and no rows exist, this route answers
 * `FORECAST_UNAVAILABLE` — the spec's own words for it: "the gate passed and no
 * rows exist — a publication failure" — which is true whether the publication
 * failed because nothing was promoted or because the job never ran.
 */

/**
 * `target_date` and `gate_profile` are parsed by `params.ts`, not here.
 *
 * They are the same two axes `/v1/grid/outlook` takes, defaulted the same way
 * and refused with the same codes — so they are parsed once. A second copy is
 * how the hero and the detail view would come to disagree about which day
 * "tomorrow" is.
 */

const HOUR_MS = 3_600_000;

const SUBSYSTEM_MEMBERS: ReadonlySet<string> = new Set(
  SUBSYSTEMS.map((entry) => entry.code),
);

function parseSubsystem(raw: string): SubsystemCode {
  if (!SUBSYSTEM_MEMBERS.has(raw)) {
    throw new CodedError(
      "SUBSYSTEM_UNKNOWN",
      `"${raw}" is not one of the four subsystems (${[...SUBSYSTEM_MEMBERS].join(", ")})`,
      { details: { subsystem: raw } },
    );
  }
  return raw as SubsystemCode;
}

/**
 * The wire body, built field by field against the generated interface.
 *
 * Field by field for the reason `grid.ts` and `meta.ts` are: the schema is
 * `additionalProperties: false`, so a key the payload has no business carrying
 * is a contract violation found by a compiler here rather than by a validator
 * in production. The fields this read holds and the contract does not — the
 * data version, the correction regime, the P50 split — stop at this boundary.
 */
export function toForecastDayAhead(
  published: PublishedForecast,
  now: Date,
): ForecastDayAhead {
  const { day, hours } = published;
  const ageHours =
    Math.round(Math.max(0, (now.getTime() - day.publishedAt.getTime()) / HOUR_MS) * 10) /
    10;
  return {
    subsystem: day.subsystem,
    onsDisplayName: subsystemMeta(day.subsystem).onsDisplayName,
    targetDate: day.targetDate,
    thresholdMw: day.thresholdMw,
    forecastOrigin: {
      producer: "wattsteer",
      runLabel: day.artifactId,
      publishedAt: day.publishedAt.toISOString(),
      ageHours,
      originKind: "served",
      gateProfile: day.gateProfile,
    },
    vintageFidelity: published.vintageFidelity,
    artifact: {
      artifactId: day.artifactId,
      featureSet: day.featureSet,
      trainedThrough: day.trainedThrough,
    },
    riskBins: {
      low: [0, day.riskBinElevatedFrom],
      elevated: [day.riskBinElevatedFrom, day.riskBinHighFrom],
      high: [day.riskBinHighFrom, 1],
    },
    dayOccurrenceProbability: day.dayOccurrenceProbability,
    riskClass: riskClass(
      day.dayOccurrenceProbability,
      day.riskBinElevatedFrom,
      day.riskBinHighFrom,
    ),
    // Straight off the day-grain row. Not a reduction of `hours`, and there is
    // nothing in this file that could make one.
    dayEnergyMwh: day.dayTotalMwh,
    peakPowerMw: day.peakPowerMw,
    dayExpectedMwh: day.dayExpectedMwh,
    split: { windMwh: day.split.windMwh, solarMwh: day.split.solarMwh },
    hoursP50Nonzero: day.hoursP50Nonzero,
    hours: hours.map((hour) => ({
      validTime: hour.validTime.toISOString(),
      hourLocal: hour.localHour,
      constrainedOffMwh: hour.band,
      expectedMwh: hour.expectedMwh,
      occurrenceProbability: hour.occurrenceProbability,
      split: { windMwh: hour.split.windMwh, solarMwh: hour.split.solarMwh },
    })),
  };
}

export function createForecastRoutes(deps: {
  db: Database | undefined;
  now?: () => Date;
}) {
  return new Elysia({ name: "forecast" }).get(
    "/v1/forecast/day-ahead",
    async ({ query, set, request }) => {
      const now = deps.now?.() ?? new Date();
      const subsystem = parseSubsystem(query.subsystem);
      const gateProfile = parseGateProfile(query.gate_profile);
      const targetDate = parseTargetDate(query.target_date, now);

      if (!deps.db) {
        throw new CodedError("DATA_UNAVAILABLE", "Persistence is not configured", {
          retryAfterSec: 30,
        });
      }

      const published = await readForecastDayAhead(deps.db, {
        subsystem,
        targetDate,
        gateProfile,
        asOf: now,
      });

      if (published === null) {
        const gate = gateAt(targetDate, gateProfile);
        if (gate.getTime() > now.getTime()) {
          // Not an error state on screen. The gate is a fact about the target
          // date, so the sentence a client builds from it — "tomorrow's view
          // publishes at 19:00 BRT" — is data rather than copy.
          throw new CodedError(
            "FORECAST_NOT_YET_PUBLISHED",
            `The ${gateProfile} gate for ${targetDate} publishes at ` +
              `${gate.toISOString()} and has not passed`,
            {
              details: {
                target_date: targetDate,
                gate_profile: gateProfile,
                publishes_at: gate.toISOString(),
              },
            },
          );
        }
        // The gate passed and nothing is stored. A publication failure, and
        // never an empty band: `/v1/meta` says whether the lane has anything to
        // serve, which is the other half of the sentence and the half this
        // route is structurally unable to know.
        throw new CodedError(
          "FORECAST_UNAVAILABLE",
          `No forecast was published for ${subsystem} on ${targetDate} at the ` +
            `${gateProfile} gate, whose instant ${gate.toISOString()} has passed. ` +
            "See /v1/meta for the artifact lane state.",
          {
            details: {
              subsystem,
              target_date: targetDate,
              gate_profile: gateProfile,
              gate_at: gate.toISOString(),
            },
          },
        );
      }

      // `api-surface.md`'s caching table, through the one place it lives: the
      // validator is the artifact, the publication instant and the row's
      // version, so a superseding `gate_late` run changes it **by
      // construction** — a different artifact published at a different instant
      // — while a re-ingest that writes no new `data_version` leaves it alone.
      //
      // It used to be the row's ingestion instant and its version, which is a
      // provenance of the *write* rather than of the publication: correct on a
      // surface where a publication is only ever written once, and a validator
      // that no longer says which artifact answered. `plugins/cache-policy.ts`
      // is where the row is now read from, so this route and
      // `/v1/grid/outlook` cannot drift apart again.
      if (
        applyCachePolicy({ set, request }, CACHE_POLICIES.forecast, [
          published.day.artifactId,
          published.day.publishedAt,
          published.day.dataVersion,
        ])
      ) {
        return null;
      }
      return encodeWire("ForecastDayAhead", toForecastDayAhead(published, now));
    },
    {
      query: t.Object({
        subsystem: t.String({
          description: "ONS subsystem code: N, NE, S or SE. There is no SIN.",
        }),
        target_date: t.Optional(
          t.String({
            description:
              "The civil day being forecast, in America/Sao_Paulo. Defaults to " +
              "tomorrow. There is no technology parameter: the forecast grain " +
              "is the subsystem and the split is a scalar.",
          }),
        ),
        gate_profile: t.Optional(
          t.String({ description: "gate_early or gate_late. Defaults to gate_late." }),
        ),
      }),
      detail: {
        summary: "The day-ahead forecast for one subsystem",
        description:
          "One subsystem, one day, one gate: the hourly band with its " +
          "expectation and scalar split, and the day energy, peak power and " +
          "day-level occurrence read from the persisted path-ensemble row — " +
          "never summed from the hours. Served from Postgres, so it survives a " +
          "modelling-service outage with its real age on the origin. Refuses " +
          "rather than inventing: 404 before the gate has passed, 404 when the " +
          "gate passed and nothing was published.",
      },
    },
  );
}

/** The wired route, over the process-wide handle. */
export const forecastRoutes = createForecastRoutes({ db: database?.db });
