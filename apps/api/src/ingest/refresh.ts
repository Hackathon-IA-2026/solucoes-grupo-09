import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { ingestionRun, resourceRepublication } from "../database/schema.js";
import { toHttpError } from "../errors.js";
import type { Execute, ReportProgress } from "../jobs/index.js";
import { DEFAULT_AREA_CODES } from "./load-job.js";
import { DESSEM_COVERAGE_START } from "./ons/dessem-balance.js";
import type { RefreshTier } from "./resource-version.js";
import {
  type IngestTask,
  type IngestTaskResult,
  periodLabelOf,
  rowsOf,
  sourceOf,
} from "./tasks.js";
import { MODEL_COVERAGE_START, RUN_CYCLES } from "./weather/single-runs.js";

/**
 * The refresh regime — tiered to how ONS actually revises, not to how often we
 * would like to be current.
 *
 * The research measured three regimes in one publication history and they are
 * genuinely different problems:
 *
 * - The **live** periods, which ONS is still writing to, change on every cycle.
 * - **Recently closed** periods still move, but weekly is enough.
 * - **Closed history** looks settled and is not: 2021-10 was rewritten in May
 *   2024, the whole of 2025 in April–May 2026. Those bulk campaigns are the
 *   highest-impact revisions precisely because they silently restate data
 *   everyone has stopped watching, and a slow sweep over all closed history is
 *   the only thing that catches them.
 *
 * The sweep is affordable because acquisition is conditional: a closed month
 * that has not moved costs one `HEAD`, so a monthly pass over 27 years of six
 * datasets is a few hundred requests and no downloads.
 *
 * **Weather is the second exception, and a deeper one.** Its unit of
 * publication is a *model run*, not a period ONS keeps writing to, and a
 * published run is immutable: ECMWF never restates the 12Z run of a past day.
 * So the three tiers cannot mean what they mean everywhere else — there is no
 * revision to catch, and `history` in particular cannot mean campaign
 * detection, because a campaign is a thing this source cannot do. Rather than
 * give weather a slot in a vocabulary that does not describe it, the tiers are
 * **re-based from volatility to coverage of a bounded archive**:
 *
 * - `live` is the **publication edge** — the two target days whose runs are
 *   either just out or about to be. This is where a run is taken within the
 *   hour it appears, which is the only thing an operator waiting on a forecast
 *   cares about.
 * - `recent` is **repair**. The archive is not gapless (5 of 112 sampled slots
 *   were missing) and the job answers a missing run by falling back to an older
 *   one. A slot answered by a fallback is a slot still worth re-asking once the
 *   late run lands, and misses cluster in the last fortnight.
 * - `history` is **backfill and verification** over the whole archive, which is
 *   bounded — it starts 2024-03-14 — and therefore finishable. Like carga it
 *   takes a rolling slice per pass, for the same reason: there is no `HEAD`.
 *
 * What makes this affordable, and what makes the same slots plannable every
 * hour, is that weather's "nothing moved" probe is **local**: a run already
 * held is never re-fetched, because it cannot have changed
 * (`readHeldRunInits`). A slot only ever costs an HTTP call when WattSteer does
 * not hold the run that was asked for — so the tier ladder doubles as a
 * decaying *retry schedule* for an archive gap: hourly for two days, then
 * weekly for a fortnight, then monthly forever.
 *
 * **The carga API is the exception and is planned differently.** It publishes
 * no files, so there is no fingerprint and no cheap "nothing moved" probe — a
 * history sweep there means re-fetching and re-diffing every row. So its
 * history is covered by a *rolling slice*: each monthly pass takes one year and
 * the slices cycle, which completes a full pass over the series in under a year
 * of passes at a bounded cost per pass. Its compensation is real: `din_atualizacao`
 * makes a verificada revision visible per row once the bytes are in hand.
 */

/** Cron for each tier, in UTC, as the job scheduler registers it. */
export const REFRESH_CADENCE: Record<Exclude<RefreshTier, "manual">, string> = {
  // Hourly. ONS publishes twice a day (12h and 19h) but not punctually, and an
  // unchanged file costs one `HEAD`.
  live: "17 * * * *",
  // Monday, early. Recently-closed periods move on the scale of weeks.
  recent: "0 3 * * 1",
  // The first of the month. This is the bulk-campaign detector.
  history: "0 4 1 * *",
};

/** First year the year-split datasets cover — balanço, intercâmbio, carga diária. */
const YEARLY_COVERAGE_START = 2000;
/** First month of the wind constrained-off history. */
const WIND_COVERAGE_START = { year: 2021, month: 10 };
/** First month of the solar constrained-off history. */
const SOLAR_COVERAGE_START = { year: 2024, month: 4 };
/** First year the carga series covers, taking the earlier of the two. */
const CARGA_COVERAGE_START_YEAR = 2016;
/**
 * First target day the weather archive can answer.
 *
 * A target day is served by the runs of D−1, so the first day covered is the
 * day *after* the model's coverage begins. Asking for the day itself would
 * spend two calls to be told the archive starts tomorrow.
 */
const WEATHER_COVERAGE_START_DAY = isoDay(
  new Date(Date.parse(`${MODEL_COVERAGE_START}T00:00:00Z`) + 86_400_000),
);

/** Periods still being written to, re-fetched every cycle. */
const LIVE_MONTHS = 2;
const LIVE_YEARS = 2;
const LIVE_DAYS = 3;
/** Periods closed recently enough to still move, swept weekly. */
const RECENT_MONTHS = 3;
const RECENT_YEARS = 2;
const RECENT_DAYS = 45;
/** Days of carga re-fetched per cycle, and per weekly sweep. */
const CARGA_LIVE_DAYS = 7;
const CARGA_RECENT_DAYS = 90;
/**
 * The publication edge: today's target day and tomorrow's.
 *
 * Tomorrow is the point of the source — its runs initialise *today*, so D+1 is
 * the newest day the archive can answer at all — and today is kept because a
 * run that was missing when the sweep last passed may have landed since.
 */
const WEATHER_LIVE_DAYS = 2;
/** Target days the weekly pass re-asks, where fallbacks and misses cluster. */
const WEATHER_RECENT_DAYS = 14;
/** Target days one monthly history pass covers, cycling over the archive. */
const WEATHER_HISTORY_SLICE_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** A year-month, as the monthly datasets are split. */
interface YearMonth {
  year: number;
  month: number;
}

function monthOf(date: Date): YearMonth {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function shiftMonth({ year, month }: YearMonth, delta: number): YearMonth {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function isBefore(a: YearMonth, b: YearMonth): boolean {
  return a.year * 12 + a.month < b.year * 12 + b.month;
}

/** Every month in `[from, to]`, oldest first. */
function monthsBetween(from: YearMonth, to: YearMonth): YearMonth[] {
  const months: YearMonth[] = [];
  let cursor = from;
  while (!isBefore(to, cursor)) {
    months.push(cursor);
    cursor = shiftMonth(cursor, 1);
  }
  return months;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(now: Date, days: number): string {
  return isoDay(new Date(now.getTime() - days * MS_PER_DAY));
}

/** What a plan was computed for. */
export interface RefreshPlanOptions {
  tier: Exclude<RefreshTier, "manual">;
  now: Date;
  /**
   * Which slice of carga history this pass takes. Defaults to a value derived
   * from the month, so consecutive monthly passes cover consecutive years
   * without anything having to remember where the last one stopped.
   */
  historySlice?: number;
}

/**
 * Compute the tasks due for one tier — a pure function of the clock.
 *
 * Pure on purpose: the refresh regime is the single most consequential policy
 * in the platform, and it should be assertable without a database, a network or
 * a queue. A test can state "in the history tier, every closed month of the
 * wind history is planned exactly once" and have that be a fact about the
 * policy rather than about a run.
 */
export function planRefresh(options: RefreshPlanOptions): IngestTask[] {
  const { tier, now } = options;
  const thisMonth = monthOf(now);
  const thisYear = now.getUTCFullYear();
  const tasks: IngestTask[] = [];

  const yearly = (year: number) => {
    tasks.push({ kind: "energy_balance", payload: { year } });
    tasks.push({ kind: "interchange", payload: { year } });
    tasks.push({ kind: "daily_load", payload: { year } });
  };
  const monthly = (period: YearMonth) => {
    if (!isBefore(period, WIND_COVERAGE_START)) {
      tasks.push({ kind: "constrained_off", payload: { technology: "WIND", ...period } });
    }
    if (!isBefore(period, SOLAR_COVERAGE_START)) {
      tasks.push({
        kind: "constrained_off",
        payload: { technology: "SOLAR", ...period },
      });
    }
  };
  /** `n` days forward from `now`, inclusive of today at offset 0. */
  const daysAhead = (days: number): string =>
    isoDay(new Date(now.getTime() + days * MS_PER_DAY));
  const weather = (from: string, to: string) => {
    // Clamped rather than trusted: a window that reaches before the archive
    // begins is planned from its first covered day, and one that lies wholly
    // before it is not planned at all.
    const start = from < WEATHER_COVERAGE_START_DAY ? WEATHER_COVERAGE_START_DAY : from;
    if (to < start) {
      return;
    }
    tasks.push({
      kind: "weather",
      payload: { from: start, to, runCycles: [...RUN_CYCLES] },
    });
  };
  const carga = (from: string, to: string) => {
    for (const series of ["VERIFIED", "PROGRAMMED"] as const) {
      tasks.push({
        kind: "load",
        payload: { series, from, to, areaCodes: DEFAULT_AREA_CODES },
      });
    }
  };

  if (tier === "live") {
    for (let offset = 0; offset < LIVE_YEARS; offset += 1) {
      yearly(thisYear - offset);
    }
    for (let offset = 0; offset < LIVE_MONTHS; offset += 1) {
      monthly(shiftMonth(thisMonth, -offset));
    }
    tasks.push({
      kind: "dessem_balance",
      payload: { from: daysAgo(now, LIVE_DAYS), to: isoDay(now) },
    });
    carga(daysAgo(now, CARGA_LIVE_DAYS), isoDay(now));
    // The registry is overwritten in place twice a day and yesterday's cut is
    // unrecoverable, so it belongs in the tier that runs every cycle even
    // though it has no period at all.
    tasks.push({ kind: "plant_registry", payload: {} });
    // SIGA is the registry's twin: a daily extract overwritten in place, with
    // no period and no archive upstream, so yesterday's cut is unrecoverable
    // the moment it is replaced. Same tier, same reason.
    tasks.push({ kind: "siga", payload: {} });
    // The publication edge. Slots already held cost one local lookup, so
    // planning them every cycle is what buys the run being taken in within the
    // hour it appears rather than the day after.
    weather(isoDay(now), daysAhead(WEATHER_LIVE_DAYS - 1));
    return tasks;
  }

  if (tier === "recent") {
    for (let offset = LIVE_YEARS; offset < LIVE_YEARS + RECENT_YEARS; offset += 1) {
      yearly(thisYear - offset);
    }
    for (let offset = LIVE_MONTHS; offset < LIVE_MONTHS + RECENT_MONTHS; offset += 1) {
      monthly(shiftMonth(thisMonth, -offset));
    }
    tasks.push({
      kind: "dessem_balance",
      payload: { from: daysAgo(now, RECENT_DAYS), to: daysAgo(now, LIVE_DAYS) },
    });
    carga(daysAgo(now, CARGA_RECENT_DAYS), daysAgo(now, CARGA_LIVE_DAYS));
    // Repair: re-ask the fortnight where a fallback or a late publication is
    // most likely to have left a slot answered by an older run than the one
    // scheduled. Slots already answered exactly are skipped for free.
    weather(daysAgo(now, WEATHER_RECENT_DAYS), daysAgo(now, 1));
    return tasks;
  }

  // history — everything closed, on the slowest cadence. This is the tier that
  // catches a bulk re-publication campaign.
  const historyEnd = shiftMonth(thisMonth, -(LIVE_MONTHS + RECENT_MONTHS));
  for (
    let year = YEARLY_COVERAGE_START;
    year <= thisYear - (LIVE_YEARS + RECENT_YEARS);
    year += 1
  ) {
    yearly(year);
  }
  for (const period of monthsBetween(WIND_COVERAGE_START, historyEnd)) {
    monthly(period);
  }
  tasks.push({
    kind: "dessem_balance",
    payload: { from: DESSEM_COVERAGE_START, to: daysAgo(now, RECENT_DAYS) },
  });

  // Carga history: one year per pass, cycling. Re-fetching 10 years of
  // half-hourly load every month to find out that nothing moved is the one
  // thing the tiering is supposed to prevent, and this source cannot ask.
  const sliceCount = thisYear - CARGA_COVERAGE_START_YEAR + 1;
  const slice =
    options.historySlice ??
    (now.getUTCFullYear() * 12 + now.getUTCMonth()) % Math.max(1, sliceCount);
  const sliceYear = CARGA_COVERAGE_START_YEAR + (slice % Math.max(1, sliceCount));
  carga(`${sliceYear}-01-01`, `${sliceYear}-12-31`);

  // Weather history: backfill and verification over a *finite* archive, one
  // rolling slice per pass. The slice exists for carga's reason — no cheap
  // remote probe — and the cycling exists because the archive is bounded: at 90
  // days a pass, the whole of it is re-examined in well under a year, and every
  // pass that finds nothing missing spends nothing.
  const historyEndDay = daysAgo(now, WEATHER_RECENT_DAYS + 1);
  const weatherSliceCount = Math.max(
    1,
    Math.ceil(
      (Date.parse(`${historyEndDay}T00:00:00Z`) -
        Date.parse(`${WEATHER_COVERAGE_START_DAY}T00:00:00Z`)) /
        (WEATHER_HISTORY_SLICE_DAYS * MS_PER_DAY),
    ),
  );
  const weatherSlice = (options.historySlice ?? slice) % weatherSliceCount;
  const sliceStart =
    Date.parse(`${WEATHER_COVERAGE_START_DAY}T00:00:00Z`) +
    weatherSlice * WEATHER_HISTORY_SLICE_DAYS * MS_PER_DAY;
  const sliceEnd = Math.min(
    sliceStart + (WEATHER_HISTORY_SLICE_DAYS - 1) * MS_PER_DAY,
    Date.parse(`${historyEndDay}T00:00:00Z`),
  );
  weather(isoDay(new Date(sliceStart)), isoDay(new Date(sliceEnd)));

  return tasks;
}

/** A bulk re-publication campaign — many settled resources rewritten at once. */
export interface RepublicationCampaign {
  /** Resources whose bytes were replaced after standing settled. */
  resources: number;
  /** Datasets involved, so "the whole of 2025" reads as what it is. */
  datasets: string[];
  /** The longest a replaced version had stood, in days. */
  maxSettledDays: number;
}

/** A campaign needs this many settled resources rewritten in one sweep. */
export const CAMPAIGN_MIN_RESOURCES = 3;
/** …each having stood unchanged at least this long. */
export const CAMPAIGN_MIN_SETTLED_DAYS = 45;

export interface RefreshSweepPayload {
  tier: Exclude<RefreshTier, "manual">;
  /** Overridable so a sweep can be planned at a chosen instant in a test. */
  now?: string;
  /** Re-download and re-diff every planned period, ignoring fingerprints. */
  force?: boolean;
  /** Which carga history slice this pass takes; see `planRefresh`. */
  historySlice?: number;
}

export interface RefreshSweepResult {
  tier: RefreshTier;
  planned: number;
  succeeded: number;
  failed: number;
  resourcesProbed: number;
  resourcesDownloaded: number;
  rowsInserted: number;
  rowsRevised: number;
  rowsUnchanged: number;
  /** Resources found rewritten under the same name during this sweep. */
  republications: number;
  /** Set when the re-publications look like a campaign rather than an edit. */
  campaign: RepublicationCampaign | null;
  /** Source and period of each task that failed, so a sweep is debuggable. */
  failures: { source: string; period: string | null; error: string }[];
}

export interface RefreshSweepDeps {
  db: Database;
  /**
   * How one planned task is executed. Injected rather than imported so the
   * sweep can run tasks in-process, hand them to the queue, or be tested
   * against a stub — and so this module does not depend on every ingestor.
   */
  run: (task: IngestTask, report: ReportProgress) => Promise<IngestTaskResult>;
}

/**
 * Drive one tier of the refresh regime, recording a run per task.
 *
 * **One failed period does not stop the sweep.** A history pass covers hundreds
 * of files; a single 404 or a single malformed month must not prevent the other
 * three hundred from being checked, because the sweep's whole value is
 * coverage. Failures are recorded per run and returned in the summary, so they
 * are loud without being fatal.
 */
export function createRefreshSweep(
  deps: RefreshSweepDeps,
): Execute<RefreshSweepPayload, RefreshSweepResult> {
  return async (payload, report) => {
    const now = payload.now ? new Date(payload.now) : new Date();
    const tasks = planRefresh({
      tier: payload.tier,
      now,
      historySlice: payload.historySlice,
    });

    const result: RefreshSweepResult = {
      tier: payload.tier,
      planned: tasks.length,
      succeeded: 0,
      failed: 0,
      resourcesProbed: 0,
      resourcesDownloaded: 0,
      rowsInserted: 0,
      rowsRevised: 0,
      rowsUnchanged: 0,
      republications: 0,
      campaign: null,
      failures: [],
    };

    const runIds: string[] = [];
    for (const [index, task] of tasks.entries()) {
      const source = sourceOf(task);
      const periodLabel = periodLabelOf(task);
      const [run] = await deps.db
        .insert(ingestionRun)
        .values({ source, tier: payload.tier, periodLabel, status: "running" })
        .returning({ id: ingestionRun.id });
      const runId = run?.id;
      if (runId) {
        runIds.push(runId);
      }

      // The tier travels with the task. A re-publication found here is then
      // attributable to the sweep that found it, which is what makes "the
      // history sweep found this" — the evidence that a settled period was
      // rewritten — a queryable fact rather than an inference.
      // The tier travels with the task, but only where it can mean something.
      // `context` attributes a *re-publication of a resource* to the sweep that
      // found it, and two sources have no resource to re-publish: the carga API
      // serves no file, and a model run is immutable. Weather still takes
      // `force`, which for it means "re-fetch a run already held".
      const contextual: IngestTask =
        task.kind === "load"
          ? task
          : task.kind === "weather"
            ? {
                ...task,
                payload: {
                  ...task.payload,
                  force: payload.force || task.payload.force,
                },
              }
            : ({
                ...task,
                payload: {
                  ...task.payload,
                  force: payload.force || task.payload.force,
                  context: { tier: payload.tier, runId },
                },
              } as IngestTask);

      try {
        const outcome = await deps.run(contextual, () => {});
        const rows = rowsOf(outcome);
        result.succeeded += 1;
        result.resourcesProbed += rows.probed;
        result.resourcesDownloaded += rows.downloaded;
        result.rowsInserted += rows.inserted;
        result.rowsRevised += rows.revised;
        result.rowsUnchanged += rows.unchanged;
        if (runId) {
          await deps.db
            .update(ingestionRun)
            .set({
              status: "ok",
              finishedAt: new Date(),
              resourcesProbed: rows.probed,
              resourcesDownloaded: rows.downloaded,
              rowsParsed: rows.parsed,
              rowsInserted: rows.inserted,
              rowsRevised: rows.revised,
              rowsUnchanged: rows.unchanged,
            })
            .where(eq(ingestionRun.id, runId));
        }
      } catch (error) {
        const message = toHttpError(error).body.error;
        result.failed += 1;
        result.failures.push({ source, period: periodLabel, error: message });
        if (runId) {
          await deps.db
            .update(ingestionRun)
            .set({ status: "failed", finishedAt: new Date(), errorMessage: message })
            .where(eq(ingestionRun.id, runId));
        }
      }

      report({ done: index + 1, total: tasks.length });
    }

    if (runIds.length > 0) {
      const found = await deps.db
        .select({
          datasetSlug: resourceRepublication.datasetSlug,
          settledDays: resourceRepublication.settledDays,
        })
        .from(resourceRepublication)
        .where(inArray(resourceRepublication.runId, runIds));

      result.republications = found.length;
      const settled = found.filter((row) => row.settledDays >= CAMPAIGN_MIN_SETTLED_DAYS);
      if (settled.length >= CAMPAIGN_MIN_RESOURCES) {
        result.campaign = {
          resources: settled.length,
          datasets: [...new Set(settled.map((row) => row.datasetSlug))].sort(),
          maxSettledDays: Math.max(...settled.map((row) => row.settledDays)),
        };
      }

      // Attribute the republications to the runs that found them, so the health
      // view can show them per source without a second join.
      await deps.db.execute(sql`
        update ingestion_run r
        set republications = coalesce((
          select count(*) from resource_republication p where p.run_id = r.id
        ), 0)
        where r.id in (${sql.join(
          runIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `);
    }

    if (result.campaign) {
      // Surfaced, not absorbed. The whole point of the slow sweep is that this
      // sentence gets said out loud somewhere.
      console.warn(
        `⚠️  Bulk re-publication campaign: ${result.campaign.resources} settled resources ` +
          `rewritten across ${result.campaign.datasets.join(", ")} ` +
          `(oldest stood ${result.campaign.maxSettledDays} days)`,
      );
    }

    return result;
  };
}

/** Re-publications observed since `since` — the campaign log, for the health view. */
export async function readRepublications(
  db: Database,
  since: Date,
  tier?: RefreshTier,
): Promise<
  {
    datasetSlug: string;
    resourceName: string;
    settledDays: number;
    detectedAt: Date;
    tier: RefreshTier | null;
  }[]
> {
  const rows = await db
    .select({
      datasetSlug: resourceRepublication.datasetSlug,
      resourceName: resourceRepublication.resourceName,
      settledDays: resourceRepublication.settledDays,
      detectedAt: resourceRepublication.detectedAt,
      tier: resourceRepublication.tier,
    })
    .from(resourceRepublication)
    .where(
      tier
        ? and(
            gte(resourceRepublication.detectedAt, since),
            eq(resourceRepublication.tier, tier),
          )
        : gte(resourceRepublication.detectedAt, since),
    )
    .orderBy(resourceRepublication.detectedAt);
  return rows;
}
