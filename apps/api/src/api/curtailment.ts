import type {
  CurtailmentEpisode,
  CurtailmentEpisodes,
  CurtailmentHour,
  CurtailmentHours,
  ObservedReason,
  ObservedReasons,
} from "@wattsteer/core/api";
import {
  MAX_GAP_HOURS,
  SUBSYSTEM_CODES,
  SUBSYSTEM_THRESHOLD_MW,
} from "@wattsteer/core/constants";
import { TECHNOLOGIES } from "@wattsteer/core/domain";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import type {
  CurtailmentEpisodesObservation,
  CurtailmentHoursObservation,
  ObservedReasonsObservation,
} from "../contract/curtailment-observed.js";
import {
  readCurtailmentEpisodes,
  readCurtailmentHours,
  readObservedReasons,
} from "../contract/curtailment-observed.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { BadInputError, CodedError } from "../errors.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { ONS_TIME_ZONE, zonedWallClock } from "../ingest/time.js";
import {
  civilDayWindow,
  instant,
  nonNegativeInteger,
  observedRange,
  positiveNumber,
} from "./params.js";
import {
  applyCachePolicy,
  CACHE_POLICIES,
  type CachePolicy,
} from "./plugins/cache-policy.js";

/**
 * `GET /v1/curtailment/hours`, `/episodes` and `/reasons` — **the observed
 * record, at the grain it was actually recorded at**.
 *
 * The three routes of `docs/specs/api-surface.md` §5–7, and the second family
 * after `/v1/grid/now` that needs **no model**: they resolve entirely from
 * Postgres through the canonical curtailment view. With `apps/ml` returning 503
 * for everything and no promoted artifact in any lane, all three still answer
 * 200 with real numbers — a property of the dependency graph rather than a
 * fallback path someone has to remember to write.
 *
 * ### Which denominator each figure uses, and why it is stated here
 *
 * The episode-versus-day denominator was a prototype defect, caught by the
 * specs and not by a test — a figure computed over one denominator and rendered
 * beside a label naming another is arithmetically fine and factually wrong. So
 * each of these routes says what its numbers are divided by, at the site:
 *
 * - **`/hours`** — one row is a **(subsystem, technology, hour)** sum over the
 *   subsystem's reporting entities. There is no division; an hour's MWh is also
 *   its mean MW. An hour with no row is **absent**, never a zero, so a total
 *   over the series is a total over the hours that were observed.
 * - **`/episodes`** — `total_mwh` and `peak_mw` are taken over the hours inside
 *   **one episode's span**, and `duration_hours` is that same span. The two
 *   share a denominator deliberately, so `total_mwh / duration_hours` is the
 *   episode's mean MW and not a day's. Nothing here is a share of a day.
 * - **`/reasons`** — one row is a sum over **one civil day's hours** for one
 *   (entity, reason, origin). It is an energy sum and never a row count, which
 *   is the distinction that matters: the source publishes at (entity,
 *   technology, hour) grain, so an entity reporting both technologies in an
 *   hour is two rows in that hour. That double-count bites a **share of rows**
 *   — which is why fe-05 recorded the grain — and does not bite a sum of MWh.
 *   No share is computed or returned here.
 *
 * ### Three shaping decisions that live here
 *
 * - **The episode parameters are echoed twice.** `threshold_mw` and
 *   `max_gap_hours` are on every episode *and* at the top level, so a screen
 *   cannot render an episode list beside a threshold it did not use. The
 *   defaults are the domain model's committed ones — 5 MW at subsystem grain
 *   and 0 gap hours — read from `@wattsteer/core` rather than written again.
 * - **Reason codes travel; the gloss does not.** `reason` is `REL | CNF | ENE |
 *   PAR` and the English wording is a `t()` key in the web app (vocabulary rule
 *   7). `description` is the opposite case: it is ONS's `dsc_restricao`,
 *   verbatim and in Portuguese in **both** locales, because it is a source
 *   record rather than copy. Translating one would be inventing evidence.
 * - **`hour_local` is computed through the IANA zone**, never a fixed −3
 *   offset. ONS's own timestamps are Brasília civil time and the zone has a DST
 *   history; the fixed offset is right today and silently wrong for every hour
 *   before 2019.
 */

/**
 * The closed enums as TypeBox, derived from `@wattsteer/core` exactly as
 * `plants.ts` derives them. A gateway that restates how many subsystems there
 * are is a second definition of a closed enum.
 */
const literalUnion = <T extends string>(values: readonly T[]) => {
  const members = values.map((value) => t.Literal(value));
  const [first, ...rest] = members;
  if (first === undefined) {
    throw new RangeError("A closed enum with no members cannot be a query parameter");
  }
  return t.Union([first, ...rest]);
};

const SUBSYSTEM = literalUnion(SUBSYSTEM_CODES);
/** Uppercase, case-sensitively: `technology=wind` is a 422, not a synonym. */
const TECHNOLOGY = t.Optional(literalUnion(TECHNOLOGIES));

const AS_OF = t.Optional(
  t.String({
    description:
      "Vintage cut (ISO-8601). Defaults to now — the cut is on the response, " +
      "beside the data version the rows were read at.",
  }),
);

/**
 * The default number of reason rows, and the ceiling on it.
 *
 * A day has at most a few hundred reporting entities with a cause, so the
 * default is the whole of a normal day for a screen and the ceiling is a
 * refusal rather than a silent truncation.
 */
const DEFAULT_REASON_LIMIT = 50;
const MAX_REASON_LIMIT = 500;

/**
 * A settled past range caches for an hour; a range touching the last 48 hours
 * caches for five minutes, because the tail is still settling.
 * `api-surface.md`'s caching table, and it is **never** `immutable`: ONS
 * rewrites history in place.
 */
const SETTLING_TAIL_MS = 48 * 3_600_000;

/**
 * Which of the table's two observed rows this range falls on.
 *
 * The one switch on the whole surface that reads a clock, and it reads it to
 * pick a *freshness window* and never a key: both rows key on the same
 * provenance — the max `data_version` in range — so a restatement invalidates
 * a settled range and a settling one identically, and the clock only decides
 * how long a shared cache may go without asking.
 */
function policyFor(to: Date, now: Date): CachePolicy {
  return to.getTime() > now.getTime() - SETTLING_TAIL_MS
    ? CACHE_POLICIES.observedTail
    : CACHE_POLICIES.observedSettled;
}

/** `2026-08-28` — a civil date in `America/Sao_Paulo`, never a UTC slice. */
function civilDateOf(instantValue: Date): string {
  const wall = zonedWallClock(instantValue, ONS_TIME_ZONE);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** The local hour an instant falls in, 0–23, through the IANA zone. */
function hourLocalOf(instantValue: Date): number {
  return zonedWallClock(instantValue, ONS_TIME_ZONE).hour;
}

/** The cursor is opaque on purpose: it is a page boundary, not an argument. */
function encodeCursor(from: Date): string {
  return Buffer.from(from.toISOString(), "utf8").toString("base64url");
}

function decodeCursor(raw: string, range: { from: Date; to: Date }): Date {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parsed = new Date(decoded);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadInputError(`cursor is not one this endpoint issued: "${raw}"`);
  }
  if (parsed.getTime() < range.from.getTime() || parsed.getTime() >= range.to.getTime()) {
    // A cursor outside the range it was issued for would silently answer a
    // different question than the one the parameters name.
    throw new BadInputError(
      "cursor falls outside [from, to) — it belongs to a different range",
    );
  }
  return parsed;
}

/**
 * The wire bodies, built field by field against the generated interfaces.
 *
 * Field by field rather than by handing an observation to the encoder: the
 * encoder carries an unrecognised key through unrenamed by design and the
 * schemas are `additionalProperties: false`, so `nextPageFrom` — the route's
 * business and not the payload's — would be a contract violation found by a
 * validator instead of by a compiler.
 */
function toCurtailmentHours(
  observation: CurtailmentHoursObservation,
  query: {
    subsystem: SubsystemCode;
    technology: "WIND" | "SOLAR" | null;
    from: Date;
    to: Date;
  },
): CurtailmentHours {
  return {
    subsystem: query.subsystem,
    technology: query.technology,
    // The range asked for, not the page served: the page is what `next_cursor`
    // is for, and echoing a narrowed window as the parameter in force would
    // make a paged read look like a smaller request than it was.
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    asOf: observation.asOf.toISOString(),
    dataVersion: observation.dataVersion,
    vintageFidelity: observation.vintageFidelity,
    rows: observation.rows.map(
      (row): CurtailmentHour => ({
        subsystem: row.subsystem,
        technology: row.technology,
        validTime: row.validTime.toISOString(),
        hourLocal: hourLocalOf(row.validTime),
        constrainedOffMwh: row.constrainedOffMwh,
      }),
    ),
    nextCursor:
      observation.nextPageFrom === null ? null : encodeCursor(observation.nextPageFrom),
  };
}

function toCurtailmentEpisodes(
  observation: CurtailmentEpisodesObservation,
  query: {
    subsystem: SubsystemCode;
    technology: "WIND" | "SOLAR" | undefined;
    from: Date;
    to: Date;
    thresholdMw: number;
    maxGapHours: number;
  },
): CurtailmentEpisodes {
  return {
    subsystem: query.subsystem,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    asOf: observation.asOf.toISOString(),
    dataVersion: observation.dataVersion,
    vintageFidelity: observation.vintageFidelity,
    // Echoed at the top level as well as on every episode, so the parameters in
    // force are visible without reading a row.
    thresholdMw: query.thresholdMw,
    maxGapHours: query.maxGapHours,
    episodes: observation.episodes.map(
      (episode): CurtailmentEpisode => ({
        subsystem: query.subsystem,
        // Present only when the caller asked for one technology. An episode
        // computed over both is not a wind episode, and labelling it as one
        // would be the same mistake as a mismatched denominator.
        ...(query.technology === undefined ? {} : { technology: query.technology }),
        startedAt: episode.startedAt.toISOString(),
        endedAt: episode.endedAt.toISOString(),
        durationHours: episode.durationHours,
        totalMwh: episode.totalMwh,
        peakMw: episode.peakMw,
        // Vocabulary rule 8: the parameters that produced it, on the object.
        thresholdMw: query.thresholdMw,
        maxGapHours: query.maxGapHours,
      }),
    ),
  };
}

function toObservedReasons(
  observation: ObservedReasonsObservation,
  query: { subsystem: SubsystemCode; date: string },
): ObservedReasons {
  return {
    subsystem: query.subsystem,
    date: query.date,
    asOf: observation.asOf.toISOString(),
    dataVersion: observation.dataVersion,
    vintageFidelity: observation.vintageFidelity,
    rows: observation.rows.map(
      (row): ObservedReason => ({
        // Required on every row: a screen labels the grain rather than assuming
        // it, because for a Tipo II-C plant the reason is genuinely unknown at
        // plant grain and for the eighteen self-reporting plants it is
        // genuinely observed there.
        grain: row.grain,
        entityCode: row.entityCode,
        entityLabel: row.entityLabel,
        // The identifier. The gloss is a `t()` key and never travels.
        reason: row.reason,
        origin: row.origin,
        constrainedOffMwh: row.constrainedOffMwh,
        // ONS's free text, verbatim and Portuguese in both locales.
        description: row.description,
        causeMixed: row.causeMixed,
      }),
    ),
  };
}

export function createCurtailmentRoutes(deps: { db: Database | undefined }) {
  /**
   * Called **after** the parameters are parsed, on every one of the three
   * routes. A malformed request is malformed whether or not a database is
   * configured, and answering it 503 would tell the caller to retry a request
   * that will never succeed.
   */
  const requireDb = (): Database => {
    if (!deps.db) {
      throw new CodedError("DATA_UNAVAILABLE", "Persistence is not configured");
    }
    return deps.db;
  };

  return new Elysia({ name: "curtailment" })
    .get(
      "/v1/curtailment/hours",
      async ({ query, set, request }) => {
        const range = observedRange(query.from, query.to);
        const asOf =
          query.as_of === undefined ? new Date() : instant("as_of", query.as_of);
        const pageFrom =
          query.cursor === undefined ? range.from : decodeCursor(query.cursor, range);
        const db = requireDb();

        const observation = await readCurtailmentHours(db, {
          asOf,
          subsystem: query.subsystem,
          from: range.from,
          to: range.to,
          ...(query.technology === undefined ? {} : { technology: query.technology }),
          pageFrom,
        });

        // A cache key is a provenance, never a duration: ONS restates settled
        // history in place, so the validator is the greatest data version
        // behind the page and nothing else moves it. The page boundary and the
        // two filters are on it because they select *which* rows of that
        // version answered.
        if (
          applyCachePolicy({ set, request }, policyFor(range.to, new Date()), [
            observation.dataVersion,
            query.subsystem,
            query.technology ?? "*",
            pageFrom,
          ])
        ) {
          return null;
        }

        return encodeWire(
          "CurtailmentHours",
          toCurtailmentHours(observation, {
            subsystem: query.subsystem,
            technology: query.technology ?? null,
            from: range.from,
            to: range.to,
          }),
        );
      },
      {
        query: t.Object({
          subsystem: SUBSYSTEM,
          from: t.String({ description: "Start of the window, inclusive (ISO-8601)." }),
          to: t.String({ description: "End of the window, exclusive (ISO-8601)." }),
          technology: TECHNOLOGY,
          as_of: AS_OF,
          cursor: t.Optional(
            t.String({
              description:
                "Continue a paged series. Opaque, and issued only by this " +
                "endpoint as `next_cursor`.",
            }),
          ),
        }),
        detail: {
          summary: "Observed constrained-off, hour by hour",
          description:
            "One row per (subsystem, technology, hour), summed over the " +
            "subsystem's reporting entities. An hour with no row is absent " +
            "rather than zero — ONS publishes a row when an entity was " +
            "restricted, and an absence is not a measurement of nothing. The " +
            "range is capped at 400 days and pages through `next_cursor`. " +
            "Observed, not forecast: served with the modelling service " +
            "unreachable.",
        },
      },
    )
    .get(
      "/v1/curtailment/episodes",
      async ({ query, set, request }) => {
        const range = observedRange(query.from, query.to);
        const asOf =
          query.as_of === undefined ? new Date() : instant("as_of", query.as_of);
        // The domain model's committed defaults, read from the shared
        // constants. A route that wrote `5` here would be a second place the
        // threshold lives, which is exactly what stamping it exists to stop.
        const thresholdMw =
          query.threshold_mw === undefined
            ? SUBSYSTEM_THRESHOLD_MW
            : positiveNumber("threshold_mw", query.threshold_mw);
        const maxGapHours =
          query.max_gap_hours === undefined
            ? MAX_GAP_HOURS
            : nonNegativeInteger("max_gap_hours", query.max_gap_hours);
        const db = requireDb();

        const observation = await readCurtailmentEpisodes(db, {
          asOf,
          subsystem: query.subsystem,
          from: range.from,
          to: range.to,
          ...(query.technology === undefined ? {} : { technology: query.technology }),
          thresholdMw,
          maxGapHours,
        });

        // The parameters are part of the key: the same range under a
        // different threshold is a different answer, and an ETag that ignored
        // them would serve one screen's episodes to another screen's request.
        if (
          applyCachePolicy({ set, request }, policyFor(range.to, new Date()), [
            observation.dataVersion,
            query.subsystem,
            query.technology ?? "*",
            thresholdMw,
            maxGapHours,
          ])
        ) {
          return null;
        }

        return encodeWire(
          "CurtailmentEpisodes",
          toCurtailmentEpisodes(observation, {
            subsystem: query.subsystem,
            technology: query.technology,
            from: range.from,
            to: range.to,
            thresholdMw,
            maxGapHours,
          }),
        );
      },
      {
        query: t.Object({
          subsystem: SUBSYSTEM,
          from: t.String({ description: "Start of the window, inclusive (ISO-8601)." }),
          to: t.String({ description: "End of the window, exclusive (ISO-8601)." }),
          technology: TECHNOLOGY,
          threshold_mw: t.Optional(
            t.String({
              description: `MW at or above which an hour is in an episode. Default ${SUBSYSTEM_THRESHOLD_MW} at subsystem grain.`,
            }),
          ),
          max_gap_hours: t.Optional(
            t.String({
              description: `Sub-threshold or unobserved hours an episode may contain. Default ${MAX_GAP_HOURS}.`,
            }),
          ),
          as_of: AS_OF,
        }),
        detail: {
          summary: "Observed curtailment episodes, computed on read",
          description:
            "Maximal runs of hours at or above a threshold, computed by a " +
            "parameterised SQL function and never stored — persisting them " +
            "would freeze one threshold into the database and let two " +
            "screens disagree about what an episode is. Every episode " +
            "carries the threshold_mw and max_gap_hours that produced it, " +
            "and both are echoed at the top level. total_mwh, peak_mw and " +
            "duration_hours share one denominator: the episode's own span.",
        },
      },
    )
    .get(
      "/v1/curtailment/reasons",
      async ({ query, set, request }) => {
        const day = civilDayWindow("date", query.date);
        const asOf =
          query.as_of === undefined ? new Date() : instant("as_of", query.as_of);
        const limit =
          query.limit === undefined
            ? DEFAULT_REASON_LIMIT
            : nonNegativeInteger("limit", query.limit);
        if (limit < 1 || limit > MAX_REASON_LIMIT) {
          throw new BadInputError(
            `limit must be between 1 and ${MAX_REASON_LIMIT}, got ${limit}`,
          );
        }
        const db = requireDb();

        const observation = await readObservedReasons(db, {
          asOf,
          subsystem: query.subsystem,
          from: day.from,
          to: day.to,
          limit,
        });

        if (
          applyCachePolicy({ set, request }, policyFor(day.to, new Date()), [
            observation.dataVersion,
            query.subsystem,
            query.date,
            limit,
          ])
        ) {
          return null;
        }

        return encodeWire(
          "ObservedReasons",
          toObservedReasons(observation, {
            subsystem: query.subsystem,
            // Echoed as the civil date it was asked for, resolved through the
            // grid's own zone rather than a UTC slice of an instant.
            date: civilDateOf(day.from),
          }),
        );
      },
      {
        query: t.Object({
          subsystem: SUBSYSTEM,
          date: t.String({
            description: `Civil date in ${ONS_TIME_ZONE} (YYYY-MM-DD). Never an instant.`,
          }),
          limit: t.Optional(
            t.String({
              description: `Rows to return, largest first. Default ${DEFAULT_REASON_LIMIT}, ceiling ${MAX_REASON_LIMIT}.`,
            }),
          ),
          as_of: AS_OF,
        }),
        detail: {
          summary: "Observed restriction reasons, at reporting-entity grain",
          description:
            "One row per (entity, reason, origin) for one civil day, with " +
            "the grain on every row — conjunto or self-reporting plant — " +
            "because a screen labels the grain rather than assuming it. " +
            "Nothing is aggregated to plant grain and there is no plant " +
            "parameter: deriving a plant's reason from its conjunto's is an " +
            "allocation, and v1 computes none. Reason codes are the " +
            "identifier; the English gloss is a translation key and is not " +
            "returned. description is ONS's own free text, verbatim.",
        },
      },
    );
}

/** The wired routes, over the process-wide handle. */
export const curtailmentRoutes = createCurtailmentRoutes({ db: database?.db });
