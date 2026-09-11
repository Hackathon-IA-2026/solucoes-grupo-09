import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import type { SubsystemCode } from "@wattsteer/core/domain";
import { GRID_TIME_ZONE } from "@wattsteer/core/scenario-validation";
import type { MlEndpoint } from "../api/ml-proxy.js";
import { postMl } from "../api/ml-proxy.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { PUBLICATION_LANES } from "./publication.js";
import type { Execute, JobSchedule, ReportProgress } from "./types.js";

/**
 * The nightly recompute of the two Replay caches, as work the queue owns.
 *
 * `.scratch/replay/issues/07-featured-days-not-a-highlight-reel.md` and
 * `.scratch/replay/issues/08-backtest-aggregate.md` had every piece built and
 * nothing running them. `POST /internal/replay/featured-days` and
 * `POST /internal/replay/backtest` exist on the modelling service, are covered
 * by its tests, and had **no caller**: no `WorkerTask` member, no branch, no
 * schedule, no cron. So `GET /v1/replay/days` served its `pending` payload —
 * the one that names this job in its own response body — and `GET /v1/backtest`
 * served its own, permanently, on every deployed instance. This module is the
 * caller, and `docs/specs/api-surface.md`'s `refresh-featured-days | 30 3 * * *`
 * row is true of the repository for the first time because of it.
 *
 * Five things live here and nowhere else.
 *
 * 1. **One task kind carries both caches.** Replay 08 says so in as many
 *    words — "the same task should carry both" — and the reason is that they
 *    are one omission rather than two: both caches are process-local on the
 *    modelling service, both are filled only from an `/internal` route, and
 *    both are a replay of the same window against the same `REFERENCE_FLEET`.
 *    Two task kinds would be two schedules that could drift into refreshing a
 *    shortlist against one night's rows and an aggregate against another's.
 *
 * 2. **Nothing is written here.** Both routes compute and cache and return;
 *    neither touches Postgres for a write, and this job appends no row. That is
 *    what makes a retry free and makes the failure policy below safe: the whole
 *    job is idempotent by construction rather than by a digest.
 *
 * 3. **The fan-out is (subsystem × served lane), and it is derived.** One
 *    shortlist per subsystem, because the days that were interesting in the
 *    Northeast are not the days that were interesting in the South; one per
 *    lane, because post-go-live a served day has one candidate forecast per
 *    served lane and `/v1/replay/days` requires the caller to name which. The
 *    subsystems come from `SUBSYSTEM_DISPLAY_ORDER` and the lanes from
 *    `PUBLICATION_LANES`, so a fifth subsystem or a third served lane is
 *    scheduled the day it is added rather than the day someone remembers.
 *
 * 4. **When it runs.** `30 3 * * *` in Brasília civil time, which is the row
 *    `docs/specs/api-surface.md` already published. Brasília rather than UTC,
 *    unlike the retrain and the backfill, because that table's column says
 *    `Cron (America/Sao_Paulo)` and the shortlist's window is a count of
 *    civil days; 03:30 is after the late gate's publication and its
 *    diagnosis follow-on have long finished and well before the 09:10 one.
 *
 * 5. **A refusal is a finished run; an outage is a retry.** See
 *    `statedAbsence`. `REPLAY_FORECAST_UNAVAILABLE` from the featured-days
 *    rule means the window holds no replayable day for that (subsystem, lane) —
 *    true before go-live and true of a lane nothing has backfilled, and a
 *    condition that does not improve by being asked again at 03:31. It is
 *    logged and the run goes on to the next pair. An unreachable service, a
 *    timeout or a 5xx is rethrown so the queue's backoff retries it.
 *
 * ### The one thing this job cannot promise, said out loud
 *
 * Both caches are **process-local** to the modelling service — `app.py` says so
 * and argues for it: a shortlist is derived rather than recorded, evictable at
 * any time with no loss beyond a recompute. So a refresh reaches the replica
 * that answered it, and a modelling service scaled past one replica has the
 * others still serving `pending` until they are refreshed in their turn. That
 * is a property of the cache's design and not something a scheduler can fix
 * from this side; what this module guarantees is that the job exists, runs
 * nightly, and fills the instance it reaches.
 */

/** The zone the cron pattern is read in. Brasília civil time — see above. */
export const REPLAY_REFRESH_TIME_ZONE = GRID_TIME_ZONE;

/** Half past three in the morning, every day, Brasília. The spec's own row. */
export const REPLAY_REFRESH_PATTERN = "30 3 * * *";

/**
 * The stable id prefix of the queue's repeatable refreshes.
 *
 * `refresh-featured-days` and not `refresh-replay-caches`, because
 * `docs/specs/api-surface.md`'s scheduled-jobs table names the job that and a
 * job an operator cannot find by the name the spec gave it is a job they will
 * conclude does not exist — which is exactly the state this module ends.
 */
export const REPLAY_REFRESH_JOB_PREFIX = "refresh-featured-days";

/** The modelling service's routes. Worker-only; no gateway path reaches them. */
export const FEATURED_DAYS_PATH = "/internal/replay/featured-days";
export const BACKTEST_PATH = "/internal/replay/backtest";

/**
 * How long the worker waits for one recompute.
 *
 * A recompute replays every replayable day against the published
 * `REFERENCE_FLEET` — 24.4 ms each, measured, ~13 s over the 521 days
 * replayable when replay 07 was written. Ten minutes is an upper bound on a
 * healthy run over a window that keeps growing rather than an expectation of
 * one, and it is deliberately far above `config.mlTimeoutMs`, whose five
 * seconds are the reason this is a nightly job and not a request.
 */
export const REPLAY_REFRESH_TIMEOUT_MS = 10 * 60_000;

/** What the queue carries for one refresh. */
export interface ReplayRefreshPayload {
  /** ONS subsystem code — one shortlist and one aggregate per subsystem. */
  subsystem: SubsystemCode;
  /** The lane directory name — `dessem_free_v1__gate_late__thr5`. */
  lane: string;
}

/** What one cache's recompute did. */
export type ReplayCacheOutcome =
  | { cache: "featured_days" | "backtest"; filled: true; computationId: string }
  | { cache: "featured_days" | "backtest"; filled: false; reason: string };

/** What one refresh run did, in the shape a job log should read. */
export interface ReplayRefreshResult {
  subsystem: string;
  lane: string;
  outcomes: ReplayCacheOutcome[];
}

/** Injected so the call can be observed without a modelling service. */
export interface ReplayRefresherDeps {
  /** Where the modelling service is. Absent means `config.mlUrl` at the timeout. */
  endpoint?: MlEndpoint;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Whether this failure is the run's answer or the run not happening.
 *
 * The distinction the retrain already draws, in its own vocabulary: a *refusal*
 * is a successful run whose answer is an absence, and what is retried is the
 * run that reached no answer at all. `REPLAY_FORECAST_UNAVAILABLE` is the
 * featured-days rule saying the window holds no replayable day for this
 * (subsystem, lane); asking again in a minute cannot change that, and a nightly
 * job that retried it would turn a pre-go-live lane into a backoff storm.
 * Everything at 5xx — `DATA_UNAVAILABLE` when the service cannot reach
 * Postgres, the integrity `500` the shortlist raises rather than silently
 * dropping a leaking day, an unreachable service, a timeout — is the run not
 * having happened, and is rethrown.
 */
function statedAbsence(error: unknown): string | null {
  if (!(error instanceof AppError)) {
    return null;
  }
  if (error.status >= 500) {
    return null;
  }
  const upstream = error.details?.upstream_code;
  const code = typeof upstream === "string" ? upstream : error.code;
  return `${code}: ${error.message}`;
}

/** One POST at one route, and the computation id it answered with. */
async function refreshOne(
  path: string,
  cache: "featured_days" | "backtest",
  payload: ReplayRefreshPayload,
  endpoint: MlEndpoint,
): Promise<ReplayCacheOutcome> {
  let response: Response;
  try {
    response = await postMl(
      path,
      JSON.stringify({ subsystem: payload.subsystem, lane: payload.lane }),
      endpoint,
    );
  } catch (error) {
    const absence = statedAbsence(error);
    if (absence === null) {
      // Rethrown as itself so the queue's backoff retries it and the modelling
      // service's own code survives the crossing.
      throw error;
    }
    console.warn(
      `⚠️  ${cache} ${payload.subsystem} ${payload.lane} was not recomputed — ${absence}`,
    );
    return { cache, filled: false, reason: absence };
  }
  const body: unknown = await response.json();
  const envelope = (body ?? {}) as { computation_id?: unknown };
  return {
    cache,
    filled: true,
    computationId: text(envelope.computation_id),
  };
}

/**
 * Build the handler the worker runs for a `refresh_replay_caches` task.
 *
 * The two caches are refreshed in the order a reader meets them — the shortlist
 * the Time Machine opens on, then the aggregate in its footer — and the second
 * runs whether or not the first found anything, because a lane with no featured
 * day can still have a fold with a backtest row and a job that stopped at the
 * first absence would make that unreachable.
 */
export function createReplayRefresher(
  deps: ReplayRefresherDeps = {},
): Execute<ReplayRefreshPayload, ReplayRefreshResult> {
  return async (
    payload: ReplayRefreshPayload,
    report: ReportProgress,
  ): Promise<ReplayRefreshResult> => {
    const endpoint = deps.endpoint ?? {
      baseUrl: config.mlUrl,
      timeoutMs: REPLAY_REFRESH_TIMEOUT_MS,
    };
    report({ done: 0, total: 2 });
    const featured = await refreshOne(
      FEATURED_DAYS_PATH,
      "featured_days",
      payload,
      endpoint,
    );
    report({ done: 1, total: 2 });
    const backtest = await refreshOne(BACKTEST_PATH, "backtest", payload, endpoint);
    report({ done: 2, total: 2 });
    for (const outcome of [featured, backtest]) {
      if (outcome.filled) {
        console.log(
          `✅ ${outcome.cache} ${payload.subsystem} ${payload.lane}: ` +
            `${outcome.computationId || "(no computation id)"}`,
        );
      }
    }
    return {
      subsystem: payload.subsystem,
      lane: payload.lane,
      outcomes: [featured, backtest],
    };
  };
}

/**
 * Every (subsystem, lane) the nightly refresh covers, in a stable order.
 *
 * Derived from the two published constants rather than listed, for the reason
 * the reachability guard gives about allow-lists: a fifth subsystem or a third
 * served lane is covered the day it is added, and nobody has to remember this
 * file. `SUBSYSTEM_DISPLAY_ORDER` outer and the lanes inner, so the ids read
 * subsystem-first the way every other subsystem-grained surface does.
 */
export function replayRefreshTargets(): ReplayRefreshPayload[] {
  const lanes = Object.values(PUBLICATION_LANES).sort();
  return SUBSYSTEM_DISPLAY_ORDER.flatMap((subsystem) =>
    lanes.map((lane) => ({ subsystem, lane })),
  );
}

/**
 * The repeatable refreshes, as `JobSchedule`s over any task union.
 *
 * One schedule per (subsystem, lane) rather than one job that loops over all of
 * them, and that is the same choice `FORECAST_PUBLICATIONS` makes for the two
 * gates: a pair that refuses is one job in the queue's own failure list rather
 * than a line in a log nobody reads, and a pair that has to be re-run by hand
 * is re-submitted on its own without recomputing the seven others. The ids are
 * stable, so N worker replicas starting at once converge on one schedule apiece
 * rather than N.
 */
export function replayRefreshSchedules<TPayload>(
  wrap: (payload: ReplayRefreshPayload) => TPayload,
): JobSchedule<TPayload>[] {
  return replayRefreshTargets().map((payload) => ({
    id: `${REPLAY_REFRESH_JOB_PREFIX}:${payload.subsystem}:${payload.lane}`,
    pattern: REPLAY_REFRESH_PATTERN,
    timeZone: REPLAY_REFRESH_TIME_ZONE,
    payload: wrap(payload),
  }));
}
