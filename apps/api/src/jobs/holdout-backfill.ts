import type { MlEndpoint } from "../api/ml-proxy.js";
import { callMl, postMl } from "../api/ml-proxy.js";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import { AppError, CodedError } from "../errors.js";
import {
  type HoldoutBackfill,
  HoldoutBackfillError,
  type HoldoutBackfillResult,
  parseHoldoutBackfill,
  writeHoldoutBackfill,
} from "../forecast/backfill.js";
import type { Execute, JobSchedule, ReportProgress } from "./types.js";

/**
 * The backtest run that keeps its out-of-fold forecasts, as work the queue owns.
 *
 * `docs/specs/replay.md`'s one storage requirement had every piece built and
 * nothing running it. `wattsteer_ml.evaluation.holdout` minted the
 * publications; `forecast/backfill.ts` parsed and appended them; and a
 * repository-wide search for a *caller* of either found none — so
 * `GET /v1/replay` answered `REPLAY_FORECAST_UNAVAILABLE` on precisely the
 * walk-forward test days the Time Machine exists to show. This module is the
 * caller, and `wattsteer_ml/holdout_backfill.py` is its other half.
 *
 * Four things live here and nowhere else.
 *
 * 1. **The write is on this side.** The modelling service is read-only against
 *    Postgres, so it composes the rows and the worker appends them — the same
 *    direction, and the same parser, `jobs/publication.ts` already goes
 *    through. Nothing under `src/api/` imports this file, so "the gateway never
 *    asks the modelling service for a forecast" stays a property of the import
 *    graph.
 *
 * 2. **A run is one instant.** `ingestedAt` is read once and stamped on every
 *    day of the fold, so an `AsOf` cut between two backfills sees one whole run
 *    and never half of each. That is what makes supersession free: a later run
 *    appends a newer vintage of the same days and a replay pinned to the
 *    earlier as-of still reconstructs the earlier numbers.
 *
 * 3. **When it runs.** Fridays at 03:40 UTC — the same firing as the retrain,
 *    thirty minutes later. The retrain is what mints the fold artifacts, and a
 *    backfill that raced it would be reading a volume mid-write. UTC for the
 *    retrain's reason: the fold calendar is civil and Brazilian, but a
 *    background job's only clock constraint is that it finishes before the next
 *    gate.
 *
 * 4. **Which fold is not decided here.** The payload's `foldId` is optional and
 *    the schedule omits it, because "the newest frozen fold" is a question for
 *    the fold calendar and the fold calendar lives on the modelling service. A
 *    gateway that computed it would be a second calendar, which is the drift
 *    `wattsteer_ml.evaluation.folds` exists to make impossible. An operator
 *    filling in the older quarters submits the fold by name.
 */

/** The zone the cron pattern is read in. UTC, deliberately — see above. */
export const HOLDOUT_BACKFILL_TIME_ZONE = "Etc/UTC";

/** Friday, twenty to four in the morning, UTC — half an hour after the retrain. */
export const HOLDOUT_BACKFILL_PATTERN = "40 3 * * 5";

/** The stable id of the queue's one repeatable backfill. */
export const HOLDOUT_BACKFILL_JOB_ID = "holdout-backfill:newest-frozen-fold";

/**
 * How long the worker waits for a fold to be scored.
 *
 * A fold is the retrain's work over a *frozen* quarter: six LightGBM fits per
 * lane over two and a half years of hourly rows for four subsystems, twice,
 * plus the composition of ninety days of bands.
 *
 * **Three hours, and it was forty minutes.** That number was the retrain's,
 * taken on the argument that this is the retrain's fit — and it was never an
 * upper bound on a healthy run, only an untested guess at one. Measured on
 * production 2026-09-23: two backfills were still `running` on the modelling
 * service at 2 651 s and 2 572 s when the worker gave up at 2 400, and the
 * retrain that same night reached a decision at about 3 600. Both were healthy
 * runs the queue recorded as failures.
 *
 * A ceiling this long is only safe because the waiting is a sequence of short
 * status reads rather than one held-open request — see the poll loop below.
 * Under the old shape three hours would have been three hours of a connection
 * this deployment cuts at 300 s.
 *
 * **Twelve hours, and it was three.** The same failure, a second time, and that
 * is the reason this number is now written against a measurement rather than
 * against an argument about how much work a fold is. Measured on production
 * 2026-09-24/25: jobs 978 and 979 were enqueued at 22:06 and failed at 01:06
 * with `the backfill did not finish inside 10800000 ms`, while
 * `/internal/backfill/holdout/{latest,F4}` still answered `running` at
 * **11 015 s** — three hours and four minutes — and went on to finish. Its
 * report carries ninety-one publications with `incomplete_days: []`, and the
 * picker's own 120-day window went from seven replayable days to forty-one.
 * So the run was healthy at every moment the queue called it failed.
 *
 * `HOLDOUT_BACKFILL_LONGEST_HEALTHY_MS` below is that observation, and the
 * job's test asserts this ceiling clears it with a factor of two. The factor
 * is the point: 11 015 s is a **lower bound**, not a duration — the run was
 * still going when the reading was taken and nothing recorded the instant it
 * stopped, so its true length is somewhere above that and was not measured.
 * A ceiling set just over the observation would be a third guess dressed as
 * evidence. Twelve hours is still deep inside a weekly cadence, and the wait
 * costs a status read every thirty seconds.
 *
 * **If this fires again, raise the shape and not the number.** Twice now a
 * wall-clock ceiling has recorded work that was running and would complete as
 * a failure, and a third repeat is that pattern rather than a fold that got
 * bigger. The run is attachable — `apps/ml` answers
 * `HOLDOUT_BACKFILL_IN_PROGRESS` and the status route keeps serving it — so
 * what a longer run actually wants is a hand-off the queue can express, not
 * another hour.
 */
export const HOLDOUT_BACKFILL_TIMEOUT_MS = 12 * 60 * 60_000;

/**
 * The longest run observed still healthy, in milliseconds.
 *
 * Not a tuning knob — a recorded measurement, kept beside the ceiling so the
 * test can compare the two. See the paragraph above for where it comes from.
 */
export const HOLDOUT_BACKFILL_LONGEST_HEALTHY_MS = 11_015_000;

/**
 * How long any single call to the modelling service may take.
 *
 * Every request in the new shape is a status read or a start — hundreds of
 * bytes, answered immediately — so this is sized for a slow network rather than
 * for a slow run, and it is comfortably under the 300 s ceiling the platform
 * turned out to enforce between the two services. It is `retrain.ts`'s number
 * because it is the same crossing.
 */
export const HOLDOUT_BACKFILL_REQUEST_TIMEOUT_MS = 30_000;

/** The first gap between polls, and the longest one the backoff grows to. */
export const HOLDOUT_BACKFILL_POLL_MIN_MS = 2000;
export const HOLDOUT_BACKFILL_POLL_MAX_MS = 30_000;

/**
 * The path segment a request with no fold runs under.
 *
 * `apps/ml` names the same string, because a status URL has to name the run and
 * "the newest frozen fold" has no id until the child has picked one.
 */
export const LATEST_FOLD = "latest";

/**
 * The status route, spelled out whole.
 *
 * `test/reachability.ts` reads every `/internal/` route the modelling service
 * declares and requires that some non-test TypeScript names it — an
 * `/internal/` route no TypeScript names is a route nothing can ever call. A
 * path assembled from fragments would satisfy nothing and name nothing, and
 * this guard went red on exactly that when the route was first added here.
 */
export const HOLDOUT_BACKFILL_STATUS_TEMPLATE = "/internal/backfill/holdout/{fold}";

/** Where that fold's run is polled. */
export function holdoutBackfillStatusPath(fold: string): string {
  return HOLDOUT_BACKFILL_STATUS_TEMPLATE.replace("{fold}", encodeURIComponent(fold));
}

/**
 * A 409 from the start call is not a failure: this worker, or the one it
 * replaced, already started this fold and that run is the one we came for.
 */
function isAlreadyStarted(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.details?.upstream_code === "HOLDOUT_BACKFILL_IN_PROGRESS"
  );
}

/**
 * The failures a *poll* may report without the run being in trouble.
 *
 * A code the modelling service itself named is a verdict about the run —
 * `HOLDOUT_BACKFILL_FAILED`, `HOLDOUT_BACKFILL_UNKNOWN`, `DATA_UNAVAILABLE` —
 * and must not be polled through. What may be retried is the ways the *call*
 * can fail without upstream having said anything.
 */
function isTransientPollFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }
  if (typeof error.details?.upstream_code === "string") {
    return false;
  }
  return (
    error.code === "OPTIMIZER_TIMEOUT" ||
    error.code === "OPTIMIZER_UNAVAILABLE" ||
    error.code === "OPTIMIZER_NOT_READY"
  );
}

/** The modelling service's route. Worker-only; no gateway path reaches it. */
export const HOLDOUT_BACKFILL_PATH = "/internal/backfill/holdout";

/** What the queue carries for one backfill. */
export interface HoldoutBackfillPayload {
  /**
   * Which fold to score — `F1`, `F2`, … Absent means "the newest frozen fold",
   * which the modelling service resolves against the calendar. The schedule
   * always omits it; an operator filling in the earlier quarters names one.
   */
  foldId?: string;
}

/** A lane the modelling service could not score, as it reported it. */
export interface HoldoutBackfillLaneFailure {
  lane: string;
  reason: string;
}

/** What one backfill run did, in the shape a job log should read. */
export interface HoldoutBackfillJobResult {
  foldId: string;
  /** The artifact that did *not* see these days — one per fold, by design. */
  artifactId: string;
  /** The instant every row of this run was ingested at. */
  ingestedAt: string;
  runs: HoldoutBackfillResult[];
  failures: HoldoutBackfillLaneFailure[];
}

/**
 * Injected so the write can be observed without a database, and so the clock
 * that stamps a run's vintage is a value rather than a global.
 */
export interface HoldoutBackfillerDeps {
  db: Database;
  /** Where the modelling service is. Absent means `config.mlUrl` at the timeout. */
  endpoint?: MlEndpoint;
  /** The clock the run's one `ingested_at` is read from. */
  now?: () => Date;
  /** The writer. Only a test replaces it; production is the real append. */
  write?: typeof writeHoldoutBackfill;
  /** The poll loop's own ceiling. Injected so a test is not a real wait. */
  deadlineMs?: number;
  poll?: { minMs?: number; maxMs?: number };
  /** How the loop waits between polls. Injected so a test is not a real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function parseFailures(value: unknown): HoldoutBackfillLaneFailure[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((one) => {
    const row = (one ?? {}) as { lane?: unknown; reason?: unknown };
    return { lane: text(row.lane), reason: text(row.reason) };
  });
}

/**
 * Why a backfill did not happen, in the operator's vocabulary.
 *
 * The distinction that matters is between "the fold could not be scored" and
 * "the service is unreachable". Neither is a refusal a client ever sees — no
 * public route backfills — so these codes stay off `packages/core`'s closed
 * enum and arrive as `details.upstream_code`, exactly as the retrain's do.
 */
function describeFailure(error: unknown): string {
  const app = error instanceof AppError ? error : undefined;
  const upstream = app?.details?.upstream_code;
  const code = typeof upstream === "string" ? upstream : app?.code;
  switch (code) {
    case "HOLDOUT_BACKFILL_IN_PROGRESS":
      return (
        "this fold is already being scored on the modelling service — the " +
        "previous attempt has not finished. The queue will retry, and the rows " +
        "carry the fold's own artifact id, so the retry supersedes rather than " +
        "duplicates"
      );
    case "HOLDOUT_BACKFILL_FAILED":
      return "the fold could not be scored; the modelling service kept the reason";
    case "DATA_UNAVAILABLE":
      return "the modelling service cannot reach Postgres";
    case "OPTIMIZER_TIMEOUT":
      return (
        `the backfill did not finish inside ${HOLDOUT_BACKFILL_TIMEOUT_MS / 60_000} ` +
        "minutes. The run may still be completing; a retry writes the same " +
        "artifact id at a later ingestion instant, which is a vintage and not a " +
        "duplicate"
      );
    default:
      return `the backfill did not complete: ${
        error instanceof Error ? error.message : String(error)
      }`;
  }
}

/**
 * Build the handler the worker runs for a `holdout_backfill` task.
 *
 * The parse is `parseHoldoutBackfill`'s and is deliberately not repeated here:
 * that function refuses a run whose envelope or whose rows claim anything but
 * `backfilled_holdout`, and this module has no branch that could reach around
 * it. A refusal throws before the first insert, so a forged run writes nothing
 * rather than half of something.
 */
export function createHoldoutBackfiller(
  deps: HoldoutBackfillerDeps,
): Execute<HoldoutBackfillPayload, HoldoutBackfillJobResult> {
  const clock = deps.now ?? (() => new Date());
  const write = deps.write ?? writeHoldoutBackfill;

  return async (
    payload: HoldoutBackfillPayload,
    report: ReportProgress,
  ): Promise<HoldoutBackfillJobResult> => {
    const endpoint = deps.endpoint ?? {
      baseUrl: config.mlUrl,
      // A *short* request now — a start or a status read. See the poll loop
      // below for why the long one had to go.
      timeoutMs: HOLDOUT_BACKFILL_REQUEST_TIMEOUT_MS,
    };
    const fold = payload.foldId ?? LATEST_FOLD;
    const deadlineMs = deps.deadlineMs ?? HOLDOUT_BACKFILL_TIMEOUT_MS;
    const minMs = deps.poll?.minMs ?? HOLDOUT_BACKFILL_POLL_MIN_MS;
    const maxMs = deps.poll?.maxMs ?? HOLDOUT_BACKFILL_POLL_MAX_MS;
    const sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    report({ done: 0, total: 1 });

    /*
      **Start, then poll — the repair forecaster 45 made to the retrain, made
      here.** This used to POST the fold and await its report on one connection.
      Measured on the live deployment on 2026-09-22: the job was enqueued at
      23:02 and failed at 23:07:48 with "The ML service is unreachable" — about
      350 s, against the forty-minute ceiling it was configured with — while the
      child went on scoring for another ninety minutes, refusing every later
      attempt with `HOLDOUT_BACKFILL_IN_PROGRESS`.

      It cost more here than it did on the retrain. That route's product is an
      artifact on a volume, so a lost response lost a *report*; this route's
      product **is** the response body, because `apps/ml` is read-only against
      Postgres and this function is what appends the rows. So every run scored a
      fold and threw it away, and `/v1/replay/days` offered only the days the
      forecaster had served — five, against a window of a hundred and twenty.
    */
    let started = false;
    let wait = minMs;
    let body: unknown;
    for (;;) {
      if (elapsed() >= deadlineMs) {
        const error = new CodedError(
          "OPTIMIZER_TIMEOUT",
          `the backfill did not finish inside ${deadlineMs} ms`,
          {
            details: {
              timeout_source: "poll_deadline",
              fold,
              ceiling_ms: deadlineMs,
              elapsed_ms: elapsed(),
            },
          },
        );
        console.warn(`⚠️  holdout backfill ${fold} — ${describeFailure(error)}`);
        throw error;
      }
      try {
        if (started) {
          const response = await callMl(
            holdoutBackfillStatusPath(fold),
            new URLSearchParams(),
            endpoint,
          );
          const status = (await response.json()) as { status?: unknown };
          if (status.status !== "running") {
            body = status;
            break;
          }
        } else {
          await postMl(
            HOLDOUT_BACKFILL_PATH,
            JSON.stringify(
              payload.foldId === undefined ? {} : { fold_id: payload.foldId },
            ),
            endpoint,
          );
          started = true;
        }
      } catch (error) {
        if (isAlreadyStarted(error)) {
          // Not a failure: this worker, or the one it replaced, already started
          // this fold, and that run is what we came for. Attach to it.
          started = true;
        } else if (isTransientPollFailure(error)) {
          // The *call* failed; the run is untouched by that, which is the whole
          // point of a short request. Said out loud, because a poll loop that
          // swallows every failure is how an outage stays invisible.
          console.warn(`⚠️  holdout backfill ${fold} — ${describeFailure(error)}`);
        } else {
          console.warn(`⚠️  holdout backfill ${fold} — ${describeFailure(error)}`);
          // Rethrown as itself so the queue's backoff retries it, and so the
          // modelling service's own code survives the crossing.
          throw error;
        }
      }
      // Backoff, never past the ceiling: a sleep that overshot the deadline
      // would make the ceiling the sleep's rather than the run's.
      await sleep(Math.max(0, Math.min(wait, deadlineMs - elapsed())));
      wait = Math.min(maxMs, Math.round(wait * 1.5));
    }

    if (typeof body !== "object" || body === null) {
      throw new CodedError("UPSTREAM_FAILED", "the backfill returned no report");
    }
    const envelope = body as { fold_id?: unknown; artifact_id?: unknown; runs?: unknown };
    const raw = Array.isArray(envelope.runs) ? envelope.runs : [];
    const failures = parseFailures((body as { failures?: unknown }).failures);
    if (raw.length === 0) {
      // Nothing to write, and never a silent success: a fold that produced no
      // lane is a run to go and look at, and the queue's retry is the right
      // response to it.
      throw new HoldoutBackfillError(
        `${text(envelope.fold_id) || "the requested fold"} produced no run` +
          (failures.length > 0
            ? `: ${failures.map((one) => `${one.lane} — ${one.reason}`).join("; ")}`
            : ""),
      );
    }

    // Parsed whole before anything is written, so a forged run in the second
    // lane cannot leave the first lane's rows behind it.
    const parsed: HoldoutBackfill[] = raw.map((one) => parseHoldoutBackfill(one));

    // One instant for the run, read once. See the module docstring.
    const ingestedAt = clock();
    const runs: HoldoutBackfillResult[] = [];
    let done = 0;
    for (const backfill of parsed) {
      runs.push(await write(deps.db, backfill, { ingestedAt }));
      done += 1;
      report({ done, total: parsed.length });
    }
    for (const run of runs) {
      console.log(
        `✅ holdout backfill ${run.foldId} ${run.artifactId}: ${run.days} day(s), ` +
          `${run.hoursInserted} hour(s) inserted, ${run.hoursRevised} revised, ` +
          `${run.hoursUnchanged} unchanged, ${run.attributionsWritten} attribution(s)`,
      );
    }
    for (const failure of failures) {
      console.warn(`⚠️  holdout backfill ${failure.lane}: ${failure.reason}`);
    }
    return {
      foldId: text(envelope.fold_id),
      artifactId: text(envelope.artifact_id),
      ingestedAt: ingestedAt.toISOString(),
      runs,
      failures,
    };
  };
}

/**
 * The one repeatable backfill, as a `JobSchedule` over the worker's task union.
 *
 * Registering is idempotent — the id is stable, so N replicas starting at once
 * converge on one schedule rather than N — and BullMQ's job scheduler is what
 * makes the run leader-safe, which is why the repeatable job lives on the queue
 * rather than beside it.
 */
export function holdoutBackfillSchedules<TPayload>(
  wrap: (payload: HoldoutBackfillPayload) => TPayload,
): JobSchedule<TPayload>[] {
  return [
    {
      id: HOLDOUT_BACKFILL_JOB_ID,
      pattern: HOLDOUT_BACKFILL_PATTERN,
      timeZone: HOLDOUT_BACKFILL_TIME_ZONE,
      payload: wrap({}),
    },
  ];
}
