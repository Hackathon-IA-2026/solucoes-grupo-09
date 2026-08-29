import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia } from "elysia";
import { createGridRoutes } from "../src/api/grid.js";
import { app } from "../src/api/index.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * The claims about `/v1/grid/now` that need no database.
 *
 * Two of them are structural and are the ones worth having: that the endpoint
 * **has no path to the modelling service** — which is why it can be served with
 * `apps/ml` down and with nothing promoted — and that it **has no path to a
 * base table**, which is what keeps the canonical views the single definition
 * of a canonical read. Both are asserted over the source with comments
 * stripped, because a rule that a docstring can satisfy is not a rule.
 */

const SOURCE = join(import.meta.dir, "..", "src");

/** Source with block and line comments removed — prose may not satisfy a rule. */
function code(relative: string): string {
  return readFileSync(join(SOURCE, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const ROUTE = code("api/grid.ts");
const READ = code("contract/grid-now.ts");

describe("grid/now · the boundary, structurally", () => {
  it("reaches the modelling service nowhere", () => {
    for (const source of [ROUTE, READ]) {
      expect(source).not.toContain("ml-proxy");
      expect(source).not.toContain("mlUrl");
      expect(source).not.toContain("fetch(");
    }
  });

  it("reads the canonical view and never a base table", () => {
    expect(READ).toContain("canonicalCurtailmentByReportingEntity");
    // The tables the view is built over. Naming one here would put the `AsOf`
    // pick, the renames and the grain in a second place.
    for (const table of [
      "curtailment_report_hour",
      "reporting_entity",
      "plant_detail_hour",
    ]) {
      expect(READ).not.toContain(table);
      expect(ROUTE).not.toContain(table);
    }
  });

  it("sets the vintage axis rather than bypassing it", () => {
    // `canonical_as_of()` raises 22023 when unset; this is the one place on
    // this path that may write it.
    expect(READ).toContain("applyAxes");
  });

  it("translates through the one translator, not by rule", () => {
    // `contract/wire.ts` derives snake_case from camelCase, and the derivation
    // is lossy on this payload's leading field: `last24hConstrainedOffMwh`
    // becomes `last24h_constrained_off_mwh`, and the contract says
    // `last_24h_constrained_off_mwh`.
    expect(ROUTE).toContain("encodeWire");
    expect(ROUTE).not.toContain('from "../contract/wire.js"');
    expect(encodeWire("SubsystemNow", { last24hConstrainedOffMwh: 1 })).toEqual({
      last_24h_constrained_off_mwh: 1,
    });
  });
});

describe("grid/now · the route", () => {
  it("is registered on the app under /v1", () => {
    const routes = app.routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toContain("GET /v1/grid/now");
  });

  it("answers an unconfigured database as an absence of data", async () => {
    const withoutDb = new Elysia()
      .use(errorHandler)
      .use(createGridRoutes({ db: undefined }));
    const response = await withoutDb.handle(new Request("http://localhost/v1/grid/now"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DATA_UNAVAILABLE");
  });
});
