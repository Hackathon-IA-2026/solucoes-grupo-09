import type { MlEndpoint } from "../api/ml-proxy.js";
import { postMl } from "../api/ml-proxy.js";
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
 * plus the composition of ninety days of bands. Forty minutes is an upper bound
 * on a healthy run rather than an expectation of one, and it is the retrain's
 * number because it is the retrain's fit.
 */
export const HOLDOUT_BACKFILL_TIMEOUT_MS = 40 * 60_000;

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
      timeoutMs: HOLDOUT_BACKFILL_TIMEOUT_MS,
    };
    report({ done: 0, total: 1 });
    let response: Response;
    try {
      response = await postMl(
        HOLDOUT_BACKFILL_PATH,
        JSON.stringify(payload.foldId === undefined ? {} : { fold_id: payload.foldId }),
        endpoint,
      );
    } catch (error) {
      console.warn(
        `⚠️  holdout backfill ${payload.foldId ?? "(newest frozen fold)"} — ${describeFailure(error)}`,
      );
      // Rethrown as itself so the queue's backoff retries it, and so the
      // modelling service's own code survives the crossing.
      throw error;
    }
    const body = await response.json();
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
          `${run.hoursUnchanged} unchanged`,
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
