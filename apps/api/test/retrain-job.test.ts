import { describe, expect, it } from "bun:test";
import { Queue } from "bullmq";
import { callMl } from "../src/api/ml-proxy.js";
import { createBullMqRunner } from "../src/jobs/bullmq.js";
import { FORECAST_PUBLICATIONS } from "../src/jobs/publication.js";
import {
  createRetrainer,
  RETRAIN_JOB_ID,
  RETRAIN_PATH,
  RETRAIN_PATTERN,
  RETRAIN_STATUS_TEMPLATE,
  RETRAIN_TIME_ZONE,
  RETRAIN_TIMEOUT_MS,
  retrainRunId,
  retrainStatusPath,
} from "../src/jobs/retrain.js";
import {
  createWorkerDispatch,
  retrainScheduleForQueue,
  type WorkerTask,
} from "../src/jobs/worker-tasks.js";

/**
 * The weekly retrain's schedule — forecaster ticket 15,
 * `docs/specs/forecaster.md` seam 11.
 *
 * Forecaster 19 gated both lanes in one pass and left nothing calling it: "no
 * job in `apps/api/src/jobs/` retrains anything". This file is about the cron
 * entry that closes that, and about the two things a schedule owns that the
 * modelling service cannot: *which run this is*, and what a failure means.
 *
 * The one that is easy to get wrong is the run id. It is the artifact stem in
 * both lanes, and the modelling service short-circuits a lane that already
 * carries a decision line for it — so an id that moved between attempts would
 * turn one Friday into two artifacts, two cards and two decision lines, none of
 * them recognisable as retries of each other.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const report = (lanes: unknown[], promoted: string[] = []) =>
  JSON.stringify({
    at: "2026-09-04T03:10:00Z",
    status: "decided",
    lanes,
    promoted,
    resources: { wall_clock_seconds: 742.25, peak_rss_mb: 1912.4 },
  });

/**
 * The modelling service in its forecaster-45 shape: a start that answers 202 and
 * a status route that answers until the run is over.
 *
 * `runMs` is the thing the ticket is about — a run that takes longer than any
 * one request may last. The tests below set a per-request ceiling *below* it, so
 * "the run outlives every request that observes it" is a fact about the fixture
 * rather than an assertion about wall clocks.
 */
const retrainService = (
  options: {
    /** How long the run takes before the status route reports a decision. */
    runMs?: number;
    /** The body the status route answers with once the run is over. */
    decided?: string;
    /** Refuse the start this way — 409 `RETRAIN_IN_PROGRESS`, in practice. */
    refuseStart?: { status: number; body: string };
    /** Answer the status route with this failure instead of a report. */
    statusFailure?: { status: number; body: string };
    /** Fail this many polls with a bare 503 before answering properly. */
    flakyPolls?: number;
    /** Hold every status request open forever — a network that eats polls. */
    stallStatus?: boolean;
  } = {},
) => {
  const runMs = options.runMs ?? 0;
  const calls: string[] = [];
  const starts: unknown[] = [];
  // A start that is refused with 409 is a run somebody else already began, so
  // the clock is already running when this fixture comes up.
  let startedAt: number | null = options.refuseStart ? Date.now() : null;
  let polls = 0;

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST") {
        if (options.refuseStart) {
          return new Response(options.refuseStart.body, {
            status: options.refuseStart.status,
            headers: JSON_HEADERS,
          });
        }
        const body = (await request.json()) as { run_id: string };
        starts.push(body);
        startedAt = Date.now();
        return new Response(JSON.stringify({ run_id: body.run_id, status: "running" }), {
          status: 202,
          headers: JSON_HEADERS,
        });
      }
      if (options.stallStatus) {
        return (await new Promise<Response>(() => {})) as Response;
      }
      polls += 1;
      if (options.flakyPolls !== undefined && polls <= options.flakyPolls) {
        return new Response("", { status: 503 });
      }
      const elapsed = startedAt === null ? 0 : Date.now() - startedAt;
      if (elapsed < runMs) {
        return new Response(
          JSON.stringify({
            status: "running",
            progress: { done: elapsed * 2 >= runMs ? 1 : 0, total: 2 },
            elapsed_seconds: elapsed / 1000,
          }),
          { headers: JSON_HEADERS },
        );
      }
      if (options.statusFailure) {
        return new Response(options.statusFailure.body, {
          status: options.statusFailure.status,
          headers: JSON_HEADERS,
        });
      }
      return new Response(options.decided ?? report([]), { headers: JSON_HEADERS });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    calls,
    starts,
    stop: () => {
      server.stop(true);
    },
  };
};

/** A retrainer that polls fast, so a test is about the shape and not the wait. */
const polling = (
  url: string,
  overrides: Partial<Parameters<typeof createRetrainer>[0]> = {},
) =>
  createRetrainer({
    endpoint: { baseUrl: url, timeoutMs: 5000 },
    poll: { minMs: 10, maxMs: 20 },
    ...overrides,
  });

describe("which run this is", () => {
  it("floors the clock to the schedule's own instant, so a retry is a retry", () => {
    // Three attempts of one firing, minutes apart, as a backoff produces.
    const ids = [
      new Date("2026-09-04T03:10:00.004Z"),
      new Date("2026-09-04T03:12:41.900Z"),
      new Date("2026-09-04T04:31:07.000Z"),
    ].map(retrainRunId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("2026-09-04T03:10:00Z");
  });

  it("is an ISO-8601 UTC stem to the second — an artifact id and not a date", () => {
    // The same shape `wattsteer_ml.lanes.is_artifact_id` admits. A stem it
    // refuses would be discovered on the far side, after the fits.
    expect(retrainRunId(new Date("2026-12-25T09:00:00Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it("belongs to the previous day when the clock is a hair early", () => {
    // Clock skew, or a queue that fired a moment before its own minute. The run
    // belongs to an instant that has happened, never to one that has not.
    expect(retrainRunId(new Date("2026-09-04T03:09:59.100Z"))).toBe(
      "2026-09-03T03:10:00Z",
    );
  });

  it("takes the payload's id when one is given, so a catch-up names its run", async () => {
    const service = retrainService();
    try {
      const retrain = polling(service.url, {
        // A clock that would produce a different id, to prove it is not read.
        now: () => new Date("2027-01-01T03:10:00Z"),
      });
      const result = await retrain({ runId: "2026-09-04T03:10:00Z" }, () => {});
      expect(service.starts).toEqual([{ run_id: "2026-09-04T03:10:00Z" }]);
      expect(result.runId).toBe("2026-09-04T03:10:00Z");
    } finally {
      service.stop();
    }
  });
});

describe("when it runs", () => {
  it("is weekly, in UTC, and finishes long before the morning publication", () => {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = RETRAIN_PATTERN.split(" ");
    expect(minute).toBe("10");
    expect(hour).toBe("3");
    // Weekly, on one named weekday, every month.
    expect(dayOfMonth).toBe("*");
    expect(month).toBe("*");
    expect(dayOfWeek).toBe("5");
    // UTC, unlike the publications: a publication instant is a civil fact about
    // the Brazilian grid, and a retrain is an internal job whose artifact stems
    // are UTC. `docs/specs/forecaster.md`'s own example stems put it here —
    // 2026-08-28T03:11:07Z and 2026-08-21T03:09:44Z, two Fridays a week apart.
    expect(RETRAIN_TIME_ZONE).toBe("Etc/UTC");
    expect(new Date("2026-08-28T03:11:07Z").getUTCDay()).toBe(5);

    // And it lands before the day's first publication, which is what makes a
    // Friday promotion serving by the morning gate rather than a day later.
    const fires = new Date("2026-09-04T03:10:00Z");
    const morning = FORECAST_PUBLICATIONS.find(
      (publication) => publication.payload.gateProfile === "gate_early",
    );
    const publishes = new Date("2026-09-04T09:10:00-03:00");
    expect(morning?.pattern).toBe("10 9 * * *");
    expect(fires.getTime()).toBeLessThan(publishes.getTime());
  });

  it("waits far longer than an interactive call, and says so in one place", () => {
    // Six LightGBM fits per lane over two and a half years of hourly rows for
    // four subsystems, twice, plus a 2,000-draw paired bootstrap. The gateway's
    // 5 s and the publication's 120 s are both sized for something else.
    expect(RETRAIN_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
  });

  it("registers one repeatable job with a stable id", () => {
    const schedules = retrainScheduleForQueue();
    expect(schedules.length).toBe(1);
    expect(schedules[0]?.id).toBe(RETRAIN_JOB_ID);
    expect(schedules[0]?.pattern).toBe(RETRAIN_PATTERN);
    expect(schedules[0]?.timeZone).toBe(RETRAIN_TIME_ZONE);
    // No run id on the schedule: a repeatable job registered once must not pin
    // an instant it will still be asking for a year later.
    expect(schedules[0]?.payload).toEqual({ kind: "retrain", payload: {} });
  });
});

describe("what comes back", () => {
  it("reports both lanes, the wall clock and the peak resident set", async () => {
    const service = retrainService({
      decided: report(
        [
          {
            lane: "dessem_free_v1__gate_early__thr5",
            gate_profile: "gate_early",
            status: "promoted",
            artifact_id: "2026-09-04T03:10:00Z",
            reason: "P(candidate better) = 0.94",
          },
          {
            lane: "dessem_free_v1__gate_late__thr5",
            gate_profile: "gate_late",
            status: "refused",
            artifact_id: null,
            reason: "coverage_p90 = 0.83 is outside [0.85, 0.97]",
          },
        ],
        ["dessem_free_v1__gate_early__thr5"],
      ),
    });
    try {
      const result = await polling(service.url)(
        { runId: "2026-09-04T03:10:00Z" },
        () => {},
      );
      expect(result.lanes.map((lane) => lane.status)).toEqual(["promoted", "refused"]);
      expect(result.promoted).toEqual(["dessem_free_v1__gate_early__thr5"]);
      // The two numbers the ticket asks to be recorded, surfaced where a job log
      // can see them growing week over week.
      expect(result.wallClockSeconds).toBe(742.25);
      expect(result.peakRssMb).toBe(1912.4);
    } finally {
      service.stop();
    }
  });

  it("treats a refusal as a completed run, not a failure to retry", async () => {
    // The distinction the whole gate exists for. A refused candidate has a card
    // and a line; the incumbent goes on serving. Retrying that would refuse
    // again, at the cost of another forty minutes.
    const service = retrainService({
      decided: report([
        {
          lane: "dessem_free_v1__gate_late__thr5",
          gate_profile: "gate_late",
          status: "refused",
          artifact_id: null,
          reason: "F7 has 21 test days, under the 60 a bootstrap needs",
        },
      ]),
    });
    try {
      const result = await polling(service.url)(
        { runId: "2026-09-04T03:10:00Z" },
        () => {},
      );
      expect(result.promoted).toEqual([]);
      expect(result.lanes[0]?.status).toBe("refused");
    } finally {
      service.stop();
    }
  });

  it("rethrows the modelling service's own failure so the queue retries it", async () => {
    // The verdict moved with the run: the POST answers before the child is
    // finished, so a failed retrain is now something a *poll* reports.
    const service = retrainService({
      statusFailure: {
        status: 500,
        body: JSON.stringify({
          error: { code: "RETRAIN_FAILED", message: "the retrain process exited 3" },
        }),
      },
    });
    try {
      const failure = await polling(service.url)(
        { runId: "2026-09-04T03:10:00Z" },
        () => {},
      ).catch((error: unknown) => error);
      // `RETRAIN_FAILED` is deliberately not in `packages/core`'s closed enum —
      // no public route retrains — so it travels as `upstream_code`, which is
      // exactly what that field is for.
      expect((failure as { code?: string }).code).toBe("UPSTREAM_FAILED");
      expect(
        (failure as { details?: Record<string, unknown> }).details?.upstream_code,
      ).toBe("RETRAIN_FAILED");
    } finally {
      service.stop();
    }
  });

  it("reaches the modelling service on the two worker-only paths", async () => {
    const service = retrainService({ runMs: 40 });
    try {
      const dispatch = createWorkerDispatch({
        // The dispatcher's ingest half is never reached by a `retrain` task.
        db: null as never,
        retrain: {
          endpoint: { baseUrl: service.url, timeoutMs: 5000 },
          poll: { minMs: 10, maxMs: 20 },
        },
      });
      await dispatch(
        { kind: "retrain", payload: { runId: "2026-09-04T03:10:00Z" } },
        () => {},
      );
      expect(service.calls[0]).toBe(`POST ${RETRAIN_PATH}`);
      expect(service.calls.slice(1)).toContain(
        `GET ${retrainStatusPath("2026-09-04T03:10:00Z")}`,
      );
      expect(RETRAIN_PATH.startsWith("/internal/")).toBe(true);
      // The status route is named as the template `apps/ml` declares, which is
      // what `test/reachability.ts` reads to know the route is reachable at all.
      expect(RETRAIN_STATUS_TEMPLATE).toBe("/internal/retrain/{run_id}");
      // The run id is a path *parameter*, so it is escaped as one — `%3A` for
      // the stem's colons. Starlette decodes it before the route sees it, and
      // `tests/test_weekly_retrain.py` asserts that from the other side.
      expect(decodeURIComponent(retrainStatusPath("2026-09-04T03:10:00Z"))).toBe(
        "/internal/retrain/2026-09-04T03:10:00Z",
      );
    } finally {
      service.stop();
    }
  });
});

/**
 * **Forecaster 45 — the property this ticket exists for.**
 *
 * Measured on the live deployment on 2026-09-15: the worker POSTed the retrain
 * and waited for the whole run in one request; the call aborted after exactly
 * 300 s and was reported as `OPTIMIZER_TIMEOUT`, while the modelling service
 * went on training (CPU 36%, RSS 2.80 GB) well past the abort and completed.
 * Every retrain reported a failure that had not happened. A request that
 * transmits no bytes for twelve minutes is not a shape this deployment's
 * internal networking will hold, and no timeout on either end changes that.
 *
 * So these tests set the per-request ceiling *below* the run's own length. That
 * is the whole claim: no single request in any of them could have carried the
 * run, and the run still reaches a decision.
 */
describe("a run longer than any single request's lifetime", () => {
  /** The fixture's run, and a per-request ceiling well under it. */
  const RUN_MS = 600;
  const REQUEST_MS = 120;

  it("still reaches a decision", async () => {
    const service = retrainService({
      runMs: RUN_MS,
      decided: report([
        {
          lane: "dessem_free_v1__gate_early__thr5",
          gate_profile: "gate_early",
          status: "refused",
          artifact_id: null,
          reason: "coverage_p90 = 0.83 is outside [0.85, 0.97]",
        },
      ]),
    });
    const began = Date.now();
    try {
      const result = await polling(service.url, {
        endpoint: { baseUrl: service.url, timeoutMs: REQUEST_MS },
      })({ runId: "2026-09-04T03:10:00Z" }, () => {});

      // The run really did outlive every request that observed it.
      expect(Date.now() - began).toBeGreaterThanOrEqual(RUN_MS);
      expect(REQUEST_MS).toBeLessThan(RUN_MS);
      expect(result.lanes[0]?.status).toBe("refused");
      // One start and several short reads, rather than one long call.
      expect(service.calls.filter((call) => call.startsWith("POST")).length).toBe(1);
      expect(
        service.calls.filter((call) => call.startsWith("GET")).length,
      ).toBeGreaterThan(1);
    } finally {
      service.stop();
    }
  });

  it("reports a lane at a time, so the queue's progress is the run's", async () => {
    // `report({done, total})` used to be called once before the POST and once
    // after, so a forty-minute job had no progress at all and the operator's
    // only window on a live run was `get-service-metrics`.
    const service = retrainService({
      runMs: RUN_MS,
      decided: report([
        {
          lane: "dessem_free_v1__gate_early__thr5",
          gate_profile: "gate_early",
          status: "refused",
          artifact_id: null,
          reason: "the band's floor",
        },
        {
          lane: "dessem_free_v1__gate_late__thr5",
          gate_profile: "gate_late",
          status: "refused",
          artifact_id: null,
          reason: "crossing_rate 0.0107 against 0.01",
        },
      ]),
    });
    const progress: { done: number; total?: number }[] = [];
    try {
      await polling(service.url, {
        endpoint: { baseUrl: service.url, timeoutMs: REQUEST_MS },
      })({ runId: "2026-09-04T03:10:00Z" }, (one) => progress.push(one));
    } finally {
      service.stop();
    }
    // A lane finishing mid-run is visible mid-run — the thing a single blocking
    // call structurally cannot report.
    expect(progress).toContainEqual({ done: 1, total: 2 });
    expect(progress.at(-1)).toEqual({ done: 2, total: 2 });
  });

  it("bounds the wait with the ceiling, and the ceiling now means what it says", async () => {
    // A run that never finishes, against a ceiling small enough to test. The
    // failure names the elapsed time it measured and the ceiling that fired,
    // and says which of the two ceilings it was.
    const service = retrainService({ runMs: 60_000 });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (entry: unknown) => {
      warnings.push(String(entry));
    };
    let failure: unknown;
    try {
      failure = await polling(service.url, { deadlineMs: 200 })(
        { runId: "2026-09-04T03:10:00Z" },
        () => {},
      ).catch((error: unknown) => error);
    } finally {
      console.warn = realWarn;
      service.stop();
    }
    expect((failure as { code?: string }).code).toBe("OPTIMIZER_TIMEOUT");
    const details = (failure as { details?: Record<string, unknown> }).details;
    expect(details?.timeout_source).toBe("poll_deadline");
    expect(details?.ceiling_ms).toBe(200);
    expect(warnings.join("\n")).toContain("did not reach a decision");
    // The sentence that asserted a duration it never measured must not return.
    expect(warnings.join("\n")).not.toContain("did not finish inside");
  });

  it("attaches to a run already in flight rather than failing on it", async () => {
    // What a worker restart looks like from here. BullMQ hands the job back, the
    // handler POSTs the same run id, and the modelling service answers 409
    // because the child from the first attempt is still training. That is not a
    // failure: it is the run we came for, and the poll finds its decision.
    const service = retrainService({
      runMs: 100,
      refuseStart: {
        status: 409,
        body: JSON.stringify({
          error: { code: "RETRAIN_IN_PROGRESS", message: "already in flight" },
        }),
      },
      decided: report(
        [
          {
            lane: "dessem_free_v1__gate_early__thr5",
            gate_profile: "gate_early",
            status: "promoted",
            artifact_id: "2026-09-04T03:10:00Z",
            reason: "P(candidate better) = 0.94",
          },
        ],
        ["dessem_free_v1__gate_early__thr5"],
      ),
    });
    try {
      const result = await polling(service.url)(
        { runId: "2026-09-04T03:10:00Z" },
        () => {},
      );
      expect(result.promoted).toEqual(["dessem_free_v1__gate_early__thr5"]);
      // It did not keep re-POSTing a run that was already started.
      expect(service.calls.filter((call) => call.startsWith("POST")).length).toBe(1);
    } finally {
      service.stop();
    }
  });

  it("does not lose the run to a poll that failed on its own", async () => {
    // A poll is a request like any other and the network eats one now and then.
    // Losing one used to cost a retrain; it now costs a few seconds, which is
    // the point of making the unit of waiting small.
    const service = retrainService({ flakyPolls: 3, runMs: 50 });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (entry: unknown) => {
      warnings.push(String(entry));
    };
    try {
      const result = await polling(service.url)(
        { runId: "2026-09-04T03:10:00Z" },
        () => {},
      );
      expect(result.runId).toBe("2026-09-04T03:10:00Z");
    } finally {
      console.warn = realWarn;
      service.stop();
    }
    // Tolerated, not swallowed: a loop that says nothing is how an outage stays
    // invisible for forty minutes.
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("fails the attempt when the service has no record of the run", async () => {
    // What a mid-run redeploy of the modelling service looks like: the child
    // went with the container. Polling on would be forty minutes of asking a
    // service that has already answered. The queue's retry starts it again, and
    // a lane carrying a decision line for the run id appends nothing.
    const service = retrainService({
      statusFailure: {
        status: 404,
        body: JSON.stringify({
          error: { code: "RETRAIN_UNKNOWN", message: "no such run here" },
        }),
      },
    });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (entry: unknown) => {
      warnings.push(String(entry));
    };
    let failure: unknown;
    try {
      failure = await polling(service.url, { deadlineMs: 5000 })(
        { runId: "2026-09-04T03:10:00Z" },
        () => {},
      ).catch((error: unknown) => error);
    } finally {
      console.warn = realWarn;
      service.stop();
    }
    expect(
      (failure as { details?: Record<string, unknown> }).details?.upstream_code,
    ).toBe("RETRAIN_UNKNOWN");
    expect(warnings.join("\n")).toContain("replaced while the run was in flight");
    // And it gave up rather than polling to the ceiling.
    expect(service.calls.filter((call) => call.startsWith("GET")).length).toBe(1);
  });
});

/**
 * The schedule on the real queue — gated on `WATTSTEER_TEST_REDIS_URL` like the
 * rest of the BullMQ suite, because "repeatable job" is a claim about BullMQ's
 * job scheduler and not about a literal in a table.
 *
 *   docker run -d -p 6390:6379 redis:7-alpine
 */
const REDIS = process.env.WATTSTEER_TEST_REDIS_URL;
const redisSuite = REDIS ? describe : describe.skip;

redisSuite("the retrain schedule on the existing Redis", () => {
  const QUEUE = "wattsteer-jobs-retrain-test";

  it("registers once, idempotently, with its pattern and its zone", async () => {
    const runner = createBullMqRunner<WorkerTask, unknown>(
      async () => undefined,
      REDIS as string,
      { startWorker: false, queueName: QUEUE },
    );
    const queue = new Queue(QUEUE, { connection: { url: REDIS as string } });
    try {
      // Twice, as two replicas booting at once would.
      for (let pass = 0; pass < 2; pass++) {
        for (const schedule of retrainScheduleForQueue()) {
          await runner.schedule(schedule);
        }
      }
      const registered = (await queue.getJobSchedulers()).filter(
        (scheduler) => String(scheduler.key ?? scheduler.id) === RETRAIN_JOB_ID,
      );
      expect(registered.length).toBe(1);
      expect(registered[0]?.pattern).toBe(RETRAIN_PATTERN);
      expect(registered[0]?.tz).toBe(RETRAIN_TIME_ZONE);
    } finally {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      await runner.close();
    }
  });
});

describe("a failure says what it measured, not what it was configured with", () => {
  it("names the elapsed time and the ceiling that actually fired", async () => {
    /*
      `OPTIMIZER_TIMEOUT` used to be what `ml-proxy` raised for *any* aborted
      fetch, and the retrain's failure line mapped it to "did not finish inside
      40 minutes" whatever had actually happened. On 2026-09-15 that sentence
      sent an operator looking for a forty-minute run that had been killed at
      five minutes by a ceiling neither end configured.

      A log line stating a duration it did not measure is worse than one stating
      none: it is a confident wrong answer to the first question anybody asks.

      Here every status request is held open and never answered — the shape of a
      network that eats polls — against a 50 ms per-request ceiling and a 400 ms
      run ceiling. Each ceiling is named by the number it was actually given, and
      the elapsed time is the one measured.
    */
    const service = retrainService({ stallStatus: true });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (entry: unknown) => {
      warnings.push(String(entry));
    };
    try {
      await polling(service.url, {
        endpoint: { baseUrl: service.url, timeoutMs: 50 },
        deadlineMs: 400,
      })({}, () => {}).catch(() => undefined);
    } finally {
      console.warn = realWarn;
      service.stop();
    }
    const line = warnings.join("\n");
    // The per-request ceiling, named as the number that fired rather than as
    // the constant the production path would have used.
    expect(line).toContain("50ms ceiling");
    // The measured elapsed time, which is what tells a redeploy from a genuine
    // overrun at a glance.
    expect(line).toMatch(/aborted after \d+s/);
    // And the run's own ceiling, when it is the one that elapsed.
    expect(line).toContain("did not reach a decision");
    // The old sentence asserted the ceiling as fact. It must not come back.
    expect(line).not.toContain("did not finish inside");
  });
});

describe("whose ceiling aborted the call", () => {
  /*
    The second wrong turn of 2026-09-15's hour of diagnosis. Bun raises
    `TimeoutError` for its *own* connect and idle timeouts, so an abort that had
    nothing to do with our `AbortSignal` arrived wearing `OPTIMIZER_TIMEOUT` —
    our ceiling's name — and every sentence downstream then described it as the
    ceiling it was not. The error object cannot tell the two apart; only a flag
    set where the abort is raised can.
  */

  it("reports our own ceiling as ours, with the number it was given", async () => {
    const service = retrainService({ stallStatus: true });
    try {
      const failure = await callMl("/internal/retrain/x", new URLSearchParams(), {
        baseUrl: service.url,
        timeoutMs: 40,
      }).catch((error: unknown) => error);
      expect((failure as { code?: string }).code).toBe("OPTIMIZER_TIMEOUT");
      const details = (failure as { details?: Record<string, unknown> }).details;
      expect(details?.timeout_source).toBe("gateway");
      expect(details?.timeout_ms).toBe(40);
    } finally {
      service.stop();
    }
  });

  it("refuses to let the runtime's own abort borrow that name", async () => {
    // A `TimeoutError` this module did not raise. Before forecaster 45 the
    // mapping was on the error's *name*, so this arrived as `OPTIMIZER_TIMEOUT`
    // — a ceiling of ours that had not fired, against a call that never reached
    // the service at all.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      const runtime = new Error("The operation timed out.");
      runtime.name = "TimeoutError";
      return Promise.reject(runtime);
    }) as unknown as typeof fetch;
    let failure: unknown;
    try {
      failure = await callMl("/internal/retrain/x", new URLSearchParams(), {
        baseUrl: "http://localhost:1",
        timeoutMs: 60_000,
      }).catch((error: unknown) => error);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((failure as { code?: string }).code).not.toBe("OPTIMIZER_TIMEOUT");
    expect((failure as { code?: string }).code).toBe("OPTIMIZER_UNAVAILABLE");
    expect(
      (failure as { details?: Record<string, unknown> }).details?.timeout_source,
    ).toBe("runtime");
  });
});
