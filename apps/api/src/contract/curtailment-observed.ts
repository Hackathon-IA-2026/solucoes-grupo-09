import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import { sql } from "drizzle-orm";
import { canonicalCurtailmentByReportingEntity } from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { readOnly } from "./read-only.js";
import { applyAxes, readGoLive } from "./scope.js";
import type { ReasonCode, RestrictionOrigin, Technology } from "./types.js";
import { type VintageFidelity, vintageFidelity } from "./vintage.js";

/**
 * The observed record — the three reads behind `GET /v1/curtailment/*`.
 *
 * Like `grid-now.ts`, and for the same reason: **nothing here needs a model.**
 * These are settled ONS rows, read through the canonical view, and this module
 * imports nothing from the modelling side. That is what makes the observed
 * panels the ones that survive an unpromoted artifact and an unreachable
 * `apps/ml`.
 *
 * Every read composes `canonical_curtailment_by_reporting_entity` and no base
 * table: the view owns the `AsOf` pick, the renames, the grain, the unit
 * resolution and — since ticket 016 — the entity's kind, subsystem and name.
 * Every read also sets the vintage axis first; `canonical_as_of()` raises
 * `22023` when it is unset, so there is no path through this module that
 * reaches a row without naming a cut.
 *
 * ### Three grains, three denominators, stated at each site
 *
 * The one defect worth naming here, because the specs caught it in a prototype
 * and it is invisible in a green test: **a figure is only as honest as the
 * denominator underneath it**, and these three reads use three different ones.
 *
 * - `readCurtailmentHours` sums over **(subsystem, technology, hour)**. One
 *   hour's MWh is also its mean MW; nothing here is divided by anything.
 * - `readCurtailmentEpisodes` sums over the **hours inside one episode's
 *   span** — not over a day, and not over the requested range. An episode's
 *   `total_mwh` and its `duration_hours` share that one denominator on purpose,
 *   which is exactly what an episode figure over a day denominator gets wrong.
 * - `readObservedReasons` sums over the **hours of one civil day at
 *   (entity, reason, origin)** grain. It is an energy sum and never a row
 *   count, which matters: the source publishes at (entity, technology, hour)
 *   grain, so an entity that reported both technologies in an hour contributes
 *   two rows to that hour. Two rows, one exact quantity of energy — the
 *   double-count that bites a share of rows does not bite a sum of MWh, and
 *   this read returns no share.
 */

/** The vintage columns every one of these responses carries. */
export interface ObservedVintage {
  /** The cut the rows were read at. */
  asOf: Date;
  /**
   * The greatest `data_version` among the rows returned, as a string.
   *
   * `api-surface.md`'s caching table makes this the ETag for the observed
   * routes: ONS rewrites history in place, so a version is the only validator
   * that moves when a settled past hour is restated. `"none"` when the read
   * returned no rows — an empty range has no version, and calling it `0` would
   * assert a version that never existed.
   */
  dataVersion: string;
  vintageFidelity: VintageFidelity;
}

/** No rows means no version. Stated rather than defaulted to a zero. */
export const NO_DATA_VERSION = "none";

const versionOf = (value: number | string | null): string =>
  value === null ? NO_DATA_VERSION : String(value);

const HOUR_MS = 3_600_000;

/**
 * How many hours one page of the hourly series covers.
 *
 * 2400 hours is 100 days, so the 400-day cap is four pages of at most 4800 rows
 * each. Paging by hour rather than by row is what keeps a page from splitting
 * an hour between two responses and leaving a screen to add a wind row from one
 * page to a solar row from the next.
 */
export const PAGE_HOURS = 2400;

// ---------------------------------------------------------------------------
// 5. The hourly series
// ---------------------------------------------------------------------------

/** One observed hour, at the grain the route publishes: subsystem by technology. */
export interface CurtailmentHourRow {
  subsystem: SubsystemCode;
  technology: Technology;
  validTime: Date;
  /** Summed over the subsystem's reporting entities for that hour. */
  constrainedOffMwh: number;
}

export interface CurtailmentHoursObservation extends ObservedVintage {
  rows: CurtailmentHourRow[];
  /**
   * The start of the next page, or `null` when this page reached `to`.
   *
   * A cursor rather than a `{data, meta}` envelope: pagination is needed on two
   * of fourteen routes, and buying a wrapper for all fourteen to serve two is
   * the trade `api-surface.md` refuses.
   */
  nextPageFrom: Date | null;
}

export interface CurtailmentHoursQuery {
  asOf: Date;
  subsystem: SubsystemCode;
  /** Half-open `[from, to)`, capped at 400 days by the route. */
  from: Date;
  to: Date;
  technology?: Technology;
  /** Start of the page to read. Defaults to `from`. */
  pageFrom?: Date;
}

/** The aggregate row's shape. Indexed because `execute` takes a row record. */
interface HourRow {
  [column: string]: unknown;
  technology: Technology;
  valid_time: string;
  constrained_off_mwh: number | string;
  max_data_version: number | string;
}

/**
 * Observed constrained-off at (subsystem, technology, hour) grain.
 *
 * **An hour with no row is absent from the series and is never a zero.** ONS
 * publishes a row when an entity was restricted; the absence of one is not a
 * measurement of nothing, and a screen drawing a line through an absence draws
 * a different claim than the one the data supports. Filling the range would be
 * cheap and would be a fabrication, so the rows are exactly the rows.
 */
export async function readCurtailmentHours(
  db: Database,
  query: CurtailmentHoursQuery,
): Promise<CurtailmentHoursObservation> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: query.asOf });

    const pageFrom = query.pageFrom ?? query.from;
    const pageEndMs = Math.min(
      query.to.getTime(),
      pageFrom.getTime() + PAGE_HOURS * HOUR_MS,
    );
    const pageTo = new Date(pageEndMs);
    const technologyFilter = query.technology
      ? sql`and technology = ${query.technology}`
      : sql``;

    const rows = await tx.execute<HourRow>(sql`
      select
        technology,
        valid_time,
        sum(constrained_off_mwh) as constrained_off_mwh,
        max(data_version) as max_data_version
      from ${canonicalCurtailmentByReportingEntity}
      where subsystem = ${query.subsystem}
        and valid_time >= ${pageFrom.toISOString()}::timestamptz
        and valid_time < ${pageTo.toISOString()}::timestamptz
        ${technologyFilter}
      group by technology, valid_time
      order by valid_time, technology
    `);

    let dataVersion: number | null = null;
    const observed = [...rows].map((row): CurtailmentHourRow => {
      const version = Number(row.max_data_version);
      dataVersion = dataVersion === null ? version : Math.max(dataVersion, version);
      return {
        subsystem: query.subsystem,
        technology: row.technology,
        validTime: new Date(row.valid_time),
        constrainedOffMwh: Number(row.constrained_off_mwh),
      };
    });

    const goLiveAt = await readGoLive(tx, "curtailment-by-reporting-entity");

    return {
      asOf: query.asOf,
      dataVersion: versionOf(dataVersion),
      // The window's start decides the fidelity: one pre-go-live hour makes the
      // whole series a restatement of ONS's current belief rather than what was
      // knowable at the time. The requested start, not the page's, because the
      // fidelity of a paged series is a property of the series.
      vintageFidelity: vintageFidelity(query.from, goLiveAt),
      rows: observed,
      nextPageFrom: pageEndMs < query.to.getTime() ? pageTo : null,
    };
  });
}

// ---------------------------------------------------------------------------
// 6. The episode view
// ---------------------------------------------------------------------------

/** One episode, as the parameterised SQL function computes it. */
export interface CurtailmentEpisodeRow {
  /**
   * Which subsystem's run this is.
   *
   * On the row and not only on the query, because the query may not have named
   * one: an episode is a run of hours in *one* subsystem, so a whole-grid read
   * returns four subsystems' runs interleaved and each has to say which it is.
   */
  subsystem: SubsystemCode;
  startedAt: Date;
  /** Exclusive: the valid_time of the first hour not in the episode. */
  endedAt: Date;
  /** The span, gap hours included — the denominator `totalMwh` also uses. */
  durationHours: number;
  totalMwh: number;
  /** The greatest hourly figure in the span. An hour's MWh is its mean MW. */
  peakMw: number;
}

export interface CurtailmentEpisodesObservation extends ObservedVintage {
  episodes: CurtailmentEpisodeRow[];
}

export interface CurtailmentEpisodesQuery {
  asOf: Date;
  /**
   * Omitted for the whole grid: every subsystem's episodes, chronological.
   *
   * This is **not** a national aggregate, and the distinction is the same one
   * `NationalNow.derived` makes. An episode is a measured run of settled
   * hours; four subsystems' runs concatenate exactly, because measurements
   * add. Nothing here computes an interval, a median or a `SIN` row, and the
   * threshold is applied per subsystem exactly as it is for one.
   */
  subsystem?: SubsystemCode;
  from: Date;
  to: Date;
  technology?: Technology;
  /** The parameter that produces the episodes, and is stamped on every one. */
  thresholdMw: number;
  maxGapHours: number;
}

interface EpisodeRow {
  [column: string]: unknown;
  subsystem: string;
  started_at: string;
  ended_at: string;
  duration_hours: number;
  total_mwh: number | string;
  peak_mw: number | string;
}

/**
 * The episode view — **computed on read, never stored**.
 *
 * `canonical_curtailment_episodes(...)` is a parameterised SQL function over
 * the same canonical view, added by the ticket's migration. Nothing is
 * persisted at episode grain, because persisting a run would freeze one
 * threshold into the database and let two screens disagree about what an
 * episode is (`docs/domain-model.md` §5). The threshold and the gap tolerance
 * are arguments, and the route stamps both on every episode and at the top
 * level.
 *
 * It is SQL rather than a loop over `readCurtailmentHours` for the reason the
 * rest of the contract is SQL: `apps/ml` has to be able to ask the same
 * question and get the same answer without a second implementation of the rule.
 */
export async function readCurtailmentEpisodes(
  db: Database,
  query: CurtailmentEpisodesQuery,
): Promise<CurtailmentEpisodesObservation> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: query.asOf });

    const technology = query.technology ?? null;
    /*
      **The whole grid is a lateral over the four, not a fifth signature.**

      `canonical_curtailment_episodes(...)` takes one subsystem and that is
      correct: the run-length rule is per subsystem, and a function that also
      accepted "all" would be a second implementation of the threshold inside
      the one place the rule is supposed to live. So the four codes are driven
      into it from the outside, and the grouping and the ordering stay in
      Postgres rather than being reassembled from four round trips.

      Measured, so that nobody has to re-derive it: this costs **4×** a
      single-subsystem read. `subsystem` is not in the view's `distinct on`
      list, so the predicate cannot be pushed through the `Unique`, and each of
      the four iterations sorts and deduplicates the whole window before
      discarding three quarters of it. At the fortnight the Overview asks for
      that is nothing; at this route's own 400-day cap it is four full-window
      dedup sorts, and the route has no cursor. One pass with
      `group by subsystem, valid_time` would be 1×, and it needs a second
      signature on the SQL function — a migration — which is the trade this
      took. If a long window ever becomes a real request, that is the change.

      `subsystems` is `SUBSYSTEM_DISPLAY_ORDER`, never a literal, so this file
      does not carry a second copy of the four. It is not a graceful widening,
      though, and the note is here rather than in a reviewer's head: the codes
      are cast `::subsystem_code`, and that enum is created in
      `0000_hot_dakota_north.sql`. A fifth member added to the TypeScript
      constant without the matching enum migration is a 500 on every whole-grid
      read, not a fifth row.

      It is driven in one placeholder per code rather than as one array
      parameter, because drizzle expands a JS array into a **tuple** — an
      array handed to `unnest(${"$"}1::text[])` compiles to
      `unnest((${"$"}1, ${"$"}2)::text[])`, which is a syntax error the query
      planner never sees. Measured: `test:db` went red on all seven episode
      cases with a failure the driver reported only as "Failed query".
    */
    const subsystems =
      query.subsystem === undefined ? [...SUBSYSTEM_DISPLAY_ORDER] : [query.subsystem];
    const rows = await tx.execute<EpisodeRow>(sql`
      select
        asked.code as subsystem,
        episode.started_at,
        episode.ended_at,
        episode.duration_hours,
        episode.total_mwh,
        episode.peak_mw
      from unnest(array[${sql.join(
        subsystems.map((code) => sql`${code}`),
        sql`, `,
      )}]::text[]) as asked(code)
      cross join lateral canonical_curtailment_episodes(
        asked.code::subsystem_code,
        ${query.from.toISOString()}::timestamptz,
        ${query.to.toISOString()}::timestamptz,
        ${query.thresholdMw}::double precision,
        ${query.maxGapHours}::int,
        ${technology}::technology
      ) as episode
      /*
        Chronological, subsystem as the tiebreak — the order the function
        already returned for one subsystem, now stated rather than inherited.
        Not newest-first: that is a rendering decision, and reversing the wire
        would have silently flipped the Time Machine's list, which reads a day
        forwards. Four laterals concatenated with no order at all would have
        given all of N's runs, then all of NE's, which is not a list of what
        happened recently in any useful sense.
      */
      order by episode.started_at, asked.code
    `);

    // The version is read from the rows the episodes were computed from, not
    // from the episodes: an episode has no version of its own, because it is
    // not a row anything stores.
    /*
      The version query's array is cast to `subsystem_code[]`, not `text[]`.
      The column is the enum, and the scalar this replaced — `where subsystem =
      $1` — only worked because Postgres coerces an *unknown* literal to an
      enum. Naming the type as text takes that inference away and leaves the
      comparison with no operator; `test:db` reported it as a failed query with
      no message attached, which is the shape this note exists to shorten.
    */
    /*
      **Per subsystem, and it used to be one `max` over all four.**

      `data_version` is not a global sequence: `versioned-write.ts` assigns it
      per business key, as a revision depth. So `max()` over a *set* of keys
      only moves when the deepest-revised key gets deeper — and over four
      subsystems that means one subsystem's restatement history can mask
      another's restatement entirely. Concretely: an NE hour already restated
      twice sits at 3; ONS then restates an S hour from 40 MWh to 90, taking it
      from 1 to 2; the max over the four is still 3, the ETag does not move, and
      a reader revalidating gets a 304 over an episode list in which S's run is
      the wrong size.

      One per subsystem, in `SUBSYSTEM_DISPLAY_ORDER`, so a restatement anywhere
      moves the component for *its* subsystem and nothing can hide behind a
      deeper neighbour. It is what `api-routes.md` means by a cache key being a
      provenance rather than a number.

      The residual is honest and pre-existing: within one subsystem, entity A at
      3 still masks entity B going 1→2. Closing that needs a digest over the
      versions actually read rather than an aggregate of them, which is a change
      to every observed read and not to this one.
    */
    const versions = await tx.execute<{
      subsystem: string;
      max_data_version: number | string | null;
    }>(sql`
      select subsystem, max(data_version) as max_data_version
      from ${canonicalCurtailmentByReportingEntity}
      where subsystem = any(array[${sql.join(
        subsystems.map((code) => sql`${code}`),
        sql`, `,
      )}]::subsystem_code[])
        and valid_time >= ${query.from.toISOString()}::timestamptz
        and valid_time < ${query.to.toISOString()}::timestamptz
        ${technology === null ? sql`` : sql`and technology = ${technology}`}
      group by subsystem
    `);
    const bySubsystem = new Map(
      [...versions].map((row) => [row.subsystem, row.max_data_version]),
    );

    const goLiveAt = await readGoLive(tx, "curtailment-by-reporting-entity");

    return {
      asOf: query.asOf,
      /*
        One component per subsystem asked for, in display order, so the string
        is stable across requests and a subsystem with no rows in the window
        reads as `none` — the value this file already uses for that — rather
        than shifting the components after it. For a single subsystem it is
        exactly what it always was: that subsystem's max, alone.
      */
      dataVersion: subsystems
        .map((code) => versionOf(bySubsystem.get(code) ?? null))
        .join("."),
      vintageFidelity: vintageFidelity(query.from, goLiveAt),
      episodes: [...rows].map((row) => ({
        subsystem: row.subsystem as SubsystemCode,
        startedAt: new Date(row.started_at),
        endedAt: new Date(row.ended_at),
        durationHours: Number(row.duration_hours),
        totalMwh: Number(row.total_mwh),
        peakMw: Number(row.peak_mw),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// 7. The observed reasons
// ---------------------------------------------------------------------------

/** The grain a reason was observed at. Required on the row, never assumed. */
export type ReasonGrain = "conjunto" | "self_reporting_plant";

export interface ObservedReasonRow {
  grain: ReasonGrain;
  entityCode: string;
  /** ONS's own name for the entity — a proper noun, not translated copy. */
  entityLabel: string;
  reason: ReasonCode;
  origin: RestrictionOrigin;
  /** Summed over the day's hours for this (entity, reason, origin). */
  constrainedOffMwh: number;
  /**
   * ONS's `dsc_restricao`, verbatim — Portuguese, in both locales.
   *
   * A source record rather than copy, which is why the i18n guard exempts it:
   * translating one would be inventing evidence about what an operator wrote.
   * Never a gloss of `reason`, and `null` where ONS wrote nothing.
   */
  description: string | null;
  /** True when any hour behind this row changed cause mid-way. */
  causeMixed: boolean;
}

export interface ObservedReasonsObservation extends ObservedVintage {
  rows: ObservedReasonRow[];
}

export interface ObservedReasonsQuery {
  asOf: Date;
  subsystem: SubsystemCode;
  /** The civil day, already resolved to the interval it occupied. */
  from: Date;
  to: Date;
  limit: number;
}

interface ReasonRow {
  [column: string]: unknown;
  reporting_entity_kind: "CONJUNTO" | "PLANT";
  reporting_entity_code: string;
  reporting_entity_name: string;
  restriction_reason: ReasonCode;
  restriction_origin: RestrictionOrigin;
  constrained_off_mwh: number | string;
  restriction_description: string | null;
  cause_mixed: boolean;
  max_data_version: number | string;
}

/**
 * Observed restriction causes, at `ReportingEntity` grain and no other.
 *
 * Three properties, each of which is a specific dishonesty when got wrong:
 *
 * 1. **The grain is on every row.** For a Tipo II-C plant the reason is
 *    genuinely unknown at plant grain, and for the eighteen self-reporting
 *    plants it is genuinely observed there. A screen that assumed one would be
 *    right about one of those and wrong about the other.
 * 2. **Nothing is aggregated to plant grain, and there is no plant parameter.**
 *    Deriving a plant's reason from its conjunto's is an allocation, and v1
 *    computes none.
 * 3. **`causeMixed` is surfaced.** The schema already records that an hour
 *    changed cause mid-way and carries only the dominant one; hiding that would
 *    make a simplification look like an observation.
 *
 * An hour with **no reported cause is not a row here.** It is not a
 * "reason unknown" row either: ONS reported curtailment without a cause, and
 * inventing a bucket for it would put a number under a heading the source never
 * wrote.
 *
 * The `description` carried is the one from the largest contributing hour,
 * because a group of hours may carry several free-text notes and picking the
 * dominant hour's is the only choice that names an hour rather than a blend.
 */
export async function readObservedReasons(
  db: Database,
  query: ObservedReasonsQuery,
): Promise<ObservedReasonsObservation> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: query.asOf });

    const rows = await tx.execute<ReasonRow>(sql`
      select
        reporting_entity_kind,
        reporting_entity_code,
        reporting_entity_name,
        restriction_reason,
        restriction_origin,
        sum(constrained_off_mwh) as constrained_off_mwh,
        (array_agg(restriction_description order by constrained_off_mwh desc))[1]
          as restriction_description,
        bool_or(restriction_cause_mixed) as cause_mixed,
        max(data_version) as max_data_version
      from ${canonicalCurtailmentByReportingEntity}
      where subsystem = ${query.subsystem}
        and valid_time >= ${query.from.toISOString()}::timestamptz
        and valid_time < ${query.to.toISOString()}::timestamptz
        and restriction_reason is not null
        and restriction_origin is not null
      group by
        reporting_entity_kind,
        reporting_entity_code,
        reporting_entity_name,
        restriction_reason,
        restriction_origin
      order by sum(constrained_off_mwh) desc, reporting_entity_code
      limit ${query.limit}::int
    `);

    let dataVersion: number | null = null;
    const observed = [...rows].map((row): ObservedReasonRow => {
      const version = Number(row.max_data_version);
      dataVersion = dataVersion === null ? version : Math.max(dataVersion, version);
      return {
        // The view's `reporting_entity_kind`, in the vocabulary the schema
        // publishes. `PLANT` on a curtailment row means the plant reports for
        // itself, which is the whole of what `self_reporting_plant` says.
        grain:
          row.reporting_entity_kind === "CONJUNTO" ? "conjunto" : "self_reporting_plant",
        entityCode: row.reporting_entity_code,
        entityLabel: row.reporting_entity_name,
        reason: row.restriction_reason,
        origin: row.restriction_origin,
        constrainedOffMwh: Number(row.constrained_off_mwh),
        description: row.restriction_description,
        causeMixed: row.cause_mixed,
      };
    });

    const goLiveAt = await readGoLive(tx, "curtailment-by-reporting-entity");

    return {
      asOf: query.asOf,
      dataVersion: versionOf(dataVersion),
      vintageFidelity: vintageFidelity(query.from, goLiveAt),
      rows: observed,
    };
  });
}
