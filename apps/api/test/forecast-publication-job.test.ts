import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GRID_TIME_ZONE, latestTargetDate } from "@wattsteer/core/scenario-validation";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { toForecastDayAhead } from "../src/api/forecast.js";
import { createDatabase, type Database } from "../src/database/connection.js";
import { gateAt } from "../src/forecast/gate.js";
import type { ForecastGateProfile } from "../src/forecast/publication.js";
import { parsePublication, writePublication } from "../src/forecast/publication.js";
import { readForecastDayAhead, readLatestPublished } from "../src/forecast/reads.js";
import { createBullMqRunner } from "../src/jobs/bullmq.js";
import {
  createForecastPublisher,
  FORECAST_PUBLICATIONS,
  PUBLICATION_LANES,
  PUBLICATION_TIME_ZONE,
} from "../src/jobs/publication.js";
import {
  createWorkerDispatch,
  forecastPublicationSchedules,
  type WorkerTask,
} from "../src/jobs/worker-tasks.js";

/**
 * The publication job — `api-surface` ticket 10.
 *
 * Forecaster 14 built and proved the unit of work: ask the modelling service,
 * write what comes back, in one transaction, append-only. This file is about
 * everything around it that only a schedule has: *when* it runs, *which* day it
 * asks for, and what it does when the answer is "the inputs are not there".
 *
 * The three that matter and are easy to get wrong:
 *
 * 1. **Ten minutes after the gate, not on it.** Asserted against `gateAt`
 *    rather than against the string `"10 19 * * *"`, so the two cannot drift
 *    apart silently.
 * 2. **The publication instant is the gate exactly.** The worker computes it
 *    from its own `gate_at` before the call and refuses a payload that came
 *    back stamped with anything else — before the first insert, so a
 *    disagreement writes nothing.
 * 3. **Missing inputs are a named condition, not an anonymous 404.** ONS's
 *    evening publication has been measured landing at 19:00:25–19:08 BRT, so
 *    the 19:10 run can legitimately be early. It writes nothing, it rethrows
 *    the modelling service's own code so the queue retries, and the previous
 *    origin keeps serving with its real age.
 */

const FIXTURE = readFileSync(
  join(import.meta.dir, "fixtures", "forecast", "publication.json"),
  "utf8",
);

/** The fixture's day, and the late gate that stamps it: D−1 19:00 in Brasília. */
const TARGET_DATE = "2025-04-08";
const GATE_LATE = new Date("2025-04-07T22:00:00.000Z");
/** Ten past the gate — where the schedule actually puts the run. */
const TEN_PAST = new Date("2025-04-07T22:10:00.000Z");
const LANE = PUBLICATION_LANES.gate_late;

/** A stand-in for the modelling service, over a real socket. */
const serving = (
  handler: (request: Request) => Response | Promise<Response>,
): { url: string; stop: () => void } => {
  const server = Bun.serve({ port: 0, fetch: handler });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
};

const refusing = (status: number, code: string, message: string) =>
  serving(
    () =>
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

/**
 * A database that fails on contact.
 *
 * The refusal tests are assertions about *not writing*, and the strongest way
 * to make "nothing was written" a measurement rather than a count that happened
 * to be zero is to hand the publisher a handle it cannot touch at all.
 */
const untouchable = (): Database =>
  new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`the database was touched: ${String(property)}`);
      },
    },
  ) as unknown as Database;

const SOURCE = (path: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

const importsOf = (source: string): string[] =>
  source.split("\n").filter((line) => line.startsWith("import "));

describe("the publication schedule", () => {
  it("registers exactly the two repeatable jobs the spec tabulates", () => {
    const schedules = forecastPublicationSchedules();
    expect(schedules.map((schedule) => schedule.id).sort()).toEqual([
      "publish-forecast:gate_early",
      "publish-forecast:gate_late",
    ]);
    for (const schedule of schedules) {
      expect(schedule.timeZone).toBe(GRID_TIME_ZONE);
      const task = schedule.payload as Extract<WorkerTask, { kind: "publish_forecast" }>;
      expect(task.kind).toBe("publish_forecast");
      expect(task.payload.lane).toBe(PUBLICATION_LANES[task.payload.gateProfile]);
      // No target date is pinned: a schedule registered once must not still be
      // asking for the day it was registered on a year later.
      expect(task.payload.targetDate).toBeUndefined();
    }
  });

  it("puts each run ten minutes after its own gate", () => {
    // Against `gateAt`, not against the cron string: the point is that the two
    // spellings of the gate hour agree, and comparing "10 19 * * *" to the
    // literal 19 would only prove the test can read.
    expect(PUBLICATION_TIME_ZONE).toBe(GRID_TIME_ZONE);
    for (const publication of FORECAST_PUBLICATIONS) {
      const [minute, hour] = publication.pattern.split(" ");
      expect(minute).toBe("10");
      const profile: ForecastGateProfile = publication.payload.gateProfile;
      // The instant the cron fires on the fixture's day, in Brasília, and the
      // day it would then publish.
      const fires = new Date(
        Date.parse(`2025-04-07T${String(hour).padStart(2, "0")}:10:00-03:00`),
      );
      const gate = gateAt(latestTargetDate(fires), profile);
      expect(fires.getTime() - gate.getTime()).toBe(10 * 60_000);
    }
  });
});

/**
 * The schedules on the real queue — gated on `WATTSTEER_TEST_REDIS_URL` like
 * the rest of the BullMQ suite, because "repeatable job" is a claim about
 * BullMQ's job scheduler and not about a literal in a table.
 *
 *   docker run -d -p 6390:6379 redis:7-alpine
 */
const REDIS = process.env.WATTSTEER_TEST_REDIS_URL;
const redisSuite = REDIS ? describe : describe.skip;

redisSuite("the publication schedule on the existing Redis", () => {
  const QUEUE = "wattsteer-jobs-publication-test";

  it("registers both, idempotently, with their pattern and their zone", async () => {
    const runner = createBullMqRunner<WorkerTask, unknown>(
      async () => undefined,
      REDIS as string,
      { startWorker: false, queueName: QUEUE },
    );
    const queue = new Queue(QUEUE, { connection: { url: REDIS as string } });
    try {
      // Twice, as two replicas booting at once would: the ids are stable, so
      // the queue converges on one scheduler apiece rather than two.
      for (let pass = 0; pass < 2; pass++) {
        for (const schedule of forecastPublicationSchedules()) {
          await runner.schedule(schedule);
        }
      }
      const registered = (await queue.getJobSchedulers()).filter((scheduler) =>
        String(scheduler.key ?? scheduler.id).startsWith("publish-forecast:"),
      );
      expect(registered.length).toBe(2);
      const byId = new Map(
        registered.map((scheduler) => [String(scheduler.key ?? scheduler.id), scheduler]),
      );
      for (const publication of FORECAST_PUBLICATIONS) {
        const scheduler = byId.get(publication.id);
        expect(scheduler?.pattern).toBe(publication.pattern);
        expect(scheduler?.tz).toBe(PUBLICATION_TIME_ZONE);
      }
    } finally {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      await runner.close();
    }
  });
});

describe("the publication job's day and gate", () => {
  it("publishes tomorrow in Brasília, resolved from the clock", async () => {
    let asked: unknown = null;
    const service = serving(async (request) => {
      asked = await request.json();
      // Refuse after recording: this test is about the question, not the answer.
      return new Response(
        JSON.stringify({
          error: { code: "FORECAST_UNAVAILABLE", message: "no feature rows" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });
    const publish = createForecastPublisher({
      db: untouchable(),
      endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      now: () => TEN_PAST,
    });
    try {
      await publish({ gateProfile: "gate_late", lane: LANE }, () => {});
      throw new Error("the refusal was not raised");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("FORECAST_UNAVAILABLE");
    } finally {
      service.stop();
    }
    expect(asked).toEqual({ lane: LANE, target_date: TARGET_DATE });
  });

  it("refuses to publish a day whose gate has not passed", async () => {
    let called = false;
    const service = serving(() => {
      called = true;
      return new Response("{}");
    });
    const publish = createForecastPublisher({
      db: untouchable(),
      endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      // One minute before the late gate: the schedule is wrong, or a day was
      // submitted by hand.
      now: () => new Date(GATE_LATE.getTime() - 60_000),
    });
    try {
      await publish({ gateProfile: "gate_late", lane: LANE }, () => {});
      throw new Error("the early run was not refused");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("FORECAST_NOT_YET_PUBLISHED");
    } finally {
      service.stop();
    }
    // And the modelling service was never asked to draw an ensemble for it.
    expect(called).toBe(false);
  });

  it("refuses a publication stamped with anything but its gate", async () => {
    // The modelling service's `published_at` comes off the feature rows, which
    // Postgres stamped with `gate_at`. If it disagrees with this side's
    // `gate_at`, one of the two is wrong and neither is a row to write.
    const shifted = JSON.parse(FIXTURE) as {
      forecast_origin: { published_at: string };
    };
    shifted.forecast_origin.published_at = "2025-04-07T22:10:00+00:00";
    const service = serving(() => Response.json(shifted));
    const publish = createForecastPublisher({
      db: untouchable(),
      endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      now: () => TEN_PAST,
    });
    try {
      await publish({ gateProfile: "gate_late", lane: LANE }, () => {});
      throw new Error("the mis-stamped publication was not refused");
    } catch (error) {
      expect(String((error as Error).message)).toContain(
        "publication instant is the gate",
      );
    } finally {
      service.stop();
    }
  });

  it("carries a refusal's own code through, and writes nothing", async () => {
    // Two refusals, two repairs: wait for the inputs, or promote an artifact.
    // Flattening either into "upstream error" costs the operator the one bit
    // that decides which.
    for (const [status, code] of [
      [404, "FORECAST_UNAVAILABLE"],
      [503, "MODEL_UNAVAILABLE"],
    ] as const) {
      const service = refusing(status, code, "refused");
      const publish = createForecastPublisher({
        db: untouchable(),
        endpoint: { baseUrl: service.url, timeoutMs: 5000 },
        now: () => TEN_PAST,
      });
      try {
        await publish({ gateProfile: "gate_late", lane: LANE }, () => {});
        throw new Error(`${code} was not raised`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe(code);
      } finally {
        service.stop();
      }
    }
  });
});

describe("the boundary, asserted structurally", () => {
  it("keeps the publication out of every gateway module", () => {
    // The forecast is a row a schedule wrote. Nothing under `src/api/` may
    // reach the publication — not the modelling call, not the schedule, not the
    // worker's task union — and this is the check that says so about the
    // import graph rather than about a comment.
    const forbidden = [
      "forecast/publish",
      "jobs/publication",
      "jobs/worker-tasks",
      "worker.js",
    ];
    for (const file of readdirSync(join(import.meta.dir, "..", "src", "api"))) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const imports = importsOf(SOURCE(join("api", file)));
      for (const module of forbidden) {
        expect(imports.some((line) => line.includes(module))).toBe(false);
      }
    }
  });

  it("gives the queue's publication task exactly one importer", () => {
    // `jobs/index.ts` is the barrel every ingest adapter imports for `Execute`.
    // Re-exporting the publication through it would put `ml-proxy` on a path
    // half the codebase already has, so the worker imports the two modules
    // directly and the barrel says why.
    expect(SOURCE("jobs/index.ts")).not.toContain('from "./publication.js"');
    expect(SOURCE("jobs/index.ts")).not.toContain('from "./worker-tasks.js"');
    // The worker is the one importer, and the import is a multi-line one, so
    // the whole source is searched rather than its `import ` line starts.
    expect(SOURCE("worker.ts")).toContain('from "./jobs/worker-tasks.js"');
  });

  it("has the modelling service write nothing", () => {
    // The direction of the call is the read-only guarantee: `apps/ml` returns
    // rows and this side inserts them. The only INSERT in the publication path
    // is `writePublication`'s, inside its transaction.
    expect(SOURCE("jobs/publication.ts")).not.toContain(".insert(");
    const publish = SOURCE("forecast/publish.ts");
    expect(publish).not.toContain(".insert(");
    expect(publish).toContain("writePublication(db");
  });
});

/**
 * The end-to-end job against real Postgres — gated exactly like the other
 * database suites, and skipped by the default `bun test`.
 *
 * The modelling service is a stub over a real socket by default and the real
 * one when `WATTSTEER_TEST_ML_URL` names it: the payload crossing the wire is
 * the same either way, and a suite that could only run with a promoted
 * artifact and a joblib volume would never run at all.
 *
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

suite("the publication job end to end (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const REAL_ML = process.env.WATTSTEER_TEST_ML_URL;

  const clear = async () => {
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
    // The national grain too. Without it a second write of the same fixture
    // reports `nationalUnchanged` — the digest matched a row the previous test
    // left behind — and any assertion about what this publication inserted
    // reads a leftover instead.
    await db.execute(sql`truncate table curtailment_forecast_national_day`);
  };

  beforeEach(clear);
  afterAll(async () => {
    await clear();
    await handle.close();
  });

  /** The worker's own handler, dispatching the queue's tagged payload. */
  const dispatchWith = (baseUrl: string) =>
    createWorkerDispatch({
      db,
      publication: {
        endpoint: { baseUrl, timeoutMs: 120_000 },
        now: () => TEN_PAST,
      },
    });

  const task: WorkerTask = {
    kind: "publish_forecast",
    payload: { gateProfile: "gate_late", lane: LANE },
  };

  it("runs the queued task and leaves the day readable at its gate", async () => {
    const service = serving(
      () => new Response(FIXTURE, { headers: { "content-type": "application/json" } }),
    );
    const dispatch = dispatchWith(REAL_ML ?? service.url);
    try {
      const first = await dispatch(task, () => {});
      if (first.kind !== "publish_forecast") {
        throw new Error("the dispatcher answered the wrong task");
      }
      expect(first.result.outcome).toBe("published");
      expect(first.result.targetDate).toBe(TARGET_DATE);
      expect(first.result.gateProfile).toBe("gate_late");
      // The publication instant is the gate, exactly — no tolerance.
      expect(first.result.publishedAt).toBe(GATE_LATE.toISOString());
      expect(first.result.hoursInserted).toBe(96);
      expect(first.result.daysInserted).toBe(4);

      // A re-run is not a second publication: every digest matches, so the
      // transaction writes nothing and `data_version` does not move. That is
      // what makes a BullMQ redelivery and a manual catch-up safe.
      const again = await dispatch(task, () => {});
      if (again.kind !== "publish_forecast") {
        throw new Error("the dispatcher answered the wrong task");
      }
      expect(again.result.outcome).toBe("unchanged");
      expect(again.result.hoursInserted + again.result.hoursRevised).toBe(0);
    } finally {
      service.stop();
    }

    const versions = await db.execute<{ versions: string }>(sql`
      select string_agg(distinct data_version::text, ',') as versions
      from curtailment_forecast_day
    `);
    expect([...versions][0]?.versions).toBe("1");

    const back = await readForecastDayAhead(db, {
      subsystem: "NE",
      targetDate: TARGET_DATE,
      gateProfile: "gate_late",
      asOf: TEN_PAST,
    });
    expect(back?.hours.length).toBe(24);
    expect(back?.day.publishedAt.toISOString()).toBe(GATE_LATE.toISOString());
    expect(back?.day.derivation).toBe("path_ensemble");
  });

  it("leaves the previous origin serving when the inputs have not landed", async () => {
    // The measured case: the late gate is at 19:00 and ONS's evening files have
    // been observed landing at 19:00:25–19:08, so the 19:10 run can find a
    // promoted model and no feature rows. What must not happen is a row of
    // zeros, a half-written day, or a reader who cannot tell.
    const good = serving(
      () => new Response(FIXTURE, { headers: { "content-type": "application/json" } }),
    );
    try {
      await dispatchWith(good.url)(task, () => {});
    } finally {
      good.stop();
    }

    const empty = refusing(
      404,
      "FORECAST_UNAVAILABLE",
      "the model is promoted and its inputs are not there",
    );
    try {
      // The next gate's run, one day on, with nothing to build from.
      const dispatch = createWorkerDispatch({
        db,
        publication: {
          endpoint: { baseUrl: empty.url, timeoutMs: 5000 },
          now: () => new Date("2025-04-08T22:10:00.000Z"),
        },
      });
      await dispatch(task, () => {});
      throw new Error("the refusal did not reach the queue");
    } catch (error) {
      // Rethrown as itself, so BullMQ retries it under the existing attempts
      // policy and an operator reads a cause rather than "job failed".
      expect((error as { code?: string }).code).toBe("FORECAST_UNAVAILABLE");
    } finally {
      empty.stop();
    }

    // Nothing was added: the failed publication is not representable as a
    // partial row, and the day that did publish is untouched.
    const counted = await db.execute<{ hours: number; days: number }>(sql`
      select
        (select count(*)::int from curtailment_forecast_hour) as hours,
        (select count(*)::int from curtailment_forecast_day) as days
    `);
    expect([...counted][0]).toEqual({ hours: 96, days: 4 });

    // And the previous origin still serves — with its real age, which is the
    // degradation the boundary decision promises rather than a hidden failure.
    const later = new Date("2025-04-08T22:15:00.000Z");
    const origins = await readLatestPublished(db, { asOf: later });
    expect(origins[0]?.targetDate).toBe(TARGET_DATE);
    expect(origins[0]?.publishedAt.toISOString()).toBe(GATE_LATE.toISOString());

    const back = await readForecastDayAhead(db, {
      subsystem: "NE",
      targetDate: TARGET_DATE,
      gateProfile: "gate_late",
      asOf: later,
    });
    if (!back) {
      throw new Error("the previous publication stopped serving");
    }
    const wire = toForecastDayAhead(back, later);
    expect(wire.forecastOrigin.ageHours).toBe(24.3);
    expect(wire.forecastOrigin.originKind).toBe("served");
  });

  /**
   * The gate equality as a **table** constraint —
   * `drizzle/0041_the_gate_as_a_table_constraint.sql`.
   *
   * Ticket 10 shipped the equality as a publisher-side check and said so: the
   * job computes `gate_at` on this side and `publishForecast` refuses a payload
   * stamped with anything else *before* its first insert. Every test above is
   * about that path. These three are about the other paths — a repair script, a
   * second writer, a `writePublication` call with no `expectPublishedAt` — for
   * which the publisher's check does not exist at all.
   *
   * Each one is written so that it cannot pass vacuously:
   *
   * - the happy-path row is inserted first and asserted to have *landed*, so
   *   the refusal below is a refusal of a row the table would otherwise take;
   * - the defect is reintroduced as the one-field diff that produces it —
   *   19:30 BRT where the late gate is 19:00 — and the assertion is on the
   *   constraint's own name, so a refusal for any other reason fails;
   * - and the catalogue check *derives* the tables it covers from
   *   `information_schema` rather than listing them. A fifth table carrying the
   *   three columns fails this test on the day it is added rather than the day
   *   somebody notices its rows are mis-stamped.
   */
  describe("published_at = gate_at(target_date, gate_profile), on the table", () => {
    /** `writePublication` with no `expectPublishedAt` — the publisher's check off. */
    const writeWithInstant = (publishedAt: string) => {
      const payload = JSON.parse(FIXTURE) as {
        forecast_origin: { published_at: string };
      };
      payload.forecast_origin.published_at = publishedAt;
      return writePublication(db, parsePublication(payload), { ingestedAt: TEN_PAST });
    };

    it("takes the row whose instant is the gate", async () => {
      // The non-vacuity half. Without it the refusal below could be a refusal
      // of anything — a missing column, an absent table, a parse error.
      const written = await writeWithInstant(GATE_LATE.toISOString());
      expect(written.hoursInserted).toBe(96);
      expect(written.daysInserted).toBe(4);
      expect(written.nationalInserted).toBe(1);
      const stamps = await db.execute<{ instants: number }>(sql`
        select count(distinct published_at)::int as instants
        from curtailment_forecast_hour
      `);
      expect([...stamps][0]?.instants).toBe(1);
    });

    it("refuses the row whose instant is not, naming the constraint", async () => {
      // Thirty minutes past the gate: a plausible "when the job actually ran"
      // stamp, and the exact defect the boundary decision rules out — a row
      // asserting a publication that did not happen at that instant.
      // Drizzle wraps the driver's error, so the constraint name — the thing
      // that makes this a refusal *by the gate constraint* rather than by
      // anything else — is on the cause.
      const refusal = await writeWithInstant("2025-04-07T22:30:00.000Z").then(
        () => undefined,
        (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause,
      );
      expect(refusal?.constraint_name).toBe(
        "curtailment_forecast_hour_published_at_is_the_gate",
      );
      // The refusal is the transaction's, so nothing of the publication landed
      // — not the hours, not the days, and not the national row.
      const counted = await db.execute<{ hours: number; days: number; nat: number }>(sql`
        select
          (select count(*)::int from curtailment_forecast_hour) as hours,
          (select count(*)::int from curtailment_forecast_day) as days,
          (select count(*)::int from curtailment_forecast_national_day) as nat
      `);
      expect([...counted][0]).toEqual({ hours: 0, days: 0, nat: 0 });
    });

    it("covers every table that carries the three columns", async () => {
      // Derived, not listed: the claim is about the schema rather than about
      // four names somebody remembered to type.
      const rows = await db.execute<{
        table_name: string;
        definition: string | null;
      }>(sql`
        with carriers as (
          select c.table_name
          from information_schema.columns c
          join pg_class rel
            on rel.relname = c.table_name and rel.relkind = 'r'
          join pg_namespace ns
            on ns.oid = rel.relnamespace and ns.nspname = 'public'
          where c.table_schema = 'public'
            and c.column_name in ('published_at', 'target_date', 'gate_profile')
          group by c.table_name, rel.oid
          having count(distinct c.column_name) = 3
        )
        select
          carriers.table_name,
          (
            select pg_get_constraintdef(con.oid)
            from pg_constraint con
            where con.conrelid =
                    ('public.' || quote_ident(carriers.table_name))::regclass
              and con.contype = 'c'
              and con.conname = carriers.table_name || '_published_at_is_the_gate'
          ) as definition
        from carriers
        order by carriers.table_name
      `);
      const carriers = [...rows];
      expect(carriers.map((row) => row.table_name)).toEqual([
        "curtailment_forecast_day",
        "curtailment_forecast_hour",
        "curtailment_forecast_national_day",
        "diagnosis_attribution",
      ]);
      for (const carrier of carriers) {
        // Present, and a *call* to `gate_at` rather than a fourth spelling of
        // the gate hour inlined into a CHECK.
        expect(carrier.definition).toContain("gate_at");
        expect(carrier.definition).toContain("published_at");
      }
    });
  });
});
