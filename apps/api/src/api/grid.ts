import type {
  GridNow,
  GridOutlook,
  RiskClass,
  SubsystemOutlook,
} from "@wattsteer/core/api";
import { SUBSYSTEMS, subsystemMeta } from "@wattsteer/core/constants";
import { weatherRunLabel } from "@wattsteer/core/schedule";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import type { GridNowObservation } from "../contract/grid-now.js";
import { readGridNow } from "../contract/grid-now.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { CodedError } from "../errors.js";
import { gateAt } from "../forecast/gate.js";
import type { ForecastDayRow, ForecastNationalDayRow } from "../forecast/reads.js";
import { readGridOutlook } from "../forecast/reads.js";
import { riskClass } from "../forecast/risk-class.js";
import {
  instant,
  gateProfile as parseGateProfile,
  targetDate as parseTargetDate,
} from "./params.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

/**
 * `GET /v1/grid/now` — the observed "right now".
 *
 * **The endpoint that needs no model**, which is exactly why it ships first. It
 * resolves entirely from Postgres, through the canonical curtailment view, and
 * touches nothing the modelling service owns: with `apps/ml` returning 503 for
 * everything and with no promoted artifact in any lane, this route still
 * answers 200 with real numbers. That is `docs/specs/api-surface.md`'s
 * degradation table, and for this route it is a property of the dependency
 * graph rather than a fallback path someone has to remember to write.
 *
 * Three shaping decisions live here and nowhere else:
 *
 * - **`ons_display_name` comes from `SUBSYSTEMS`**, the published constant, and
 *   never from a row. There is no `GET /v1/subsystems` on purpose — an endpoint
 *   would invite a fifth member of a four-member enum — so the display name is
 *   read from the same constant the web app and `apps/ml` read.
 * - **The wire form is produced by `@wattsteer/core`'s translator**, given the
 *   schema's shape name. Not by this file, and not by `contract/wire.ts`: that
 *   one derives `snake_case` from `camelCase` by rule, and the rule is lossy on
 *   exactly the field this payload leads with —
 *   `last24hConstrainedOffMwh` derives to `last24h_constrained_off_mwh`, and
 *   the contract says `last_24h_constrained_off_mwh`. The generated table gets
 *   it right because the schema, not a regular expression, is the authority.
 * - **The response is typed as the generated `GridNow`**, so a field renamed in
 *   `grid-now.schema.json` breaks this compile rather than a screen.
 *
 * The route is built by a factory over its database, as `ingest-health.ts` is,
 * so the whole path — axes, view, shaping, headers — can be asserted against a
 * real Postgres rather than only the read underneath it.
 */

/**
 * The wire body, built field by field against the generated interface.
 *
 * Field by field rather than by handing the whole observation to the encoder:
 * the encoder carries an unrecognised key through unrenamed by design, and the
 * schema is `additionalProperties: false`, so `window` and `latestIngestedAt` —
 * which are the read's business and not the readout's — would be a contract
 * violation discovered by a validator instead of by a compiler.
 */
function toGridNow(observation: GridNowObservation): GridNow {
  return {
    asOf: observation.asOf.toISOString(),
    latestSettledHour: observation.latestSettledHour.toISOString(),
    lagHours: observation.lagHours,
    vintageFidelity: observation.vintageFidelity,
    subsystems: observation.subsystems.map((entry) => ({
      subsystem: entry.subsystem,
      onsDisplayName: subsystemMeta(entry.subsystem).onsDisplayName,
      last24hConstrainedOffMwh: entry.last24hConstrainedOffMwh,
      latestHourConstrainedOffMwh: entry.latestHourConstrainedOffMwh,
      split: entry.split,
    })),
    national: observation.national,
  };
}

/**
 * `GET /v1/grid/outlook` — the one call the hero and the Overview both make.
 *
 * ### The national figure, which is the point of this route
 *
 * The hero originally rendered a national band whose P50 was the componentwise
 * sum of four subsystem P50s. **Medians do not add.** The median of a sum is
 * the sum of the medians only when the components are comonotone, and four
 * subsystems' curtailment is not — which is precisely the assumption every
 * other number on this page refuses to make. So the national figure here is:
 *
 * - `expected_mwh` — the sum of the four `day_expected_mwh`. Expectations add
 *   **exactly**, with no independence and no comonotonicity assumed, and this
 *   is the only additive forecast quantity in the domain.
 * - `risk_class_counts` — a count of the four subsystems per class, which is a
 *   count and not a statistic, so nothing about it needs a joint distribution.
 * - `band` — **read from the persisted national row**, or `null` with
 *   `band_unavailable_reason: "no_joint_ensemble"` when there is not one. The
 *   schema makes a null band without a stated reason unrepresentable, so the
 *   absence is a fact the screen renders rather than a blank it interprets.
 *
 * **There is still no arithmetic here that could produce a national band.** The
 * one reduction in this file adds expectations, and `p10`/`p50`/`p90` never
 * enter it. The band comes off `curtailment_forecast_national_day`, which
 * `apps/ml`'s `training/national.py` (forecaster ticket 08) computed by adding
 * four day totals **on the same draw** — peak-of-sum rather than sum-of-peaks —
 * and which forecaster ticket 22 gave a row grain of its own, because `SIN` is
 * not a subsystem and a fifth row of the subsystem table is the shape
 * `docs/domain-model.md`'s vocabulary rule 6 forbids. Measured, that band is
 * roughly half the width of the componentwise sum, which is what a real joint
 * distribution buys over an assumption of comonotonicity.
 *
 * **The `null` branch stays, and is not dead code.** An artifact trained before
 * the shared draw index landed publishes no national row, and a day whose four
 * subsystem rows disagree about the threshold has no single national key to
 * read. Both are absences with a stated reason. Synthesising a band by summing
 * the four subsystems' quantiles is the defect this whole thread exists to
 * remove, and it is not available from this file's data either way.
 *
 * ### Two run labels, because they are two facts
 *
 * `forecast_origin.run_label` is the **artifact** version, and
 * `weather_run_label` is the weather run the forecast was built on — the "D−1
 * 12Z" the screen prints. Both are on the payload, derived from the gate table,
 * so no screen has to choose which of the two to call "the run".
 */

/** The four subsystems in the published order, so the payload is stable. */
const SUBSYSTEM_ORDER: readonly string[] = SUBSYSTEMS.map((entry) => entry.code);

/**
 * The one origin the four rows share, or a refusal.
 *
 * A publication is one lane-day: the modelling service emits all four
 * subsystems under one artifact, at one gate instant, against one threshold and
 * one set of risk bins, and `writePublication` stores them in one transaction.
 * Four rows that disagree are therefore not a state this route may average or
 * pick a winner from — it is two publications overlapping, and picking one
 * would put a band from one artifact beside a band from another under a single
 * origin the reader would take as covering both.
 */
function sharedOrigin(rows: ForecastDayRow[], targetDate: string) {
  const [first] = rows;
  if (first === undefined) {
    throw new RangeError("sharedOrigin needs at least one row");
  }
  const disagreeing = rows.filter(
    (row) =>
      row.artifactId !== first.artifactId ||
      row.publishedAt.getTime() !== first.publishedAt.getTime() ||
      row.thresholdMw !== first.thresholdMw ||
      row.riskBinElevatedFrom !== first.riskBinElevatedFrom ||
      row.riskBinHighFrom !== first.riskBinHighFrom,
  );
  if (disagreeing.length > 0) {
    throw new CodedError(
      "FORECAST_UNAVAILABLE",
      `The four subsystems published for ${targetDate} do not share one origin, ` +
        "so there is no single forecast origin this readout could name.",
      {
        details: {
          target_date: targetDate,
          artifact_ids: [...new Set(rows.map((row) => row.artifactId))].join(", "),
        },
      },
    );
  }
  return first;
}

/**
 * The wire body, built field by field against the generated interface.
 *
 * Field by field for the reason `toGridNow` is: the schema is
 * `additionalProperties: false`, and the fields these rows carry that the
 * contract does not — the data version, the correction regime, the feature set,
 * `hours_p50_nonzero` — stop at this boundary and are caught by a compiler
 * rather than a validator.
 */
export function toGridOutlook(
  rows: ForecastDayRow[],
  now: Date,
  national: ForecastNationalDayRow | null = null,
): GridOutlook {
  const ordered = [...rows].sort(
    (a, b) => SUBSYSTEM_ORDER.indexOf(a.subsystem) - SUBSYSTEM_ORDER.indexOf(b.subsystem),
  );
  const [first] = ordered;
  if (first === undefined) {
    throw new RangeError("toGridOutlook needs the four published rows");
  }
  const ageHours =
    Math.round(
      Math.max(0, (now.getTime() - first.publishedAt.getTime()) / HOUR_MS) * 10,
    ) / 10;

  const subsystems: SubsystemOutlook[] = ordered.map((row) => ({
    subsystem: row.subsystem,
    onsDisplayName: subsystemMeta(row.subsystem).onsDisplayName,
    dayOccurrenceProbability: row.dayOccurrenceProbability,
    riskClass: riskClass(
      row.dayOccurrenceProbability,
      row.riskBinElevatedFrom,
      row.riskBinHighFrom,
    ),
    // Straight off the day-grain row: path-ensemble quantiles, never a
    // reduction of hours this route does not even read.
    dayEnergyMwh: row.dayTotalMwh,
    peakPowerMw: row.peakPowerMw,
    dayExpectedMwh: row.dayExpectedMwh,
    split: { windMwh: row.split.windMwh, solarMwh: row.split.solarMwh },
  }));

  // The one sum on this route, and it is over expectations. `p10`, `p50` and
  // `p90` are not in scope of this reduction and there is nowhere else in this
  // file they could be added.
  const expectedMwh = subsystems.reduce(
    (total, entry) => total + entry.dayExpectedMwh,
    0,
  );
  const counts: Record<RiskClass, number> = { low: 0, elevated: 0, high: 0 };
  for (const entry of subsystems) {
    counts[entry.riskClass] += 1;
  }

  return {
    targetDate: first.targetDate,
    thresholdMw: first.thresholdMw,
    forecastOrigin: {
      producer: "wattsteer",
      runLabel: first.artifactId,
      publishedAt: first.publishedAt.toISOString(),
      ageHours,
      originKind: "served",
      gateProfile: first.gateProfile,
      // The other fact: the artifact version above named what WattSteer ran,
      // this names the weather run it ran on.
      weatherRunLabel: weatherRunLabel(first.gateProfile),
    },
    vintageFidelity: "point_in_time",
    riskBins: {
      low: [0, first.riskBinElevatedFrom],
      elevated: [first.riskBinElevatedFrom, first.riskBinHighFrom],
      high: [first.riskBinHighFrom, 1],
    },
    subsystems,
    national: {
      // Still the *summed expectation*, and still not a mean over the draws:
      // `E[Y]` adds exactly, so a Monte-Carlo estimate of it would turn a fact
      // into an estimate. The national row carries the same figure; this one
      // is read off the four so it cannot disagree with the array above it.
      expectedMwh,
      riskClassCounts: counts,
      // The persisted national row, or an absence with its reason. Both
      // branches stay: an artifact trained before the shared draw index landed
      // published no national row, and that is not a zero and not a band this
      // file could assemble — there is still no arithmetic here that could.
      band: national === null ? null : { ...national.dayTotalMwh },
      bandUnavailableReason: national === null ? "no_joint_ensemble" : null,
    },
  };
}

const HOUR_MS = 3_600_000;

export function createGridRoutes(deps: { db: Database | undefined; now?: () => Date }) {
  return new Elysia({ name: "grid" })
    .get(
      "/v1/grid/now",
      async ({ query, set, request }) => {
        if (!deps.db) {
          throw new CodedError("DATA_UNAVAILABLE", "Persistence is not configured");
        }

        // `as_of` defaults to the request instant, which the canonical reads
        // refuse to do and this route must. `/v1/canonical/*` is the modelling
        // surface, where a forgotten axis silently turns a backtest into a
        // latest-version read; this is a landing page, which cannot be asked to
        // name a vintage cut before it may see a number. The honesty the default
        // would have cost is paid on the response instead: `as_of` is *on* the
        // payload, beside the lag, so what the reader is holding is stated
        // rather than assumed.
        const asOf =
          query.as_of === undefined ? new Date() : instant("as_of", query.as_of);
        const observation = await readGridNow(deps.db, { asOf });

        if (observation === null) {
          // No hour is settled in all four subsystems at this cut. An absence,
          // and answered as one: the alternative is four zeroes under an invented
          // hour, which reads as "no curtailment anywhere" — a different and much
          // worse statement than "we have not settled an hour yet".
          throw new CodedError(
            "DATA_UNAVAILABLE",
            "No hour is settled in all four subsystems at this as-of",
            { details: { as_of: asOf.toISOString() } },
          );
        }

        // `api-surface.md`'s caching rule, applied through the one place it
        // lives: a cache key is a provenance, never a duration. This response
        // moves with ingestion, which is hourly at best, so the validator is
        // the freshest ingestion instant behind it and the `max-age` is short
        // enough that the clock is never what makes it right.
        if (
          applyCachePolicy({ set, request }, CACHE_POLICIES.now, [
            observation.latestIngestedAt,
          ])
        ) {
          return null;
        }

        return encodeWire("GridNow", toGridNow(observation));
      },
      {
        query: t.Object({
          as_of: t.Optional(
            t.String({
              description:
                "Vintage cut (ISO-8601). Defaults to now — this is the observed " +
                "readout, and the cut it was read at is on the response.",
            }),
          ),
        }),
        detail: {
          summary: "The observed right-now readout",
          description:
            "Latest settled hour, the lag, the four subsystems' observed " +
            "constrained-off over the last 24 hours and in the latest hour with " +
            "their scalar technology splits, and the national total with its " +
            "derivation named. Observed, not forecast: it needs no model and is " +
            "served with the modelling service unreachable.",
        },
      },
    )
    .get(
      "/v1/grid/outlook",
      async ({ query, set, request }) => {
        const now = deps.now?.() ?? new Date();
        // The axes are parsed before anything is read, and by `params.ts` —
        // the same two parsers `/v1/forecast/day-ahead` uses, so the hero and
        // the detail view cannot disagree about which day "tomorrow" is.
        const gateProfile = parseGateProfile(query.gate_profile);
        const targetDate = parseTargetDate(query.target_date, now);

        if (!deps.db) {
          throw new CodedError("DATA_UNAVAILABLE", "Persistence is not configured", {
            retryAfterSec: 30,
          });
        }

        // One read, one transaction, one `AsOf`: the national row cannot be a
        // vintage away from the four subsystems it was summed over.
        const { subsystems: rows, national } = await readGridOutlook(deps.db, {
          targetDate,
          gateProfile,
          asOf: now,
        });

        if (rows.length < SUBSYSTEM_ORDER.length) {
          const gate = gateAt(targetDate, gateProfile);
          if (rows.length === 0 && gate.getTime() > now.getTime()) {
            // Not an error state on screen: the gate is a fact about the target
            // date, so "tomorrow's view publishes at 19:00 BRT" is data.
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
          // A partial publication is an absence, and answered as one. The
          // alternative — three subsystems and a fourth zeroed to keep the
          // array at four — reads as "no curtailment in the north", which is a
          // statement about the grid rather than about the publication.
          const present = new Set(rows.map((row) => row.subsystem));
          throw new CodedError(
            "FORECAST_UNAVAILABLE",
            `No complete outlook was published for ${targetDate} at the ` +
              `${gateProfile} gate, whose instant ${gate.toISOString()} has passed. ` +
              "See /v1/meta for the artifact lane state.",
            {
              details: {
                target_date: targetDate,
                gate_profile: gateProfile,
                gate_at: gate.toISOString(),
                missing: SUBSYSTEM_ORDER.filter(
                  (code) => !present.has(code as never),
                ).join(", "),
              },
            },
          );
        }

        const origin = sharedOrigin(rows, targetDate);
        // A national band from one artifact beside four subsystem bands from
        // another would be read as covering them. It is not a state to average
        // or to prefer one side of, so the band is dropped back to its stated
        // absence rather than published under an origin it does not have.
        const joint =
          national !== null &&
          national.artifactId === origin.artifactId &&
          national.publishedAt.getTime() === origin.publishedAt.getTime()
            ? national
            : null;

        // `api-surface.md`'s caching table, verbatim: the validator is the
        // provenance — artifact, publication instant, newest version behind the
        // four rows — so a superseding 12Z run changes the ETag by construction
        // rather than by a TTL expiring. The `max-age` never crosses the next
        // gate, which is what makes serving a stale copy for five minutes safe.
        const maxVersion = [...rows, ...(joint ? [joint] : [])].reduce(
          (high, row) => Math.max(high, row.dataVersion),
          0,
        );
        if (
          applyCachePolicy({ set, request }, CACHE_POLICIES.forecast, [
            origin.artifactId,
            origin.publishedAt,
            maxVersion,
          ])
        ) {
          return null;
        }

        return encodeWire("GridOutlook", toGridOutlook(rows, now, joint));
      },
      {
        query: t.Object({
          target_date: t.Optional(
            t.String({
              description:
                "The civil day being forecast, in America/Sao_Paulo. Defaults " +
                "to tomorrow.",
            }),
          ),
          gate_profile: t.Optional(
            t.String({ description: "gate_early or gate_late. Defaults to gate_late." }),
          ),
        }),
        detail: {
          summary: "Four subsystems' day-ahead outlook, in one request",
          description:
            "The landing hero and the Overview's first paint, as one call: the " +
            "risk class and the bins it was read off, the day energy and " +
            "peak-power bands from the persisted path-ensemble row, the " +
            "expectation and its scalar split, the forecast origin with the " +
            "weather run beside the artifact version, and a national figure. " +
            "The national figure is the summed expectation — expectations add " +
            "exactly — plus a count of subsystems per risk class and the joint " +
            "band from the persisted national day row, whose quantiles are " +
            "taken over the four subsystems' paths added draw by draw. Where " +
            "no national row was published the band is null and carries the " +
            "reason. No hourly detail and no drivers: those are the day-ahead " +
            "and diagnosis routes.",
        },
      },
    );
}

/** The wired routes, over the process-wide handle. */
export const gridRoutes = createGridRoutes({ db: database?.db });
