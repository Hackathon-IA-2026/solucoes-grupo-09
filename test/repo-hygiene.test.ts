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
 * - `reference/`      the Next.js app the design system was ported from
 * - `IDEA.md`         the historical source document
 * - `.wayfinder/`     the map, which records Zalytix as the thing removed
 * - `.scratch/`       implementation tickets that reference the same history
 * - `docs/research/`  primary-source findings, quoted verbatim
 * - `docs/specs/`     the spec for this very removal
 */
const EXEMPT = new Set([
  "reference",
  "IDEA.md",
  ".wayfinder",
  ".scratch",
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
});
