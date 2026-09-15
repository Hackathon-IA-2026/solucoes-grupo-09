import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A third of the gateway's suite does not run, and the default output does not
 * say so.
 *
 * `bun run test:api` prints `1342 pass · 596 skip · 0 fail` and a reader
 * reasonably concludes the suite passed. What it actually did was skip **30
 * files** — every repository, every contract read, the whole ingestion path —
 * because they need a Postgres and `WATTSTEER_TEST_DATABASE_URL` was unset.
 *
 * **How much that hides, measured on 2026-09-15.** With a database supplied,
 * the same command runs 1,845 tests with 1,795 passing and 0 failing, and
 * coverage goes from *nothing* on `src/ingest/**` and `src/contract/**` — every
 * one of those files reported `0.00 %` — to **93.11 % of functions and 91.41 %
 * of lines overall**. The repositories are not untested. They are untested *by
 * default*, and those are very different facts to hold about a production
 * system.
 *
 * So this file does not try to run them. It makes the arrangement **legible and
 * derived**: one gate, named once, wired to a script that supplies it, so the
 * set cannot quietly grow a second spelling and a file cannot opt out of the
 * only command that runs it.
 */

const ROOT = join(import.meta.dir, "..");
const API_TESTS = join(ROOT, "apps/api/test");

/** The one environment variable that decides whether the database suite runs. */
const GATE = "WATTSTEER_TEST_DATABASE_URL";

function testFiles(): string[] {
  return readdirSync(API_TESTS).filter((name) => name.endsWith(".test.ts"));
}

function sourceOf(name: string): string {
  return readFileSync(join(API_TESTS, name), "utf8");
}

/**
 * Files that gate themselves on a database.
 *
 * Matched on `process.env.<GATE>` rather than on the name appearing anywhere,
 * because `live-conformance.test.ts` *mentions* the variable in a comment while
 * gating on something else — and a detector that counted that file would report
 * it as mis-spelling a gate it does not use.
 */
function gatedFiles(): string[] {
  return testFiles().filter((name) => sourceOf(name).includes(`process.env.${GATE}`));
}

describe("the database suite is gated in one way, and that way is wired up", () => {
  it("has files that gate on a database at all", () => {
    // Non-vacuity for everything below: if the gate were renamed and this list
    // went empty, every other assertion here would pass against nothing.
    expect(gatedFiles().length).toBeGreaterThan(20);
  });

  it("gates every one of them on the same variable, spelled the same way", () => {
    // A second spelling is a file that runs in neither mode: absent from the
    // default run because it is gated, and absent from `test:db` because the
    // script does not set the name it is gated on. It would look like a passing
    // suite from both directions.
    // Every file that names the gate at all must name it as *the* gate. A file
    // that mentions it in prose and reads a different variable is the case this
    // catches: it would run in neither mode and look like a passing suite from
    // both directions.
    // Every file that names the gate must either read it, or only mention it in
    // prose. The case this catches is a file that *reads a different variable*
    // while naming this one: it would run in neither mode — skipped by default
    // because it is gated, and skipped under `test:db` because the script does
    // not set the name it actually reads — and look like a passing suite from
    // both directions.
    const wrong = testFiles().filter((name) => {
      const source = sourceOf(name);
      if (!source.includes(GATE)) {
        return false;
      }
      if (source.includes(`process.env.${GATE}`)) {
        return false;
      }
      // Named but not read: fine only if every mention is inside a comment.
      return source
        .split("\n")
        .some((line) => line.includes(GATE) && !/^\s*(\*|\/\/)/.test(line));
    });
    expect(wrong).toEqual([]);
  });

  it("is run by a script that supplies the gate", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "apps/api/package.json"), "utf8"))
      .scripts as Record<string, string>;
    expect(scripts["test:db"]).toBeDefined();
    expect(scripts["test:db"]).toContain(GATE);
    // And it migrates first, because a suite pointed at an empty database fails
    // in a way that reads like the code is broken.
    expect(scripts["test:db"]).toContain("db:migrate");
  });

  it("tells a reader how to run it, in the files that need it", () => {
    // The instruction lives beside the gate rather than only in a README,
    // because the moment anybody needs it is the moment they are looking at a
    // skipped file wondering why.
    const silent = gatedFiles().filter((name) => {
      const source = sourceOf(name);
      return !/docker run|test:db/.test(source);
    });
    expect(silent).toEqual([]);
  });
});
