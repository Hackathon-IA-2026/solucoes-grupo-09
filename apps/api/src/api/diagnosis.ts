import type { DiagnosisDayAhead, Driver, RuleFlag } from "@wattsteer/core/api";
import { SUBSYSTEMS } from "@wattsteer/core/constants";
import type { SupportedLocale } from "@wattsteer/core/errors";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import {
  type AttributionDriverRow,
  type AttributionQuery,
  buildNarrationPayload,
  type CachedNarrationDeps,
  cachedNarration,
  type InFlightResult,
  NARRATION_PROMPT_VERSION,
  narrationKeyFor,
  observedReasonsFromFlags,
  type PublishedAttributionRow,
  readAttributionDayAhead,
} from "../diagnosis/index.js";
import { CodedError } from "../errors.js";
import { gateAt } from "../forecast/gate.js";
import type { ForecastQuery, PublishedForecast } from "../forecast/reads.js";
import { readForecastDayAhead } from "../forecast/reads.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import {
  gateProfile as parseGateProfile,
  narrationLocale as parseLocale,
  targetDate as parseTargetDate,
} from "./params.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";
import { dailyCap } from "./plugins/daily-cap.js";
import { limitStore } from "./plugins/limit-store-handle.js";
import { createLockedCache } from "./plugins/locked-cache.js";

/**
 * `GET /v1/diagnosis/day-ahead?subsystem=&date=&gate_profile=&locale=`.
 *
 * **The attribution half is a row read.** No artifact is loaded, no background
 * is drawn, no Shapley game is replayed and the modelling service is not
 * called: with `WATTSTEER_ML_URL` unset this route still answers 200 from
 * Postgres alone. As on `./forecast.ts`, that is a property of the dependency
 * graph rather than a fallback anyone has to remember — there is no import of
 * `ml-proxy.js` in this file and nothing for one to do.
 *
 * ### Six decisions inside the shape
 *
 * 1. **There is no `technology` parameter**, and a request carrying one is
 *    **refused** rather than ignored. There is one attribution per
 *    subsystem-day because there is one model per subsystem-day, so a
 *    `technology=wind` that quietly returned the subsystem's ranking would
 *    answer a question nobody can ask with numbers that are not about it.
 * 2. **All eight groups are returned, ranked by `|share|`.** The `share ≥ 0.03`
 *    cut, the six-row cap and the merge into `other` are the client's. Applying
 *    them here would put the merged row's `direction: "mixed"` in two places
 *    the first time a second client appears, and would publish shares whose
 *    denominator no longer exists.
 * 3. **A withheld diagnosis is a 200.** A `withhold` rule carries the drivers
 *    **untouched**, names the rules in `withheld_by`, and puts a template
 *    narration where the model's would have been. "There is nothing to explain"
 *    is an answer, and `../diagnosis/narration-gate.ts` is where the model call
 *    is declined rather than discarded.
 * 4. **This is the only endpoint that varies by locale**, because it is the
 *    only one that returns generated prose, so it is the only one that sets
 *    `Vary` — and it sets `Accept-Language` and nothing else.
 * 5. **Two caches, and there is no third.** The attribution is a row and caches
 *    like one; the narration is cached under `docs/specs/diagnosis.md`'s exact
 *    key inside `../diagnosis/narration-cache.ts`. The HTTP layer adds no key
 *    over the composed response: that response's identity is already the pair,
 *    and a third key would have its own drift. The `ETag` is that pair written
 *    down — the row's version and the narration key — rather than a new
 *    identity anything is stored under.
 * 6. **The language model is protected by a lock and a budget, not by an IP
 *    limit.** Sixteen distinct narrations a day cannot be protected by counting
 *    requests; a thousand concurrent misses on one cold key can. The
 *    single-flight and the cap both live in `../diagnosis/narration-cache.ts`,
 *    and over the cap the answer is still a 200 whose `narration.source` says
 *    `template`.
 *
 * ### The absence states, and the one this route adds
 *
 * `../api/forecast.ts` answers three. This route answers the same three about
 * the **forecast** — a gate that has not passed, a gate that passed with
 * nothing published, a database that is unreachable — and then one of its own:
 * a forecast exists and its attribution row does not. That is
 * `DIAGNOSIS_UNAVAILABLE`, distinct from a generic 404 on purpose. "We have no
 * forecast for that day" and "we forecast that day and did not explain it" are
 * two different failures with two different owners, and a screen that got the
 * same code for both would show the same empty state for a publication gap and
 * for a diagnosis job that did not run.
 */

const HOUR_MS = 3_600_000;

/** The counter the daily cap spends against. Named so two caps never share one. */
const NARRATION_BUDGET = "narration";

const SUBSYSTEM_CODES: ReadonlySet<string> = new Set(
  SUBSYSTEMS.map((entry) => entry.code),
);

function parseSubsystem(raw: string): SubsystemCode {
  if (!SUBSYSTEM_CODES.has(raw)) {
    throw new CodedError(
      "SUBSYSTEM_UNKNOWN",
      `"${raw}" is not one of the four subsystems (${[...SUBSYSTEM_CODES].join(", ")})`,
      { details: { subsystem: raw } },
    );
  }
  return raw as SubsystemCode;
}

/**
 * The parameter this endpoint does not have, refused rather than ignored.
 *
 * Ignoring it would return the subsystem's one attribution under a name that
 * says it is wind's, which is worse than a refusal in exactly the way a
 * silently-clamped date is: the caller cannot tell from the response that the
 * question they asked was not the question answered.
 */
export function refuseTechnology(query: Record<string, unknown>): void {
  if (query.technology === undefined) {
    return;
  }
  throw new CodedError(
    "BAD_INPUT",
    "There is one attribution per subsystem-day, because there is one model " +
      "per subsystem-day, so this endpoint takes no technology parameter. " +
      "The observed panels still take one.",
    { details: { field: "technology", technology: String(query.technology) } },
  );
}

/**
 * One stored driver row on the wire.
 *
 * `hour_disagreement` is required by the schema on every driver and is stored
 * as `null` on the peak hour's rows — `../diagnosis/publication.ts` refuses to
 * write anything else there, because one hour has nothing to disagree with. So
 * the peak hour's rows carry **0**, which is the only number that is true of a
 * single hour, rather than an omission the closed schema has no room for.
 */
export function toDriver(driver: AttributionDriverRow): Driver {
  return {
    code: driver.code as Driver["code"],
    labelCode: driver.labelCode,
    phiMwh: driver.phiMwh,
    share: driver.share,
    direction: driver.direction,
    headlineFeature: driver.headlineFeature,
    // Numbers with a unit code, never a preformatted reading: the client
    // formats these through `Intl`, so the decimal separator stays the
    // reader's.
    observed: driver.observed,
    typical: driver.typical,
    unit: driver.unit as Driver["unit"],
    hourDisagreement: driver.hourDisagreement ?? 0,
    demoted: driver.demoted,
  };
}

/** One fired rule on the wire. The stored `action` is the wire's `severity`. */
function toRuleFlag(flag: PublishedAttributionRow["ruleFlags"][number]): RuleFlag {
  return {
    code: flag.code,
    severity: flag.action,
    facts: flag.facts as RuleFlag["facts"],
  };
}

/** What the composed response needs beyond the attribution row itself. */
export interface DiagnosisNarrationPart {
  narration: DiagnosisDayAhead["narration"];
  withheldBy: string[];
}

/**
 * The wire body, built field by field against the generated interface.
 *
 * Field by field for the reason `./forecast.ts` and `./grid.ts` are: the schema
 * is `additionalProperties: false`, so a key the payload has no business
 * carrying is a contract violation found by a compiler here rather than by a
 * validator in production. The fields the row holds and the contract does not —
 * the background seed, the coalition count, the resamples — stop at this
 * boundary.
 */
export function toDiagnosisDayAhead(
  attribution: PublishedAttributionRow,
  part: DiagnosisNarrationPart,
  now: Date,
): DiagnosisDayAhead {
  const ageHours =
    Math.round(
      Math.max(0, (now.getTime() - attribution.publishedAt.getTime()) / HOUR_MS) * 10,
    ) / 10;
  const observedReasonsLatest = observedReasonsFromFlags(attribution.ruleFlags);
  return {
    subsystem: attribution.subsystem,
    targetDate: attribution.targetDate,
    thresholdMw: attribution.thresholdMw,
    forecastOrigin: {
      producer: "wattsteer",
      runLabel: attribution.artifactId,
      publishedAt: attribution.publishedAt.toISOString(),
      ageHours,
      originKind: "served",
      gateProfile: attribution.gateProfile,
    },
    vintageFidelity: attribution.vintageFidelity,
    attribution: {
      target: "expected_mwh_day",
      totalAttributedMwh: attribution.totalAttributedMwh,
      sumAbsAttributedMwh: attribution.sumAbsAttributedMwh,
      stderrMwh: attribution.attributionStderrMwh,
      baselineExpectedMwh: attribution.baselineExpectedMwh,
      dayExpectedMwh: attribution.dayExpectedMwh,
      driverGroupVersion: attribution.driverGroupVersion,
      driverGroupHash: attribution.driverGroupHash,
      // All eight, in the ranking the publication wrote. Not a shortlist and
      // not re-ranked here: `rank` is what was said, and re-sorting a stored
      // ranking is how a re-read stops reproducing the row it read.
      drivers: attribution.drivers.map(toDriver),
      peakHourLocal: attribution.peakHourLocal,
      peakHourDrivers: attribution.peakHourDrivers.map(toDriver),
    },
    ruleFlags: attribution.ruleFlags.map(toRuleFlag),
    withheldBy: part.withheldBy,
    narration: part.narration,
    ...(observedReasonsLatest === undefined ? {} : { observedReasonsLatest }),
  };
}

/**
 * How the two rows are read.
 *
 * Injected, and typed as the read functions themselves, so the composed
 * response — the ranking, the withheld state, the single-flight — is provable
 * without Postgres. The round trip through the canonical `AsOf` views is
 * `database-diagnosis.test.ts`, which needs a real database and says so.
 */
export interface DiagnosisSources {
  attribution: (
    db: Database,
    query: AttributionQuery,
  ) => Promise<PublishedAttributionRow | null>;
  forecast: (db: Database, query: ForecastQuery) => Promise<PublishedForecast | null>;
}

const DEFAULT_SOURCES: DiagnosisSources = {
  attribution: readAttributionDayAhead,
  forecast: readForecastDayAhead,
};

export interface DiagnosisDeps {
  db: Database | undefined;
  now?: () => Date;
  sources?: Partial<DiagnosisSources>;
  /** The narration cache and its lock. Redis in production, a map in tests. */
  narration?: Pick<CachedNarrationDeps, "store" | "cap" | "messages"> &
    Partial<CachedNarrationDeps>;
  promptVersion?: string;
}

/**
 * The route, with everything it depends on visible in one argument.
 *
 * The in-flight map is created **once per route**, not per request. That is the
 * whole of the in-process single-flight: a map created inside the handler would
 * be a fresh map per request and would collapse nothing at all.
 */
export function createDiagnosisRoutes(deps: DiagnosisDeps) {
  const sources: DiagnosisSources = { ...DEFAULT_SOURCES, ...deps.sources };
  const promptVersion = deps.promptVersion ?? NARRATION_PROMPT_VERSION;
  const inflight = new Map<string, Promise<InFlightResult>>();
  const narrationDeps: CachedNarrationDeps = {
    ...(deps.narration ?? {}),
    store: deps.narration?.store ?? createLockedCache(config.redisUrl),
    cap:
      deps.narration?.cap ??
      dailyCap({
        name: NARRATION_BUDGET,
        limit: config.narrationDailyCap,
        store: limitStore,
      }),
    // One map for the life of the route, never one per request: a map created
    // inside the handler would collapse nothing at all.
    inflight: deps.narration?.inflight ?? inflight,
  };

  return new Elysia({ name: "diagnosis" }).get(
    "/v1/diagnosis/day-ahead",
    async ({ query, set, headers, request }) => {
      const now = deps.now?.() ?? new Date();
      refuseTechnology(query as Record<string, unknown>);
      const subsystem = parseSubsystem(query.subsystem);
      const gateProfile = parseGateProfile(query.gate_profile);
      const targetDate = parseTargetDate(query.date, now);
      const locale: SupportedLocale = parseLocale(
        query.locale,
        headers["accept-language"],
      );

      if (!deps.db) {
        throw new CodedError("DATA_UNAVAILABLE", "Persistence is not configured", {
          retryAfterSec: 30,
        });
      }

      const [attribution, forecast] = await Promise.all([
        sources.attribution(deps.db, { subsystem, targetDate, gateProfile, asOf: now }),
        sources.forecast(deps.db, { subsystem, targetDate, gateProfile, asOf: now }),
      ]);

      if (forecast === null) {
        throw noForecast(subsystem, targetDate, gateProfile, now);
      }
      if (attribution === null) {
        // The one code this route adds, and the reason it is not a generic
        // 404: the day *was* forecast, so what is missing is the explanation
        // rather than the answer, and only one of those two is a publication
        // gap somebody has to go and fix.
        throw new CodedError(
          "DIAGNOSIS_UNAVAILABLE",
          `A forecast exists for ${subsystem} on ${targetDate} at the ` +
            `${gateProfile} gate and no attribution was published beside it.`,
          {
            details: {
              subsystem,
              target_date: targetDate,
              gate_profile: gateProfile,
            },
          },
        );
      }

      const payload = buildNarrationPayload({
        attribution,
        forecast: forecast.day,
        locale,
        promptVersion,
      });
      // The pair, written down, and computed **before** the narration is
      // fetched. Not a third cache key: nothing is stored under this string —
      // it is the attribution row's version beside `diagnosis.md`'s narration
      // key, which is exactly the two identities the response already has.
      //
      // `narrationKeyFor` is the same pure function `cachedNarration` keys on,
      // so asking it first costs a digest and buys the 304 its whole point:
      // a client holding this version is answered without a cache read, a
      // lock, a counted call or a model call. Revalidation that re-ran the
      // narration path would be a 304 that cost what the 200 costs.
      const narrationKey = narrationKeyFor(payload);
      set.headers["content-language"] = locale;
      if (
        applyCachePolicy({ set, request }, CACHE_POLICIES.diagnosis, [
          attribution.ingestedAt,
          attribution.dataVersion,
          narrationKey,
        ])
      ) {
        return null;
      }

      const narration = await cachedNarration(narrationDeps, {
        payload,
        ruleFlags: attribution.ruleFlags,
        // The instant the budget is counted at, so the cap's civil day is the
        // request's day and not the process clock's.
        now: now.getTime(),
      });
      return encodeWire(
        "DiagnosisDayAhead",
        toDiagnosisDayAhead(
          attribution,
          { narration: narration.narration, withheldBy: narration.withheldBy },
          now,
        ),
      );
    },
    {
      query: t.Object({
        subsystem: t.String({
          description: "ONS subsystem code: N, NE, S or SE. There is no SIN.",
        }),
        date: t.Optional(
          t.String({
            description:
              "The civil day being explained, in America/Sao_Paulo. Defaults to tomorrow.",
          }),
        ),
        gate_profile: t.Optional(
          t.String({ description: "gate_early or gate_late. Defaults to gate_late." }),
        ),
        locale: t.Optional(
          t.String({
            description:
              "pt-BR or en-US, matched on the primary subtag. Defaults from " +
              "Accept-Language, then to pt-BR.",
          }),
        ),
        technology: t.Optional(
          t.String({
            description:
              "Not a parameter of this endpoint. Declared so a request carrying " +
              "one is refused with a reason rather than silently ignored.",
          }),
        ),
      }),
      detail: {
        summary: "The attribution and the narration for one subsystem-day",
        description:
          "All eight driver groups ranked by absolute share, the rules that " +
          "fired, and one paragraph — generated by a language model in the " +
          "requested locale, or assembled from a fixed template when a rule " +
          "withheld it, the model was unreachable or the day's global call " +
          "budget was spent. narration.source says which. A withheld " +
          "diagnosis is a 200 carrying the drivers untouched. The attribution " +
          "resolves from Postgres alone, so it survives a modelling-service " +
          "outage.",
      },
    },
  );
}

/** The two forecast absences, told apart by the gate rather than guessed at. */
function noForecast(
  subsystem: SubsystemCode,
  targetDate: string,
  gateProfile: ReturnType<typeof parseGateProfile>,
  now: Date,
): CodedError {
  const gate = gateAt(targetDate, gateProfile);
  if (gate.getTime() > now.getTime()) {
    return new CodedError(
      "FORECAST_NOT_YET_PUBLISHED",
      `The ${gateProfile} gate for ${targetDate} publishes at ` +
        `${gate.toISOString()} and has not passed, so there is nothing to explain yet`,
      {
        details: {
          target_date: targetDate,
          gate_profile: gateProfile,
          publishes_at: gate.toISOString(),
        },
      },
    );
  }
  return new CodedError(
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

/** The wired route, over the process-wide handle. */
export const diagnosisRoutes = createDiagnosisRoutes({ db: database?.db });
