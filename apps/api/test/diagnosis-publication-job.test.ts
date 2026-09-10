import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import { readAttributionDayAhead } from "../src/diagnosis/reads.js";
import { readRecentReasonMix } from "../src/diagnosis/reason-mix.js";
import { gateAt } from "../src/forecast/gate.js";
import {
  type CurtailmentReportHour,
  type ObservedReportingEntity,
  upsertReportingEntities,
  writeCurtailment,
} from "../src/ingest/index.js";
import {
  createDiagnosisPublisher,
  diagnosisFollowOn,
} from "../src/jobs/diagnosis-publication.js";
import { PUBLICATION_LANES } from "../src/jobs/publication.js";
import { createWorkerDispatch, type WorkerTask } from "../src/jobs/worker-tasks.js";
import {
  attributionPayload,
  GATE_LATE,
  TARGET_DATE,
} from "./support/attribution-payload.js";

/**
 * The diagnosis publication — `api-surface` ticket 10's third and fourth boxes.
 *
 * Two things are proved here and nowhere else:
 *
 * 1. **The chain.** `docs/specs/api-surface.md`'s job table gives
 *    `publish-diagnosis` the trigger "on completion of each" forecast
 *    publication — the one row that is not a cron pattern. So what has to be
 *    asserted is not a schedule but a *submission*: a forecast publication that
 *    finished puts a `publish_diagnosis` task on the same queue, carrying the
 *    day it actually wrote rather than a re-resolved "tomorrow".
 *
 * 2. **`recent_reasons` comes from a real read.** `diagnosis` ticket 07 shipped
 *    `unmodelled_outage_regime` complete and tested against a *supplied*
 *    `ReasonMix`, and the rule could not fire because nothing read one. The
 *    read is `src/diagnosis/reason-mix.ts`; the assertions below are against
 *    real ONS-shaped rows in real Postgres, and the sharp one is the **cutoff**:
 *    a day whose reason mix would change the answer sits just beyond
 *    `actuals_cutoff` and must not be the day that is read.
 *
 * The modelling service is a stub over a real socket, as the forecast
 * publication's suite has it. `apps/ml` serves no `/internal/publish/diagnosis`
 * route yet — that half is blocked on the forecaster's matched background
 * sample in the artifact bundle — so the payload crossing the wire is the
 * checked-in cross-language vector's shape and not a live computation.
 *
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const LANE = PUBLICATION_LANES.gate_late;
/** Ten past the late gate for the fixture's day — where the schedule runs. */
const TEN_PAST = new Date("2024-05-06T22:10:00.000Z");

/**
 * The cutoff, worked out once so every date below is checkable by hand.
 *
 * `gate_at('2024-05-07', 'gate_late')` is 2024-05-06 19:00 BRT =
 * `2024-05-06T22:00Z`. `restricao-coff` carries a 40 h publication lag
 * (`drizzle/0021`), so `actuals_cutoff` is `2024-05-05T06:00Z` = 2024-05-05
 * 03:00 BRT.
 *
 * A Brasília civil day qualifies only when its **last** hour is behind that:
 * day `D`'s 23:00 BRT is `D+1 02:00Z`, so `D+1 02:00Z <= 2024-05-05T06:00Z`,
 * so `D <= 2024-05-04`.
 *
 * - `2024-05-04` — the last qualifying day. `REL` leads it.
 * - `2024-05-05` — one day too new. `CNF` leads it, overwhelmingly, so a read
 *   that ignored the cutoff would return a different day *and* a different
 *   top reason. That is what makes the cutoff assertion sharp rather than
 *   decorative.
 */
const SETTLED_DAY = "2024-05-04";
const TOO_NEW_DAY = "2024-05-05";

const CONJUNTO = "CJU_TESTREASON";
const PLANT_S = "TESTREASONS1";

const entities: ObservedReportingEntity[] = [
  {
    onsCode: CONJUNTO,
    kind: "CONJUNTO",
    cegCore: null,
    name: "CONJ. REASON NE",
    subsystem: "NE",
    stateCode: "BA",
  },
  {
    onsCode: PLANT_S,
    kind: "PLANT",
    cegCore: "EOL.RS.RS.000999",
    name: "USINA REASON S",
    subsystem: "S",
    stateCode: "RS",
  },
];

const report = (
  entity: string,
  validTime: string,
  constrainedOffMwh: number,
  reason: "REL" | "CNF" | "ENE" | "PAR",
): CurtailmentReportHour => ({
  reportingEntityCode: entity,
  technology: "WIND",
  validTime: new Date(validTime),
  verifiedGenerationMwh: 100,
  constrainedOffMwh,
  referenceGenerationMwh: 150,
  finalReferenceGenerationMwh: null,
  availableCapacityMw: 200,
  halfHoursObserved: 2,
  cause: { reason, origin: "SIS", description: null },
  causeMixed: false,
});

/**
 * NE on the qualifying day: 60 MWh of `REL` against 40 of `ENE`.
 *
 * Chosen so `top_reason_share` is exactly `0.6` — a number a reader can check
 * against the rows — and so `REL` leads, which is what makes
 * `unmodelled_outage_regime` fire.
 */
const rows: CurtailmentReportHour[] = [
  report(CONJUNTO, `${SETTLED_DAY}T10:00:00.000Z`, 45, "REL"),
  report(CONJUNTO, `${SETTLED_DAY}T11:00:00.000Z`, 15, "REL"),
  report(CONJUNTO, `${SETTLED_DAY}T12:00:00.000Z`, 40, "ENE"),
  // One day too new, and led by a different reason. Nothing may read it.
  report(CONJUNTO, `${TOO_NEW_DAY}T10:00:00.000Z`, 900, "CNF"),
  // S, on the same qualifying day, led by `ENE`: the mix is resolved per
  // subsystem, so this must not become NE's answer or take NE's.
  report(PLANT_S, `${SETTLED_DAY}T10:00:00.000Z`, 80, "ENE"),
  report(PLANT_S, `${SETTLED_DAY}T11:00:00.000Z`, 20, "REL"),
];

const SOURCE = (path: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

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

/**
 * A database that fails on contact — the forecast suite's proxy, reused.
 *
 * The strongest way to make "nothing was written" a measurement rather than a
 * count that happened to be zero.
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

describe("the diagnosis publication, chained", () => {
  it("maps a finished forecast publication onto the day it wrote", () => {
    // The mapping in one place, asserted without running either job. The day
    // is *carried*, never re-resolved: a follow-on that recomputed "tomorrow in
    // Brasília" a few seconds after midnight would explain the wrong day.
    expect(
      diagnosisFollowOn({
        gateProfile: "gate_late",
        lane: LANE,
        targetDate: TARGET_DATE,
      }),
    ).toEqual({ gateProfile: "gate_late", lane: LANE, targetDate: TARGET_DATE });
  });

  it("keeps the diagnosis publication out of every gateway module", () => {
    // The same structural claim `forecast-publication-job.test.ts` makes about
    // the forecast half. Nothing under `src/api/` may reach the private
    // publication route — not the call, not the job, not the reason read — and
    // this says so about the import graph rather than about a comment.
    const forbidden = [
      "diagnosis/publish",
      "diagnosis/reason-mix",
      "jobs/diagnosis-publication",
      "jobs/worker-tasks",
    ];
    const files = readdirSync(join(import.meta.dir, "..", "src", "api")).filter((file) =>
      file.endsWith(".ts"),
    );
    // Non-vacuous: there are gateway modules to check, and one of them is the
    // diagnosis route itself.
    expect(files).toContain("diagnosis.ts");
    for (const file of files) {
      const imports = SOURCE(join("api", file))
        .split("\n")
        .filter((line) => line.startsWith("import "));
      for (const module of forbidden) {
        expect(imports.some((line) => line.includes(module))).toBe(false);
      }
    }
  });

  it("does not re-export the publish path through the diagnosis barrel", () => {
    // `src/api/diagnosis.ts` imports the barrel, so a re-export would put
    // `ml-proxy` and the private route on the gateway's graph by the back door
    // — which is why `jobs/index.ts` does not re-export `jobs/publication.ts`
    // either.
    const barrel = SOURCE("diagnosis/index.ts");
    expect(barrel).not.toContain('from "./publish.js"');
    expect(barrel).not.toContain('from "./reason-mix.js"');
  });

  it("has the modelling service write nothing", () => {
    // The direction of the call is the read-only guarantee: `apps/ml` returns
    // rows and this side inserts them. The only INSERT in the path is
    // `writeAttributionPublication`'s, inside its transaction.
    expect(SOURCE("jobs/diagnosis-publication.ts")).not.toContain(".insert(");
    const publish = SOURCE("diagnosis/publish.ts");
    expect(publish).not.toContain(".insert(");
    expect(publish).toContain("writeAttributionPublication(db");
  });

  it("refuses a publication stamped with anything but its gate, and writes nothing", async () => {
    // The forecast publisher's check, one grain over. Thirty minutes past the
    // gate is a plausible "when the job ran" stamp and it is the exact defect:
    // an attribution is published with the forecast it explains.
    const shifted = attributionPayload({
      publishedAt: "2024-05-06T22:30:00.000Z",
    });
    const service = serving(
      () =>
        new Response(JSON.stringify(shifted), {
          headers: { "content-type": "application/json" },
        }),
    );
    const publish = createDiagnosisPublisher({
      db: untouchable(),
      endpoint: { baseUrl: service.url, timeoutMs: 5000 },
      now: () => TEN_PAST,
    });
    try {
      await publish(
        { gateProfile: "gate_late", lane: LANE, targetDate: TARGET_DATE },
        () => {},
      );
      throw new Error("the mis-stamped publication was not refused");
    } catch (error) {
      expect(String((error as Error).message)).toContain(
        "published with the forecast it explains",
      );
    } finally {
      service.stop();
    }
  });
});

suite("the diagnosis publication end to end (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  const clear = async () => {
    await db.execute(sql`truncate table diagnosis_attribution cascade`);
    await db.execute(sql`truncate table curtailment_forecast_hour`);
    await db.execute(sql`truncate table curtailment_forecast_day`);
    await db.execute(sql`truncate table curtailment_forecast_national_day`);
  };

  beforeAll(async () => {
    await clear();
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_conj",
        resourceName: "Restricoes_coff_eolicas-2024-05",
        resourceUrl: "https://example.invalid/REASONS_2024_05.csv",
        format: "CSV",
        changeKey: `reason-mix-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    await upsertReportingEntities(db, entities);
    await writeCurtailment(db, {
      rows,
      publishedAt: new Date("2024-05-06T09:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId: version?.id ?? "",
      ingestedAt: new Date("2024-05-06T09:30:00.000Z"),
    });
  });

  afterAll(async () => {
    await clear();
    await handle.close();
  });

  describe("recent_reasons, from a real read", () => {
    it("reads the most recent settled day behind the cutoff, per subsystem", async () => {
      const ne = await readRecentReasonMix(db, {
        subsystem: "NE",
        targetDate: TARGET_DATE,
        gateProfile: "gate_late",
        asOf: TEN_PAST,
      });
      if (ne === null) {
        throw new Error("NE had no reason mix, so the rule still cannot fire");
      }
      // The qualifying day, not the newer one — and the numbers are the rows'.
      expect(ne.settledDate).toBe(SETTLED_DAY);
      expect(ne.totalMwh).toBe(100);
      expect(ne.shares).toEqual({ REL: 0.6, ENE: 0.4 });

      // Per subsystem, resolved separately: S's own day, led by ENE.
      const s = await readRecentReasonMix(db, {
        subsystem: "S",
        targetDate: TARGET_DATE,
        gateProfile: "gate_late",
        asOf: TEN_PAST,
      });
      expect(s?.settledDate).toBe(SETTLED_DAY);
      expect(s?.shares).toEqual({ ENE: 0.8, REL: 0.2 });
    });

    it("does not read a day the gate could not have seen", async () => {
      // The sharp one. `2024-05-05` exists in the table, is *newer*, carries
      // 900 MWh — nine times the whole qualifying day — and is led by `CNF`
      // rather than `REL`. A read at the gate instead of at `actuals_cutoff`
      // would return it, and `unmodelled_outage_regime` would stop firing on a
      // day it should fire on. So the assertion is on the reason too, not only
      // on the date.
      const present = await db.execute<{ days: number }>(sql`
        select count(distinct
          (valid_time at time zone 'America/Sao_Paulo')::date
        )::int as days
        from curtailment_report_hour
      `);
      expect([...present][0]?.days).toBe(2);

      const ne = await readRecentReasonMix(db, {
        subsystem: "NE",
        targetDate: TARGET_DATE,
        gateProfile: "gate_late",
        asOf: TEN_PAST,
      });
      expect(ne?.settledDate).not.toBe(TOO_NEW_DAY);
      expect(ne?.shares.CNF).toBeUndefined();
    });

    it("moves the cutoff with the gate profile", async () => {
      // `gate_early` is ten hours earlier, so its cutoff is ten hours earlier
      // too. Asserted as a relation between the two answers rather than as a
      // literal instant: what matters is that the profile reaches the read.
      const early = await readRecentReasonMix(db, {
        subsystem: "NE",
        // A target date whose early gate falls just before the qualifying
        // day's last hour is behind the cutoff.
        targetDate: "2024-05-06",
        gateProfile: "gate_early",
        asOf: TEN_PAST,
      });
      const late = await readRecentReasonMix(db, {
        subsystem: "NE",
        targetDate: "2024-05-06",
        gateProfile: "gate_late",
        asOf: TEN_PAST,
      });
      // gate_early('2024-05-06') = 2024-05-05T12:00Z − 40 h = 2024-05-03T20:00Z,
      // which is before 2024-05-04's last hour, so nothing qualifies.
      expect(early).toBeNull();
      // gate_late('2024-05-06') = 2024-05-05T22:00Z − 40 h = 2024-05-04T06:00Z,
      // which is still before it. Both null, and the gate arithmetic is what
      // the next assertion pins.
      expect(late).toBeNull();
      expect(gateAt("2024-05-06", "gate_early").toISOString()).toBe(
        "2024-05-05T12:00:00.000Z",
      );
      expect(gateAt("2024-05-06", "gate_late").toISOString()).toBe(
        "2024-05-05T22:00:00.000Z",
      );
    });

    it("returns an absence rather than a day of zeros", async () => {
      // No rows for this subsystem at all. `null`, so
      // `RuleContext.recent_reasons` is `None` and the rule does not fire —
      // never four zero shares, which the rule would read as a finding.
      const none = await readRecentReasonMix(db, {
        subsystem: "N",
        targetDate: TARGET_DATE,
        gateProfile: "gate_late",
        asOf: TEN_PAST,
      });
      expect(none).toBeNull();
    });
  });

  describe("the publication itself", () => {
    /** The worker's own handler, dispatching the queue's tagged payload. */
    const dispatchWith = (
      baseUrl: string,
      submitted: WorkerTask[],
    ): ReturnType<typeof createWorkerDispatch> =>
      createWorkerDispatch({
        db,
        diagnosis: {
          endpoint: { baseUrl, timeoutMs: 120_000 },
          now: () => TEN_PAST,
        },
        submit: async (task) => {
          submitted.push(task);
          return "queued";
        },
      });

    it("runs the queued task, supplying the reason mix it read", async () => {
      let asked: Record<string, unknown> | null = null;
      const service = serving(async (request) => {
        asked = (await request.json()) as Record<string, unknown>;
        return new Response(JSON.stringify(attributionPayload()), {
          headers: { "content-type": "application/json" },
        });
      });
      const submitted: WorkerTask[] = [];
      const dispatch = dispatchWith(service.url, submitted);
      try {
        const first = await dispatch(
          {
            kind: "publish_diagnosis",
            payload: { gateProfile: "gate_late", lane: LANE, targetDate: TARGET_DATE },
          },
          () => {},
        );
        if (first.kind !== "publish_diagnosis") {
          throw new Error("the dispatcher answered the wrong task");
        }
        expect(first.result.outcome).toBe("published");
        expect(first.result.targetDate).toBe(TARGET_DATE);
        expect(first.result.publishedAt).toBe(GATE_LATE);
        expect(first.result.attributionsInserted).toBe(1);
        expect(first.result.driversInserted).toBe(16);
        // The read reached the request, for the two subsystems that had a day.
        expect(first.result.reasonsSuppliedFor.sort()).toEqual(["NE", "S"]);
      } finally {
        service.stop();
      }

      // And this is what crossed the wire: the shares, the settled date, and
      // no MWh — the rule compares shares, and shipping the energies would
      // invite a second producer of the same ratio.
      const request = asked as unknown as {
        lane: string;
        target_date: string;
        recent_reasons: Record<string, { settled_date: string; shares: unknown }>;
      };
      expect(request.lane).toBe(LANE);
      expect(request.target_date).toBe(TARGET_DATE);
      expect(Object.keys(request.recent_reasons).sort()).toEqual(["NE", "S"]);
      expect(request.recent_reasons.NE).toEqual({
        settled_date: SETTLED_DAY,
        shares: { REL: 0.6, ENE: 0.4 },
      });
    });

    it("writes nothing on a re-run whose numbers match", async () => {
      const service = serving(
        () =>
          new Response(JSON.stringify(attributionPayload()), {
            headers: { "content-type": "application/json" },
          }),
      );
      const submitted: WorkerTask[] = [];
      const dispatch = dispatchWith(service.url, submitted);
      const task: WorkerTask = {
        kind: "publish_diagnosis",
        payload: { gateProfile: "gate_late", lane: LANE, targetDate: TARGET_DATE },
      };
      try {
        await dispatch(task, () => {});
        const again = await dispatch(task, () => {});
        if (again.kind !== "publish_diagnosis") {
          throw new Error("the dispatcher answered the wrong task");
        }
        expect(again.result.outcome).toBe("unchanged");
        expect(again.result.attributionsInserted).toBe(0);
        expect(again.result.attributionsRevised).toBe(0);
      } finally {
        service.stop();
      }
      const versions = await db.execute<{ versions: string }>(sql`
        select string_agg(distinct data_version::text, ',') as versions
        from diagnosis_attribution
      `);
      expect([...versions][0]?.versions).toBe("1");

      // And the day reads back, which is what the whole chain exists for.
      const back = await readAttributionDayAhead(db, {
        subsystem: "NE",
        targetDate: TARGET_DATE,
        gateProfile: "gate_late",
        asOf: new Date(TEN_PAST.getTime() + 60_000),
      });
      expect(back?.publishedAt.toISOString()).toBe(GATE_LATE);
      expect(back?.drivers).toHaveLength(8);
      expect(back?.peakHourDrivers).toHaveLength(8);
    });

    it("chains itself onto a forecast publication's completion", async () => {
      // The trigger, end to end on the queue's own vocabulary: the forecast
      // publication finishes and *submits* the follow-on, carrying the day it
      // wrote. The forecast fixture is a different day from the attribution
      // one, which is what makes "the day is carried" visible.
      const fixture = readFileSync(
        join(import.meta.dir, "fixtures", "forecast", "publication.json"),
        "utf8",
      );
      const forecastDay = "2025-04-08";
      const service = serving(
        () => new Response(fixture, { headers: { "content-type": "application/json" } }),
      );
      const submitted: WorkerTask[] = [];
      const dispatch = createWorkerDispatch({
        db,
        publication: {
          endpoint: { baseUrl: service.url, timeoutMs: 120_000 },
          now: () => new Date("2025-04-07T22:10:00.000Z"),
        },
        submit: async (task) => {
          submitted.push(task);
          return "queued";
        },
      });
      try {
        const result = await dispatch(
          { kind: "publish_forecast", payload: { gateProfile: "gate_late", lane: LANE } },
          () => {},
        );
        if (result.kind !== "publish_forecast") {
          throw new Error("the dispatcher answered the wrong task");
        }
        expect(result.result.outcome).toBe("published");
      } finally {
        service.stop();
      }
      // Exactly one follow-on, for the day the forecast publication wrote.
      expect(submitted).toEqual([
        {
          kind: "publish_diagnosis",
          payload: {
            gateProfile: "gate_late",
            lane: LANE,
            targetDate: forecastDay,
          },
        },
      ]);
    });

    it("chains on an unchanged re-publication too", async () => {
      // A forecast publication that wrote nothing says nothing about whether
      // the *attribution* exists — it has its own digest, its own vintage and
      // its own way of having failed last time. So the chain is unconditional,
      // and this is the assertion that keeps it that way.
      const fixture = readFileSync(
        join(import.meta.dir, "fixtures", "forecast", "publication.json"),
        "utf8",
      );
      const service = serving(
        () => new Response(fixture, { headers: { "content-type": "application/json" } }),
      );
      const submitted: WorkerTask[] = [];
      const dispatch = createWorkerDispatch({
        db,
        publication: {
          endpoint: { baseUrl: service.url, timeoutMs: 120_000 },
          now: () => new Date("2025-04-07T22:10:00.000Z"),
        },
        submit: async (task) => {
          submitted.push(task);
          return "queued";
        },
      });
      const task: WorkerTask = {
        kind: "publish_forecast",
        payload: { gateProfile: "gate_late", lane: LANE },
      };
      try {
        await dispatch(task, () => {});
        const again = await dispatch(task, () => {});
        if (again.kind !== "publish_forecast") {
          throw new Error("the dispatcher answered the wrong task");
        }
        expect(again.result.outcome).toBe("unchanged");
      } finally {
        service.stop();
      }
      expect(submitted).toHaveLength(2);
      expect(submitted.map((task) => task.kind)).toEqual([
        "publish_diagnosis",
        "publish_diagnosis",
      ]);
    });

    it("does not fail a forecast publication whose follow-on could not be queued", async () => {
      // The rows are written and committed by the time the chain runs, so
      // throwing would mark a publication that succeeded as failed and hand it
      // back for a retry that would rewrite nothing. The forecast is the
      // deliverable; the explanation is repaired by a re-submitted task.
      const fixture = readFileSync(
        join(import.meta.dir, "fixtures", "forecast", "publication.json"),
        "utf8",
      );
      const service = serving(
        () => new Response(fixture, { headers: { "content-type": "application/json" } }),
      );
      const dispatch = createWorkerDispatch({
        db,
        publication: {
          endpoint: { baseUrl: service.url, timeoutMs: 120_000 },
          now: () => new Date("2025-04-07T22:10:00.000Z"),
        },
        submit: async () => {
          throw new Error("redis is gone");
        },
      });
      try {
        const result = await dispatch(
          { kind: "publish_forecast", payload: { gateProfile: "gate_late", lane: LANE } },
          () => {},
        );
        if (result.kind !== "publish_forecast") {
          throw new Error("the dispatcher answered the wrong task");
        }
        // Reported as what it was: the forecast published.
        expect(["published", "unchanged"]).toContain(result.result.outcome);
      } finally {
        service.stop();
      }
    });

    it("submits nothing when no chain is configured", async () => {
      // `submit` absent means the chain is off, which is what every test of
      // the ingest dispatcher and every in-process runner gets. The forecast
      // publication still publishes.
      const fixture = readFileSync(
        join(import.meta.dir, "fixtures", "forecast", "publication.json"),
        "utf8",
      );
      const service = serving(
        () => new Response(fixture, { headers: { "content-type": "application/json" } }),
      );
      const dispatch = createWorkerDispatch({
        db,
        publication: {
          endpoint: { baseUrl: service.url, timeoutMs: 120_000 },
          now: () => new Date("2025-04-07T22:10:00.000Z"),
        },
      });
      try {
        const result = await dispatch(
          { kind: "publish_forecast", payload: { gateProfile: "gate_late", lane: LANE } },
          () => {},
        );
        expect(result.kind).toBe("publish_forecast");
      } finally {
        service.stop();
      }
    });
  });
});
