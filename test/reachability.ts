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
 *  6. **Every `WorkerTask` kind** reaches a `createWorkerDispatch` branch *and*
 *     something that puts it on the queue — a registered schedule producer, a
 *     chain, or an inline schedule literal, which are the three mechanisms this
 *     repository actually uses. Added by api-surface 32, because the wiring of
 *     `.scratch/replay/issues/07` and `/08` was found by hand and the five
 *     checks above could not have found it: `createReplayRefresher` is not a
 *     `create*Ingestor` or `create*Routes`, and `WorkerTask` is not
 *     `IngestTask`. See {@link workerTaskKinds} for how each kind is reached
 *     and why `publish_diagnosis` legitimately has no cron.
 *
 * Beside them, and not a sixth of the same kind because its population is not
 * TypeScript: **every `/internal/` route the modelling service declares is
 * named by non-test TypeScript** ({@link mlInternalRoutes}). Check 6 governs
 * kinds that exist; that one governs the case where a capability was wired
 * nowhere at all, which is what replay 07/08 actually were.
 *
 * Nothing here is an allow-list, and no check needs an edit when a module is
 * added — that is api-surface 27's rule, and it is the rule check 6 was built
 * under rather than an exception to it.
 *
 * ### What this guard cannot see, stated rather than implied
 *
 *  - **SQL.** The feature gate is a Postgres function in `apps/api/drizzle/`.
 *    Reachability of a view or a function is not derivable from TypeScript, and
 *    this file does not pretend to it.
 *  - **Python.** `apps/ml` dispatches through FastAPI decorators and a CLI, so
 *    a caller sweep *inside* that tree is advisory only. The one thing read
 *    from it is its route table, which is a declaration rather than a call
 *    graph; nothing under `apps/ml` is edited here.
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

/* ------------------------------------------------------------ worker tasks */

/**
 * The sixth check, and the one the wiring of replay 07/08 asked for.
 *
 * `.scratch/replay/issues/07-featured-days-not-a-highlight-reel.md` and
 * `.scratch/replay/issues/08-backtest-aggregate.md` were found **by hand**.
 * The five checks above could not see them: `createReplayRefresher` is neither
 * a `create*Ingestor` nor a `create*Routes`, and `WorkerTask` is not
 * `IngestTask`. So `POST /internal/replay/featured-days` and
 * `POST /internal/replay/backtest` sat on the modelling service with no
 * `WorkerTask` member, no dispatcher branch and no schedule, and
 * `/v1/replay/days` and `/v1/backtest` served `pending` on every deployed
 * instance while the spec read as though a nightly job maintained them.
 *
 * ### How a `WorkerTask` kind is actually reached, found before deciding
 *
 * The naive rule — "every kind needs a cron" — fires on correct code and would
 * be deleted, which is api-surface 25's fourth lesson again. There are three
 * ways a kind is reached in this repository and they look nothing alike:
 *
 *  1. **A schedule producer.** A function returning `JobSchedule<WorkerTask>[]`
 *     — `forecastPublicationSchedules`, `retrainScheduleForQueue`,
 *     `holdoutBackfillScheduleForQueue`, `replayRefreshSchedulesForQueue` —
 *     built in `jobs/worker-tasks.ts` and *registered* by `worker.ts`. Both
 *     halves matter: a producer nobody loops over schedules nothing, which is
 *     exactly the state replay 07/08 would be back in if `worker.ts`'s loop
 *     were deleted.
 *  2. **A chain.** `publish_diagnosis` has **no cron and correctly so**:
 *     `docs/specs/api-surface.md` gives it the trigger "on completion of each"
 *     forecast publication, and `chainDiagnosis` submits it from inside the
 *     `publish_forecast` branch through `deps.submit`. A check that demanded a
 *     cron for it would be accusing the one row of the job table that is not a
 *     cron pattern.
 *  3. **An inline schedule literal.** `worker.ts` registers `refresh_sweep`,
 *     `retention` and `centroid_drift` as `payload: { kind: … }` object
 *     literals, with no producer function at all.
 *
 * So "reached" is: dispatched **and** (scheduled by a registered producer, or
 * chained, or scheduled inline). All three are discovered by shape and none is
 * an allow-list — a kind added tomorrow is governed the day it is written.
 *
 * ### Both directions, because the defect has three shapes
 *
 * Removing the union member is as much a break as removing the branch, and it
 * is the one a one-directional check cannot see: the branch and the schedule
 * go on existing for a kind the type no longer admits.
 * {@link undeclaredWorkerKinds} is that direction.
 *
 * **What it still cannot see,** stated rather than implied: a capability wired
 * nowhere at all — no member, no branch, no schedule — the state replay
 * 07/08 were actually in. Nothing in the TypeScript declared it to exist, so
 * there was no shape to be unreachable. {@link mlInternalRoutes} is the half
 * that covers that case, from the other side of the wire.
 */
export function workerTaskKinds(workerTasksCode: string): string[] {
  const union = /export type WorkerTask =([\s\S]*?);\n/.exec(workerTasksCode);
  if (union === null) {
    throw new Error("worker-tasks.ts no longer declares `export type WorkerTask =`");
  }
  const kinds = [
    ...new Set(
      [...(union[1] as string).matchAll(/kind:\s*"([a-z_]+)"/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ];
  if (kinds.length === 0) {
    throw new Error(
      "the WorkerTask union declares no `kind:` member — the guard is governing nothing",
    );
  }
  return kinds;
}

/**
 * The union members that are a type reference rather than an inline member.
 *
 * `QueueTask` is the ingest union folded in one level up; its kinds are check
 * 2's business and are reached through the dispatcher's delegation rather than
 * a branch of their own. Returned so the test can assert that the delegation
 * exists rather than quietly ignoring half the union.
 */
export function workerTaskDelegates(workerTasksCode: string): string[] {
  const union = /export type WorkerTask =([\s\S]*?);\n/.exec(workerTasksCode);
  if (union === null) {
    throw new Error("worker-tasks.ts no longer declares `export type WorkerTask =`");
  }
  return [...(union[1] as string).matchAll(/^\s*\|\s*([A-Z]\w*)\s*$/gm)].map(
    (m) => m[1] as string,
  );
}

/**
 * Every kind `createWorkerDispatch` branches on.
 *
 * `if (task.kind === "…")` is the shape this dispatcher uses where the ingest
 * one uses `switch`; both are read, so a rewrite from one to the other does not
 * silently empty the check.
 */
export function workerDispatchedKinds(workerTasksCode: string): string[] {
  const body = /export function createWorkerDispatch\([\s\S]*?\n}/.exec(workerTasksCode);
  if (body === null) {
    throw new Error(
      "worker-tasks.ts no longer declares `export function createWorkerDispatch`",
    );
  }
  const text = body[0];
  const kinds = [
    ...new Set([
      ...[...text.matchAll(/task\.kind === "([a-z_]+)"/g)].map((m) => m[1] as string),
      ...[...text.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1] as string),
    ]),
  ];
  if (kinds.length === 0) {
    throw new Error(
      "createWorkerDispatch branches on no kind — the guard is reading an empty dispatcher",
    );
  }
  return kinds;
}

/** A function that manufactures repeatable work for the worker's queue. */
export interface ScheduleProducer {
  name: string;
  file: string;
  /** The kinds its returned schedules carry. */
  kinds: string[];
}

/**
 * Every function returning `JobSchedule<WorkerTask>[]`, with the kinds it emits.
 *
 * Found by return type, not by name: `*ScheduleForQueue` and `*Schedules` are
 * both already in use, and a fifth one named anything at all is picked up the
 * day it is written.
 */
export function scheduleProducers(sources: Source[]): ScheduleProducer[] {
  const found: ScheduleProducer[] = [];
  for (const source of sources) {
    if (isTestFile(source.file)) {
      continue;
    }
    for (const match of source.code.matchAll(
      /export function (\w+)\([^)]*\):\s*JobSchedule<WorkerTask>\[\]\s*\{([\s\S]*?)\n}/g,
    )) {
      found.push({
        name: match[1] as string,
        file: source.file,
        kinds: [
          ...new Set(
            [...(match[2] as string).matchAll(/kind:\s*"([a-z_]+)"/g)].map(
              (m) => m[1] as string,
            ),
          ),
        ],
      });
    }
  }
  if (found.length === 0) {
    throw new Error(
      "no function returning JobSchedule<WorkerTask>[] was found — the guard found no schedule",
    );
  }
  return found;
}

/**
 * The kinds something actually puts on the queue, by all three mechanisms.
 *
 * A producer counts only when a non-test module **other than the one declaring
 * it** names it: `worker.ts`'s `for (const schedule of …ScheduleForQueue())`
 * loop is the registration, and without it the producer is a function that
 * manufactures schedules nobody registers — replay 07/08's defect wearing a
 * different hat.
 */
export function enqueuedWorkerKinds(
  producers: ScheduleProducer[],
  sources: Source[],
): string[] {
  const enqueued = new Set<string>();
  for (const producer of producers) {
    const named = sources.some(
      (source) =>
        !isTestFile(source.file) &&
        source.file !== producer.file &&
        new RegExp(String.raw`\b${producer.name}\s*\(`).test(source.code),
    );
    if (named) {
      for (const kind of producer.kinds) {
        enqueued.add(kind);
      }
    }
  }
  for (const source of sources) {
    if (isTestFile(source.file)) {
      continue;
    }
    // The chain: `submit({ kind: "publish_diagnosis", payload })`.
    for (const match of source.code.matchAll(/submit\(\s*\{\s*kind:\s*"([a-z_]+)"/g)) {
      enqueued.add(match[1] as string);
    }
    // The inline schedule literal: `payload: { kind: "retention", payload: {} }`.
    for (const match of source.code.matchAll(/payload:\s*\{\s*kind:\s*"([a-z_]+)"/g)) {
      enqueued.add(match[1] as string);
    }
  }
  return [...enqueued];
}

/** A kind that is declared and not fully wired, with the half that is missing. */
export interface UnreachedKind {
  kind: string;
  /** `"dispatch"`, `"enqueue"`, or both. */
  missing: string[];
}

/**
 * The declared kinds that do not reach both halves.
 *
 * **Throws on empty input of either kind.** `[] === []` is how this repository
 * has read green over nothing four times; an empty dispatcher or an empty
 * enqueue set means the parse broke, not that the code is clean.
 */
export function unreachedWorkerKinds(
  kinds: string[],
  dispatched: string[],
  enqueued: string[],
): UnreachedKind[] {
  if (kinds.length === 0) {
    throw new Error("no WorkerTask kind was found — the guard is governing nothing");
  }
  if (dispatched.length === 0) {
    throw new Error(
      "no dispatched kind was found — the guard is reading an empty dispatcher",
    );
  }
  if (enqueued.length === 0) {
    throw new Error("nothing enqueues any kind — the guard is reading an empty queue");
  }
  const canDispatch = new Set(dispatched);
  const canEnqueue = new Set(enqueued);
  const unreached: UnreachedKind[] = [];
  for (const kind of kinds) {
    const missing: string[] = [];
    if (!canDispatch.has(kind)) {
      missing.push("dispatch");
    }
    if (!canEnqueue.has(kind)) {
      missing.push("enqueue");
    }
    if (missing.length > 0) {
      unreached.push({ kind, missing });
    }
  }
  return unreached;
}

/**
 * The other direction: a branch or a schedule for a kind the union no longer has.
 *
 * This is the shape that catches the *member* being removed while the wiring
 * stays, which a one-directional check reads as green — and it is what a
 * half-reverted wiring commit leaves behind.
 */
export function undeclaredWorkerKinds(
  kinds: string[],
  dispatched: string[],
  scheduled: string[],
): { kind: string; from: string[] }[] {
  if (kinds.length === 0) {
    throw new Error("no WorkerTask kind was found — the guard is governing nothing");
  }
  const declared = new Set(kinds);
  const out: { kind: string; from: string[] }[] = [];
  for (const kind of [...new Set([...dispatched, ...scheduled])]) {
    if (declared.has(kind)) {
      continue;
    }
    const from: string[] = [];
    if (dispatched.includes(kind)) {
      from.push("dispatch");
    }
    if (scheduled.includes(kind)) {
      from.push("schedule");
    }
    out.push({ kind, from });
  }
  return out;
}

/* ----------------------------------------------- the other side of the wire */

/**
 * Every `/internal/` route the modelling service declares.
 *
 * The half that covers the case the sixth check structurally cannot: a
 * capability wired **nowhere** in TypeScript. Replay 07/08 were in exactly that
 * state — the endpoints existed and were tested on `apps/ml`, and no
 * `WorkerTask` member, no branch and no schedule existed to be unreachable. The
 * convention `apps/ml` holds to without exception is that `/internal/` is the
 * worker's private surface and `/v1/` is the gateway's, so an `/internal/`
 * route no TypeScript names is a route nothing can ever call.
 *
 * Read from the raw text on purpose: `stripCode` is a TypeScript stripper and
 * `//` is floor division in Python. Anchoring on `@app.` at the start of a line
 * is what keeps a commented-out decorator out of the population.
 */
export function mlInternalRoutes(appText: string): string[] {
  const routes = [
    ...new Set(
      [...appText.matchAll(/^@app\.\w+\(\s*"(\/internal\/[^"]+)"/gm)].map(
        (m) => m[1] as string,
      ),
    ),
  ];
  if (routes.length === 0) {
    throw new Error(
      "the modelling service declares no /internal route — the guard is reading nothing",
    );
  }
  return routes;
}

/** The modelling-service routes no non-test TypeScript names. */
export function uncalledMlRoutes(routes: string[], sources: Source[]): string[] {
  return routes.filter(
    (route) =>
      !sources.some((source) => !isTestFile(source.file) && source.code.includes(route)),
  );
}

/** Read one repo file as raw text, by repo-relative path. */
export function textAt(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}
