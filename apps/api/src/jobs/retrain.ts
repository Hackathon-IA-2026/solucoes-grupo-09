import type { MlEndpoint } from "../api/ml-proxy.js";
import { callMl, postMl } from "../api/ml-proxy.js";
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
 *    `retrainRunId` floors the clock to **the pattern in force**, so every
 *    attempt of one firing computes the *same* id. That id is the artifact stem
 *    in both lanes, and the modelling service short-circuits a lane that already
 *    carries a decision line for it — which is what makes "appends exactly one
 *    decision line per run" survive a redelivery and a backoff retry.
 *
 *    **It reads the pattern rather than two constants — forecaster 44.** Flooring
 *    to a pair of constants regardless of the schedule meant an
 *    operator's catch-up pattern minted the id the morning's scheduled run had
 *    already used, so every lane short-circuited as a retry of it and the
 *    catch-up could not produce a run.
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

/** The stable id of the queue's one repeatable retrain. */
export const RETRAIN_JOB_ID = "retrain:serving-lanes";

/**
 * How long the worker is prepared to wait for a run to reach a decision.
 *
 * A run is six LightGBM fits per lane over two and a half years of hourly rows
 * for four subsystems, twice, plus a 2,000-draw paired bootstrap. Forty minutes
 * is an upper bound on a healthy run rather than an expectation of one, and the
 * wall-clock the card records is what turns "how long does it actually take"
 * from a guess into a measurement.
 *
 * **Three hours, and it was forty minutes.** The measurement arrived: on
 * production 2026-09-23 a two-lane retrain was still `running` when the worker
 * gave up at 2 400 s and reached its decision at about 3 600 — both lanes
 * refused on guardrails, which is a verdict the queue recorded as a timeout.
 * Forty minutes had never been measured; it was the number this comment
 * already calls a guess.
 *
 * **Forecaster 45 made this number mean what it says.** It used to be the
 * timeout on *one* HTTP request, and a request that transmits no bytes for
 * twelve minutes is not a shape this deployment's internal networking will
 * hold: measured on 2026-09-15, the call aborted after exactly 300 s while the
 * modelling service went on training and completed. A ceiling nothing enforces
 * is worse than no ceiling, because the failure it produces names a duration
 * that never elapsed. It now bounds a *sequence of short requests*, each of
 * which the network is perfectly willing to carry.
 */
export const RETRAIN_TIMEOUT_MS = 3 * 60 * 60_000;

/**
 * How long any single call to the modelling service may take.
 *
 * Every request in the new shape is a status read or a start — hundreds of
 * bytes, answered immediately — so this is sized for a slow network rather than
 * for a slow run, and it is comfortably under the 300 s ceiling the platform
 * turned out to enforce between the two services.
 */
export const RETRAIN_REQUEST_TIMEOUT_MS = 30_000;

/** The first gap between polls, and the longest one the backoff grows to. */
export const RETRAIN_POLL_MIN_MS = 2000;
export const RETRAIN_POLL_MAX_MS = 30_000;

/** The modelling service's route. Worker-only; no gateway path reaches it. */
export const RETRAIN_PATH = "/internal/retrain";

/**
 * The status route, written exactly as `apps/ml` declares it.
 *
 * A template rather than a string built at the call site, because
 * `test/reachability.ts` reads every `/internal/` route the modelling service
 * declares and requires that some non-test TypeScript names it — an
 * `/internal/` route no TypeScript names is a route nothing can ever call. A
 * path assembled from fragments would satisfy nothing and name nothing.
 */
export const RETRAIN_STATUS_TEMPLATE = "/internal/retrain/{run_id}";

/** Where to ask about one run. */
export function retrainStatusPath(runId: string): string {
  return RETRAIN_STATUS_TEMPLATE.replace("{run_id}", encodeURIComponent(runId));
}

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
 * The hour and minute a cron pattern fires at, or `null` where it says "every".
 *
 * Only the two leading fields, and only a bare number in them. That is the whole
 * grammar `retrainRunId` needs: it is deciding what instant a firing *belongs
 * to*, and a pattern's day fields cannot move an instant within the day. A step
 * or a list — `*\/15`, `0,30` — reads as "every", which floors to the clock the
 * job actually fired on and is the safe direction: a run id that tracks the
 * firing is at worst more granular than the schedule, never coarser than it.
 */
function scheduledField(pattern: string, index: 0 | 1): number | null {
  const field = pattern.trim().split(/\s+/)[index];
  if (field === undefined || !/^\d+$/.test(field)) {
    return null;
  }
  return Number(field);
}

/**
 * The instant a run belongs to: `now` floored to **the schedule in force**.
 *
 * **Stable across attempts, which is the whole point.** BullMQ hands the same
 * job back after a failure, and a handler that read its own clock would mint a
 * new artifact id on every attempt — two bundles, two cards and two decision
 * lines for one Friday, none of them recognisable as retries of each other.
 *
 * **Read off `config.retrainPattern`, not off two constants — forecaster 44.**
 * It used to floor to a hardcoded 03:10 whatever the schedule
 * said, which is right for the weekly pattern those constants describe and
 * wrong for every other one. An operator who set `5 * * * *` to catch up after
 * forecaster 43 got `2026-09-15T03:10:00Z` — *the id that morning's scheduled
 * run had already used*. Every lane short-circuited as a retry, no lane reached
 * a decision, and the catch-up `config.ts` advertises as "the operator path"
 * could not produce a run at all. The id now tracks the pattern: a fixed field
 * floors to it, a wildcard floors to the clock, so `10 3 * * 5` behaves exactly
 * as before and `5 * * * *` mints one id per hour.
 *
 * The floor is never finer than a minute. Two firings inside one minute are the
 * same run, which is what keeps a redelivery idempotent.
 */
export function retrainRunId(now: Date, options: { pattern?: string } = {}): string {
  // An *object* rather than a second positional string, and the reason is a
  // test that caught it: `[...].map(retrainRunId)` hands the callback an index,
  // which as a positional `pattern` arrived as the number 1 and threw. A caller
  // that maps this over a list of dates is doing something reasonable, so the
  // signature has to survive it.
  const cron = options.pattern ?? config.retrainPattern ?? RETRAIN_PATTERN;
  const minute = scheduledField(cron, 0);
  const hour = scheduledField(cron, 1);
  const instant = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour ?? now.getUTCHours(),
      minute ?? now.getUTCMinutes(),
      0,
      0,
    ),
  );
  // A run that fires a hair before its own scheduled minute — clock skew, or a
  // queue that ran slightly early — belongs to the *previous* occurrence, not to
  // one that has not happened yet. How far back that is, is how far apart the
  // occurrences are: a day when the hour is fixed, an hour when it is not.
  if (instant.getTime() > now.getTime()) {
    if (hour === null) {
      instant.setUTCHours(instant.getUTCHours() - 1);
    } else {
      instant.setUTCDate(instant.getUTCDate() - 1);
    }
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

/** A duration in the unit a reader would have written it in. */
function describeMs(ms: number): string {
  if (ms >= 60_000) {
    return `${ms / 60_000}-minute`;
  }
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
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
function describeFailure(error: unknown, elapsedMs?: number): string {
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
    case "RETRAIN_UNKNOWN":
      return (
        "the modelling service has no record of this run — it was almost " +
        "certainly replaced while the run was in flight, and the child went with " +
        "the container. The queue will retry, and a lane that already appended a " +
        "decision line for this run id will append nothing the second time"
      );
    case "OPTIMIZER_TIMEOUT": {
      // **The elapsed time, not the ceiling.** This used to assert "did not
      // finish inside 40 minutes" whatever had actually happened, because
      // `OPTIMIZER_TIMEOUT` was what `ml-proxy` raised for *any* aborted fetch.
      // On 2026-09-15 that sentence sent an operator looking for a forty-minute
      // run that had been aborted at five. A log line that states a duration it
      // did not measure is worse than one that states none: it is a confident
      // wrong answer to the first question anybody asks.
      //
      // Two ceilings can produce this code now and they mean opposite things,
      // so the sentence branches on which one fired. `timeout_source` is set at
      // the throw site in both cases; neither is inferred from an elapsed time.
      // Every duration in the sentences below is read off the error rather than
      // off a constant, because an injected ceiling and the configured one are
      // both real and a message that named the constant would be wrong about
      // exactly the case a test is exercising.
      const measured =
        elapsedMs === undefined ? "" : ` after ${Math.round(elapsedMs / 1000)}s`;
      if (app?.details?.timeout_source === "poll_deadline") {
        const ceiling =
          typeof app.details.ceiling_ms === "number"
            ? app.details.ceiling_ms
            : RETRAIN_TIMEOUT_MS;
        return (
          `the run did not reach a decision${measured}, against a ${describeMs(ceiling)} ` +
          "ceiling — and this one genuinely elapsed, because it bounds the polling " +
          "rather than one request. The run may still be completing on the " +
          `modelling service; ${RETRAIN_STATUS_TEMPLATE} is where to look. The ` +
          "queue's retry is idempotent on the run id, so it will not produce a " +
          "second artifact"
        );
      }
      const perCall =
        typeof app?.details?.timeout_ms === "number"
          ? app.details.timeout_ms
          : RETRAIN_REQUEST_TIMEOUT_MS;
      return (
        `one call to the modelling service was aborted${measured}, against this ` +
        `call's ${describeMs(perCall)} ceiling. A retrain is no longer waited for in ` +
        "one request, so this is a network fault rather than a slow run, and the " +
        "poll loop tolerates it until the run's own ceiling"
      );
    }
    case "OPTIMIZER_UNAVAILABLE":
      return (
        "the call to the modelling service never got an answer" +
        (app?.details?.timeout_source === "runtime"
          ? " — the runtime aborted the socket itself, which is not this API's " +
            "ceiling and is deliberately not reported as one (forecaster 45)"
          : "") +
        `. The run is unaffected by a failed poll; the loop retries until the ${
          RETRAIN_TIMEOUT_MS / 60_000
        }-minute ceiling`
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

export interface RetrainerDeps {
  /**
   * Where the modelling service is. Absent means `config.mlUrl` at
   * `RETRAIN_REQUEST_TIMEOUT_MS` — which is now a ceiling on *one short call*
   * rather than on the whole run.
   */
  endpoint?: MlEndpoint;
  /** The clock, injected so "which run is this" is testable. */
  now?: () => Date;
  /**
   * The ceiling on the whole run. Absent means `RETRAIN_TIMEOUT_MS`; a test
   * overrides it so that proving the loop gives up does not take forty minutes.
   */
  deadlineMs?: number;
  /** The backoff's first gap and the longest one it grows to. */
  poll?: { minMs?: number; maxMs?: number };
  /** How the loop waits between polls. Injected so a test is not a real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** The failures a *poll* may report without the run being in trouble. */
function isTransientPollFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }
  // A code the modelling service itself named is a verdict about the run —
  // `RETRAIN_FAILED`, `RETRAIN_UNKNOWN`, `REQUEST_INVALID` — and must not be
  // polled through. What may be retried is the three ways the *call* can fail
  // without upstream having said anything.
  if (typeof error.details?.upstream_code === "string") {
    return false;
  }
  return (
    error.code === "OPTIMIZER_TIMEOUT" ||
    error.code === "OPTIMIZER_UNAVAILABLE" ||
    error.code === "OPTIMIZER_NOT_READY"
  );
}

/** Whether the modelling service refused a start because it is already running. */
function isAlreadyStarted(error: unknown): boolean {
  return (
    error instanceof AppError && error.details?.upstream_code === "RETRAIN_IN_PROGRESS"
  );
}

/** What one poll said, in the two shapes the status route answers with. */
interface StatusBody {
  status?: unknown;
  progress?: { done?: unknown; total?: unknown };
}

/**
 * Build the handler the worker runs for a `retrain` task.
 *
 * The call is **worker → modelling service** and nothing is written to Postgres
 * by either side: a retrain's output is an artifact on the volume, a card, and a
 * line in `promotions.jsonl`. Nothing under `src/api/` imports this module, so
 * "only the worker retrains" stays a property of the import graph rather than a
 * rule someone has to remember.
 *
 * **Start, then poll — forecaster 45.** This used to POST the run and await the
 * whole thing in one request, against a forty-minute endpoint timeout. It was
 * correct on its own terms and it did not survive the network: measured on
 * 2026-09-15, the call aborted after exactly 300 s and was reported as
 * `OPTIMIZER_TIMEOUT` while the modelling service went on training — CPU 36%,
 * RSS 2.80 GB — well past the abort, and completed. *Every retrain reported a
 * failure that had not happened.* A request that transmits no bytes for twelve
 * minutes is simply not a shape this deployment's internal networking will hold.
 *
 * So the run and the waiting are separated. The POST returns 202 the moment the
 * child exists; this loop then asks a short question repeatedly, with a backoff,
 * until the run reaches a decision or `RETRAIN_TIMEOUT_MS` genuinely elapses.
 * Three properties fall out of that, and each was a defect before it:
 *
 * 1. **The ceiling means what it says**, because it bounds a sequence of short
 *    requests rather than one long one that something else was always going to
 *    kill first.
 * 2. **The run is observable while it matters.** Progress used to be one report
 *    before the POST and one after, so a forty-minute job showed nothing for
 *    forty minutes; it is now one report per lane, off the child's own stderr.
 * 3. **A restart costs nothing.** A worker that dies mid-run comes back and
 *    POSTs again; the modelling service answers 409 `RETRAIN_IN_PROGRESS`,
 *    which this loop reads as *attach and poll* rather than as a failure. The
 *    run it attaches to is the one that was already going.
 *
 * Everything that makes this safe was already there: a lane carrying a decision
 * line for the run id is skipped (`decided_in_run`), and forecaster 44 made an
 * all-skipped run exit zero rather than look like a failure.
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
      timeoutMs: RETRAIN_REQUEST_TIMEOUT_MS,
    };
    const deadlineMs = deps.deadlineMs ?? RETRAIN_TIMEOUT_MS;
    const minMs = deps.poll?.minMs ?? RETRAIN_POLL_MIN_MS;
    const maxMs = deps.poll?.maxMs ?? RETRAIN_POLL_MAX_MS;
    const sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    // Measured so a failure can say how long it actually waited, rather than
    // asserting the ceiling it was configured with. See `describeFailure`.
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const giveUp = (error: unknown): never => {
      console.warn(`⚠️  retrain ${runId} — ${describeFailure(error, elapsed())}`);
      // Rethrown as itself so the queue's backoff policy retries it, and so the
      // modelling service's own code survives the crossing.
      throw error;
    };

    let started = false;
    let reported = -1;
    let wait = minMs;
    report({ done: 0 });
    for (;;) {
      if (elapsed() >= deadlineMs) {
        giveUp(
          new CodedError(
            "OPTIMIZER_TIMEOUT",
            `the retrain did not reach a decision inside ${deadlineMs} ms`,
            {
              // Named at the throw site, never inferred downstream: this is the
              // *only* place in the retrain path where our own ceiling fires,
              // and forecaster 45 is what it cost to have two ceilings wearing
              // one name.
              details: {
                timeout_source: "poll_deadline",
                run_id: runId,
                ceiling_ms: deadlineMs,
                elapsed_ms: elapsed(),
              },
            },
          ),
        );
      }
      try {
        if (started) {
          const response = await callMl(
            retrainStatusPath(runId),
            new URLSearchParams(),
            endpoint,
          );
          const body = (await response.json()) as StatusBody;
          if (body.status !== "running") {
            const result = parseReport(body, runId);
            report({ done: result.lanes.length, total: result.lanes.length });
            for (const lane of result.lanes) {
              const mark = lane.status === "promoted" ? "✅" : "•";
              console.log(
                `${mark} retrain ${runId} ${lane.lane}: ${lane.status} — ${lane.reason}`,
              );
            }
            return result;
          }
          const done = typeof body.progress?.done === "number" ? body.progress.done : 0;
          const total =
            typeof body.progress?.total === "number" ? body.progress.total : undefined;
          if (done !== reported) {
            // Only on a change: `report` is best-effort but it is not free, and
            // a poll every thirty seconds that re-states the same number tells
            // a reader of the queue nothing.
            reported = done;
            report(total === undefined ? { done } : { done, total });
          }
        } else {
          await postMl(
            RETRAIN_PATH,
            JSON.stringify({
              run_id: runId,
              ...(payload.ladder === undefined ? {} : { ladder: payload.ladder }),
            }),
            endpoint,
          );
          started = true;
        }
      } catch (error) {
        if (isAlreadyStarted(error)) {
          // Not a failure: this worker (or the one it replaced) already started
          // this run, and the run is what we came for. Attach to it.
          started = true;
        } else if (isTransientPollFailure(error)) {
          // The *call* failed; the run is untouched by that, and the whole point
          // of a short request is that losing one costs a few seconds rather
          // than a retrain. Said out loud, because a poll loop that swallows
          // every failure silently is how an outage stays invisible for forty
          // minutes.
          console.warn(`⚠️  retrain ${runId} — ${describeFailure(error, elapsed())}`);
        } else {
          giveUp(error);
        }
      }
      // Backoff, never past the ceiling: a sleep that overshot the deadline
      // would make the ceiling the sleep's rather than the run's.
      await sleep(Math.max(0, Math.min(wait, deadlineMs - elapsed())));
      wait = Math.min(maxMs, Math.round(wait * 1.5));
    }
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
