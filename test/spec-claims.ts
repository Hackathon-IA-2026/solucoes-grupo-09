/**
 * Deriving, from the tree, the facts the nine specs assert about it.
 *
 * This module is the machine-checkable half of api-surface 27. That ticket's
 * evidence was eleven claims in `docs/specs/*.md` that were **false when
 * found** — a count that had moved, a file that had been deleted, a route that
 * was described as unserved after it was served — and none of them broke a
 * test, because nothing read the specs.
 *
 * ### The one design rule
 *
 * **Nothing here restates a number, and nothing here holds a list somebody has
 * to keep in step.** Every quantity is *derived* — from the migrations, from
 * the route registrations, from the published enum, from the fixture directory
 * — and then bound to the spec's own words by a regex over the prose. That
 * direction matters twice over:
 *
 *  - a spec sentence that states the quantity is checked whether or not anyone
 *    remembered to add it here, because the regex finds sentences rather than
 *    line numbers; and
 *  - a spec sentence *added later* that states the same quantity is checked the
 *    day it is written.
 *
 * `apps/api/test/cache-policy.test.ts` established the pattern — it derives the
 * caching table's row count from the spec's own table rather than restating it
 * — and `packages/core/test/spec-examples.ts` established the other half, that
 * a manifest and the prose must each fail when the other moves. This is the
 * same idea widened to counts, file paths, routes and codes.
 *
 * ### Where the ceiling is, stated rather than implied
 *
 * A parse that silently matches nothing is the failure mode this repository has
 * hit four separate times, so every finder below returns its *inputs* beside
 * its violations, and `spec-claims.test.ts` asserts the inputs are non-empty
 * before it asserts anything is clean. A binder whose regex stops matching
 * fails loudly instead of passing vacuously.
 *
 * What this cannot check is in `spec-claims.test.ts`'s closing block: prose
 * about intent, judgement, or the future, and counts whose value exists only
 * inside a live Postgres.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const SPEC_DIR = join(ROOT, "docs", "specs");

/** Every spec file name, sorted. Discovered, never listed. */
export function specFiles(): string[] {
  return readdirSync(SPEC_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();
}

/** One spec's text, keyed by file name. */
export function specTexts(): Map<string, string> {
  return new Map(
    specFiles().map((file) => [file, readFileSync(join(SPEC_DIR, file), "utf8")]),
  );
}

// --- the tree's own facts ----------------------------------------------------

/** Directories never worth walking. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".expo",
  ".venv",
  "__pycache__",
  "test-results",
  "playwright-report",
]);

/**
 * Every file in the working tree, as a repo-relative POSIX path.
 *
 * The working tree and not `git ls-files`, deliberately: `.github/` and
 * `.wayfinder/` are referenced by the specs and are not always in the index a
 * worktree sees, and a guard that called a file that is plainly there "missing"
 * would be the kind of guard somebody deletes.
 */
export function treeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(
            join(dir, entry.name),
            prefix === "" ? entry.name : `${prefix}/${entry.name}`,
          );
        }
        continue;
      }
      found.push(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
    }
  };
  walk(ROOT, "");
  return found.sort();
}

const MIGRATION_DIR = join(ROOT, "apps", "api", "drizzle");

/** Every migration's SQL, in order. The authority for anything schema-shaped. */
export function migrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATION_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATION_DIR, file), "utf8") }));
}

/**
 * The attributes of the `feature_row` composite type, in declaration order.
 *
 * Replayed from the migrations rather than read from a live database, so the
 * count is available to an ungated test: `CREATE TYPE … AS (…)` seeds it and
 * each `ALTER TYPE … ADD ATTRIBUTE` / `DROP ATTRIBUTE` moves it. This is the
 * "112 attributes" the specs quote, and it is the number that was wrong in five
 * places at once when `0036` added the 112th.
 */
export function featureRowAttributes(): string[] {
  const attrs: string[] = [];
  for (const { sql } of migrations()) {
    const created = /CREATE TYPE feature_row AS \(([\s\S]*?)\n\);/.exec(sql);
    if (created !== null) {
      for (const line of (created[1] ?? "").split("\n")) {
        const field = line.trim().replace(/,$/, "");
        if (field === "" || field.startsWith("--")) {
          continue;
        }
        attrs.push(field.split(/\s+/)[0] as string);
      }
    }
    for (const added of sql.matchAll(/ALTER TYPE feature_row ADD ATTRIBUTE (\w+)/g)) {
      attrs.push(added[1] as string);
    }
    for (const dropped of sql.matchAll(/ALTER TYPE feature_row DROP ATTRIBUTE (\w+)/g)) {
      const at = attrs.indexOf(dropped[1] as string);
      if (at !== -1) {
        attrs.splice(at, 1);
      }
    }
  }
  return attrs;
}

export interface DictionaryEntry {
  column: string;
  role: string;
  inFree: boolean;
  inAugmented: boolean;
  availableAtGateEarly: boolean;
  isProxy: boolean;
  justifiesDessemTrade: boolean;
  modelInput: boolean;
}

/**
 * `feature_dictionary_entry`'s seeded rows, from the migrations that insert
 * them.
 *
 * The six booleans on each row are the source of five separate numbers
 * `feature-engineering.md` quotes in prose — the model-input counts per set,
 * the proxy count, the gate-early absences, and the four names that justify the
 * DESSEM trade — and quoting a boolean census in prose is exactly the thing
 * that rots. Parsed positionally against the `VALUES` tuple the migrations
 * write, which is stable because a landed migration is never edited.
 */
export function featureDictionary(): DictionaryEntry[] {
  const bool = "(true|false)";
  const row = new RegExp(
    String.raw`^  \('(\w+)', '(\w+)', (?:array\[[^\]]*\]::text\[\]|'\{\}'::text\[\]), '(?:[^']|'')*', (?:null|'\w+'), ` +
      `${bool}, ${bool}, ${bool}, ${bool}, ${bool}, ${bool}\\)`,
    "gm",
  );
  const byColumn = new Map<string, DictionaryEntry>();
  for (const { sql } of migrations()) {
    for (const match of sql.matchAll(row)) {
      byColumn.set(match[1] as string, {
        column: match[1] as string,
        role: match[2] as string,
        inFree: match[3] === "true",
        inAugmented: match[4] === "true",
        availableAtGateEarly: match[5] === "true",
        isProxy: match[6] === "true",
        justifiesDessemTrade: match[7] === "true",
        modelInput: match[8] === "true",
      });
    }
  }
  return [...byColumn.values()];
}

/**
 * `gate_at`'s two local hours, from the migration that defines the function.
 *
 * The whole of the operator-notice arithmetic rests on these two numbers, and
 * five sentences in `feature-engineering.md` were quoting an eleven-hour
 * interval between a 9 and a 19.
 */
export function gateLocalHours(): { gateEarly: number; gateLate: number } {
  for (const { sql } of migrations()) {
    const early = /WHEN 'gate_early' THEN (\d+)/.exec(sql);
    const late = /WHEN 'gate_late' THEN (\d+)/.exec(sql);
    if (early !== null && late !== null) {
      return { gateEarly: Number(early[1]), gateLate: Number(late[1]) };
    }
  }
  return { gateEarly: Number.NaN, gateLate: Number.NaN };
}

/** The published error enum: code to canonical status, from `errors.ts`. */
export function errorStatuses(): Map<string, number> {
  const source = readFileSync(join(ROOT, "packages", "core", "src", "errors.ts"), "utf8");
  const table = /export const ERROR_STATUS = \{([\s\S]*?)\n\} as const/.exec(source);
  const body = table?.[1] ?? "";
  return new Map(
    [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]+): (\d+),/gm)].map((m) => [
      m[1] as string,
      Number(m[2]),
    ]),
  );
}

export interface ServedRoute {
  method: string;
  path: string;
  module: string;
}

const API_DIR = join(ROOT, "apps", "api", "src", "api");

/**
 * Every HTTP route the gateway registers, discovered from the sources.
 *
 * Recursive over `src/api`, because a route mounted from a subdirectory is
 * still served. Three literal forms appear and all three are read: a plain
 * string, a template literal built on `CANONICAL_BASE_PATH`, and
 * `canonicalReadPath("<read>")`. A `.get(` whose first argument is neither —
 * `headers.get("x-request-id")` — is skipped by requiring the argument to look
 * like a path or a canonical-read name.
 */
export function servedRoutes(): ServedRoute[] {
  const found: ServedRoute[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const module = `${prefix}${entry.name}`;
      const source = readFileSync(join(dir, entry.name), "utf8");
      const call =
        /\.(get|post|put|patch|delete)\(\s*(?:"(\/[^"]*)"|`\$\{CANONICAL_BASE_PATH\}(\/[^`]*)`|CANONICAL_BASE_PATH|canonicalReadPath\("([a-z-]+)"\))/g;
      for (const match of source.matchAll(call)) {
        const path =
          match[2] ??
          (match[3] === undefined ? undefined : `/v1/canonical${match[3]}`) ??
          (match[4] === undefined ? undefined : `/v1/canonical/${match[4]}`) ??
          "/v1/canonical";
        found.push({ method: (match[1] as string).toUpperCase(), path, module });
      }
    }
  };
  walk(API_DIR, "");
  return found;
}

/**
 * The distinct refusal codes the cross-language validation fixtures exercise.
 *
 * `packages/core/fixtures/scenario-validation/refusals/` is read by both the
 * TypeScript and the Python suite, so its distinct code set *is* the validation
 * table as implemented. It comes to eighteen, which is what
 * `flex-optimizer.md`'s nineteen-row table means by "the eighteen-rule table":
 * the nineteenth row, `FORECAST_UNAVAILABLE`, is a database question and is
 * thrown elsewhere.
 */
export function scenarioRefusalCodes(): string[] {
  const dir = join(
    ROOT,
    "packages",
    "core",
    "fixtures",
    "scenario-validation",
    "refusals",
  );
  const codes = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(
      /"([A-Z][A-Z0-9_]{5,})"/g,
    )) {
      codes.add(match[1] as string);
    }
  }
  return [...codes].sort();
}

/**
 * The published response schemas that carry a `next_cursor`.
 *
 * One schema per paged surface, which is what makes this the count of paged
 * **routes**: a cursor is part of a response shape, and a route that pages
 * without saying so in its schema could not tell a client how to continue.
 * `api-surface.md` said "exactly two routes" in two places, having assumed
 * `episodes` paged because it takes the same range as `hours`.
 */
export function pagedResponseSchemas(): string[] {
  const dir = join(ROOT, "packages", "core", "schema");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .filter((file) => readFileSync(join(dir, file), "utf8").includes('"next_cursor"'))
    .sort();
}

/** The `DriverCode` union's members — the grouped-Shapley players. */
export function driverCodes(): string[] {
  const source = readFileSync(
    join(ROOT, "packages", "core", "src", "types.generated.ts"),
    "utf8",
  );
  const union = /export type DriverCode =([\s\S]*?);\n/.exec(source);
  return [...(union?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

// --- reading the specs' claims -----------------------------------------------

/** Number words the specs actually use, so a word and a digit compare equal. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  "twenty-one": 21,
  "twenty-two": 22,
  "thirty-four": 34,
  "thirty-five": 35,
};

/** A spec's numeral, as a number, or `null` if it is not one. */
export function numberOf(token: string): number | null {
  const word = token.trim().toLowerCase().replace(/\*/g, "");
  if (/^\d[\d,  ]*$/.test(word)) {
    return Number(word.replace(/[,  ]/g, ""));
  }
  return NUMBER_WORDS[word] ?? null;
}

export interface Claim {
  /** Spec file name. */
  spec: string;
  /** 1-based line of the paragraph the claim is in, for grepping. */
  line: number;
  /** What the spec wrote. */
  quoted: string;
  /** The number the spec stated, or `null` when the token was not a numeral. */
  stated: number | null;
  /**
   * Whether the **sentence** announces itself as a record of what the spec used
   * to say.
   *
   * The specs correct themselves by quoting the wrong number back —
   * `forecaster.md`'s "This document said *eleven* hours of operator notice in
   * five places" is the existing pattern, and it is the pattern this ticket is
   * told to match. A binder that read those as live claims would fail on every
   * correction ever written, so a number in a sentence carrying a retrospective
   * marker is a quotation and is not compared.
   *
   * **The scope is one sentence, not one paragraph, and that is deliberate.**
   * Paragraph scope was tried first and was far too generous: this repository's
   * correction notes are long, and three live counts — the attribute total, the
   * proxy census, the model-input pair — sit inside notes whose *other*
   * sentences correct something else. A paragraph-scoped exemption silently
   * stopped governing all three, which is precisely the vacuity this ticket is
   * about.
   *
   * Like {@link ABSENCE_MARKERS} this is a closed vocabulary of English and not
   * a list of exemptions: it needs no edit when a spec changes, and it cannot
   * be used to hide a live claim without saying, in that sentence, that the
   * number is one the document no longer stands behind.
   */
  quotation: boolean;
}

/** Phrases with which a sentence declares its number a quotation, not a claim. */
const CORRECTION_MARKERS = [
  "corrected",
  "this document said",
  "this section said",
  "this table first read",
  "was saying",
  "an earlier draft",
  "previously said",
  "used to say",
  "used to read",
  "first read",
  "withdrawn",
];

/**
 * Where one sentence ends.
 *
 * Sentence-terminating punctuation, **plus any closing Markdown emphasis or
 * quotation that trails it**. The trailing group is not decoration: this
 * repository's documents lead a paragraph with a bolded sentence — `**Two
 * boxes, and neither is a judgement call.** (This heading has outlived …` — and
 * without it the full stop is hidden behind `**`, the two sentences never
 * separate, and a retrospective marker in the *second* one silently excuses a
 * live claim in the first. That is api-surface 27's paragraph-scope bug in
 * miniature, and api-surface 29 hit it on `api-surface/issues/10`.
 */
const SENTENCE_END = /(?<=[.;:!?][*_)\u201d"']{0,3})\s+/;

/** One sentence of a document, blockquote markers stripped and lines joined. */
export interface Sentence {
  /** 1-based line of the paragraph it came from, for grepping. */
  line: number;
  prose: string;
  quotation: boolean;
}

/**
 * A spec as sentences, with Markdown blockquote markers removed and every run
 * of whitespace collapsed.
 *
 * Both transformations are needed rather than cosmetic: most of these claims
 * wrap across two source lines, and the ones with the most history behind them
 * live inside `> ` notes.
 */
export function sentencesOf(text: string, extraMarkers: string[] = []): Sentence[] {
  const markers = [...CORRECTION_MARKERS, ...extraMarkers];
  const found: Sentence[] = [];
  let line = 1;
  for (const block of text.split(/\n[ \t]*\n/)) {
    const flat = block
      .split("\n")
      .map((one) => one.replace(/^\s*>\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    for (const sentence of flat.split(SENTENCE_END)) {
      const lower = sentence.toLowerCase();
      found.push({
        line,
        prose: sentence,
        quotation: markers.some((marker) => lower.includes(marker)),
      });
    }
    line += block.split("\n").length + 1;
  }
  return found;
}

/**
 * Every occurrence, across every spec, of a sentence shaped like `pattern`.
 *
 * `pattern` must have a global flag and one capturing group holding the number.
 * Matching runs over sentences with blockquote markers stripped and newlines
 * collapsed, so a claim that wraps across two lines — most of them do — is
 * still one match.
 *
 * The returned list is the *input* to a comparison, and it is returned rather
 * than compared here so that the test can assert it is non-empty first: a
 * binder whose regex stops matching must fail, not go quiet. This repository
 * has shipped four guards that governed nothing because nobody asserted the
 * thing they walked was not empty.
 */
export function claimsMatching(
  pattern: RegExp,
  texts: Map<string, string> = specTexts(),
): Claim[] {
  const claims: Claim[] = [];
  for (const [spec, text] of texts) {
    for (const sentence of sentencesOf(text)) {
      for (const match of sentence.prose.matchAll(
        new RegExp(
          pattern.source,
          pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
        ),
      )) {
        claims.push({
          spec,
          line: sentence.line,
          quoted: match[0],
          stated: numberOf(match[1] ?? ""),
          quotation: sentence.quotation,
        });
      }
    }
  }
  return claims;
}

/**
 * One spec as a single line, blockquote markers stripped.
 *
 * For the two claims that state several numbers in one sentence and are
 * therefore easier to read with their own multi-group regex than through
 * {@link claimsMatching}.
 */
export function flatSpec(spec: string, texts: Map<string, string> = specTexts()): string {
  return (texts.get(spec) ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** The claims a spec is asserting now, as opposed to quoting from its own past. */
export function live(claims: Claim[]): Claim[] {
  return claims.filter((claim) => !claim.quotation);
}

/** The claims in `claims` whose number is not `expected`. */
export function drifted(claims: Claim[], expected: number): Claim[] {
  return claims.filter((claim) => claim.stated !== expected);
}

// --- file references ---------------------------------------------------------

const REFERENCE = /`([A-Za-z0-9_./@-]+\.(?:ts|tsx|py|sql|json|md|yaml|yml|toml))`/g;

/**
 * Words that mark a paragraph as talking about something that is *gone*.
 *
 * The specs cite deleted files on purpose — a decision record that cannot name
 * what it deleted is not a record — so a path reference is exempt when the
 * paragraph around it says so. This is a closed vocabulary of **English**, not
 * a list of files: it needs no maintenance when a spec changes, and a stale
 * reference dropped into ordinary present-tense prose is still caught. The
 * cost is stated plainly: a paragraph that legitimately uses one of these words
 * **and** carries a rotted path gets a free pass, which is why this is the weaker
 * of the two halves and why the census below is asserted separately.
 */
const ABSENCE_MARKERS = [
  "deleted",
  "deletion",
  "removed",
  "retired",
  "replaced",
  "renamed",
  "no longer",
  "before commit",
  "does not exist",
  "did not exist",
  "never existed",
  "had not landed",
  "when this was written",
  "when this section was written",
];

export interface Reference {
  spec: string;
  line: number;
  ref: string;
  /** Whether some file in the working tree answers to it. */
  resolves: boolean;
  /** Whether the surrounding paragraph marks it as gone. */
  marked: boolean;
}

/**
 * Every **path-form** file reference in the specs, with whether it resolves.
 *
 * Path-form means it contains a `/`: the spec asserted a *location*, and a
 * location is a checkable claim. A bare `grid.ts` is not in scope and the
 * reason is that it cannot be checked without guessing — this tree holds three
 * files called `grid.ts` and two called `replay.ts`, so "a file of that name
 * exists somewhere" is true of almost any name and proves nothing about the
 * one the spec meant. References containing `...` are elisions, not paths.
 */
export function pathReferences(
  texts: Map<string, string> = specTexts(),
  files: string[] = treeFiles(),
): Reference[] {
  const set = new Set(files);
  const resolvesIn = (ref: string): boolean =>
    set.has(ref) || files.some((file) => file.endsWith(`/${ref}`));
  const found: Reference[] = [];
  for (const [spec, text] of texts) {
    const paragraphs = text.split(/\n\s*\n/);
    let offset = 0;
    for (const paragraph of paragraphs) {
      const lower = paragraph.toLowerCase();
      const marked = ABSENCE_MARKERS.some((marker) => lower.includes(marker));
      for (const match of paragraph.matchAll(REFERENCE)) {
        const ref = match[1] as string;
        if (!ref.includes("/") || ref.includes("...")) {
          continue;
        }
        // `../research/x.md` and friends are relative to `docs/specs`.
        const normalised =
          ref.startsWith("./") || ref.startsWith("../")
            ? `docs/specs/${ref}`
                .split("/")
                .reduce<string[]>((parts, part) => {
                  if (part === "..") {
                    parts.pop();
                  } else if (part !== ".") {
                    parts.push(part);
                  }
                  return parts;
                }, [])
                .join("/")
            : ref;
        found.push({
          spec,
          line: text.slice(0, offset + (match.index ?? 0)).split("\n").length,
          ref,
          resolves: resolvesIn(normalised),
          marked,
        });
      }
      offset += paragraph.length + 2;
    }
  }
  return found;
}
