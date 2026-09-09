import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../src/api/index.js";
import {
  CANONICAL_BASE_PATH,
  CANONICAL_READ_BY_NAME,
  CANONICAL_READS,
  canonicalReadPath,
  combineFidelity,
  combineGoLive,
  type VintageSource,
  vintageFidelity,
} from "../src/contract/index.js";
import { snakeKey, toWire } from "../src/contract/wire.js";

/**
 * Seam 1 for the canonical read contract: everything that is true without a
 * database.
 *
 * The gated Postgres half is `database-contract.test.ts`; the cross-language
 * half is `packages/core/test/canonical-contract.test.ts` and
 * `apps/ml/tests/test_canonical_contract.py`. What is here is the vocabulary,
 * the wire translation, the structural claims about what the contract *cannot*
 * do, and the routing.
 */

const SRC = join(import.meta.dir, "..", "src", "contract");
const read = (file: string): string => readFileSync(join(SRC, file), "utf8");

/**
 * The same file with its comments removed.
 *
 * The structural assertions below are about what the code *does*, and a comment
 * explaining why a thing is absent necessarily names the thing. Scanning the
 * raw text instead would make the prose that documents a rule the reason the
 * rule's test fails. (These files contain no `//` inside a string literal and
 * no regex, so the strip is exact rather than approximate.)
 */
const code = (file: string): string =>
  read(file)
    // Line comments FIRST — see `stripsLineCommentsFirst` below for why the
    // reverse order silently deletes real code from this scan's own input.
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

describe("contract · the vocabulary is the domain's, not the source's", () => {
  it("exposes the five families the modelling side needs", () => {
    expect(CANONICAL_READS.map((spec) => spec.name)).toEqual([
      "curtailment-by-reporting-entity",
      "curtailment-by-plant",
      "system-context",
      "system-exchange",
      "day-ahead-balance",
      "weather-forecast",
      "installed-capacity",
      "conjunto-membership",
    ]);
  });

  it("names no source, no table and no source column anywhere in the manifest", () => {
    // The acceptance criterion, checked over the file rather than over the
    // values: a source name in a doc comment misleads a reader just as
    // effectively as one in an identifier. `conjunto` and `constrained-off` are
    // the sanctioned survivals of naming rule 2 and are not searched for.
    const source = read("manifest.ts").toLowerCase();
    for (const table of [
      "curtailment_report_hour",
      "plant_detail_hour",
      "subsystem_energy_balance_hour",
      "subsystem_exchange_hour",
      "dessem_balance_half_hour",
      "weather_forecast_hour",
      "generating_unit",
      "conjunto_membership",
    ]) {
      expect(source).not.toContain(table);
    }
    for (const column of [
      "val_geracaolimitada",
      "val_disponibilidade",
      "din_instante",
      "num_patamar",
      "id_ons",
      "cod_razaorestricao",
      "nom_conjuntousina",
    ]) {
      expect(source).not.toContain(column);
    }
  });

  it("keeps `SIN` unrepresentable — it is never a subsystem", () => {
    // `docs/domain-model.md` §2: the national aggregate row is filtered at the
    // boundary. If it reached a read name or a grain, double-counted sums
    // become expressible.
    for (const spec of CANONICAL_READS) {
      expect(spec.name).not.toContain("sin");
      expect(spec.key).not.toContain("SIN");
    }
  });
});

describe("contract · forecast and observation are distinguishable in the contract", () => {
  it("every forecast read names a producer and no observation read can", () => {
    for (const spec of CANONICAL_READS) {
      if (spec.kind === "forecast") {
        expect(spec.producer).not.toBeNull();
      } else {
        expect(spec.producer).toBeNull();
      }
    }
  });

  it("the two forecast reads are the ones with a run behind them", () => {
    expect(
      CANONICAL_READS.filter((spec) => spec.kind === "forecast").map((s) => s.name),
    ).toEqual(["day-ahead-balance", "weather-forecast"]);
  });

  it("no read returns a lead time — it is derived from two timestamps it has", () => {
    // `docs/domain-model.md` §4 makes it derived; the api-surface vocabulary
    // rules make it never returned, so a wire copy cannot disagree with the
    // pair it came from.
    for (const file of ["manifest.ts", "types.ts", "reads.ts"]) {
      expect(code(file)).not.toContain("leadTime");
    }
  });
});

describe("contract · a reason is reachable only where it is observed", () => {
  it("exactly one read carries a restriction cause", () => {
    const carrying = CANONICAL_READS.filter((spec) => spec.carriesRestrictionCause);
    expect(carrying.map((spec) => spec.name)).toEqual([
      "curtailment-by-reporting-entity",
    ]);
  });

  it("the plant-grain read has no cause field and no cause parameter", () => {
    // Structural, not stylistic. `docs/domain-model.md` §3: there is no path in
    // the type system from a Plant to a reason, and this is what keeps it so
    // when someone later adds a screen that wants one.
    const types = read("types.ts");
    const plantType = types.slice(
      types.indexOf("export interface PlantMeasurement"),
      types.indexOf("export interface SystemContextObservation"),
    );
    expect(plantType.length).toBeGreaterThan(0);
    expect(plantType).not.toContain("restrictionCause");
    expect(plantType).not.toContain("reason");

    const reads = read("reads.ts");
    const plantQuery = reads.slice(
      reads.indexOf("export interface PlantMeasurementReadQuery"),
      reads.indexOf("async function plantMeasurementsWithin"),
    );
    expect(plantQuery.length).toBeGreaterThan(0);
    expect(plantQuery).not.toContain("cause");
    expect(plantQuery).not.toContain("reason");
  });
});

describe("contract · the reads are a thin caller over the canonical views", () => {
  it("writes no as-of of its own and names no base table", () => {
    // Ticket 016's instruction, enforced. A second `DISTINCT ON` written here
    // would be a second implementation of the as-of — and this time it would
    // drift against SQL that Python is also reading, which is worse than the
    // TypeScript-only drift ticket 013 was guarding against.
    const reads = code("reads.ts");
    expect(reads.toLowerCase()).not.toContain("distinct on");
    for (const table of [
      "curtailment_report_hour",
      "plant_detail_hour",
      "subsystem_energy_balance_hour",
      "subsystem_exchange_hour",
      "dessem_balance_half_hour",
      "weather_forecast_hour",
      "generating_unit",
      "conjunto_membership",
    ]) {
      expect(reads).not.toContain(table);
    }
  });

  it("reads exactly one view per canonical read, named by the shared rule", () => {
    // The view a read lives in is *derived* from its manifest name, in both
    // languages, rather than tabulated beside it — `apps/ml`'s `view_name` does
    // the same transform and `test_canonical_contract.py` checks it from the
    // other side. A lookup table would be a second place the pairing is written
    // down, and the failure it invites is the quiet one: a renamed view and a
    // stale entry that still parses.
    const views = readFileSync(
      join(import.meta.dir, "..", "src", "database", "canonical-views.ts"),
      "utf8",
    );
    const reads = read("reads.ts");
    for (const spec of CANONICAL_READS) {
      const view = `canonical_${spec.name.replaceAll("-", "_")}`;
      const binding = view.replace(/_([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      );
      expect(views).toContain(`export const ${binding} = pgView(`);
      expect(views).toContain(`"${view}"`);
      // …and that binding is what `reads.ts` selects from, once per read.
      expect(reads.split(`\${${binding}}`)).toHaveLength(2);
    }
  });

  it("keeps the vintage rule out of SQL, and its input in", () => {
    // The one thing deliberately not pushed into the database. What the views
    // supply is the go-live instant; the inequality over two timestamps stays a
    // pure function in each language, bound by the golden vectors.
    const views = readFileSync(
      join(import.meta.dir, "..", "src", "database", "canonical-views.ts"),
      "utf8",
    );
    expect(views).not.toContain("point_in_time");
    expect(views).not.toContain("revision_optimistic");
    expect(views).toContain("canonical_read_go_live");
  });

  it("has exactly one implementation of the vintage rule in the whole app", () => {
    // Ticket 016's second drift item. It was written out identically in eight
    // `*-repository.ts` files beside the one that was actually tested; the copies
    // are gone and the survivor is `contract/vintage.ts`.
    const root = join(import.meta.dir, "..", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(dir, entry.name)]
            : [],
      );
    // Line comments FIRST, then block comments. This stripper removed block
    // comments only, and this walk reads `api/grid.ts` and `api/plants.ts`,
    // whose `//` comments at lines 280 and 261 contain a `/*`: the block it
    // opened there ran to the next `*/`, deleting 144 and 69 non-blank lines
    // from this scan's own input. A second implementation of the vintage rule
    // placed in either of those spans was invisible here.
    const scanned = walk(root);
    const strip = (source: string): string =>
      source.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const implementing = scanned.filter((file) =>
      /\?\s*"point_in_time"/.test(strip(readFileSync(file, "utf8"))),
    );
    expect(implementing.map((file) => file.replace(`${root}/`, ""))).toEqual([
      "contract/vintage.ts",
    ]);

    // The walk found the app, and read the two modules the old order truncated.
    // Without this, an empty walk would report the rule as implemented nowhere,
    // which fails only because the expectation above names a survivor — and a
    // walk that reached everything *except* those two would not fail at all.
    expect(scanned.length).toBeGreaterThan(50);
    const nonBlank = (text: string): number =>
      text.split("\n").filter((line) => line.trim() !== "").length;
    for (const name of ["api/grid.ts", "api/plants.ts"]) {
      const raw = readFileSync(join(root, name), "utf8");
      expect(scanned).toContain(join(root, name));
      // A live control: the orders genuinely disagree on these two files.
      expect(nonBlank(strip(raw))).toBeGreaterThan(
        nonBlank(raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")),
      );
    }
  });

  it("reaches no write path", () => {
    for (const file of ["reads.ts", "types.ts", "manifest.ts", "wire.ts"]) {
      const source = read(file);
      for (const forbidden of [
        "writeVersioned",
        "writeCurtailment",
        "writeEnergyBalance",
        ".insert(",
        ".update(",
        ".delete(",
        "migrate",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("runs every read inside a READ ONLY transaction", () => {
    expect(read("read-only.ts")).toContain("set transaction read only");
    // Every exported read goes through it — a read that forgot would be a hole
    // in the guarantee, so the count is asserted rather than spot-checked.
    const reads = read("reads.ts");
    const wrapped = reads.match(/readOnly\(db,/g) ?? [];
    expect(wrapped.length).toBe(9);
  });
});

describe("contract · VintageFidelity", () => {
  const goLive = new Date("2026-01-15T09:30:00.000Z");

  it("is point-in-time only from go-live onwards, inclusive", () => {
    expect(vintageFidelity(goLive, goLive)).toBe("point_in_time");
    expect(vintageFidelity(new Date(goLive.getTime() + 1), goLive)).toBe("point_in_time");
    expect(vintageFidelity(new Date(goLive.getTime() - 1), goLive)).toBe(
      "revision_optimistic",
    );
  });

  it("treats a source that has ingested nothing as revision-optimistic", () => {
    expect(vintageFidelity(new Date("2030-01-01T00:00:00Z"), null)).toBe(
      "revision_optimistic",
    );
  });

  const src = (
    fidelity: VintageSource["vintageFidelity"],
    goLiveAt: Date | null,
  ): VintageSource => ({ read: "system-context", vintageFidelity: fidelity, goLiveAt });

  it("degrades a composition to its weakest source", () => {
    expect(
      combineFidelity([src("point_in_time", goLive), src("point_in_time", goLive)]),
    ).toBe("point_in_time");
    expect(
      combineFidelity([src("point_in_time", goLive), src("revision_optimistic", goLive)]),
    ).toBe("revision_optimistic");
  });

  it("is not vacuously honest about nothing", () => {
    expect(combineFidelity([])).toBe("revision_optimistic");
    expect(combineGoLive([])).toBeNull();
  });

  it("reports the latest contributing go-live, or none when one is missing", () => {
    const later = new Date("2026-02-01T00:00:00.000Z");
    expect(
      combineGoLive([
        src("point_in_time", goLive),
        src("point_in_time", later),
      ])?.toISOString(),
    ).toBe(later.toISOString());
    expect(
      combineGoLive([src("point_in_time", goLive), src("revision_optimistic", null)]),
    ).toBeNull();
  });
});

describe("contract · the wire form", () => {
  it("converts keys the way the database spells its own columns", () => {
    expect(snakeKey("validTime")).toBe("valid_time");
    expect(snakeKey("constrainedOffMwh")).toBe("constrained_off_mwh");
    expect(snakeKey("windSpeed120mKmh")).toBe("wind_speed120m_kmh");
    expect(snakeKey("temperature2mC")).toBe("temperature2m_c");
    expect(snakeKey("goLiveAt")).toBe("go_live_at");
  });

  it("renders instants as one ISO-8601 format and keeps null as null", () => {
    expect(
      toWire({
        validTime: new Date("2026-03-01T00:00:00.000Z"),
        availableCapacityMw: null,
        rows: [{ dataVersion: 2 }],
      }),
    ).toEqual({
      valid_time: "2026-03-01T00:00:00.000Z",
      available_capacity_mw: null,
      rows: [{ data_version: 2 }],
    });
  });
});

describe("contract · routing", () => {
  it("serves the manifest with a path for every read", async () => {
    const response = await app.handle(
      new Request(`http://localhost${CANONICAL_BASE_PATH}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      base_path: string;
      reads: Array<{ name: string; path: string; carries_restriction_cause: boolean }>;
    };
    expect(body.base_path).toBe(CANONICAL_BASE_PATH);
    expect(body.reads).toHaveLength(CANONICAL_READS.length);
    for (const entry of body.reads) {
      expect(CANONICAL_READ_BY_NAME.has(entry.name as never)).toBe(true);
      expect(entry.path).toBe(canonicalReadPath(entry.name as never));
    }
    // The wire form is snake_case throughout, including the manifest itself.
    expect(body.reads[0]?.carries_restriction_cause).toBe(true);
  });

  it("lets the manifest be cached, keyed on the manifest and not on a clock", async () => {
    // The manifest is a constant of the deployment — no database, no `as_of`,
    // an answer that changes when the code changes and at no other time. It
    // gets a shared `max-age` and a content validator, and deliberately *not*
    // the `no-store` its nine siblings under the same path prefix carry:
    // sharing a path is not a caching argument. See `cache-policy.ts`.
    const url = `http://localhost${CANONICAL_BASE_PATH}`;
    const response = await app.handle(new Request(url));
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");

    const etag = response.headers.get("etag");
    // Weak, like every validator on this surface, and stable across requests —
    // a validator built from the request's own clock would differ here, which
    // is the `/v1/plants` defect and the reason this assertion is two calls.
    expect(etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
    expect((await app.handle(new Request(url))).headers.get("etag")).toBe(etag);

    const revalidated = await app.handle(
      new Request(url, { headers: { "if-none-match": etag as string } }),
    );
    expect(revalidated.status).toBe(304);
    // A 304 with no `Cache-Control` resets the window it exists to extend.
    expect(revalidated.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("stores nothing for a read, and offers no validator to store it under", async () => {
    // The reads are the other half of the ticket, and the opposite decision
    // from the manifest: an `as_of` at or after the wall clock — the ordinary
    // call from `apps/ml` — names an answer that grows under a fixed URL, and
    // there is no validator to catch it, so a heuristically cached copy is a
    // point-in-time answer served at the wrong point in time. `no-store` on
    // every path, applied in `serve` before the read runs rather than after it
    // succeeds, which is why it is here on the unconfigured 503 too.
    //
    // What this cannot show, because no suite configures the module-level
    // handle: the 200. That path is closed by a type rather than by a test —
    // `serve` takes the response as its first parameter and applies the row
    // itself, so a tenth read cannot be added without one.
    const response = await app.handle(
      new Request(
        `http://localhost${canonicalReadPath("system-context")}` +
          "?as_of=2026-03-05T00:00:00Z&from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z",
      ),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("refuses a read with no as_of rather than defaulting to now", async () => {
    const response = await app.handle(
      new Request(
        `http://localhost${canonicalReadPath("system-context")}` +
          "?from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z",
      ),
    );
    expect(response.status).toBe(422);
  });

  it("refuses an inverted or empty window rather than returning no rows", async () => {
    // An empty result would read as "there was no curtailment", which is a
    // different and much worse statement than "your window is backwards".
    const response = await app.handle(
      new Request(
        `http://localhost${canonicalReadPath("system-context")}` +
          "?as_of=2026-03-05T00:00:00Z&from=2026-03-02T00:00:00Z&to=2026-03-01T00:00:00Z",
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("[from, to)") },
    });
  });

  it("refuses an as_of that is not an instant", async () => {
    const response = await app.handle(
      new Request(
        `http://localhost${canonicalReadPath("system-context")}` +
          "?as_of=yesterday&from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z",
      ),
    );
    expect(response.status).toBe(400);
  });

  it("exposes no verb but GET", async () => {
    const response = await app.handle(
      new Request(`http://localhost${canonicalReadPath("system-context")}`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(404);
  });
});
