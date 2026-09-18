import { describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The migration ledger: the directory, the journal and the snapshots, checked
 * against each other.
 *
 * ### What happened, twice, on 2026-09-10
 *
 * Data-platform 22 and 23 were cut from the same tip. Both ran `drizzle-kit
 * generate`, both were handed `0046`, and neither could see the other:
 * `0046_a_parse_that_landed.sql` (four columns on `ons_resource_version`) and
 * `0046_the_plant_grain_is_a_source.sql` (two members on `ingestion_source`).
 * Different tables, neither wrong. Git saw no conflict in `drizzle/` at all —
 * two new files with different names — and surfaced it only as an add/add
 * conflict on `meta/0046_snapshot.json`, at merge time, hours later. The repair
 * was manual: keep one, delete the other, regenerate against the merged schema
 * as `0047`, diff the DDL to prove nothing was lost, and hand-repair
 * `meta/_journal.json`.
 *
 * Then the renumber broke a reference. `docs/specs/data-platform.md` named
 * `drizzle/0046_a_parse_that_landed.sql`, a file that no longer existed;
 * api-surface 27's path guard caught that one, because its corpus is
 * `docs/specs/`. `.scratch/data-platform/issues/22-…md` carried the same stale
 * name in its own `Status:` line and **nothing caught it** — it was found by
 * grepping afterwards.
 *
 * Every part of that is mechanical, and every part of it recurs the next time
 * two branches are cut from one tip. This file is the guard.
 *
 * ### The one design rule, inherited from api-surface 27
 *
 * **Nothing here holds a list somebody has to keep in step, and nothing here
 * restates a number the tree already carries.** There is no roster of
 * migrations, no "the head is 0047", no expected journal length. The set of
 * migrations is discovered by shape — `NNNN_name.sql` in `apps/api/drizzle/` —
 * and every expectation is derived from one half of the ledger and asserted
 * against another half. The directory is checked against the journal, the
 * journal against the snapshots, and the numbering against itself. A guard
 * that needed editing when `0048` lands is the failure it exists to end.
 *
 * That is also why the checks are pure functions over a `Ledger` value rather
 * than over the filesystem: the proofs at the bottom of this file plant the
 * exact 2026-09-10 collision and watch each check go red, and they can do that
 * without ever writing into `apps/api/drizzle/`, which `apps/api/README.md`
 * forbids touching for any reason — the landed migrations are the record of
 * what was run against a real database.
 *
 * ### Where the ceiling is
 *
 * This checks the *bookkeeping*, not the DDL. Two migrations that contradict
 * each other semantically, a snapshot that is stale rather than absent, a
 * migration whose SQL was never applied anywhere — none of that is visible
 * from here. `test/drizzle-snapshot.test.ts` in `apps/api` covers head-snapshot
 * drift by regenerating; this covers the shape of the ledger around it.
 *
 * A parse that silently matches nothing is the failure mode this repository has
 * shipped four times, so the first `describe` asserts every input is non-empty
 * before anything is asserted clean, and the last two assert each check can go
 * red — by mutation and by starvation.
 */

const ROOT = join(import.meta.dir, "..");
const MIGRATION_DIR = join(ROOT, "apps", "api", "drizzle");

// --- the ledger, read by shape -----------------------------------------------

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface Ledger {
  /** `0046_the_plant_grain_is_a_source.sql`, sorted. Discovered, never listed. */
  files: string[];
  /** `0046_snapshot.json`, sorted. */
  snapshots: string[];
  /** `meta/_journal.json`'s entries, in the order the file states them. */
  journal: JournalEntry[];
}

/** `0046_the_plant_grain_is_a_source(.sql)` → `{ number: 46, tag: "0046_…" }`. */
const TAG = /^(\d{4})_([a-z][a-z0-9_]*)$/;

export function parseTag(name: string): { number: number; tag: string } | null {
  const tag = name.endsWith(".sql") ? name.slice(0, -4) : name;
  const match = TAG.exec(tag);
  return match ? { number: Number(match[1]), tag } : null;
}

/**
 * The three halves of the ledger, read from a migration directory.
 *
 * Tolerant of every absence on purpose: a missing `meta/`, a missing journal
 * and an empty directory all read as empty rather than throwing, so that
 * "pointed at nothing" is a state the assertions below can *see* and reject,
 * instead of an exception that a `try` somewhere could turn into a pass.
 */
export function readLedger(dir: string): Ledger {
  const entries = (path: string): string[] => {
    try {
      return readdirSync(path).sort();
    } catch {
      return [];
    }
  };
  const meta = join(dir, "meta");
  let journal: JournalEntry[] = [];
  try {
    const parsed = JSON.parse(readFileSync(join(meta, "_journal.json"), "utf8")) as {
      entries?: JournalEntry[];
    };
    journal = parsed.entries ?? [];
  } catch {
    journal = [];
  }
  return {
    files: entries(dir).filter((file) => file.endsWith(".sql")),
    snapshots: entries(meta).filter((file) => file.endsWith("_snapshot.json")),
    journal,
  };
}

// --- check 1: two migrations sharing a number --------------------------------

/**
 * The collision itself, in the tree.
 *
 * Derived by grouping the discovered filenames on their own numeric prefix —
 * there is nothing to keep in step, and the check is identical for `0046` and
 * for a number that does not exist yet. This is the one that would have fired
 * on 2026-09-10 the moment the two branches met, in `drizzle/` rather than in
 * an add/add conflict on a snapshot.
 */
export function duplicateNumbers(ledger: Ledger): string[] {
  const byNumber = new Map<number, string[]>();
  for (const file of ledger.files) {
    const parsed = parseTag(file);
    if (parsed === null) {
      continue;
    }
    byNumber.set(parsed.number, [...(byNumber.get(parsed.number) ?? []), file]);
  }
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([number, files]) => `${String(number).padStart(4, "0")}: ${files.join(", ")}`);
}

// --- check 2: the numbering sequence -----------------------------------------

/**
 * Gaps and non-migration files in the sequence.
 *
 * The expected sequence is derived from the count of migrations found: `n`
 * migrations occupy `0000`…`n-1`. Nothing states the head. A deleted migration
 * (a gap) and a file that does not parse as a migration at all are both
 * reported here; duplicates are reported by `duplicateNumbers`, which is why
 * this compares the *set* of numbers and says nothing about multiplicity.
 */
export function sequenceBreaks(ledger: Ledger): string[] {
  const numbers = new Set<number>();
  const problems: string[] = [];
  for (const file of ledger.files) {
    const parsed = parseTag(file);
    if (parsed === null) {
      problems.push(`not a migration filename: ${file}`);
      continue;
    }
    numbers.add(parsed.number);
  }
  const highest = Math.max(-1, ...numbers);
  for (let n = 0; n <= highest; n += 1) {
    if (!numbers.has(n)) {
      problems.push(`gap at ${String(n).padStart(4, "0")}`);
    }
  }
  return problems;
}

// --- check 3: the journal against the directory ------------------------------

/**
 * Every way `meta/_journal.json` can disagree with the directory beside it.
 *
 * This is the check written for the hand-repair: resolving a journal by hand is
 * exactly the edit that silently goes wrong, and a wrong journal is not inert —
 * `drizzle-kit migrate` walks *it*, not the directory, so an entry dropped
 * during a merge means a migration that never runs and never complains.
 *
 * Four disagreements, each derived from the other half:
 *
 *  - an entry whose `tag` has no `.sql` file;
 *  - a `.sql` file with no entry;
 *  - `idx` that is not the entry's own position, or not its tag's own number —
 *    drizzle assigns both from the same counter, so they are two statements of
 *    one fact and either can rot alone;
 *  - entries out of order, by `idx` or by `when`. Applied history is a
 *    sequence; a journal that states it out of order states it wrongly.
 */
export function journalDisagreements(ledger: Ledger): string[] {
  const problems: string[] = [];
  const fileTags = new Set(
    ledger.files
      .map((file) => parseTag(file)?.tag)
      .filter((tag): tag is string => Boolean(tag)),
  );
  const journalTags = new Set(ledger.journal.map((entry) => entry.tag));

  for (const entry of ledger.journal) {
    if (!fileTags.has(entry.tag)) {
      problems.push(`journal names ${entry.tag}, which has no .sql file`);
    }
  }
  for (const tag of [...fileTags].sort()) {
    if (!journalTags.has(tag)) {
      problems.push(`${tag}.sql has no journal entry`);
    }
  }

  let previousWhen = Number.NEGATIVE_INFINITY;
  ledger.journal.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push(`${entry.tag} is at position ${position} with idx ${entry.idx}`);
    }
    const parsed = parseTag(entry.tag);
    if (parsed !== null && parsed.number !== entry.idx) {
      problems.push(`${entry.tag} is numbered ${parsed.number} with idx ${entry.idx}`);
    }
    if (entry.when < previousWhen) {
      problems.push(`${entry.tag} is stamped before the entry above it`);
    }
    previousWhen = entry.when;
  });
  return problems;
}

// --- check 4: the snapshots --------------------------------------------------

/**
 * A snapshot missing for a migration, or orphaned by one.
 *
 * The snapshot chain is what `db:generate` diffs against, so a missing snapshot
 * makes the next migration wrong and an orphaned one is the residue of a
 * deletion somebody did not finish — which is precisely what the 2026-09-10
 * repair had to do by hand, on the file git had actually conflicted on.
 *
 * Derived from the migration numbers found in the directory, in both
 * directions, so neither half can be the authority for itself.
 */
export function snapshotDisagreements(ledger: Ledger): string[] {
  const problems: string[] = [];
  const migrationNumbers = new Set(
    ledger.files
      .map((file) => parseTag(file)?.number)
      .filter((number): number is number => number !== undefined),
  );
  const snapshotNumbers = new Map<number, string>();
  for (const snapshot of ledger.snapshots) {
    const match = /^(\d{4})_snapshot\.json$/.exec(snapshot);
    if (match === null) {
      problems.push(`not a snapshot filename: ${snapshot}`);
      continue;
    }
    snapshotNumbers.set(Number(match[1]), snapshot);
  }
  for (const number of [...migrationNumbers].sort((a, b) => a - b)) {
    if (!snapshotNumbers.has(number)) {
      problems.push(`no snapshot for migration ${String(number).padStart(4, "0")}`);
    }
  }
  for (const [number, snapshot] of [...snapshotNumbers.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    if (!migrationNumbers.has(number)) {
      problems.push(`orphaned snapshot ${snapshot}`);
    }
  }
  return problems;
}

// --- check 5: a named migration that does not exist --------------------------

/**
 * Every `*.md` in the working tree, as a repo-relative POSIX path.
 *
 * The whole tree and not `docs/specs/`, which is the extension argued for in
 * the ticket: the stale `0046_a_parse_that_landed.sql` that nothing caught was
 * in `.scratch/data-platform/issues/`, and the specs' guard could not see it.
 * The working tree rather than `git ls-files`, for the reason api-surface 27
 * gives: a worktree's index does not always carry what is plainly on disk.
 */
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

export function markdownTexts(root: string = ROOT): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(join(dir, entry.name), rel);
        }
        continue;
      }
      if (entry.name.endsWith(".md")) {
        found.set(rel, readFileSync(join(dir, entry.name), "utf8"));
      }
    }
  };
  walk(root, "");
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Words that mark a paragraph as talking about a migration this tree does not
 * hold — and is right not to hold.
 *
 * A closed vocabulary of **English**, not a list of files, for the same reason
 * api-surface 27's `ABSENCE_MARKERS` is: it needs no maintenance when a
 * document changes, and a name that rotted in ordinary present-tense prose is
 * still caught. The first eight are 27's own, for a migration that was renamed
 * or superseded. `emitted`, `throwaway` and `scratch` are added here and earn
 * their place on one real case: api-surface 28 names
 * `0043_crazy_typhoid_mary.sql`, which `drizzle-snapshot.test.ts` generates
 * into a throwaway copy of `drizzle/` and never commits. That is a true
 * sentence about a file that correctly does not exist, and the alternative to a
 * marker was a hardcoded exception — the thing this guard refuses to be.
 *
 * The cost, stated rather than hidden: a paragraph that uses one of these words
 * **and** carries a rotted name gets a free pass. Which is why the census below
 * is asserted separately, and why the excused set is asserted to be a small
 * minority of the references rather than assumed to be.
 */
const ABSENCE_MARKERS = [
  "deleted",
  "removed",
  "retired",
  "replaced",
  "renamed",
  "no longer",
  "does not exist",
  "never existed",
  "emitted",
  "throwaway",
  "scratch copy",
  // The prospective case, and it is the opposite of rot. `docs/rag/` plans a
  // service that does not exist yet and draws its directory tree, including the
  // `migrations/` it would own — a different service's ledger, not this one's.
  // A name that has not been created is as true a sentence as a name that was
  // deleted, and the guard cannot tell them apart from the tag alone.
  //
  // Spelt in both languages because the plans are written in both, and a marker
  // that only matched English would excuse a plan in English while failing the
  // same plan in Portuguese.
  "plano",
  "planned",
  "proposto",
  "proposed",
];

export interface MigrationReference {
  file: string;
  line: number;
  tag: string;
  /** Whether a migration of exactly that tag is in the tree. */
  resolves: boolean;
  /** Whether the surrounding paragraph marks it as absent on purpose. */
  marked: boolean;
  /**
   * The migration that holds the number this reference claims, when one does
   * and it is a different migration. The renumber defect's exact signature.
   */
  numberHeldBy?: string;
}

/** `0046_a_parse_that_landed`, in prose or in a path, with or without `.sql`. */
const REFERENCE = /(\d{4})_([a-z][a-z0-9_]*)/g;

/**
 * Every migration a document names, with whether the tree holds it.
 *
 * Shape-matched rather than path-matched, deliberately: the reference that
 * nothing caught was `drizzle/0046_a_parse_that_landed.sql` in a ticket, but
 * the same name appears bare in prose, as `0016_the_feature_gate`, and both are
 * the same checkable claim. The `NNNN_lowercase_words` shape is specific enough
 * that dates (`2026_08_29`) and years do not match it — the second component
 * must begin with a letter.
 */
export function migrationReferences(
  texts: Map<string, string>,
  ledger: Ledger,
): MigrationReference[] {
  const tags = new Set(
    ledger.files
      .map((file) => parseTag(file)?.tag)
      .filter((tag): tag is string => Boolean(tag)),
  );
  const byNumber = new Map<number, string>();
  for (const file of ledger.files) {
    const parsed = parseTag(file);
    if (parsed !== null) {
      byNumber.set(parsed.number, parsed.tag);
    }
  }
  const found: MigrationReference[] = [];
  for (const [file, text] of texts) {
    let offset = 0;
    for (const paragraph of text.split(/\n\s*\n/)) {
      const lower = paragraph.toLowerCase();
      // The document's own name counts, not only the paragraph's prose. A plan
      // draws its proposed directory tree inside a code fence, and a fence is
      // its own paragraph with no prose in it at all — so `plano-rag-v0.2.md`
      // named a migration it proposes and was read as rot. A file that says in
      // its name what it is has said it for every paragraph in it.
      const context = `${lower} ${file.toLowerCase()}`;
      const marked = ABSENCE_MARKERS.some((marker) => context.includes(marker));
      for (const match of paragraph.matchAll(REFERENCE)) {
        const tag = `${match[1]}_${match[2]}`;
        // `meta/0046_snapshot.json` has the migration shape and is not a
        // migration. Snapshots are checked against the directory by
        // `snapshotDisagreements`, from the files rather than from prose.
        if (match[2] === "snapshot") {
          continue;
        }
        const holder = byNumber.get(Number(match[1]));
        found.push({
          file,
          line: text.slice(0, offset + (match.index ?? 0)).split("\n").length,
          tag,
          resolves: tags.has(tag),
          marked,
          ...(holder !== undefined && holder !== tag ? { numberHeldBy: holder } : {}),
        });
      }
      offset += paragraph.length + 2;
    }
  }
  return found;
}

/** A reference is a violation when nothing answers to it and nothing excuses it. */
export function rottedReferences(references: MigrationReference[]): MigrationReference[] {
  return references.filter((reference) => !(reference.resolves || reference.marked));
}

// --- the tree's own ledger ---------------------------------------------------

const LEDGER = readLedger(MIGRATION_DIR);
const TEXTS = markdownTexts();
const REFERENCES = migrationReferences(TEXTS, LEDGER);

/** A scratch copy of the real ledger, for mutations. `drizzle/` is never written. */
function copyOfLedgerDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "migration-ledger-")), "drizzle");
  cpSync(MIGRATION_DIR, dir, { recursive: true });
  return dir;
}

// --- part 1: the inputs are not empty ----------------------------------------

describe("nothing below is asserted over an empty ledger", () => {
  // This repository has shipped four guards that read green while governing
  // nothing. Every check in this file reports violations as a list, and an
  // empty list is what "clean" looks like — so "there was something to check"
  // is a separate assertion, and it comes first.

  it("discovered the migrations, by shape and not by list", () => {
    expect(LEDGER.files.length).toBeGreaterThan(40);
    expect(LEDGER.files.every((file) => parseTag(file) !== null)).toBe(true);
    // The head is derived here too: whatever the highest number is, a file
    // holds it. Nothing in this file states what it is.
    const numbers = LEDGER.files.map(
      (file) => (parseTag(file) as { number: number }).number,
    );
    expect(Math.max(...numbers)).toBe(LEDGER.files.length - 1);
  });

  it("read the journal, with an entry per migration", () => {
    expect(LEDGER.journal.length).toBe(LEDGER.files.length);
    expect(LEDGER.journal.every((entry) => typeof entry.when === "number")).toBe(true);
  });

  it("read the snapshot chain", () => {
    expect(LEDGER.snapshots.length).toBe(LEDGER.files.length);
  });

  it("walked the whole tree for markdown, not just docs/specs", () => {
    // The corpus extension is the point of check 5, so its reach is asserted
    // rather than assumed: the guard that missed the stale name had a corpus
    // of `docs/specs/`, and a walk that quietly stopped there again would
    // report the rest clean by never reading it.
    //
    // The `.scratch/` half of that assertion is gone with the directory. What
    // it was buying — that the walk does not stop at `docs/specs/` — is bought
    // by the README line below, which is outside `docs/` and still asserted.
    expect(TEXTS.size).toBeGreaterThan(20);
    expect([...TEXTS.keys()].some((file) => file.startsWith("docs/specs/"))).toBe(true);
    expect(TEXTS.has("apps/api/README.md")).toBe(true);
  });

  it("found migration names in that markdown, across several documents", () => {
    expect(REFERENCES.length).toBeGreaterThan(20);
    expect(new Set(REFERENCES.map((reference) => reference.file)).size).toBeGreaterThan(
      5,
    );
    // The corpus actually carries references outside one directory. The
    // `.scratch/` half of this pair went with that directory; the spread
    // assertion above — more than five distinct files — is what now stops the
    // census being a claim about a single document.
    expect(REFERENCES.some((reference) => reference.file.startsWith("docs/specs/"))).toBe(
      true,
    );
  });
});

// --- part 2: the ledger agrees with itself -----------------------------------

describe("the migration ledger agrees with itself", () => {
  it("no two migrations share a number", () => {
    expect(duplicateNumbers(LEDGER)).toEqual([]);
  });

  it("the numbering has no gaps", () => {
    expect(sequenceBreaks(LEDGER)).toEqual([]);
  });

  it("the journal states the directory, in order", () => {
    expect(journalDisagreements(LEDGER)).toEqual([]);
  });

  it("every migration has its snapshot, and no snapshot is orphaned", () => {
    expect(snapshotDisagreements(LEDGER)).toEqual([]);
  });
});

describe("every migration a document names is a migration that exists", () => {
  it("no markdown in the tree names a migration that is gone", () => {
    expect(
      rottedReferences(REFERENCES).map(
        (reference) => `${reference.file}:${reference.line} → ${reference.tag}`,
      ),
    ).toEqual([]);
  });

  it("the excuse is the exception and not the rule", () => {
    // The marker vocabulary is the weak half of this check, so its reach is
    // measured: if most references were being excused, the check would be
    // decorative and this assertion is what would say so.
    const excused = REFERENCES.filter(
      (reference) => !reference.resolves && reference.marked,
    );
    const resolved = REFERENCES.filter((reference) => reference.resolves);
    expect(resolved.length).toBeGreaterThan(excused.length * 4);
  });
});

// --- part 3: the guard can fail, by mutation ---------------------------------

describe("the guard is not vacuous: it goes red when the ledger drifts", () => {
  // Each mutation is planted in a scratch copy of `drizzle/`, never in the
  // real one — `apps/api/README.md` forbids editing a landed migration for any
  // reason, and a guard that violated the rule it guards would deserve to be
  // deleted.

  it("catches the collision of 2026-09-10, replayed", () => {
    const dir = copyOfLedgerDir();
    // The exact file data-platform 22 generated, beside the one 23 generated.
    writeFileSync(join(dir, "0046_a_parse_that_landed.sql"), "-- planted\n");
    const duplicates = duplicateNumbers(readLedger(dir));
    expect(duplicates.length).toBe(1);
    expect(duplicates[0]).toContain("0046_a_parse_that_landed.sql");
    expect(duplicates[0]).toContain("0046_the_plant_grain_is_a_source.sql");
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("catches a migration deleted out of the middle of the sequence", () => {
    const dir = copyOfLedgerDir();
    const victim = readLedger(dir).files[20] as string;
    rmSync(join(dir, victim));
    expect(sequenceBreaks(readLedger(dir))).toEqual(["gap at 0020"]);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("catches a journal entry dropped by a hand-repair", () => {
    const dir = copyOfLedgerDir();
    const journal = JSON.parse(
      readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries: JournalEntry[] };
    const dropped = journal.entries.splice(30, 1)[0] as JournalEntry;
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
    const problems = journalDisagreements(readLedger(dir));
    expect(problems).toContain(`${dropped.tag}.sql has no journal entry`);
    // And the renumbering it causes is caught too: every entry after the hole
    // now sits one position earlier than its own idx.
    expect(
      problems.filter((one) => one.includes("is at position")).length,
    ).toBeGreaterThan(10);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("catches a journal whose tag was retyped, in both directions", () => {
    const dir = copyOfLedgerDir();
    const journal = JSON.parse(
      readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries: JournalEntry[] };
    const entry = journal.entries.at(-1) as JournalEntry;
    const original = entry.tag;
    entry.tag = `${original.slice(0, 4)}_a_parse_that_did_not_land`;
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
    expect(journalDisagreements(readLedger(dir))).toEqual([
      `journal names ${entry.tag}, which has no .sql file`,
      `${original}.sql has no journal entry`,
    ]);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("catches a journal reordered, and a timestamp that runs backwards", () => {
    const dir = copyOfLedgerDir();
    const journal = JSON.parse(
      readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries: JournalEntry[] };
    const last = journal.entries.at(-1) as JournalEntry;
    const previous = journal.entries.at(-2) as JournalEntry;
    journal.entries.splice(journal.entries.length - 2, 2, last, previous);
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
    const problems = journalDisagreements(readLedger(dir));
    expect(problems).toContain(
      `${last.tag} is at position ${last.idx - 1} with idx ${last.idx}`,
    );
    expect(problems).toContain(`${previous.tag} is stamped before the entry above it`);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("catches a snapshot missing, and a snapshot left behind", () => {
    const dir = copyOfLedgerDir();
    const head = readLedger(dir).files.at(-1) as string;
    const number = (parseTag(head) as { number: number }).number;
    rmSync(join(dir, "meta", `${String(number).padStart(4, "0")}_snapshot.json`));
    // The other half of the same mistake: the snapshot for a migration that
    // was deleted in the merge, left where the repair did not look.
    writeFileSync(join(dir, "meta", "9999_snapshot.json"), "{}");
    expect(snapshotDisagreements(readLedger(dir))).toEqual([
      `no snapshot for migration ${String(number).padStart(4, "0")}`,
      "orphaned snapshot 9999_snapshot.json",
    ]);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("catches the reference the renumber broke, in a ticket and not a spec", () => {
    // Verbatim the line that nothing caught: the `Status:` line of
    // `.scratch/data-platform/issues/22-…md` after `0046_a_parse_that_landed`
    // had been regenerated as `0047`.
    const drifted = new Map([
      [
        ".scratch/data-platform/issues/22-a-thrown-parse-is-never-retried.md",
        "**Status:** done — `drizzle/0046_a_parse_that_landed.sql`,\n`test/database-resource-settlement.test.ts`\n",
      ],
    ]);
    const rotted = rottedReferences(migrationReferences(drifted, LEDGER));
    expect(rotted.length).toBe(1);
    expect(rotted[0]?.tag).toBe("0046_a_parse_that_landed");
    // And it is identified as the renumber's signature, not merely as unknown:
    // the number exists, held by a different migration.
    expect(rotted[0]?.numberHeldBy).toBe("0046_the_plant_grain_is_a_source");
  });

  it("does not excuse a rotted name merely because it is in a ticket", () => {
    const drifted = new Map([
      ["x.md", "we changed `0046_the_plant_grain_is_a_sink.sql` today"],
    ]);
    expect(rottedReferences(migrationReferences(drifted, LEDGER)).length).toBe(1);
    // …and the marker vocabulary does excuse the sentence that says it is gone,
    // which is the whole of the exemption and is asserted rather than trusted.
    const excused = new Map([
      ["x.md", "`0046_the_plant_grain_is_a_sink.sql` was renamed"],
    ]);
    expect(rottedReferences(migrationReferences(excused, LEDGER))).toEqual([]);
  });

  it("does not mistake a snapshot for a migration", () => {
    // `meta/0046_snapshot.json` is named all over this repository's prose and
    // wears the migration shape. Treating it as one would have made the
    // reference check red on documents that are entirely correct.
    const snapshots = new Map([
      ["x.md", "the add/add conflict was on `meta/0046_snapshot.json`"],
    ]);
    expect(migrationReferences(snapshots, LEDGER)).toEqual([]);
  });

  it("does not mistake a date for a migration", () => {
    // `2026_08_29` and friends are all over the research notes. If the shape
    // matched them, this guard would be red for reasons that are not defects,
    // and somebody would delete it.
    const dates = new Map([["x.md", "the 2026_08_29 file, and 2025_05_23, and 2024_04"]]);
    expect(migrationReferences(dates, LEDGER)).toEqual([]);
  });
});

// --- part 4: the guard can fail, by starvation -------------------------------

describe("the guard is not vacuous: an empty input does not pass", () => {
  // The four-times defect, in its own shape for this file. Every check returns
  // `[]` for an empty ledger — which is exactly what "clean" looks like — so
  // the emptiness has to be caught by a *different* assertion, and these are
  // the proofs that it is.

  it("an empty directory reads as clean on every check, which is why part 1 exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "migration-ledger-empty-"));
    const ledger = readLedger(empty);
    expect(ledger).toEqual({ files: [], snapshots: [], journal: [] });
    // All four checks: green over nothing.
    expect(duplicateNumbers(ledger)).toEqual([]);
    expect(sequenceBreaks(ledger)).toEqual([]);
    expect(journalDisagreements(ledger)).toEqual([]);
    expect(snapshotDisagreements(ledger)).toEqual([]);
    // And the non-emptiness assertions, run against it, throw. This is the
    // assertion that would have caught the four shipped vacuous guards.
    expect(() => {
      expect(ledger.files.length).toBeGreaterThan(40);
    }).toThrow();
    expect(() => {
      expect(ledger.journal.length).toBe(ledger.files.length);
      expect(ledger.snapshots.length).toBe(ledger.files.length);
      expect(ledger.files.length).toBeGreaterThan(40);
    }).toThrow();
    rmSync(empty, { recursive: true, force: true });
  });

  it("a directory with a journal and no migrations is not clean, it is inconsistent", () => {
    // The polarity that matters: starving one half must report the other half
    // as broken, never as fine.
    const dir = copyOfLedgerDir();
    for (const file of readLedger(dir).files) {
      rmSync(join(dir, file));
    }
    const ledger = readLedger(dir);
    expect(ledger.files).toEqual([]);
    expect(journalDisagreements(ledger).length).toBe(LEDGER.journal.length);
    expect(snapshotDisagreements(ledger).length).toBe(LEDGER.snapshots.length);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("a missing journal is a disagreement, not an absence of opinion", () => {
    const dir = copyOfLedgerDir();
    rmSync(join(dir, "meta", "_journal.json"));
    const ledger = readLedger(dir);
    expect(ledger.journal).toEqual([]);
    expect(journalDisagreements(ledger).length).toBe(LEDGER.files.length);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("an empty markdown corpus finds nothing, and the census says so", () => {
    const empty = new Map<string, string>();
    expect(migrationReferences(empty, LEDGER)).toEqual([]);
    expect(rottedReferences(migrationReferences(empty, LEDGER))).toEqual([]);
    expect(() => {
      expect(empty.size).toBeGreaterThan(20);
    }).toThrow();
  });

  it("an empty ledger makes every named migration rotted, not resolved", () => {
    // The direction is the point. A reader that returned no migrations must
    // report the whole corpus as broken; reporting it clean is the parity-README
    // defect, which read green.
    const blind = migrationReferences(TEXTS, { files: [], snapshots: [], journal: [] });
    expect(blind.length).toBe(REFERENCES.length);
    expect(blind.some((reference) => reference.resolves)).toBe(false);
    expect(rottedReferences(blind).length).toBeGreaterThan(20);
  });

  it("a tree walk that finds no markdown fails rather than passing", () => {
    const nowhere = mkdtempSync(join(tmpdir(), "migration-ledger-nomd-"));
    mkdirSync(join(nowhere, "docs"));
    writeFileSync(join(nowhere, "docs", "not-markdown.txt"), "`0099_nothing_here.sql`");
    const texts = markdownTexts(nowhere);
    expect(texts.size).toBe(0);
    expect(() => {
      expect(texts.size).toBeGreaterThan(20);
    }).toThrow();
    rmSync(nowhere, { recursive: true, force: true });
  });
});
