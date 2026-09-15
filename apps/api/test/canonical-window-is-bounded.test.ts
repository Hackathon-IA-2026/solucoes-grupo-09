import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { canonicalReads } from "../src/api/canonical.js";
import { MAX_OBSERVED_RANGE_DAYS } from "../src/api/params.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { canonicalReadPath } from "../src/contract/manifest.js";

/**
 * Ten requests inside the published read budget could wedge the database.
 *
 * The canonical reads take `from`/`to` with no maximum span, have no `LIMIT`,
 * materialise every row into a JS array before encoding, and `training-window`
 * runs seven of them serially inside one transaction. The pool is ten
 * connections wide and `no-store` means nothing absorbs a repeat. So ten
 * concurrent `from=1970-01-01&to=2100-01-01` — one client, well under 120/min —
 * hold every connection, leave `/ready`'s own `select 1` with nowhere to run
 * until the instance is pulled from rotation, and keep running after the caller
 * has gone.
 *
 * `MAX_OBSERVED_RANGE_DAYS` already existed and was bound to `/v1/curtailment/*`
 * only, which is what made this an inconsistency rather than a policy anyone had
 * argued for.
 */

const routes = new Elysia().use(errorHandler).use(canonicalReads);

const get = (path: string): Promise<Response> =>
  routes.handle(new Request(`http://localhost${path}`));

// One real read, named through the same helper the routes are mounted with, so
// a renamed read fails here rather than silently testing a 404.
const window = (from: string, to: string): string =>
  `${canonicalReadPath("curtailment-by-reporting-entity")}` +
  `?as_of=2026-09-01T00:00:00Z&from=${from}&to=${to}`;

describe("a canonical window may not be unbounded", () => {
  it("refuses a window wider than the cap, with the cap on the refusal", async () => {
    const response = await get(window("1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z"));
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; details?: { max_days?: number } };
    };
    expect(body.error.code).toBe("DATE_RANGE_TOO_LARGE");
    // The cap travels on the refusal so a caller can retry correctly rather
    // than bisecting to discover it.
    expect(body.error.details?.max_days).toBe(MAX_OBSERVED_RANGE_DAYS);
  });

  it("refuses rather than clamping", async () => {
    // A clamped range returns real numbers for a window the caller did not ask
    // for, and nothing on the payload says so — `observedRange` gives this
    // reason for the sibling routes and it is the same reason here.
    const response = await get(window("1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z"));
    expect(response.status).not.toBe(200);
  });

  it("allows a window at the cap, so the bound is not off by a day", async () => {
    // Non-vacuity in the other direction: a cap that refused everything would
    // pass both assertions above and would have broken every legitimate read.
    // At exactly the cap the window is fine — it fails later for want of a
    // database, which is a different refusal and the one that proves we got
    // past this check.
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date(from.getTime() + MAX_OBSERVED_RANGE_DAYS * 86_400_000);
    const response = await get(window(from.toISOString(), to.toISOString()));
    const body = (await response.json()) as { error?: { code: string } };
    expect(body.error?.code).not.toBe("DATE_RANGE_TOO_LARGE");
  });

  it("reads the cap from the observed surface rather than restating it", () => {
    // A second copy of the number is how the two surfaces come to disagree, and
    // the comment on `MAX_OBSERVED_RANGE_DAYS` says so explicitly.
    const source = readFileSync(join(import.meta.dir, "../src/api/canonical.ts"), "utf8");
    expect(source).toContain("MAX_OBSERVED_RANGE_DAYS");
    expect(source).not.toMatch(/const\s+MAX_\w*RANGE\w*\s*=\s*\d/);
  });
});

describe("a connection cannot be held indefinitely", () => {
  it("bounds a statement and an idle transaction on the connection itself", () => {
    // On the connection rather than per query, so a read added next month is
    // bounded by construction rather than by its author remembering. Asserted
    // over the source because the values are handed to the driver at connect
    // time and there is no handle to read them back from.
    const source = readFileSync(
      join(import.meta.dir, "../src/database/connection.ts"),
      "utf8",
    );
    expect(source).toContain("statement_timeout");
    // The narrower hazard and the more insidious one: a transaction that opens
    // and then waits holds its connection *and* its locks indefinitely, and
    // `statement_timeout` never fires because no statement is running.
    expect(source).toContain("idle_in_transaction_session_timeout");
    // Both inside the driver's `connection` block — a name in a comment is not
    // a setting.
    expect(source).toMatch(/connection:\s*\{[\s\S]*statement_timeout/);
  });
});
