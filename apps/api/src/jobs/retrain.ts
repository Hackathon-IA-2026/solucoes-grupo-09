import type { MlEndpoint } from "../api/ml-proxy.js";
import { postMl } from "../api/ml-proxy.js";
import { config } from "../config.js";
import { AppError, CodedError } from "../errors.js";
import type { Execute, JobSchedule, ReportProgress } from "./types.js";

/**
 * The weekly retrain, as work the schedule owns.
 *
 * `docs/specs/forecaster.md`'s **seam 11 — live, scheduled**. Forecaster 19 left
 * the retrain gated but unscheduled: `run_serving_lanes` runs both lanes in one
 * pass and neither can block the other, and nothing called it. This module is
 * the cron entry that does — the *only* one, on the queue the worker already
 * owns, because `docs/specs/data-platform.md` is emphatic that the one thing
 * worse than no scheduler is a second one.
 *
 * Three things live here and nowhere else.
 *
 * 1. **When it runs.** One repeatable job, Fridays at 03:10 UTC. That is where
 *    `docs/specs/forecaster.md`'s own artifact stems put it —
 *    `2026-08-28T03:11:07Z` and `2026-08-21T03:09:44Z`, two Fridays a week
 *    apart, a minute past three — and it is what user story 18 means by "a
 *    promotion is not a judgement call at 03:00". 03:10 UTC is 00:10 in
 *    Brasília, so the civil day has just turned and the retrain's newest target
 *    date, `as_of − 1`, is a day whose labels have settled. It is also nine
 *    hours ahead of the 09:10 BRT publication, so a Friday promotion is serving
 *    by the morning gate.
 *
 *    **UTC, not Brasília** — unlike the two publications. The publication instant
 *    is a civil fact about the Brazilian grid and has to follow Brasília's
 *    clock; a retrain is an internal job whose only clock constraint is that it
 *    finishes before the next gate, and the artifact ids it mints are UTC stems.
 *    Reading the pattern in Brasília would make those stems move with a
 *    time-zone rule for no gain.
 *
 * 2. **What identifies the run.** Not the instant the handler happened to start:
 *    `retrainRunId` floors the clock to the schedule's own hour and minute, so
 *    every attempt of one firing computes the *same* id. That id is the artifact
 *    stem in both lanes, and the modelling service short-circuits a lane that
 *    already carries a decision line for it — which is what makes "appends
 *    exactly one decision line per run" survive a redelivery, a backoff retry
 *    and a hand-submitted catch-up.
 *
 * 3. **What a failure means.** See `describeFailure`: a lane that *refused* is a
 *    successful run and comes back 200 with the refusal named, because a gate
 *    that refuses is the gate working. What is retried is the run that reached
 *    no decision at all.
 */

/** The zone the cron pattern is read in. UTC, deliberately — see above. */
export const RETRAIN_TIME_ZONE = "Etc/UTC";

/** Friday, ten past three in the morning, UTC. */
export const RETRAIN_PATTERN = "10 3 * * 5";

/** The hour and minute `RETRAIN_PATTERN` fires at, for `retrainRunId`. */
export const RETRAIN_HOUR = 3;
export const RETRAIN_MINUTE = 10;

/** The stable id of the queue's one repeatable retrain. */
export const RETRAIN_JOB_ID = "retrain:serving-lanes";

/**
 * How long the worker waits for the modelling service to finish.
 *
 * Not `config.mlTimeoutMs`, whose ceiling is 60 s and whose purpose is an
 * interactive solve, and not `PUBLISH_TIMEOUT_MS`'s two minutes either. A run is
 * six LightGBM fits per lane over two and a half years of hourly rows for four
 * subsystems, twice, plus a 2,000-draw paired bootstrap. Forty minutes is an
 * upper bound on a healthy run rather than an expectation of one, and the
 * wall-clock the card records is what turns "how long does it actually take"
 * from a guess into a measurement.
 */
export const RETRAIN_TIMEOUT_MS = 40 * 60_000;

/** The modelling service's route. Worker-only; no gateway path reaches it. */
export const RETRAIN_PATH = "/internal/retrain";

/** What the queue carries for one retrain. */
export interface RetrainPayload {
  /**
   * The run's identity, and the artifact stem in every lane. Absent means "the
   * scheduled instant this attempt belongs to", resolved by `retrainRunId` when
   * the job runs — which is what the repeatable job carries, so a schedule
   * registered once does not pin an instant it will still be asking for a year
   * later.
   */
  runId?: string;
  /**
   * Whether the baseline ladder is fitted beside the served model. Only a
   * time-boxed rerun sets this false; the schedule does not, because the ladder
   * is where the cold-start bar comes from and a first artifact has nothing to
   * be measured against without it.
   */
  ladder?: boolean;
}

/**
 * The instant a run belongs to: `now` floored to the schedule's hour and minute.
 *
 * **Stable across attempts, which is the whole point.** BullMQ hands the same
 * job back after a failure, and a handler that read its own clock would mint a
 * new artifact id on every attempt — two bundles, two cards and two decision
 * lines for one Friday, none of them recognisable as retries of each other. The
 * floor is to the day rather than to the week so that a hand-submitted catch-up
 * on a Tuesday is still a run with a well-defined id; the *schedule* only fires
 * on Fridays.
 */
export function retrainRunId(now: Date): string {
  const instant = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      RETRAIN_HOUR,
      RETRAIN_MINUTE,
      0,
      0,
    ),
  );
  // A run that fires a hair before its own scheduled minute — clock skew, or a
  // queue that ran slightly early — belongs to the previous day's instant, not
  // to one that has not happened yet.
  if (instant.getTime() > now.getTime()) {
    instant.setUTCDate(instant.getUTCDate() - 1);
  }
  return `${instant.toISOString().slice(0, 19)}Z`;
}

/** One lane's turn, as the modelling service reports it. */
export interface RetrainLaneResult {
  lane: string;
  gateProfile: string;
  status: "promoted" | "refused" | "no_candidate" | "failed";
  artifactId: string | null;
  reason: string;
}

/** What one retrain run did, in the shape a job log should read. */
export interface RetrainResult {
  runId: string;
  lanes: RetrainLaneResult[];
  /** The lanes that promoted — usually none, and that is the gate working. */
  promoted: string[];
  wallClockSeconds: number | null;
  peakRssMb: number | null;
}

export interface RetrainerDeps {
  /**
   * Where the modelling service is. Absent means `config.mlUrl` at the retrain
   * timeout — overridable so a test can point at a stub over a real socket.
   */
  endpoint?: MlEndpoint;
  /** The clock, injected so "which run is this" is testable. */
  now?: () => Date;
}

/**
 * Why a retrain did not happen, in the operator's vocabulary.
 *
 * The distinction that matters is between *the run failed* and *the gate said
 * no*. A refusal is not in here at all: it comes back 200, it is on the card and
 * in `promotions.jsonl`, and the incumbent goes on serving — which is the
 * system behaving exactly as `docs/specs/forecaster.md` designs it. What this
 * function names is the cases where no decision was reached, and whether the
 * repair is to wait or to go and look.
 */
function describeFailure(error: unknown): string {
  const app = error instanceof AppError ? error : undefined;
  // `RETRAIN_IN_PROGRESS` and `RETRAIN_FAILED` are the modelling service's own
  // codes and are deliberately **not** added to `packages/core`'s enum: that
  // enum is the public API's closed set, and neither of these can ever reach a
  // client — no route on the gateway retrains. `ml-proxy` carries them through
  // as `details.upstream_code` under `UPSTREAM_REJECTED` / `UPSTREAM_FAILED`,
  // which is exactly what that field is for.
  const upstream = app?.details?.upstream_code;
  const code = typeof upstream === "string" ? upstream : app?.code;
  switch (code) {
    case "RETRAIN_IN_PROGRESS":
      return (
        "this run is already in flight on the modelling service — the previous " +
        "attempt has not finished. The queue will retry, and the retry after the " +
        "first one lands will find its decision line and append nothing"
      );
    case "DATA_UNAVAILABLE":
      return "the modelling service cannot reach Postgres";
    case "REQUEST_INVALID":
      return "the run id is not an artifact stem — a bug on this side, not an outage";
    case "OPTIMIZER_TIMEOUT":
      return (
        `the retrain did not finish inside ${RETRAIN_TIMEOUT_MS / 60_000} minutes. ` +
        "The run may still be completing on the modelling service; the retry is " +
        "idempotent on the run id, so it will not produce a second artifact"
      );
    default:
      return `the retrain did not complete: ${
        error instanceof Error ? error.message : String(error)
      }`;
  }
}

interface ServiceLane {
  lane?: unknown;
  gate_profile?: unknown;
  status?: unknown;
  artifact_id?: unknown;
  reason?: unknown;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function parseReport(body: unknown, runId: string): RetrainResult {
  if (typeof body !== "object" || body === null) {
    throw new CodedError("UPSTREAM_FAILED", "the retrain returned no report");
  }
  const payload = body as {
    lanes?: unknown;
    promoted?: unknown;
    resources?: { wall_clock_seconds?: unknown; peak_rss_mb?: unknown };
  };
  const lanes = Array.isArray(payload.lanes) ? (payload.lanes as ServiceLane[]) : [];
  return {
    runId,
    lanes: lanes.map((lane) => ({
      lane: text(lane.lane),
      gateProfile: text(lane.gate_profile),
      status: text(lane.status) as RetrainLaneResult["status"],
      artifactId: typeof lane.artifact_id === "string" ? lane.artifact_id : null,
      reason: text(lane.reason),
    })),
    promoted: Array.isArray(payload.promoted)
      ? payload.promoted.filter((one): one is string => typeof one === "string")
      : [],
    wallClockSeconds: number(payload.resources?.wall_clock_seconds),
    peakRssMb: number(payload.resources?.peak_rss_mb),
  };
}

/**
 * Build the handler the worker runs for a `retrain` task.
 *
 * The call is **worker → modelling service** and nothing is written to Postgres
 * by either side: a retrain's output is an artifact on the volume, a card, and a
 * line in `promotions.jsonl`. Nothing under `src/api/` imports this module, so
 * "only the worker retrains" stays a property of the import graph rather than a
 * rule someone has to remember.
 */
export function createRetrainer(
  deps: RetrainerDeps = {},
): Execute<RetrainPayload, RetrainResult> {
  const clock = deps.now ?? (() => new Date());

  return async (
    payload: RetrainPayload,
    report: ReportProgress,
  ): Promise<RetrainResult> => {
    const runId = payload.runId ?? retrainRunId(clock());
    const endpoint = deps.endpoint ?? {
      baseUrl: config.mlUrl,
      timeoutMs: RETRAIN_TIMEOUT_MS,
    };
    report({ done: 0, total: 1 });
    let response: Response;
    try {
      response = await postMl(
        RETRAIN_PATH,
        JSON.stringify({
          run_id: runId,
          ...(payload.ladder === undefined ? {} : { ladder: payload.ladder }),
        }),
        endpoint,
      );
    } catch (error) {
      console.warn(`⚠️  retrain ${runId} — ${describeFailure(error)}`);
      // Rethrown as itself so the queue's backoff policy retries it, and so the
      // modelling service's own code survives the crossing.
      throw error;
    }
    const result = parseReport(await response.json(), runId);
    report({ done: 1, total: 1 });
    for (const lane of result.lanes) {
      const mark = lane.status === "promoted" ? "✅" : "•";
      console.log(
        `${mark} retrain ${runId} ${lane.lane}: ${lane.status} — ${lane.reason}`,
      );
    }
    return result;
  };
}

/**
 * The one repeatable retrain, as a `JobSchedule` over the worker's task union.
 *
 * Registering is idempotent — the id is stable, so N replicas starting at once
 * converge on one schedule rather than N — and it is BullMQ's job scheduler that
 * makes the run leader-safe, which is the whole reason the repeatable job lives
 * on the queue rather than beside it.
 */
export function retrainSchedules<TPayload>(
  wrap: (payload: RetrainPayload) => TPayload,
): JobSchedule<TPayload>[] {
  return [
    {
      id: RETRAIN_JOB_ID,
      // `config.retrainPattern` is the operator's catch-up lever: the id is
      // stable, so an override re-registers this schedule rather than adding a
      // second one, and clearing the variable restores the weekly cadence.
      pattern: config.retrainPattern ?? RETRAIN_PATTERN,
      timeZone: RETRAIN_TIME_ZONE,
      payload: wrap({}),
    },
  ];
}
