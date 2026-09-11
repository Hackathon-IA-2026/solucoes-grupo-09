import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Does the repository actually **keep** the schedules its documents describe?
 *
 * api-surface 31. The evidence is one row of `docs/specs/api-surface.md`'s job
 * table:
 *
 * ```
 * | `refresh-featured-days` | `30 3 * * *` | — | the Replay shortlist cache |
 * ```
 *
 * `refresh-featured-days` is not a `WorkerTask` member, not an `IngestTask`
 * kind, not an id `worker.ts` registers on the queue, not a cron in
 * `.github/workflows/`, not a line of `railway.json` and not a service in
 * `docker-compose.yml`. Nothing anywhere fires at `30 3 * * *`. The document
 * promises a nightly job, the shortlist is never computed, and
 * `/v1/replay/days` answers `pending` forever.
 *
 * Three guards were already in the tree and none of them could see it:
 *
 *  - **api-surface 27** (`spec-claims.ts`) binds counts, path-form file
 *    references and "does not exist / is not served" claims. A table row naming
 *    a job and a cron is none of the three.
 *  - **api-surface 29** (`ticket-claims.ts`) reads tickets' own box counts, not
 *    specs.
 *  - **api-surface 30** (`reachability.ts`) asks whether code reaches code. A
 *    document is not code, and the job it names has no symbol to be unreachable.
 *
 * So this is the fourth question: **a document names a scheduled job; does the
 * repository schedule it?**
 *
 * ### The one design rule, inherited
 *
 * **No human-maintained list, on either side.** Both halves are discovered:
 *
 *  - the **claimed** side by *shape* — a Markdown table any row of which pairs
 *    a name with a cron expression is a job table, and every row of it is a
 *    claim; a cron-shaped code span anywhere else in a document is a claim
 *    about a pattern. A job table added to a new spec tomorrow is swept the day
 *    it is written, and nothing here knows the name of any job.
 *  - the **real** side by sweeping every mechanism that can put work on a
 *    clock in this repository, each read from its own source. There turned out
 *    to be more than one expected, and they look nothing alike:
 *
 *    1. **BullMQ repeatable jobs** — `{ id, pattern }` object literals, mostly
 *       in `apps/api/src/jobs/` and registered by `worker.ts`. The id may be a
 *       template (`` `refresh:${tier}` ``) and the pattern may be an imported
 *       constant (`RETRAIN_PATTERN`) or an index expression
 *       (`REFRESH_CADENCE[tier]`), so tokens are resolved against the tree's
 *       own `const … = "…"` declarations and a template becomes a `*` glob.
 *    2. **Cron string literals** in any non-test TypeScript — which is how the
 *       three `REFRESH_CADENCE` tiers are stated, as values of a `Record`, not
 *       beside an id at all.
 *    3. **GitHub Actions** — `schedule:` blocks in `.github/workflows/*.yml`.
 *       Seven crons, none of them on the queue.
 *    4. **`railway.json`** — any cron-shaped value, at any depth.
 *    5. **`docker-compose.yml`** — any cron-shaped value, and any service whose
 *       image or command is a cron daemon.
 *    6. **Task kinds** — the `IngestTask` / `WorkerTask` unions and the kinds
 *       `planRefresh` enqueues. These carry no cron and are identities only:
 *       `publish-diagnosis` is real work with a real trigger and no pattern of
 *       its own, and a guard that demanded a cron for it would be wrong.
 *
 * A mechanism added later is not covered until someone teaches this file about
 * it — that is the honest ceiling, and it is the same ceiling `reachability.ts`
 * states about SQL and Python. What is *not* a ceiling is the set of jobs: no
 * check here needs an edit when a job is added, renamed or removed.
 *
 * ### Three verdicts, and the honest one is named
 *
 *  - **real** — the document's cron is a pattern something in the tree fires
 *    at, and its job name is an identity the tree can run.
 *  - **phantom** — either half fails. `refresh-featured-days` fails both.
 *  - **not checkable** — the row states a *trigger* rather than a cron ("on
 *    completion of each above"). The name is still checked; the trigger is
 *    prose and this file does not pretend to evaluate it.
 *
 * Beside the table there is a fourth kind, counted and named rather than
 * skipped: **schedule prose** — "a shortlist the nightly job has not yet
 * computed", "the schedule is 11:00 UTC = 08:00 BRT". These are claims about a
 * cadence in English, they are not derivable, and
 * {@link scheduleProse} exists so that the size of the unchecked half is a
 * measured number rather than an assumption.
 *
 * ### Vacuity
 *
 * This repository has shipped four guards that read green over nothing, and in
 * the two days before this one api-surface 29 found 27's sentence splitter
 * blind to a bolded full stop and api-surface 30 found its own scanner eating
 * the file it scanned. So: {@link auditSchedules} **throws** when either side
 * of the comparison is empty rather than returning `[]`, the corpus and every
 * mechanism are asserted non-trivial before anything is compared, the comment
 * stripper is asserted on the exact file that broke the last one, and the
 * cron-shape reader is asserted to reject the prose it must not match.
 */

const ROOT = join(import.meta.dir, "..");

/* ------------------------------------------------------------ cron shapes */

/** One cron field: a star, a number, a step, a range or a list. */
const CRON_FIELD = String.raw`(?:\*|\d+)(?:[-/,](?:\*|\d+))*`;
const CRON_ONLY = new RegExp(`^${CRON_FIELD}(?: +${CRON_FIELD}){4,5}$`);

/**
 * Is `text` a cron expression?
 *
 * Five or six fields, and **at least one `*`**. The star is not decoration: a
 * bare five-number sequence is how this repository writes a list of ticket
 * numbers ("seams 1, 3, 5, 6, 8"), a row of hours and a fixture vector, and a
 * reader without the star reports all of them as schedules. The cost is stated
 * plainly — a starless cron such as `0 0 1 1 0` is not read as one — and it is
 * the cheaper mistake: a missed claim is a gap, a false claim is a guard
 * somebody deletes.
 */
export function isCron(text: string): boolean {
  const one = text.trim();
  return one.includes("*") && CRON_ONLY.test(one);
}

/** The contents of every backticked code span in `text`. */
function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] as string);
}

/** Lowercased and stripped to letters, digits and globs, for comparing names. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9*]/g, "");
}

/* ------------------------------------------------------- the claimed side */

export interface ClaimedSchedule {
  /** Repo-relative path of the document. */
  doc: string;
  /** 1-based line, for grepping. */
  line: number;
  /** The job the document names, or `null` for a bare cron in prose. */
  job: string | null;
  /** The cron the document states, or `null` when it states a trigger. */
  cron: string | null;
  /** What the document wrote where a cron would go, when it is not one. */
  trigger: string | null;
}

const DOC_DIRS = ["docs"];
const DOC_FILES = ["README.md"];

function walkFiles(
  dir: string,
  test: (name: string) => boolean,
  out: string[],
): string[] {
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
      walkFiles(path, test, out);
    } else if (test(entry)) {
      out.push(relative(ROOT, path));
    }
  }
  return out;
}

/**
 * Every published document, keyed by repo-relative path.
 *
 * `docs/**` and the README: the documents this project publishes about itself.
 * `.scratch/**` tickets are deliberately **out of scope** — a ticket is a
 * working log that quotes the defect it is fixing, api-surface 29 already owns
 * what a ticket claims about itself, and the ticket for this very guard has to
 * be able to print the phantom row as evidence without turning red.
 */
export function documentTexts(): Map<string, string> {
  const files = walkFiles(
    join(ROOT, DOC_DIRS[0] as string),
    (n) => n.endsWith(".md"),
    [],
  );
  for (const file of DOC_FILES) {
    files.push(file);
  }
  return new Map(
    files.sort().map((file) => [file, readFileSync(join(ROOT, file), "utf8")]),
  );
}

function isTableRow(line: string): boolean {
  return /^\s*\|/.test(line);
}

/**
 * Phrases with which a sentence declares its cron a quotation, not a claim.
 *
 * The same vocabulary `spec-claims.ts` uses, and for the same reason: these
 * documents correct themselves by quoting the withdrawn thing back, and the
 * correction note for *this very defect* is likely to print
 * `` `30 3 * * *` `` beside the words "this table said". A guard that read
 * that as a live claim would fail on every correction ever written and would
 * be deleted within a week.
 *
 * A closed vocabulary of English, not a list of exemptions: it needs no edit
 * when a document changes, and a cron cannot hide behind it without the
 * sentence saying, in English, that the document no longer stands behind it.
 * Scoped to the **sentence**, never the paragraph — api-surface 29 found
 * paragraph scope silently excusing three live claims in 27.
 */
const CORRECTION_MARKERS = [
  "corrected",
  "this document said",
  "this section said",
  "this table said",
  "this table first read",
  "was saying",
  "an earlier draft",
  "previously said",
  "used to say",
  "used to read",
  "first read",
  "withdrawn",
  "no longer",
];

/** Where one sentence ends — punctuation plus any Markdown emphasis after it. */
const SENTENCE_END = /(?<=[.;:!?][*_)”"']{0,3})\s+/;

/** Does the sentence around `index` in `paragraph` withdraw what it quotes? */
function isQuotation(paragraph: string, index: number): boolean {
  let at = 0;
  for (const sentence of paragraph.split(SENTENCE_END)) {
    const end = at + sentence.length;
    if (index >= at && index <= end + 1) {
      const lower = sentence.toLowerCase();
      return CORRECTION_MARKERS.some((marker) => lower.includes(marker));
    }
    at = end + 1;
  }
  return false;
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Every schedule a document claims.
 *
 * **A job table is discovered, not named.** Any contiguous run of Markdown
 * table lines in which *some* row's second cell holds a cron expression is a
 * job table, and then **every** row of it is a claim — which is how
 * `publish-diagnosis`, whose second cell says "on completion of each above",
 * is swept without anybody writing its name down. Rows whose first cell holds
 * no code span are headers and separators and are skipped by that fact alone.
 *
 * Outside a job table, a cron-shaped code span is a claim about a pattern with
 * no name attached — `forecaster.md`'s "`10 3 * * 5` UTC, registered beside
 * the …" is the live example.
 */
export function claimedSchedules(docs: Map<string, string>): ClaimedSchedule[] {
  const found: ClaimedSchedule[] = [];
  for (const [doc, text] of docs) {
    const lines = text.split("\n");
    const consumed = new Set<number>();
    let i = 0;
    while (i < lines.length) {
      if (!isTableRow(lines[i] as string)) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < lines.length && isTableRow(lines[j] as string)) {
        j += 1;
      }
      const rows = lines
        .slice(i, j)
        .map((line, k) => ({ at: i + k, cells: cellsOf(line) }));
      const schedules = rows.filter((row) => codeSpans(row.cells[1] ?? "").some(isCron));
      if (schedules.length > 0) {
        for (const row of rows) {
          const job = codeSpans(row.cells[0] ?? "")[0];
          if (job === undefined) {
            continue;
          }
          const cron = codeSpans(row.cells[1] ?? "").find(isCron) ?? null;
          found.push({
            doc,
            line: row.at + 1,
            job,
            cron,
            trigger: cron === null ? (row.cells[1] ?? null) : null,
          });
        }
        for (let k = i; k < j; k += 1) {
          consumed.add(k);
        }
      }
      i = j;
    }
    // Paragraph boundaries, so that a cron in a sentence which *withdraws* it
    // can be told from one that asserts it. Most claims in these documents
    // wrap across two source lines, so the sentence has to be read off the
    // flattened paragraph rather than off the line the span happens to sit on.
    const paragraphs: { from: number; flat: string }[] = [];
    let start = 0;
    lines.forEach((line, k) => {
      if (line.trim() === "") {
        paragraphs.push({
          from: start,
          flat: lines
            .slice(start, k)
            .map((one) => one.replace(/^\s*>\s?/, ""))
            .join(" ")
            .replace(/\s+/g, " "),
        });
        start = k + 1;
      }
    });
    paragraphs.push({
      from: start,
      flat: lines
        .slice(start)
        .map((one) => one.replace(/^\s*>\s?/, ""))
        .join(" ")
        .replace(/\s+/g, " "),
    });
    const paragraphAt = (k: number): { from: number; flat: string } =>
      [...paragraphs].reverse().find((one) => one.from <= k) ?? { from: 0, flat: "" };

    lines.forEach((line, k) => {
      if (consumed.has(k)) {
        return;
      }
      for (const span of codeSpans(line)) {
        if (!isCron(span)) {
          continue;
        }
        const paragraph = paragraphAt(k);
        if (isQuotation(paragraph.flat, paragraph.flat.indexOf(`\`${span}\``))) {
          continue;
        }
        found.push({ doc, line: k + 1, job: null, cron: span, trigger: null });
      }
    });
  }
  return found;
}

/** Cadence words a document uses when it states a schedule in English. */
const CADENCE_WORDS =
  /\b(nightly|daily|weekly|hourly|every (?:day|night|hour|week|morning|friday|monday)|fridays|mondays|twice a day)\b/i;
/** Words that make the sentence about *work*, rather than about data cadence. */
const WORK_WORDS =
  /\b(job|cron|schedule[sd]?|sweep|retrain|publication|publishes|backfill|watch|refresh|conformance|run[s]?)\b/i;

export interface ProseSchedule {
  doc: string;
  line: number;
  sentence: string;
}

/**
 * Schedules stated in English rather than in cron — the unchecked half, counted.
 *
 * "A shortlist the nightly job has not yet computed", "the schedule is 11:00
 * UTC = 08:00 BRT", "the weekly retrain runs end to end". None of these is
 * derivable: there is no name to resolve and no pattern to compare, and a
 * regex that tried to turn "nightly" into `* * * * *` would be inventing a
 * claim in order to check it. They are enumerated so that the size of what
 * this guard does not govern is a number somebody can read, the way
 * `spec-claims.test.ts` measures its own exemptions rather than trusting them.
 */
export function scheduleProse(docs: Map<string, string>): ProseSchedule[] {
  const found: ProseSchedule[] = [];
  for (const [doc, text] of docs) {
    text.split("\n").forEach((line, k) => {
      if (codeSpans(line).some(isCron)) {
        return;
      }
      if (CADENCE_WORDS.test(line) && WORK_WORDS.test(line)) {
        found.push({ doc, line: k + 1, sentence: line.trim() });
      }
    });
  }
  return found;
}

/* ---------------------------------------------------------- the real side */

export type Mechanism =
  | "bullmq-schedule"
  | "cron-literal"
  | "github-actions"
  | "railway"
  | "compose"
  | "task-kind";

export interface RealSchedule {
  /** A stable identity, possibly a `*` glob from a template literal. */
  id: string | null;
  /** The cron it fires at, or `null` for an identity with no pattern. */
  cron: string | null;
  mechanism: Mechanism;
  /** Where it was read from. */
  where: string;
}

/**
 * Comments out, code in, in one positional pass.
 *
 * api-surface 25's third defect was a stripper that removed block comments
 * before line comments and so ate a hundred lines of `apps/api/src/api/grid.ts`
 * out of its own input, because a `//` comment in that file contains `/*`. This
 * walks once and takes whichever of `//`, `/*` or a quote opens first, so that
 * line costs it nothing — and the test below asserts that on the same file
 * rather than trusting this paragraph. Length is preserved so line numbers
 * survive; string literals are kept, because a cron *is* a string literal.
 */
export function stripComments(text: string): string {
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
    const quote = text[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      out += quote;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i];
        i += 1;
        if (text[i - 1] === quote) {
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

export interface Source {
  file: string;
  code: string;
}

const CODE_DIRS = ["apps/api", "apps/web", "packages", "scripts"];

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || /(^|\/)(test|e2e|__tests__)\//.test(file);
}

/** Every non-test TypeScript file under the walked roots, comments removed. */
export function codeSources(): Source[] {
  const files: string[] = [];
  for (const dir of CODE_DIRS) {
    walkFiles(join(ROOT, dir), (name) => /\.tsx?$/.test(name), files);
  }
  return files
    .filter((file) => !isTestFile(file))
    .map((file) => ({
      file,
      code: stripComments(readFileSync(join(ROOT, file), "utf8")),
    }));
}

/** Every `const NAME = "literal"` in the tree, for resolving a token. */
export function stringConstants(sources: Source[]): Map<string, string> {
  const consts = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.code.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*"([^"\n]*)"/g,
    )) {
      consts.set(match[1] as string, match[2] as string);
    }
  }
  return consts;
}

/**
 * What a token in an object literal actually is, as far as it can be known.
 *
 * A double-quoted literal is itself; a template literal is itself with every
 * `${…}` turned into a `*` glob, because `` `refresh:${tier}` `` genuinely is
 * a family of ids; a bare identifier is looked up among the tree's string
 * constants, which is what makes `RETRAIN_PATTERN` resolve to `10 3 * * 5`
 * without this file ever naming the retrain. Anything else — a property
 * access, an index expression — resolves to `null` and is *counted* rather
 * than dropped, so a scan that suddenly resolves nothing is visible.
 */
export function resolveToken(token: string, consts: Map<string, string>): string | null {
  const one = token.trim().replace(/,$/, "");
  const literal = /^"([^"]*)"$/.exec(one);
  if (literal !== null) {
    return literal[1] as string;
  }
  const template = /^`([^`]*)`$/.exec(one);
  if (template !== null) {
    // An interpolation whose expression is a string constant this scan already
    // read resolves to that constant; only the genuinely variable ones become
    // `*`. Both halves matter. `refresh-featured-days:${subsystem}:${lane}` is
    // registered as one schedule per (subsystem, lane), and a blanket
    // substitution rendered it `*:*:*` — which failed to answer to the name
    // `docs/specs/api-surface.md` gives that job, *and* would have answered to
    // almost any other three-segment id. Resolving the constant makes the
    // guard both correct here and stricter everywhere.
    return (template[1] as string).replace(/\$\{([^}]*)\}/g, (_whole, expression) => {
      const name = String(expression).trim();
      return /^[A-Za-z_$][\w$]*$/.test(name) ? (consts.get(name) ?? "*") : "*";
    });
  }
  if (/^[A-Za-z_$][\w$]*$/.test(one)) {
    return consts.get(one) ?? null;
  }
  return null;
}

/** An `{ id, pattern }` pair as it was written, before resolution. */
const SCHEDULE_LITERAL = /\bid:\s*([^,\n]+),[^{}]{0,240}?\bpattern:\s*([^,\n]+)\s*[,\n]/g;
/** The same pair written the other way round. */
const SCHEDULE_LITERAL_REVERSED =
  /\bpattern:\s*([^,\n]+),[^{}]{0,240}?\bid:\s*([^,\n]+)\s*[,\n]/g;

/**
 * Every repeatable job registered on the queue, from the object literals that
 * declare one.
 *
 * By shape — an `id` beside a `pattern` — and not by import, so a schedule
 * declared in a module `worker.ts` has not been taught about yet is still
 * found, and a schedule deleted from `worker.ts` disappears from here the same
 * day. Entries where neither half resolves are dropped: `{ id: publication.id,
 * pattern: publication.pattern }` is the *mapping* over the real table, not a
 * second schedule.
 */
export function bullmqSchedules(sources: Source[]): RealSchedule[] {
  const consts = stringConstants(sources);
  const found: RealSchedule[] = [];
  for (const source of sources) {
    const pairs: [string, string][] = [];
    for (const match of source.code.matchAll(SCHEDULE_LITERAL)) {
      pairs.push([match[1] as string, match[2] as string]);
    }
    for (const match of source.code.matchAll(SCHEDULE_LITERAL_REVERSED)) {
      pairs.push([match[2] as string, match[1] as string]);
    }
    for (const [idToken, patternToken] of pairs) {
      const id = resolveToken(idToken, consts);
      const pattern = resolveToken(patternToken, consts);
      if (id === null && pattern === null) {
        continue;
      }
      found.push({
        id,
        cron: pattern !== null && isCron(pattern) ? pattern : null,
        mechanism: "bullmq-schedule",
        where: source.file,
      });
    }
  }
  return found;
}

/**
 * Every cron written as a string literal in non-test TypeScript.
 *
 * The mechanism that does **not** look like the others: `REFRESH_CADENCE` is a
 * `Record` of three tiers to three patterns, with no `id` within twenty lines
 * of it, and `worker.ts` indexes it at registration time. A sweep that only
 * read `{ id, pattern }` would call the hourly live sweep imaginary. The id
 * here is whatever names the literal — the object key or the constant — which
 * is the closest thing to an identity the source offers.
 */
export function cronLiterals(sources: Source[]): RealSchedule[] {
  const found: RealSchedule[] = [];
  for (const source of sources) {
    for (const match of source.code.matchAll(/"([^"\n]*)"/g)) {
      const value = match[1] as string;
      if (!isCron(value)) {
        continue;
      }
      const before = source.code.slice(0, match.index ?? 0);
      const line = before.split("\n").length;
      const named =
        /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(before.slice(-80)) ??
        /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*$/.exec(
          before.slice(-120),
        );
      found.push({
        id: named?.[1] ?? null,
        cron: value,
        mechanism: "cron-literal",
        where: `${source.file}:${line}`,
      });
    }
  }
  return found;
}

/**
 * Every cron in a `schedule:` block of a GitHub Actions workflow.
 *
 * Scoped to the block rather than to the file: a `cron` word in a comment or a
 * step name is not a schedule, and four of these five files talk about their
 * own crons in prose at the top. The identity is the workflow's `name:`, since
 * that is what a failure is reported under.
 */
export function workflowSchedules(): RealSchedule[] {
  const dir = join(ROOT, ".github", "workflows");
  const found: RealSchedule[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
  } catch {
    return found;
  }
  for (const file of files.sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? file;
    let indent = -1;
    text.split("\n").forEach((line, k) => {
      if (/^\s*#/.test(line) || line.trim() === "") {
        return;
      }
      const at = line.search(/\S/);
      if (/^\s*schedule:\s*$/.test(line)) {
        indent = at;
        return;
      }
      if (indent === -1) {
        return;
      }
      if (at <= indent && !/^\s*-/.test(line)) {
        indent = -1;
        return;
      }
      const cron = /^\s*-\s*cron:\s*["']?([^"'#\n]+)["']?/.exec(line);
      if (cron !== null && isCron(cron[1] as string)) {
        found.push({
          id: name,
          cron: (cron[1] as string).trim(),
          mechanism: "github-actions",
          where: `.github/workflows/${file}:${k + 1}`,
        });
      }
    });
  }
  return found;
}

/** Every cron-shaped string anywhere in a JSON file, with the key that held it. */
function cronsInJson(value: unknown, path: string, into: [string, string][]): void {
  if (typeof value === "string") {
    if (isCron(value)) {
      into.push([path, value]);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, k) => {
      cronsInJson(item, `${path}[${k}]`, into);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      cronsInJson(item, path === "" ? key : `${path}.${key}`, into);
    }
  }
}

/**
 * Railway's own scheduler, from `railway.json`.
 *
 * Railway runs a service on a cron through a `cron`/`cronSchedule` field, so
 * the whole document is walked for a cron-shaped value at any depth rather
 * than one key being read. It currently holds none — the deploy block is a
 * health check and a restart policy — and that emptiness is a *fact about the
 * deployment* rather than a broken reader, which is why the test below asserts
 * the reader on a synthetic document instead of on this file.
 */
export function railwaySchedules(): RealSchedule[] {
  const found: RealSchedule[] = [];
  for (const file of readdirSync(ROOT).filter((name) => /^railway.*\.json$/.test(name))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
    } catch {
      continue;
    }
    found.push(...schedulesInJson(parsed, file));
  }
  return found;
}

/** The cron-shaped values of one parsed JSON document, as real schedules. */
export function schedulesInJson(parsed: unknown, where: string): RealSchedule[] {
  const crons: [string, string][] = [];
  cronsInJson(parsed, "", crons);
  return crons.map(([path, cron]) => ({
    id: path,
    cron,
    mechanism: "railway" as const,
    where: `${where}:${path}`,
  }));
}

/**
 * Anything in `docker-compose.yml` that puts work on a clock.
 *
 * Two shapes, because a compose file can schedule in two ways: a cron-shaped
 * string in any value (a `command`, an `environment` entry a scheduler image
 * reads), and a service whose image or command *is* a cron daemon — `ofelia`,
 * `supercronic`, a plain `crond`. Neither is present today; the five services
 * are Postgres, Redis, the API, the worker and the ML service, and the worker
 * is the scheduler. The reader is here because "the local topology mirrors the
 * deployed one, one for one" is the file's own claim, and a sixth service
 * added to it must be swept without anyone remembering to come back here.
 */
export function composeSchedules(): RealSchedule[] {
  const found: RealSchedule[] = [];
  for (const file of readdirSync(ROOT).filter((name) =>
    /^docker-compose.*\.ya?ml$/.test(name),
  )) {
    const text = readFileSync(join(ROOT, file), "utf8");
    text.split("\n").forEach((line, k) => {
      if (/^\s*#/.test(line)) {
        return;
      }
      const value = line.replace(/^[^:]*:/, "");
      for (const quoted of [
        ...value.matchAll(/["']([^"']+)["']/g),
        ...[[value, value.trim()] as unknown as RegExpMatchArray],
      ]) {
        if (isCron(quoted[1] as string)) {
          found.push({
            id: line.split(":")[0]?.trim() ?? null,
            cron: (quoted[1] as string).trim(),
            mechanism: "compose",
            where: `${file}:${k + 1}`,
          });
          return;
        }
      }
      const daemon = /\b(ofelia|supercronic|crond|cronie|go-cron)\b/.exec(line);
      if (daemon !== null) {
        found.push({
          id: daemon[1] as string,
          cron: null,
          mechanism: "compose",
          where: `${file}:${k + 1}`,
        });
      }
    });
  }
  return found;
}

/**
 * Every kind of work the queue can carry, from the task unions and the planner.
 *
 * Identities with no pattern. This is the half that makes `publish-diagnosis`
 * answerable: it has no cron and never will — its trigger is the completion of
 * the forecast publication — but it is a `WorkerTask` member, so the document
 * naming it is telling the truth. Read from every `export type …Task = …`
 * union and from every `kind: "…"` inside `planRefresh`, both by shape.
 */
export function taskKinds(sources: Source[]): RealSchedule[] {
  const found: RealSchedule[] = [];
  for (const source of sources) {
    for (const union of source.code.matchAll(
      /export type (\w*Task)\s*=([\s\S]*?);\s*\n/g,
    )) {
      for (const kind of (union[2] as string).matchAll(/kind:\s*"([a-z_]+)"/g)) {
        found.push({
          id: kind[1] as string,
          cron: null,
          mechanism: "task-kind",
          where: `${source.file} (${union[1] as string})`,
        });
      }
    }
    const planner = /export function planRefresh[\s\S]*?\n}/.exec(source.code);
    if (planner !== null) {
      for (const kind of planner[0].matchAll(/kind:\s*"([a-z_]+)"/g)) {
        found.push({
          id: kind[1] as string,
          cron: null,
          mechanism: "task-kind",
          where: `${source.file} (planRefresh)`,
        });
      }
    }
  }
  return found;
}

/** Every mechanism, swept. */
export function realSchedules(sources: Source[] = codeSources()): RealSchedule[] {
  return [
    ...bullmqSchedules(sources),
    ...cronLiterals(sources),
    ...workflowSchedules(),
    ...railwaySchedules(),
    ...composeSchedules(),
    ...taskKinds(sources),
  ];
}

/* -------------------------------------------------------------- the audit */

export type Status = "real" | "phantom" | "not checkable";

export interface Verdict {
  claim: ClaimedSchedule;
  status: Status;
  /** Which checks were applied. */
  check: string;
  /** What was found, or what was missing. */
  detail: string;
}

/** Does `name` answer to one of the real identities, globs included? */
export function identityOf(name: string, ids: string[]): string | null {
  const want = normalize(name);
  const literal = name.trim().toLowerCase();
  for (const id of ids) {
    // An exact match ignores punctuation, because the same job is spelled
    // `publish_diagnosis` in the union and `publish-diagnosis` in the table.
    if (normalize(id) === want) {
      return id;
    }
    // A glob does **not**, and that is the whole of the difference: the id
    // `refresh:${tier}` is a family separated by a colon, and a comparison
    // that had already thrown the colon away would let `refresh:*` swallow
    // `refresh-featured-days` — which is precisely the phantom this guard
    // exists to catch, absolved by its own prefix.
    const have = id.trim().toLowerCase();
    // A family instance answers to the family's name. The table names the job
    // `refresh-featured-days`; the queue registers one schedule per (subsystem,
    // lane) as `refresh-featured-days:<subsystem>:<lane>`, so the id the guard
    // sees is a glob with two segments the bare name cannot match.
    //
    // The colon is **required**, and that is what keeps this from undoing the
    // rule above: `refresh-featured-days` does not begin `refresh:`, so the
    // `refresh:${tier}` family still cannot absolve it. Asserted below.
    if (have.startsWith(`${literal}:`)) {
      return id;
    }
    if (have.includes("*")) {
      const pattern = have
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[a-z0-9_]*");
      if (new RegExp(`^${pattern}$`).test(literal)) {
        return id;
      }
    }
  }
  return null;
}

/**
 * Every documented schedule, judged against every real one.
 *
 * **Throws on an empty input, on either side.** `[] === []` is how this
 * repository has read green over nothing four separate times, and every one of
 * the three ways this comparison can be starved is live: a Markdown table
 * syntax nobody writes any more, a walk pointed at a moved directory, a
 * stripper that ate its own input. Refusing here puts the vacuous case at the
 * place the verdict is taken rather than in a floor somebody has to remember
 * to assert beside it — which is exactly what `orphanUnits` does in
 * `reachability.ts`, for the same reason.
 */
export function auditSchedules(
  claims: ClaimedSchedule[],
  real: RealSchedule[],
): Verdict[] {
  if (claims.length === 0) {
    throw new Error(
      "no documented schedule was found — the claimed side is empty and the guard is governing nothing",
    );
  }
  if (real.length === 0) {
    throw new Error(
      "no real schedule was found — the repository appears to schedule nothing, which would make every claim a phantom",
    );
  }
  const crons = new Set(
    real.map((one) => one.cron).filter((cron): cron is string => cron !== null),
  );
  const ids = real.map((one) => one.id).filter((id): id is string => id !== null);
  if (crons.size === 0) {
    throw new Error(
      "no real cron pattern was found — the pattern half of the comparison would pass nothing",
    );
  }
  if (ids.length === 0) {
    throw new Error(
      "no real job identity was found — the name half of the comparison would pass nothing",
    );
  }

  return claims.map((claim) => {
    const checks: string[] = [];
    const missing: string[] = [];
    const found: string[] = [];
    if (claim.cron !== null) {
      checks.push("cron");
      if (crons.has(claim.cron)) {
        const at = real.find((one) => one.cron === claim.cron) as RealSchedule;
        found.push(`\`${claim.cron}\` is fired by ${at.mechanism} (${at.where})`);
      } else {
        missing.push(`nothing in this repository fires at \`${claim.cron}\``);
      }
    }
    if (claim.job !== null) {
      checks.push("name");
      const id = identityOf(claim.job, ids);
      if (id === null) {
        missing.push(`no schedule id, task kind or workflow answers to \`${claim.job}\``);
      } else {
        const at = real.find((one) => one.id === id) as RealSchedule;
        found.push(`\`${claim.job}\` is ${at.mechanism} \`${id}\` (${at.where})`);
      }
    }
    const status: Status =
      missing.length > 0 ? "phantom" : claim.cron === null ? "not checkable" : "real";
    return {
      claim,
      status,
      check: checks.join(" + ") || "none",
      detail: missing.length > 0 ? missing.join("; ") : found.join("; "),
    };
  });
}

/** A one-line account of a verdict, in the shape the ticket reports it. */
export function describeVerdict(verdict: Verdict): string {
  const what = verdict.claim.job ?? verdict.claim.cron ?? "?";
  return `${verdict.claim.doc}:${verdict.claim.line} \`${what}\` — ${verdict.status} (${verdict.check}): ${verdict.detail}`;
}

/* ------------------------------------------------------------------ tests */

const DOCS = documentTexts();
const SOURCES = codeSources();
const CLAIMS = claimedSchedules(DOCS);
const REAL = realSchedules(SOURCES);

// --- part 1: neither side of the comparison is empty -------------------------

describe("nothing below is asserted over an empty input", () => {
  it("read the published documents, all of them, by discovery", () => {
    // Discovery, not enumeration — a tenth spec is swept the day it lands —
    // with a floor so that a walk which started returning nothing cannot make
    // every assertion in this file vacuously true.
    expect(DOCS.size).toBeGreaterThan(15);
    expect([...DOCS.keys()]).toContain("docs/specs/api-surface.md");
    expect([...DOCS.keys()]).toContain("docs/contracts/canonical-reads.md");
    expect(
      [...DOCS.values()].filter((text) => text.length > 2000).length,
    ).toBeGreaterThan(8);
  });

  it("found the documents' job tables and their prose crons", () => {
    expect(CLAIMS.length).toBeGreaterThan(3);
    // Both readers work: a table row that pairs a name with a cron, a table row
    // that pairs a name with a trigger, and a bare cron in a sentence.
    expect(CLAIMS.some((claim) => claim.job !== null && claim.cron !== null)).toBe(true);
    expect(CLAIMS.some((claim) => claim.job !== null && claim.cron === null)).toBe(true);
    expect(CLAIMS.some((claim) => claim.job === null && claim.cron !== null)).toBe(true);
  });

  it("swept every scheduling mechanism, and found more than one", () => {
    const byMechanism = new Map<Mechanism, number>();
    for (const one of REAL) {
      byMechanism.set(one.mechanism, (byMechanism.get(one.mechanism) ?? 0) + 1);
    }
    // The four that are live today. `railway` and `compose` are readers over
    // documents that currently schedule nothing; they are asserted on synthetic
    // input below instead, because asserting a count here would be asserting
    // that the deployment has a cron it does not have.
    expect(byMechanism.get("bullmq-schedule") ?? 0).toBeGreaterThan(3);
    expect(byMechanism.get("cron-literal") ?? 0).toBeGreaterThan(5);
    expect(byMechanism.get("github-actions") ?? 0).toBeGreaterThan(4);
    expect(byMechanism.get("task-kind") ?? 0).toBeGreaterThan(8);
  });

  it("resolved the tokens that are not literals", () => {
    const consts = stringConstants(SOURCES);
    // A constant, resolved out of another module: this is how the retrain's
    // pattern is written, and a resolver that gave up on identifiers would
    // report the weekly retrain as unscheduled.
    expect(consts.get("RETRAIN_PATTERN")).toBe("10 3 * * 5");
    expect(resolveToken("RETRAIN_PATTERN", consts)).toBe("10 3 * * 5");
    // A template id becomes a glob rather than a miss.
    const template = ["`refresh:$", "{tier}`"].join("");
    expect(resolveToken(template, consts)).toBe("refresh:*");
    // And an expression resolves to nothing rather than to a wrong answer.
    expect(resolveToken("REFRESH_CADENCE[tier]", consts)).toBeNull();
    expect(REAL.some((one) => one.id === "refresh:*")).toBe(true);
  });

  it("reads the three tiers nothing declares beside an id", () => {
    // `REFRESH_CADENCE` is a `Record` of three patterns with no `id` anywhere
    // near it; `worker.ts` indexes it at registration. The `{ id, pattern }`
    // reader cannot see these, and a sweep that had only that reader would call
    // the hourly live sweep imaginary.
    const literals = cronLiterals(SOURCES);
    const tiers = literals.filter((one) =>
      ["live", "recent", "history"].includes(one.id ?? ""),
    );
    expect(tiers.map((one) => one.id).sort()).toEqual(["history", "live", "recent"]);
    expect(tiers.every((one) => one.cron !== null)).toBe(true);
  });

  it("strips comments positionally, on the file that broke the last stripper", () => {
    // api-surface 25's third defect: a stripper that removed block comments
    // first ate a hundred lines of this file, because a `//` comment in it
    // contains `/*`. Asserted on the file rather than argued in a paragraph.
    const raw = readFileSync(join(ROOT, "apps/api/src/api/grid.ts"), "utf8");
    const stripped = stripComments(raw);
    expect(stripped.length).toBe(raw.length);
    expect(stripped.split("\n").length).toBe(raw.split("\n").length);
    // The offending line, and the proof it cost nothing: every route this file
    // registers *after* it is still in the stripped text. A stripper that took
    // the block comments first deleted all of them.
    expect(/\/\/[^\n]*\/\*/.test(raw)).toBe(true);
    const offender = /\/\/[^\n]*\/\*/.exec(raw) as RegExpExecArray;
    const routesAfter = [
      ...raw.slice(offender.index).matchAll(/\.(get|post)\(\s*"([^"]+)"/g),
    ];
    expect(routesAfter.length).toBeGreaterThanOrEqual(1);
    for (const route of routesAfter) {
      expect(stripped).toContain(route[2] as string);
    }
    // And the property that matters here: a cron inside a comment is not a
    // schedule, and a cron inside a string literal still is.
    expect(stripComments('const a = "5 4 * * *"; // was "6 4 * * *"')).toContain(
      '"5 4 * * *"',
    );
    expect(stripComments('const a = "5 4 * * *"; // was "6 4 * * *"')).not.toContain(
      "6 4",
    );
  });
});

// --- part 2: the documents' schedules are schedules the repository keeps ------

describe("every schedule a document names is a schedule the repository keeps", () => {
  const verdicts = auditSchedules(CLAIMS, REAL);

  it("names no job the repository cannot run, and no cron it never fires", () => {
    // The defect: `docs/specs/api-surface.md`'s job table promises a nightly
    // `refresh-featured-days` at `30 3 * * *`. There is no such task kind, no
    // such queue id, no such workflow cron, and nothing in the tree fires at
    // that minute — so `/v1/replay/days` serves `pending` forever and the
    // document says it is computed nightly.
    //
    // Nothing here knows that name. The row is caught because its second cell
    // is cron-shaped, which made its table a job table, which made every row of
    // it a claim.
    expect(
      verdicts.filter((one) => one.status === "phantom").map(describeVerdict),
    ).toEqual([]);
  });

  it("checked both halves of a table row, not just one", () => {
    // A row is real only when its *name* resolves and its *cron* is fired. A
    // guard that checked only the pattern would pass a row whose cron happened
    // to collide with another job's, and one that checked only the name would
    // pass a job rescheduled in the document and nowhere else.
    const rows = verdicts.filter(
      (one) => one.claim.job !== null && one.claim.cron !== null,
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((one) => one.check === "cron + name")).toBe(true);
  });

  it("says which claims it cannot check, rather than passing them quietly", () => {
    // The honest half. A row stating a trigger rather than a cron —
    // "on completion of each above" — has its name checked and its trigger
    // reported as unevaluated; a cadence stated in English has neither.
    const unchecked = verdicts.filter((one) => one.status === "not checkable");
    expect(unchecked.length).toBeGreaterThan(0);
    expect(unchecked.every((one) => one.check === "name")).toBe(true);

    const prose = scheduleProse(DOCS);
    expect(prose.length).toBeGreaterThan(5);
    // Measured rather than trusted: if the English half ever dwarfed the
    // checkable one by two orders of magnitude, this guard would be governing
    // a rounding error and somebody should be told.
    expect(prose.length).toBeLessThan(200);
  });
});

// --- part 3: the guard goes red when the thing it governs moves --------------

describe("the guard is not vacuous: drift makes it fail", () => {
  /** One document with `find` replaced by `replace`, and proof it changed. */
  function scratch(doc: string, find: string, replace: string): Map<string, string> {
    const text = DOCS.get(doc) as string;
    expect(text).toContain(find);
    return new Map([...DOCS, [doc, text.replace(find, replace)]]);
  }

  it("fails when a document plants a job that is scheduled nowhere", () => {
    // A phantom invented for this test, in a scratch copy of the corpus — not
    // the row the reachability sweep is having wired this round, deliberately:
    // this proof must go on working after that line becomes true.
    const planted = scratch(
      "docs/specs/api-surface.md",
      "| `publish-diagnosis` |",
      "| `refresh-imaginary-cache` | `7 2 * * *` | — | nothing at all |\n| `publish-diagnosis` |",
    );
    const verdicts = auditSchedules(claimedSchedules(planted), REAL);
    const caught = verdicts.filter(
      (one) => one.claim.job === "refresh-imaginary-cache" && one.status === "phantom",
    );
    expect(caught.length).toBe(1);
    expect(caught[0]?.detail).toContain("`7 2 * * *`");
    expect(caught[0]?.detail).toContain("refresh-imaginary-cache");
  });

  it("fails when a real job's schedule is deleted and its document stands", () => {
    // The other direction, and the likelier one: the row is right when it is
    // written and the job is removed underneath it. `forecaster.md` states the
    // retrain's cron in prose; delete the schedule from the swept tree and the
    // sentence becomes a phantom the same day.
    const retrainGone = REAL.filter((one) => one.cron !== "10 3 * * 5");
    expect(REAL.length - retrainGone.length).toBeGreaterThan(0);
    const verdicts = auditSchedules(CLAIMS, retrainGone);
    const caught = verdicts.filter(
      (one) => one.claim.cron === "10 3 * * 5" && one.status === "phantom",
    );
    expect(caught.length).toBeGreaterThan(0);
    expect(caught[0]?.detail).toContain("nothing in this repository fires at");
  });

  it("fails when a job is renamed in the tree and not in the document", () => {
    // Identity drift, with the pattern left alone: the cron still fires, so a
    // pattern-only guard would pass. The name half is what catches it.
    const renamed = REAL.map((one) =>
      one.id === "publish-forecast:gate_late"
        ? { ...one, id: "publish-forecast:gate_evening" }
        : one,
    );
    expect(renamed.some((one) => one.id === "publish-forecast:gate_evening")).toBe(true);
    const verdicts = auditSchedules(CLAIMS, renamed);
    expect(
      verdicts.filter(
        (one) =>
          one.claim.job === "publish-forecast:gate_late" && one.status === "phantom",
      ).length,
    ).toBe(1);
  });

  it("fails when a task kind the document names is dropped from the union", () => {
    // `publish-diagnosis` has no cron and never will. Its name is still a
    // claim, and dropping the kind must break the row that names it.
    const noDiagnosis = REAL.filter((one) => one.id !== "publish_diagnosis");
    expect(REAL.length - noDiagnosis.length).toBeGreaterThan(0);
    const verdicts = auditSchedules(CLAIMS, noDiagnosis);
    expect(
      verdicts.filter(
        (one) => one.claim.job === "publish-diagnosis" && one.status === "phantom",
      ).length,
    ).toBe(1);
  });
});

describe("the guard is not vacuous: an empty input throws rather than passing", () => {
  // The failure this repository has shipped four times, in four shapes, each of
  // which passed its own suite. Every way this comparison can be starved is
  // asserted to be a *throw*, not an empty violation list.

  it("an empty document corpus throws", () => {
    const empty = new Map<string, string>();
    expect(claimedSchedules(empty)).toEqual([]);
    // And this is the assertion that fires, rather than `[] === []` passing.
    expect(() => auditSchedules(claimedSchedules(empty), REAL)).toThrow(
      /claimed side is empty/,
    );
  });

  it("a real side that found nothing throws", () => {
    expect(() => auditSchedules(CLAIMS, [])).toThrow(/appears to schedule nothing/);
  });

  it("a real side with identities but no patterns throws", () => {
    // The subtler shape: the task-kind reader still works, the cron readers all
    // broke. Every cron claim would silently have no pattern to match and the
    // suite would go green on a corpus of phantoms.
    const namesOnly = REAL.map((one) => ({ ...one, cron: null }));
    expect(namesOnly.length).toBeGreaterThan(0);
    expect(() => auditSchedules(CLAIMS, namesOnly)).toThrow(/no real cron pattern/);
  });

  it("a real side with patterns but no identities throws", () => {
    const cronsOnly = REAL.map((one) => ({ ...one, id: null }));
    expect(() => auditSchedules(CLAIMS, cronsOnly)).toThrow(/no real job identity/);
  });

  it("a source walk that returned nothing throws rather than reading green", () => {
    // The whole chain, starved at the root: no sources means no schedules means
    // no comparison. The polarity matters — a blind walk must report the
    // repository as scheduling nothing, never the documents as fine.
    expect(realSchedules([])).not.toEqual([]);
    // (`realSchedules([])` still finds the workflows, which is itself the
    // point: the mechanisms are independent and one going blind does not take
    // the others with it.)
    expect(() =>
      auditSchedules(CLAIMS, bullmqSchedules([]).concat(taskKinds([]))),
    ).toThrow();
  });

  it("a cron reader that stopped matching is a failure, not a pass", () => {
    const blind = claimedSchedules(DOCS).filter((claim) => claim.cron === null);
    expect(blind.every((claim) => claim.cron === null)).toBe(true);
    expect(() => {
      expect(blind.some((claim) => claim.cron !== null)).toBe(true);
    }).toThrow();
  });
});

describe("the readers match what they should and nothing else", () => {
  it("reads a cron and refuses a list of numbers that looks like one", () => {
    expect(isCron("30 3 * * *")).toBe(true);
    expect(isCron("*/5 * * * *")).toBe(true);
    expect(isCron("45 14,21 * * 1-5")).toBe(true);
    expect(isCron("0 7 * * * *")).toBe(true);
    // The false positives this corpus is full of, and the reason the `*` is
    // required: ticket lists, seam lists, hour lists and fixture vectors.
    expect(isCron("seams 1, 3, 5, 6, 8")).toBe(false);
    expect(isCron("10, 11, 12, 13, 16")).toBe(false);
    expect(isCron("0 20 70 110 90")).toBe(false);
    expect(isCron("10 3 * * 5 extra")).toBe(false);
  });

  it("discovers a job table anywhere, including one that does not exist yet", () => {
    // No document is named and no table is located by heading: a spec that
    // grows a job table next month is swept on its first commit.
    const invented = new Map([
      [
        "docs/specs/invented.md",
        [
          "# A spec nobody has written",
          "",
          "| Job | Cron | Writes |",
          "|---|---|---|",
          "| `sweep-the-floor` | `0 2 * * *` | dust |",
          "| `wipe-the-bench` | when the floor sweep finishes | crumbs |",
          "",
          "Unrelated prose with a `10 3 * * 5` in it.",
        ].join("\n"),
      ],
    ]);
    const claims = claimedSchedules(invented);
    expect(claims.map((claim) => claim.job)).toEqual([
      "sweep-the-floor",
      "wipe-the-bench",
      null,
    ]);
    expect(claims[1]?.trigger).toBe("when the floor sweep finishes");
    const verdicts = auditSchedules(claims, REAL);
    // Two invented jobs and one real cron: the sweep row is a phantom on both
    // halves, the bench row is a phantom on its name alone (its trigger is
    // prose and is not evaluated), and the stray `10 3 * * 5` in the sentence
    // is the retrain's own pattern, so it is real with no name to check.
    expect(verdicts.map((one) => one.status)).toEqual(["phantom", "phantom", "real"]);
    expect(verdicts[1]?.check).toBe("name");
  });

  it("reads a withdrawn cron as a quotation, and only in the sentence that withdraws it", () => {
    // These documents correct themselves by quoting the wrong thing back, and
    // the correction note for this very defect will print `30 3 * * *` beside
    // the words "this table said". That sentence is not a claim. The sentence
    // *next to* it still is — paragraph scope was 27's bug and 29 found it.
    const note = new Map([
      [
        "docs/specs/correction.md",
        [
          "**A schedule that was never kept.** This table said `30 3 * * *` and",
          "nothing ever fired at it. The job now runs at `9 9 * * *` instead.",
          "",
          "A separate paragraph states `8 8 * * *` with no marker at all.",
        ].join("\n"),
      ],
    ]);
    const claims = claimedSchedules(note);
    expect(claims.map((claim) => claim.cron)).toEqual(["9 9 * * *", "8 8 * * *"]);
  });

  it("ignores a table that is not a job table", () => {
    // The corpus is full of tables whose first cell is a backticked name — the
    // error code table, the column dictionary, the endpoint list. A table
    // becomes a job table only because one of its rows states a cron.
    const codes = new Map([
      [
        "docs/specs/codes.md",
        "| Code | Status |\n|---|---|\n| `NOT_FOUND` | `404` |\n| `GONE` | `410` |\n",
      ],
    ]);
    expect(claimedSchedules(codes)).toEqual([]);
  });

  it("reads a railway cron at any depth, and a compose one, on synthetic input", () => {
    // Both readers govern documents that schedule nothing today, so they are
    // asserted here rather than against a count that would be asserting the
    // deployment has a cron it does not have.
    const parsed = { deploy: { healthcheckPath: "/health" }, cron: "15 4 * * *" };
    expect(schedulesInJson(parsed, "railway.json").map((one) => one.cron)).toEqual([
      "15 4 * * *",
    ]);
    expect(
      schedulesInJson(
        { services: [{ name: "x", cronSchedule: "0 * * * *" }] },
        "r.json",
      )[0]?.cron,
    ).toBe("0 * * * *");
    expect(schedulesInJson({ deploy: { healthcheckTimeout: 120 } }, "r.json")).toEqual(
      [],
    );
  });

  it("reads a workflow's schedule block and not its prose", () => {
    const workflows = workflowSchedules();
    expect(workflows.length).toBeGreaterThan(4);
    expect(workflows.every((one) => one.cron !== null && isCron(one.cron))).toBe(true);
    // Every one of these files discusses its own crons in a comment header; a
    // reader that swept the whole file would double-count them and would also
    // pick up the ones the prose says it *rejected*.
    expect(workflows.every((one) => /\.github\/workflows\//.test(one.where))).toBe(true);
  });
});

describe("phantom schedules · a family id resolves to its family", () => {
  it("resolves a constant inside an id template instead of blanking it", () => {
    // `refresh-featured-days:${subsystem}:${lane}` was rendered `*:*:*` when
    // every interpolation became a star. That failed two ways at once: the
    // bare name the spec table gives the job could not answer to it, and it
    // would have answered to almost any other three-segment id. Resolving the
    // constant is therefore a tightening, and this asserts both halves.
    const consts = new Map([["PREFIX", "refresh-featured-days"]]);
    expect(resolveToken("`${PREFIX}:${payload.subsystem}:${payload.lane}`", consts)).toBe(
      "refresh-featured-days:*:*",
    );
    // Genuinely variable interpolations still blank, so nothing is invented.
    expect(resolveToken("`${a.b}:${c}`", new Map())).toBe("*:*");
  });

  it("still refuses to let one family absolve a different job", () => {
    // The bug api-surface 31 found in its own first run, which must stay
    // fixed: `refresh:${tier}` is a different family from
    // `refresh-featured-days`, and the colon is what says so.
    expect(identityOf("refresh-featured-days", ["refresh:*"])).toBeNull();
    // And the real relationship is accepted, because the boundary is a colon.
    expect(identityOf("refresh-featured-days", ["refresh-featured-days:*:*"])).toBe(
      "refresh-featured-days:*:*",
    );
    // A bare name never swallows an unrelated longer one.
    expect(identityOf("refresh", ["refresh-featured-days:*:*"])).toBeNull();
  });
});
