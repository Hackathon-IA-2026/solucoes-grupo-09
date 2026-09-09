import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_FLEET, SOURCE_ATTRIBUTION } from "@wattsteer/core/constants";
import { GATES } from "@wattsteer/core/schedule";
import { explain, validate } from "@wattsteer/core/schema";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { createMetaRoutes } from "../src/api/meta.js";
import type { MlEndpoint } from "../src/api/ml-proxy.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * `/v1/meta` — the endpoint you read *because* something is broken, so the
 * claims worth asserting are the ones that hold while things are broken.
 *
 * No database is configured in this suite and, for most of it, no modelling
 * service either. That is not a limitation of the tests: it is the deployment
 * the spec's degradation table describes, and the whole point of this endpoint
 * is that it answers 200 in it and says precisely what is missing.
 */

const SOURCE = join(import.meta.dir, "..", "src");

/** Source with block and line comments removed — prose may not satisfy a rule. */
function code(relative: string): string {
  return (
    readFileSync(join(SOURCE, relative), "utf8")
      // Line comments FIRST, then block comments — the order is load-bearing and
      // the reverse is silently wrong. `api/grid.ts:280` and `api/plants.ts:261`
      // are `//` comments containing `/*`, whose slash-star opens a block the
      // block-stripper then runs to the next `*/` — 190 and 94 lines later —
      // deleting real route code from the scan. Measured: a `fetch(config.mlUrl)`
      // planted at `grid.ts:400` was NOT caught and the identical one at line 268
      // was. `stripsLineCommentsFirst` below is the standing control.
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}

/** What the stubbed modelling service answers next. */
let reply: () => Response | Promise<Response> = () => new Response("{}");
const upstream: Server = Bun.serve({ port: 0, fetch: () => reply() });

/** A port nothing is listening on: opened, its number kept, then closed. */
const closedPort = (() => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  return port;
})();

afterAll(() => {
  upstream.stop(true);
});

const reachable = (): MlEndpoint => ({
  baseUrl: `http://127.0.0.1:${upstream.port}`,
  timeoutMs: 2000,
});

const NOW = new Date("2026-08-28T18:04:11.000Z");

function server(ml?: MlEndpoint) {
  return new Elysia()
    .use(errorHandler)
    .use(createMetaRoutes({ db: undefined, ml, now: () => NOW, environment: "test" }));
}

async function meta(ml?: MlEndpoint): Promise<{
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}> {
  const response = await server(ml).handle(
    new Request("http://localhost/v1/meta", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    }),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** The modelling service's own `/v1/meta`, as `apps/ml/src/wattsteer_ml/app.py` writes it. */
function mlMeta(overrides: {
  lanes?: unknown[];
  mounted?: boolean;
  writable?: boolean;
  declines?: unknown[];
  caveats?: unknown[];
}) {
  reply = () =>
    new Response(
      JSON.stringify({
        service: "wattsteer-ml",
        version: "0.1.0",
        environment: "test",
        database_configured: true,
        database_access: "read-only",
        artifacts: {
          path: "/data/models",
          mounted: overrides.mounted ?? true,
          writable: overrides.writable ?? true,
          count: (overrides.lanes ?? []).length,
          lanes: overrides.lanes ?? [],
          promotion_log: { path: "/data/models/promotions.jsonl", decisions: 1 },
          unrecognised: [],
        },
        // Forecaster 25's census, as `wattsteer_ml/declined.py` assembles it.
        // Its contents are asserted in `declined-figures.test.ts`; what it is
        // doing here is keeping this stub the shape of the real reply.
        declines: overrides.declines ?? [],
        // Forecaster 28's mirror, from `wattsteer_ml/caveated.py`: the
        // figures this build *does* state that do not mean what their
        // names say. Same reason for being here — the stub keeps the shape.
        caveats: overrides.caveats ?? [],
      }),
      { headers: { "content-type": "application/json" } },
    );
}

describe("meta · one request says what this deployment can do", () => {
  it("answers the whole document, and it is the schema's own shape", async () => {
    mlMeta({
      lanes: [
        {
          lane: "dessem_free_v1__gate_late__thr5",
          state: "promoted",
          promoted: "2026-08-28T03:11:07Z",
          fault: null,
        },
      ],
    });
    const { status, body } = await meta(reachable());
    expect(status).toBe(200);
    const result = validate("meta.schema.json", body);
    expect(result.valid ? "" : explain(result)).toBe("");

    // Every block the ticket asks for, in one request. Named rather than
    // counted — a count here is a number that goes stale the next time the
    // document grows, and it has: `declines` is forecaster 25's census of the
    // figures this deployment will not state. A client reads all of them
    // before first paint, which is the argument for one document rather than
    // five round trips.
    expect(Object.keys(body).sort()).toEqual([
      "attribution",
      "caveats",
      "data",
      "declines",
      "defaults",
      "environment",
      "forecast",
      "gates",
      "model",
      "reference_fleet",
      "server_time",
      "service",
      "version",
      "window",
    ]);
  });

  it("echoes the four published constants rather than restating them", async () => {
    const { body } = await meta(reachable());
    expect(body.defaults).toEqual({
      subsystem_threshold_mw: 5,
      reporting_entity_threshold_mw: 1,
      max_gap_hours: 0,
      brl_per_mwh: 180,
    });
  });

  it("puts the gate instants on the payload, so no screen hardcodes one", async () => {
    const { body } = await meta(reachable());
    expect(body.gates).toEqual(
      GATES.map((gate) => ({
        profile: gate.profile,
        publishes_at_local: gate.publishesAtLocal,
        timezone: gate.timezone,
        weather_run: gate.weatherRun,
      })),
    );
    // The instant the data next changes, derived from the same table. This is
    // what a client polls against — `api-surface.md` rules out webhooks and SSE
    // on the grounds that this field exists.
    const forecast = body.forecast as Record<string, unknown>;
    expect(forecast.next_publication_at).toBe("2026-08-28T22:00:00.000Z");
    expect(forecast.latest_published).toEqual([]);
  });

  it("echoes the reference fleet, whole, in the wire's spelling", async () => {
    const { body } = await meta(reachable());
    expect(body.reference_fleet).toEqual({
      battery: {
        asset_type: "battery",
        label: REFERENCE_FLEET.battery.label,
        max_power_mw: REFERENCE_FLEET.battery.maxPowerMw,
        energy_capacity_mwh: REFERENCE_FLEET.battery.energyCapacityMwh,
        round_trip_efficiency: REFERENCE_FLEET.battery.roundTripEfficiency,
        initial_state_of_charge: REFERENCE_FLEET.battery.initialStateOfCharge,
      },
      shiftable_load: {
        asset_type: "shiftable_load",
        label: REFERENCE_FLEET.shiftableLoad.label,
        max_power_mw: REFERENCE_FLEET.shiftableLoad.maxPowerMw,
        max_shift_mw: REFERENCE_FLEET.shiftableLoad.maxShiftMw,
        shift_window_hours: REFERENCE_FLEET.shiftableLoad.shiftWindowHours,
        daily_energy_mwh: REFERENCE_FLEET.shiftableLoad.dailyEnergyMwh,
      },
    });
  });
});

describe("meta · nothing fetches the reference fleet in order to use it", () => {
  /** Every `.ts`/`.tsx` file under a source tree. */
  function files(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules") {
          files(path, found);
        }
      } else if (/\.tsx?$/.test(entry)) {
        found.push(path);
      }
    }
    return found;
  }

  it("only the route that echoes it names it at all", () => {
    // `api-surface.md` refuses `GET /v1/reference-fleet` because floor coverage
    // and the forecaster's `Δ recovered_floor_mwh` must be measured against the
    // *same* battery. Echoing it on `/v1/meta` reintroduces the hazard in one
    // narrow way — a caller could read it back off this payload — so the rule
    // is asserted on this side: everything that computes against the fleet
    // imports the constant, and exactly one file mentions the wire field.
    const offenders = [
      ...files(SOURCE),
      ...files(join(import.meta.dir, "..", "..", "web", "src")),
    ].filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        /\breferenceFleet\b|\breference_fleet\b/.test(source) &&
        !path.endsWith(join("api", "meta.ts"))
      );
    });
    expect(offenders).toEqual([]);
  });

  it("the echo is the constant itself, not a copy of its numbers", () => {
    const route = code("api/meta.ts");
    expect(route).toContain("REFERENCE_FLEET");
    // A literal here is a second fleet, which is the whole failure mode.
    expect(route).not.toContain("maxPowerMw: ");
    expect(route).not.toContain("energyCapacityMwh");
  });
});

describe("meta · the model block, and it is the only one that can go missing", () => {
  it("reports the lane states verbatim, with the volume beside them", async () => {
    mlMeta({
      lanes: [
        {
          lane: "a__gate_late__thr5",
          state: "promoted",
          promoted: "2026-08-28T03:11:07Z",
        },
        { lane: "b__gate_late__thr5", state: "present_unpromoted", promoted: null },
        { lane: "c__gate_late__thr5", state: "no_artifact", promoted: null },
      ],
      mounted: true,
      writable: false,
    });
    const { body } = await meta(reachable());
    const model = body.model as Record<string, unknown>;
    expect(model.reachable).toBe(true);
    // Verbatim: the forecaster's own spellings, not re-worded on the way out.
    expect((model.lanes as Record<string, unknown>[]).map((lane) => lane.state)).toEqual([
      "promoted",
      "present_unpromoted",
      "no_artifact",
    ]);
    expect((model.lanes as Record<string, unknown>[])[0]?.artifact_id).toBe(
      "2026-08-28T03:11:07Z",
    );
    // Reported separately, so "the volume did not mount" and "nothing is
    // trained" do not look alike. A read-only mount is neither of those again.
    expect(model.volume).toEqual({ mounted: true, writable: false });
  });

  it("carries `unresolvable` through rather than guessing between the three", async () => {
    // `artifacts.py` produces it for a damaged promotion log, and the one thing
    // it must never do is fall back to the newest file. Neither may this: an
    // `unresolvable` lane rendered as `no_artifact` reports a broken volume as
    // an untrained model.
    mlMeta({
      lanes: [
        {
          lane: "a__gate_late__thr5",
          state: "unresolvable",
          promoted: null,
          fault: "promotion log line 3 is truncated",
        },
      ],
    });
    const { body } = await meta(reachable());
    const lane = (
      (body.model as Record<string, unknown>).lanes as Record<string, unknown>[]
    )[0];
    expect(lane?.state).toBe("unresolvable");
    expect(lane?.fault).toBe("promotion log line 3 is truncated");
  });

  it("says a promoted lane owes a retrain rather than reporting it as serving", async () => {
    // Forecaster 26. `0039_the_gate_over_a_backfill.sql` repaired the feature
    // gate's `as_of` inside `feature_rows`, which moved `feature_hash` on
    // purpose — so every artifact fitted before it is bound to a vector the
    // database no longer produces, and the hot-swap gate marks it invalid. The
    // promotion log still names it: a migration revokes no line. So the lane is
    // `promoted` and serves nothing, and this is the field that says so without
    // an operator having to trigger a promotion attempt to find out.
    mlMeta({
      lanes: [
        {
          lane: "dessem_free_v1__gate_late__thr5",
          state: "promoted",
          promoted: "2026-08-28T03:11:07Z",
          usable: false,
          retrain_owed: true,
          contract_fault: "the live feature_rows definition hashes to sha256:04228af2",
          unusable_reason: "2026-08-28T03:11:07Z is marked invalid; a retrain is owed.",
        },
      ],
    });
    const { body } = await meta(reachable());
    const lane = (
      (body.model as Record<string, unknown>).lanes as Record<string, unknown>[]
    )[0];
    expect(lane?.state).toBe("promoted");
    expect(lane?.usable).toBe(false);
    expect(lane?.retrain_owed).toBe(true);
    expect(String(lane?.contract_fault)).toContain("feature_rows");
    expect(String(lane?.unusable_reason)).toContain("retrain");
    // The two are mutually exclusive: a card that would not parse states no
    // contract fault, so a lane reporting one must not report the other.
    expect(lane).not.toHaveProperty("card_error");
  });

  it("keeps an unreadable card apart from a moved feature contract", async () => {
    // Both make the lane unusable and the repairs are different — one is a
    // retrain, the other is the volume — so `retrain_owed` stays false and the
    // sentence says the question cannot be answered from here.
    mlMeta({
      lanes: [
        {
          lane: "dessem_free_v1__gate_late__thr5",
          state: "promoted",
          promoted: "2026-08-28T03:11:07Z",
          usable: false,
          retrain_owed: false,
          contract_fault: null,
          card_error: "the promoted artifact's card cannot be read.",
          unusable_reason: "the volume must be repaired before anything can serve.",
        },
      ],
    });
    const { body } = await meta(reachable());
    const lane = (
      (body.model as Record<string, unknown>).lanes as Record<string, unknown>[]
    )[0];
    expect(lane?.usable).toBe(false);
    expect(lane?.retrain_owed).toBe(false);
    expect(String(lane?.card_error)).toContain("cannot be read");
    expect(lane).not.toHaveProperty("contract_fault");
  });

  it("does not report a debt for a lane the forecaster says is serving", async () => {
    // The control. Without it the assertion above is compatible with a
    // gateway that reports `retrain_owed` for every lane it sees.
    mlMeta({
      lanes: [
        {
          lane: "dessem_free_v1__gate_late__thr5",
          state: "promoted",
          promoted: "2026-08-28T03:11:07Z",
          usable: true,
          retrain_owed: false,
          contract_fault: null,
          unusable_reason: null,
        },
      ],
    });
    const { body } = await meta(reachable());
    const lane = (
      (body.model as Record<string, unknown>).lanes as Record<string, unknown>[]
    )[0];
    expect(lane?.usable).toBe(true);
    expect(lane?.retrain_owed).toBe(false);
    expect(lane).not.toHaveProperty("contract_fault");
    expect(lane).not.toHaveProperty("unusable_reason");
  });

  it("omits the serviceability fields when the forecaster does not report them", async () => {
    // Absent is not `false`. A modelling service too old to answer the question
    // must not be rendered as one answering "this lane cannot serve" — that is
    // the same rounding-down this endpoint refuses for the lane states.
    mlMeta({
      lanes: [
        {
          lane: "dessem_free_v1__gate_late__thr5",
          state: "promoted",
          promoted: "2026-08-28T03:11:07Z",
        },
      ],
    });
    const { body } = await meta(reachable());
    const lane = (
      (body.model as Record<string, unknown>).lanes as Record<string, unknown>[]
    )[0];
    expect(lane).not.toHaveProperty("usable");
    expect(lane).not.toHaveProperty("retrain_owed");
  });

  it("refuses to round an unrecognised state down to one of the three", async () => {
    mlMeta({ lanes: [{ lane: "a__gate_late__thr5", state: "retired", promoted: null }] });
    const { body } = await meta(reachable());
    const lane = (
      (body.model as Record<string, unknown>).lanes as Record<string, unknown>[]
    )[0];
    expect(lane?.state).toBe("unresolvable");
    expect(String(lane?.fault)).toContain("retired");
  });

  it("degrades to a 200 when the modelling service refuses the connection", async () => {
    const { status, body } = await meta({
      baseUrl: `http://127.0.0.1:${closedPort}`,
      timeoutMs: 500,
    });
    expect(status).toBe(200);
    expect(body.model).toEqual({
      reachable: false,
      unreachable_reason: "OPTIMIZER_UNAVAILABLE",
      lanes: [],
      // Not `{mounted: false}`: the volume is mounted into *that* process, so
      // with the service unreachable its state is unknown, and this endpoint
      // does not make claims it cannot support.
      volume: null,
    });
    // And the rest of the body is still correct, which is the whole promise.
    expect(body.defaults).toBeDefined();
    expect(body.gates).toHaveLength(2);
    expect(body.attribution).toBeDefined();
    expect(validate("meta.schema.json", body).valid).toBe(true);
  });

  it("says which failure it was, because three of them mean different things", async () => {
    // Unconfigured is not broken. An operator reading `OPTIMIZER_NOT_CONFIGURED`
    // learns something a boolean `reachable: false` would have hidden.
    const unconfigured = await meta({ baseUrl: undefined, timeoutMs: 500 });
    expect((unconfigured.body.model as Record<string, unknown>).unreachable_reason).toBe(
      "OPTIMIZER_NOT_CONFIGURED",
    );

    reply = () => new Promise<Response>(() => {});
    const timedOut = await meta({
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      timeoutMs: 60,
    });
    expect((timedOut.body.model as Record<string, unknown>).unreachable_reason).toBe(
      "OPTIMIZER_TIMEOUT",
    );
  });

  it("survives a modelling service that answers 200 with nonsense", async () => {
    // A service answering unreadably is a broken service, not a broken gateway.
    reply = () =>
      new Response("<html>not json</html>", { headers: { "content-type": "text/html" } });
    const { status, body } = await meta(reachable());
    expect(status).toBe(200);
    expect((body.model as Record<string, unknown>).reachable).toBe(false);
  });
});

describe("meta · the attribution block is data, and untranslated", () => {
  it("names every source the shared constant does, with its licence identifier", async () => {
    const { body } = await meta(reachable());
    const attribution = body.attribution as Record<string, Record<string, unknown>>;
    expect(Object.keys(attribution).sort()).toEqual(
      Object.keys(SOURCE_ATTRIBUTION).sort(),
    );
    expect(attribution.ons?.licence).toBe("CC-BY-4.0");
    expect(attribution.aneel_siga?.licence).toBe("ODbL-1.0");
    // Untranslated on purpose: the bilingual §4.3 notice is assembled by the
    // client around these identifiers. `ODbL-1.0` has no Portuguese spelling.
    for (const source of Object.values(attribution)) {
      expect(typeof source.licence).toBe("string");
      expect(typeof source.url).toBe("string");
    }
  });

  it("puts the ODbL specifics on the wire under their own names", async () => {
    // The bug ticket 19 found and worked around: `attribution` is a map, the
    // codec used to carry its values through unrenamed, and the block validated
    // either way. This is the assertion that the fix is in force end to end,
    // through the real route rather than through the codec alone.
    const { body } = await meta(reachable());
    const siga = (body.attribution as Record<string, Record<string, unknown>>).aneel_siga;
    expect(siga?.derivative_database).toBe(true);
    expect(siga?.machine_readable_at).toBe("/v1/plants");
    expect(siga?.derivativeDatabase).toBeUndefined();
    expect(siga?.machineReadableAt).toBeUndefined();
  });

  it("takes it from the shared constant rather than a literal", () => {
    const route = code("api/meta.ts");
    expect(route).toContain("SOURCE_ATTRIBUTION");
    expect(route).not.toContain('"CC-BY-4.0"');
    expect(route).not.toContain('"ODbL-1.0"');
  });
});

describe("meta · no-store, and no ETag", () => {
  it("is not cacheable, and offers no validator to revalidate against", async () => {
    // `api-surface.md`'s caching table, and it is in tension with its own story
    // 25 ("an ETag on every read"). Resolved in favour of `no-store`: an ETag
    // exists so a shared cache can revalidate rather than re-query, and a
    // response that may not be stored has nothing to revalidate. The 304 it
    // would enable is also the wrong answer here — "unchanged" is not what an
    // operator asking "is the volume still gone?" needs to hear from a cache.
    const { headers } = await meta(reachable());
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("etag")).toBeNull();
  });

  it("answers a conditional request with the document, never a 304", async () => {
    const response = await server(reachable()).handle(
      new Request("http://localhost/v1/meta", {
        headers: { "if-none-match": 'W/"anything"', "x-forwarded-for": "9.9.9.9" },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("meta · the boundary", () => {
  it("translates through the one translator", () => {
    const route = code("api/meta.ts");
    expect(route).toContain("encodeWire");
    expect(route).not.toContain('from "../contract/wire.js"');
  });

  it("crosses to the modelling service through the one edge module", () => {
    // `api-surface.md`'s Seam 1 names the optimizer and the replay solve; this
    // is the third and last crossing, it is diagnostic rather than a data path,
    // and it goes through `ml-proxy.ts` so the failure mapping is the same one.
    const route = code("api/meta.ts");
    expect(route).toContain("callMl");
    expect(route).not.toContain("fetch(");
  });
});
