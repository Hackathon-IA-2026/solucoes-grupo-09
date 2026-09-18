import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The rename is only true for as long as nothing reintroduces the old name.
 * Every other test in this repo runs against code that already exists; this one
 * asserts a property of the repository itself, so a future session adding a
 * WattSteer feature cannot quietly bring Zalytix back with it.
 *
 * It exists because "the strip is complete" is otherwise an unverifiable claim.
 */

const ROOT = join(import.meta.dir, "..");

/**
 * Tokens that must not appear in project code, in any casing.
 *
 * The name alone is not enough. The strip renamed "Zalytix scraper" to
 * "WattSteer scraper" and this test was satisfied, leaving apps/api/README.md
 * documenting a review scraper for a curtailment engine. Guard the *domain*
 * too, since that is what actually misleads a reader.
 */
const FORBIDDEN = [
  "zalytix",
  "cloakbrowser",
  "app store",
  "google play",
  "scraper",
  "scraping",
];

/**
 * Paths where the old name is legitimate and must survive:
 * - `IDEA.md`         the historical source document
 * - `docs/research/`  primary-source findings, quoted verbatim
 * - `docs/specs/`     the spec for this very removal
 *
 * `.wayfinder/` and `.scratch/` were on this list and are gone from the
 * repository: the map and the implementation tickets carried the old name as
 * history, and deleting them took the exemption's subject with it.
 */
const EXEMPT = new Set([
  "IDEA.md",
  join("docs", "research"),
  join("docs", "specs"),
  // This file necessarily contains the token it forbids.
  join("test", "repo-hygiene.test.ts"),
]);

/** Never worth walking. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".expo",
  "test-results",
  "playwright-report",
]);

/** Generated, and regenerated from the manifests we do check. */
const SKIP_FILES = new Set(["bun.lock"]);

/** Extensions worth reading — everything else is binary or generated. */
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".yml",
  ".yaml",
  ".txt",
  ".xml",
  ".html",
  ".css",
  ".sh",
  ".webmanifest",
  ".example",
]);

const TEXT_NAMES = new Set(["Dockerfile", ".env.example", ".dockerignore", ".gitignore"]);

function isText(name: string): boolean {
  if (TEXT_NAMES.has(name)) {
    return true;
  }
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_EXT.has(name.slice(dot));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    // Exempt by path prefix, so `docs/research/anything.md` is covered too.
    if (EXEMPT.has(rel) || [...EXEMPT].some((e) => rel.startsWith(e + sep))) {
      continue;
    }
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        walk(full, out);
      }
    } else if (isText(entry) && !SKIP_FILES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("repo hygiene", () => {
  it("contains no reference to the template it was built from", () => {
    const pattern = new RegExp(FORBIDDEN.join("|"), "i");
    const offenders: string[] = [];

    for (const file of walk(ROOT)) {
      const text = readFileSync(file, "utf8");
      if (!pattern.test(text)) {
        continue;
      }
      // Report every offending line, not just the first file — a partial
      // rename should be visible in one run rather than one file at a time.
      text.split("\n").forEach((line, i) => {
        if (pattern.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("walked the repository, so the clean result above means something", () => {
    // `toEqual([])` over a walk is the shape that reads green when the walk
    // finds nothing. Measured: making the file filter reject everything left
    // this file's single assertion passing, and the strip would have been
    // reported complete at the moment it stopped reading any of the repo.
    //
    // Named trees rather than a bare count, because the exemption mechanism is
    // prefix-based and the failure to design for is one exemption swallowing a
    // parent: `EXEMPT` holds `docs/specs`, and an entry of `docs` — or of the
    // empty string — would silently retire the whole documentation tree while
    // still passing a count.
    const files = walk(ROOT).map((file) => relative(ROOT, file));
    expect(files.length).toBeGreaterThan(100);
    for (const file of ["README.md", join("apps", "api", "README.md")]) {
      expect(files).toContain(file);
    }
    for (const tree of [
      join("apps", "api", "src"),
      join("apps", "web", "src"),
      join("packages", "core", "src"),
      join("docs"),
    ]) {
      expect({
        tree,
        reached: files.some((file) => file.startsWith(tree + sep)),
      }).toEqual({ tree, reached: true });
    }
    // And the exemptions still exempt exactly what they name: `docs/specs` is
    // out, `docs` at large is in.
    expect(files.some((file) => file.startsWith(join("docs", "specs") + sep))).toBe(
      false,
    );
  });

  it("can fail: every forbidden token is caught, in any casing", () => {
    // The pattern itself had no control. It is assembled from `FORBIDDEN` with
    // `join("|")`, so a stray token — an empty string, an unescaped `.` — would
    // either match everything or nothing, and a `[]` result cannot tell the two
    // apart. Held as strings rather than as a planted file because this file is
    // the one path `EXEMPT` excuses, so a real fixture here would be skipped.
    const pattern = new RegExp(FORBIDDEN.join("|"), "i");
    for (const token of FORBIDDEN) {
      expect({ token, caught: pattern.test(`a line mentioning ${token} here`) }).toEqual({
        token,
        caught: true,
      });
      // Casing, which is the whole reason the `i` flag is there.
      expect(pattern.test(token.toUpperCase())).toBe(true);
    }
    // And it is not a pattern that matches anything at all. The domain this
    // repository *is* about must pass, or the guard would be unusable and the
    // honest response to it failing would be to delete it.
    for (const innocent of [
      "curtailment intelligence for the Brazilian grid",
      "the ONS publication window",
      "constrained-off energy by reporting entity",
    ]) {
      expect({ innocent, caught: pattern.test(innocent) }).toEqual({
        innocent,
        caught: false,
      });
    }
  });
});
