import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { candidatesFor, SPA_FALLBACK, statusFor } from "../scripts/static-routing";

/**
 * What the deployment serves for a path, and with what status.
 *
 * Two servers read this rule: `server.ts` on the deployment and
 * `e2e/serve-dist.ts` under Playwright and Lighthouse. The second used to be a
 * hand-written mirror of the first — "Mirrors server.ts", its comment said —
 * and the arrangement did exactly what that arrangement does: a soft-404 fix
 * landed in one of them and the two disagreed about a status code inside a
 * single edit. So the rule is one module, and this is its table.
 */

describe("which file answers a path", () => {
  it("the root resolves to the shell, and is not a fallback", () => {
    expect(candidatesFor("")).toEqual([SPA_FALLBACK]);
    expect(statusFor("", SPA_FALLBACK)).toBe(200);
  });

  it("a deep route is tried as a file before the fallback", () => {
    // `/app/explain` is written by the export as `dist/app/explain.html`.
    const candidates = candidatesFor("app/explain");
    expect(candidates[0]).toBe("app/explain");
    expect(candidates[1]).toBe("app/explain.html");
    expect(candidates.indexOf("app/explain.html")).toBeLessThan(
      candidates.indexOf(SPA_FALLBACK),
    );
  });

  it("a locale root finds its directory index", () => {
    // The export writes `/pt/` as `dist/pt/index.html`.
    expect(candidatesFor("pt")).toContain("pt/index.html");
  });

  it("the fallback is last, always", () => {
    for (const path of ["pt", "app/explain", "nope", "a/b/c"]) {
      expect(candidatesFor(path).at(-1)).toBe(SPA_FALLBACK);
    }
  });
});

describe("the status is a fact about the file that matched", () => {
  it("a real file is 200, whatever the path looked like", () => {
    expect(statusFor("pt", "pt/index.html")).toBe(200);
    expect(statusFor("app/explain", "app/explain.html")).toBe(200);
  });

  it("an unknown path that reached the fallback is 404, not 200", () => {
    /*
      The regression. Every unknown path used to answer 200 with `/`'s HTML,
      which is a soft 404: it spends crawl budget on URLs that do not exist and
      can get them indexed. Measured on production before the fix — `GET /nope`
      answered 200.
    */
    expect(statusFor("nope", SPA_FALLBACK)).toBe(404);
    expect(statusFor("pt/nope", SPA_FALLBACK)).toBe(404);
  });

  it("the site root is not mistaken for a miss", () => {
    // Non-vacuity for the `path !== ""` half: the root resolves to the same
    // file as the fallback, so a rule keyed on the filename alone would answer
    // 404 for the homepage.
    expect(statusFor("", SPA_FALLBACK)).toBe(200);
  });
});

describe("both servers read the rule rather than restating it", () => {
  /** Comments stripped: they quote the candidate spellings these rules ban. */
  const read = (...parts: string[]) =>
    readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  for (const file of [["server.ts"], ["e2e", "serve-dist.ts"]]) {
    it(`${file.join("/")} imports it`, () => {
      const source = read(...file);
      expect(source).toContain("candidatesFor(path)");
      expect(source).toContain("statusFor(path, candidate)");
      // And carries no copy of the candidate list: with comments stripped,
      // neither server should name a filename at all — that is this module's
      // job now, and naming one again is how the mirror grew back last time.
      expect(source).not.toContain("index.html");
    });
  }
});
