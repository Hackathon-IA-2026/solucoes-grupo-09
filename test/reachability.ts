/**
 * Does the thing a ticket says it built actually get **called**?
 *
 * This is api-surface 30. api-surface 27 established that a spec cannot be
 * trusted to describe itself and 29 that a ticket cannot be trusted to count
 * itself; this is the third question, and the one with teeth:
 * `.scratch/data-platform/issues/03-constrained-off-per-plant.md` carried
 * `**Status:** done` while `createConstrainedOffDetailIngestor` appeared in
 * **no** `IngestTask` kind, **no** branch of `createIngestDispatcher` and
 * **no** line of `planRefresh`. Its parser and repository were merged and
 * covered by forty tests. `plant_detail_hour` was unfillable. The whole defect
 * was visible in one grep: the constructor appeared only in its own module and
 * in the ingest barrel.
 *
 * ### What is derivable, and what is not
 *
 * "Everything exported must be called" is not a rule this repository can hold.
 * A comment-stripped sweep finds ~107 exported values with no non-test caller,
 * and most are legitimate: a design-system primitive the app has not used yet,
 * a repository read the canonical layer reaches through SQL instead, a helper
 * a test pins on purpose. A guard that failed on all of them would be deleted
 * within a week, which is api-surface 25's fourth lesson in advance.
 *
 * So this guard governs the **shapes the repository itself declares to be
 * wired**, each discovered rather than listed:
 *
 *  1. **Every `create*Ingestor` and `create*Routes`.** The naming convention is
 *     the repo's own statement that a thing is a unit the system runs. A module
 *     adding `createFooIngestor` tomorrow is governed the day it is written,
 *     and ticket 03's defect is red on the first run.
 *  2. **Every `IngestTask` kind** reaches a dispatcher branch — counting the
 *     exhaustive `default:` branch, because `plant_registry` is handled there
 *     and a `case`-only check would accuse it falsely — and is planned by
 *     `planRefresh`.
 *  3. **Every `ingestion_source` enum member** is produced by `sourceOf`. This
 *     is data-platform 15's failure mode: `siga` and `weather` were added to
 *     the enum and to no plan, and were therefore unschedulable, undispatchable
 *     and invisible to `/ingest/health`.
 *  4. **Every route object** in `apps/api/src/api/*.ts` is mounted in
 *     `api/index.ts`. A route defined and mounted nowhere answers nothing.
 *  5. **Every `config` key** is read outside `config.ts`. A flag nothing reads
 *     is a setting that does not exist.
 *
 * Nothing here is an allow-list, and no check needs an edit when a module is
 * added — that is api-surface 27's rule and the reason a sixth check is not
 * bolted on with a hand-maintained exception set.
 *
 * ### What this guard cannot see, stated rather than implied
 *
 *  - **SQL.** The feature gate is a Postgres function in `apps/api/drizzle/`.
 *    Reachability of a view or a function is not derivable from TypeScript, and
 *    this file does not pretend to it.
 *  - **Python.** `apps/ml` dispatches through FastAPI decorators and a CLI;
 *    another agent owns that tree in this wave.
 *  - **Writes through a generic helper.** Tables are written by
 *    `writeVersioned(db, SPEC, rows, vintage)`, so "no textual `.insert(table)`"
 *    proves nothing and no table-write check is attempted.
 *
 * ### The stripper
 *
 * api-surface 25's third defect was a scanner that removed block comments
 * before line comments and so ate a hundred lines of `api/grid.ts` from its own
 * input, because line 280 is a `//` comment containing `/*`. {@link stripCode}
 * is positional — it walks once and takes whichever of `//`, block-open or a
 * quote it meets first — which is why that line costs it nothing.
 * `reachability.test.ts` asserts the property on that exact file rather than
 * asserting it in a comment.
 *
 * String literals are deliberately **kept**. Dynamic dispatch in this
 * repository goes through string keys, and a reference that exists only as a
 * string is still a reference; blanking them would manufacture orphans.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./spec-claims";

/** Where the guard walks. Directories, not files: a new module is included. */
const WALK = ["apps/api", "apps/web", "packages", "scripts"];

/**
 * Comments out, code in — in one left-to-right pass.
 *
 * The order of the branches inside the loop is irrelevant to correctness
 * because the loop is positional: whatever opens first at index `i` wins, so a
 * `/*` inside a `//` comment is never an opener and a `//` inside a string is
 * never a comment. Length is preserved so offsets and line numbers survive.
 */
export function stripCode(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < n && text.slice(i, i + 2) !== "*/") {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    const q = text[i];
    if (q === '"' || q === "'" || q === "`") {
      // Kept, not blanked: see the header. Only the scan has to know where the
      // literal ends, so that a `//` inside it is not read as a comment.
      out += q;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i];
        i += 1;
        if (text[i - 1] === q) {
          break;
        }
      }
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** One TypeScript file, raw and with its comments removed. */
export interface Source {
  /** Repo-relative POSIX path. */
  file: string;
  text: string;
  /** {@link stripCode} of `text`. Every reference count uses this. */
  code: string;
}

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(relative(ROOT, path));
    }
  }
  return out;
}

/** A file the test suites own rather than the product. */
export function isTestFile(file: string): boolean {
  return (
    /\.test\.tsx?$/.test(file) ||
    /(^|\/)test\//.test(file) ||
    /(^|\/)e2e\//.test(file) ||
    /(^|\/)__tests__\//.test(file)
  );
}

/**
 * Every TypeScript file under the walked roots, discovered by extension.
 *
 * No manifest and no list of modules: the corpus is the directory tree, which
 * is what keeps a module added next month inside the guard.
 */
export function allSources(): Source[] {
  const files: string[] = [];
  for (const root of WALK) {
    walk(join(ROOT, root), files);
  }
  return files.map((file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    return { file, text, code: stripCode(text) };
  });
}

/** Read one repo file, stripped, by repo-relative path. */
export function sourceAt(file: string): Source {
  const text = readFileSync(join(ROOT, file), "utf8");
  return { file, text, code: stripCode(text) };
}

/* ------------------------------------------------------------------ units */

/**
 * A factory the repository's own naming convention declares to be wired in.
 *
 * `create<Something>Ingestor` and `create<Something>Routes` are the two shapes
 * this system uses for "a unit the running process constructs". Both are
 * conventions the code already holds to without exception, which is what makes
 * them usable as a rule rather than as a list.
 */
export const WIRED_UNIT =
  /^export\s+(?:async\s+)?function\s+(create\w*(?:Ingestor|Routes))\b/gm;

export interface Unit {
  name: string;
  /** Where it is declared. */
  file: string;
  /**
   * Who reaches it: its own module when that module uses it beyond the
   * declaration, plus every non-test file that names it other than to re-export
   * it. Pure barrels are excluded — that is the whole of ticket 03's evidence.
   */
  callers: string[];
  /** Test files that name it. Recorded, never a verdict. */
  tests: string[];
}

/** Does `source` mention `name` only to re-export it from somewhere else? */
function onlyReExports(source: Source, name: string): boolean {
  const all = source.code.match(new RegExp(String.raw`\b${name}\b`, "g")) ?? [];
  const asReExport =
    source.code.match(
      new RegExp(
        String.raw`export\s*(?:type\s*)?\{[^}]*?\b${name}\b[^}]*?\}\s*from`,
        "gs",
      ),
    ) ?? [];
  return all.length > 0 && all.length <= asReExport.length;
}

/**
 * Every wired-unit factory, with who names it.
 *
 * A barrel re-export is not a caller — that is the whole of ticket 03's
 * evidence. The declaring module **is** one, when it names the factory beyond
 * the declaration: every route module in this repository reads
 * `export const xRoutes = createXRoutes({ … })` one line below the factory, and
 * that object is then governed by the mount check instead. Ticket 03's ingestor
 * had exactly one occurrence in its own file — the `export function` line — so
 * this concession costs the check nothing it was built to catch.
 */
export function wiredUnits(sources: Source[]): Unit[] {
  const units: Unit[] = [];
  for (const source of sources) {
    if (isTestFile(source.file)) {
      continue;
    }
    for (const match of source.code.matchAll(WIRED_UNIT)) {
      const name = match[1] as string;
      const callers: string[] = [];
      const tests: string[] = [];
      const own = (source.code.match(new RegExp(String.raw`\b${name}\b`, "g")) ?? [])
        .length;
      if (own > 1) {
        callers.push(source.file);
      }
      for (const other of sources) {
        if (other.file === source.file) {
          continue;
        }
        if (!new RegExp(String.raw`\b${name}\b`).test(other.code)) {
          continue;
        }
        if (isTestFile(other.file)) {
          tests.push(other.file);
        } else if (!onlyReExports(other, name)) {
          callers.push(other.file);
        }
      }
      units.push({ name, file: source.file, callers, tests });
    }
  }
  return units;
}

/**
 * The units nothing outside their own module, barrel and tests reaches.
 *
 * **Throws on an empty population.** `[] === []` is how this repository has
 * read green over nothing four separate times (api-surface 25), and the
 * emptiness is not hypothetical: a rename of the factory convention, a walk
 * pointed at a moved directory, or a stripper that ate its own input all
 * produce it. Refusing here means the vacuous case is a failure at the place
 * the verdict is taken, rather than a floor somebody has to remember to assert
 * beside it.
 */
export function orphanUnits(units: Unit[]): Unit[] {
  if (units.length === 0) {
    throw new Error(
      "no create*Ingestor or create*Routes factory was found — the guard is governing nothing",
    );
  }
  return units.filter((unit) => unit.callers.length === 0);
}

/** A one-line account of an orphan, in the shape ticket 03 was found in. */
export function describeOrphan(unit: Unit): string {
  return `${unit.name} (${unit.file}) — no call site; ${unit.tests.length} test file(s)`;
}

/* ------------------------------------------------------- the ingest queue */

/** The `kind` of every member of the `IngestTask` union, in `tasks.ts`. */
export function taskKinds(tasksCode: string): string[] {
  const union = /export type IngestTask =([\s\S]*?);\n\s*\n/.exec(tasksCode);
  if (union === null) {
    throw new Error("tasks.ts no longer declares `export type IngestTask =`");
  }
  return [...(union[1] as string).matchAll(/kind:\s*"([a-z_]+)"/g)].map(
    (m) => m[1] as string,
  );
}

/**
 * Every kind `createIngestDispatcher` can run.
 *
 * The `case` labels **and** the exhaustiveness assertion, because the
 * dispatcher's `default:` branch narrows `task.kind` to a single remaining
 * literal (`const exhaustive: "plant_registry" = task.kind`) and runs the
 * registry ingestor there. A `case`-only reading of this file accuses
 * `plant_registry` of being unreachable, which is the false positive this
 * function exists to avoid.
 */
export function dispatchedKinds(dispatchCode: string): string[] {
  const cases = [...dispatchCode.matchAll(/case\s+"([a-z_]+)":/g)].map(
    (m) => m[1] as string,
  );
  const exhaustive = [...dispatchCode.matchAll(/:\s*"([a-z_]+)"\s*=\s*task\.kind/g)].map(
    (m) => m[1] as string,
  );
  return [...new Set([...cases, ...exhaustive])];
}

/** Every kind `planRefresh` can enqueue. */
export function plannedKinds(refreshCode: string): string[] {
  return [
    ...new Set(
      [...refreshCode.matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1] as string),
    ),
  ];
}

/** The members of the `ingestion_source` Postgres enum, from the schema. */
export function ingestionSourceMembers(schemaCode: string): string[] {
  const block = /ingestionSource = pgEnum\("ingestion_source",\s*\[([\s\S]*?)\]\)/.exec(
    schemaCode,
  );
  if (block === null) {
    throw new Error("schema.ts no longer declares the `ingestion_source` pgEnum");
  }
  return [...(block[1] as string).matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

/**
 * Every `ingestion_source` value `sourceOf` can return.
 *
 * Its `default:` returns `task.kind` unchanged, so the producible set is the
 * literals it names plus every task kind that is not intercepted by a `case`.
 */
export function producibleSources(tasksCode: string, kinds: string[]): string[] {
  const body = /export function sourceOf\([\s\S]*?\n}/.exec(tasksCode);
  if (body === null) {
    throw new Error("tasks.ts no longer declares `export function sourceOf`");
  }
  const text = body[0];
  const intercepted = new Set(
    [...text.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1] as string),
  );
  // Every snake_case literal the body names that is not a `case` label is a
  // value it can return. `"WIND"` and `"VERIFIED"` are the payload discriminants
  // the branches switch on, and they are not of this shape.
  const literals = [...text.matchAll(/"([a-z][a-z_]*)"/g)]
    .map((m) => m[1] as string)
    .filter((literal) => !intercepted.has(literal));
  const passthrough = /default:\s*\n\s*return task\.kind/.test(text)
    ? kinds.filter((kind) => !intercepted.has(kind))
    : [];
  return [...new Set([...literals, ...passthrough])];
}

/* ----------------------------------------------------------------- routes */

/** A route object a module publishes for the app to mount. */
export interface RouteObject {
  name: string;
  file: string;
}

/**
 * Every mountable route object under `apps/api/src/api/`.
 *
 * Found by shape, not by name: a top-level `export const X = new Elysia(` or
 * `export const X = create…Route…(`. `index.ts` is excluded because it is the
 * thing doing the mounting, and `plugins/` because a plugin is composed into
 * the app rather than mounted as a surface.
 */
export function routeObjects(sources: Source[]): RouteObject[] {
  const found: RouteObject[] = [];
  for (const source of sources) {
    if (!/^apps\/api\/src\/api\/[^/]+\.ts$/.test(source.file)) {
      continue;
    }
    if (source.file.endsWith("/index.ts")) {
      continue;
    }
    for (const match of source.code.matchAll(
      /^export const (\w+) = (?:new Elysia\(|create\w*Route\w*\()/gm,
    )) {
      found.push({ name: match[1] as string, file: source.file });
    }
  }
  if (found.length === 0) {
    throw new Error(
      "no route object was found under apps/api/src/api — the guard found no surface",
    );
  }
  return found;
}

/** The route objects `api/index.ts` actually composes. */
export function mountedRoutes(indexCode: string): string[] {
  return [
    ...[...indexCode.matchAll(/\.use\((\w+)\)/g)].map((m) => m[1] as string),
    ...[...indexCode.matchAll(/\.mount\([^,]+,\s*(\w+)/g)].map((m) => m[1] as string),
  ];
}

/* ----------------------------------------------------------------- config */

/** Every key of the exported `config` object. */
export function configKeys(configCode: string): string[] {
  const block = /export const config = \{([\s\S]*?)\n\} as const;/.exec(configCode);
  if (block === null) {
    throw new Error(
      "config.ts no longer declares `export const config = { … } as const;`",
    );
  }
  return [...(block[1] as string).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1] as string);
}

/** The keys nothing outside `config.ts` reads as `config.<key>`. */
export function unreadConfigKeys(keys: string[], sources: Source[]): string[] {
  return keys.filter((key) => {
    const read = new RegExp(String.raw`config\.${key}\b`);
    return !sources.some(
      (source) => source.file !== "apps/api/src/config.ts" && read.test(source.code),
    );
  });
}
