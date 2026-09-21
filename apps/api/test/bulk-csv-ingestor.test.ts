import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The invariants every bulk ONS source shares, asserted once.
 *
 * These were unassertable until `bulk-csv-ingestor.ts` existed. The body was
 * written out per source — `daily-load-job` and `interchange-job` were 62 and
 * 66 lines with 28 differing, and the five differences were names — so "no
 * ingestor marks the resource ingested before its write resolves" was four
 * separate readings of four files, and a fifth source could break it by being
 * copied wrong.
 *
 * The ordering is not a style preference. `bulk-resource.ts`'s header records
 * what it costs: a parse that threw once left the resource **marked ingested**,
 * and the task then reported `changed: false, inserted: 0` for ever after — a
 * source that had stopped ingesting while every run looked clean.
 */

const INGEST = join(import.meta.dir, "..", "src", "ingest");

/** Source with comments blanked: a claim in prose is not a claim in code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

const ingestor = code(readFileSync(join(INGEST, "bulk-csv-ingestor.ts"), "utf8"));

/** Every job module that declares a bulk CSV spec. */
const SPECS = readdirSync(INGEST)
  .filter((name) => name.endsWith("-job.ts"))
  .map((name) => ({ name, text: code(readFileSync(join(INGEST, name), "utf8")) }))
  .filter((file) => file.text.includes("createBulkCsvIngestor"));

describe("the shared body owns the order, and owns it once", () => {
  it("there are specs to govern", () => {
    // The half that stops every assertion below passing vacuously if the
    // filename convention changes.
    expect(SPECS.map((s) => s.name).sort()).toEqual([
      "constrained-off-detail-job.ts",
      "constrained-off-job.ts",
      "daily-load-job.ts",
      "interchange-job.ts",
    ]);
  });

  it("settles the resource only after the write has resolved", () => {
    // The incident this file exists for, as an ordering in one place.
    const write = ingestor.indexOf("await spec.write(");
    const settle = ingestor.indexOf("await acquired.markIngested()");
    expect(write).toBeGreaterThan(0);
    expect(settle).toBeGreaterThan(write);
  });

  it("reports the last progress step only on the path that downloaded", () => {
    const early = ingestor.indexOf("return { ...base, downloaded: false }");
    const report = ingestor.indexOf("report({ done: BULK_STEPS");
    expect(early).toBeGreaterThan(0);
    expect(report).toBeGreaterThan(early);
  });

  it("decodes UTF-8 in one place", () => {
    expect(ingestor).toContain('new TextDecoder("utf-8").decode(acquired.bytes)');
    for (const spec of SPECS) {
      expect({ file: spec.name, text: spec.text }).toMatchObject({
        text: expect.not.stringContaining("TextDecoder"),
      });
    }
  });
});

describe("no source keeps a private copy of the skeleton", () => {
  for (const spec of SPECS) {
    it(`${spec.name} settles nothing itself`, () => {
      // A source that called `markIngested` again would be ordering the one
      // thing it no longer owns.
      expect({ file: spec.name, text: spec.text }).toMatchObject({
        text: expect.not.stringContaining("markIngested"),
      });
      expect({ file: spec.name, text: spec.text }).toMatchObject({
        text: expect.not.stringContaining("acquireBulkResource"),
      });
    });
  }
});

describe("what a source still owns", () => {
  /**
   * The body of a spec's `write`, and only that.
   *
   * Scoped rather than searched whole: an `import` of the same symbol sits at
   * the top of the file, so `indexOf` over the module finds the import and
   * two of these assertions pass or fail on import order rather than on the
   * ordering they are about. The detail source caught this by failing.
   */
  function writeBody(name: string): string {
    const text = SPECS.find((s) => s.name === name)?.text ?? "";
    const from = text.indexOf("write: async (db, parsed, version) => {");
    expect({ name, found: from >= 0 }).toEqual({ name, found: true });
    return text.slice(from, text.indexOf("counted:", from));
  }

  it("constrained-off writes its entities before its facts", () => {
    // Domain ordering, deliberately left at the source rather than hoisted
    // into a hook: the fact table has a foreign key to the reporting entities.
    const body = writeBody("constrained-off-job.ts");
    expect(body.indexOf("writeCurtailment")).toBeGreaterThan(
      body.indexOf("upsertReportingEntities"),
    );
    expect(body).toContain("upsertReportingEntities");
  });

  it("the detail source reconciles identity after its facts land", () => {
    const body = writeBody("constrained-off-detail-job.ts");
    expect(body.indexOf("upsertObservedPlants")).toBeLessThan(
      body.indexOf("writePlantDetail"),
    );
    expect(body.indexOf("reconcilePlantIdentity")).toBeGreaterThan(
      body.indexOf("writePlantDetail"),
    );
  });
});
