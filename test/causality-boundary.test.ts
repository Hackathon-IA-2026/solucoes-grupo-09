import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  CAUSALITY_ALLOWLIST,
  type CausalityAllowlistEntry,
} from "../apps/web/src/lib/copy/causality-allowlist";
import {
  CAUSALITY_BANNED_LEMMAS,
  type CausalityHit,
  findCausalityHits,
} from "../packages/core/src/causality";

/**
 * The §26 boundary, as a test rather than as a paragraph.
 *
 * The rule is written once, in `docs/domain-model.md` §10, and given its two
 * enforcers in `docs/specs/diagnosis.md`: WattSteer says the model **raised**
 * or **lowered** its forecast; it never says a condition **caused**
 * curtailment, and "Causal AI" appears nowhere, marketing copy included.
 *
 * A rule that lives only in a spec survives exactly as long as the next
 * session that reads it. This is the build-time half — a repo-level scan in the
 * shape of `repo-hygiene.test.ts`, which already demonstrates the pattern by
 * forbidding a token repo-wide. The other half is the lexical gate of the
 * narration output validator, which reads the same lexicon from
 * `@wattsteer/core` because a sentence generated per request is never seen by a
 * copy review at all.
 *
 * **Why the exceptions are a module and not a widened regex.** The instinct
 * when this check fires on a legitimate disclaimer is to soften the pattern
 * until it stops firing, at which point it means nothing. So the pattern is
 * fixed and the exceptions are enumerated, one per occurrence, each with its
 * location and its reason — and an entry whose string has since been edited or
 * deleted fails this test, so the list cannot rot into a set of permissions
 * nobody can account for.
 */

const ROOT = join(import.meta.dir, "..");

/**
 * What gets scanned: the surfaces a user can read.
 *
 * `apps/web/src` covers the app's source *and* both message catalogues, which
 * live at `apps/web/src/i18n/copy.{pt,en}.ts` and are asserted below to be
 * inside the scan. The narration system prompt does not exist yet (diagnosis
 * ticket 11 writes it), so it is scoped by name rather than by path: whatever
 * file under `apps/api/src` ends up carrying the prompt is scanned the day it
 * lands, without anyone having to remember to come back here.
 */
const SCOPE: { root: string; ext: string[]; nameMatches?: RegExp }[] = [
  { root: join("apps", "web", "src"), ext: [".ts", ".tsx"] },
  { root: join("packages", "ui", "src"), ext: [".ts", ".tsx"] },
  {
    root: join("apps", "api", "src"),
    ext: [".ts", ".md", ".txt"],
    nameMatches: /narration|prompt/i,
  },
];

/**
 * The one file that must contain the words in order to permit them.
 *
 * The allowlist quotes every string it allows, so scanning it would report
 * every exception as an offence. Exactly the self-exemption
 * `repo-hygiene.test.ts` takes for the same reason, and the only one: no
 * component, screen or catalogue is ever exempted as a file.
 */
const EXEMPT_FILES = new Set(["apps/web/src/lib/copy/causality-allowlist.ts"]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".expo"]);

/** POSIX-separated, repo-relative — the form an allowlist entry is written in. */
function repoPath(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join("/");
}

function walk(dir: string, ext: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        walk(full, ext, out);
      }
    } else if (ext.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

interface ScannedFile {
  path: string;
  text: string;
}

function collect(): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const { root, ext, nameMatches } of SCOPE) {
    for (const absolute of walk(join(ROOT, root), ext)) {
      const path = repoPath(absolute);
      if (EXEMPT_FILES.has(path)) {
        continue;
      }
      if (nameMatches && !nameMatches.test(path)) {
        continue;
      }
      files.push({ path, text: readFileSync(absolute, "utf8") });
    }
  }
  return files;
}

/** Every `[start, end)` a permitted string occupies in a file. */
function permittedRanges(
  text: string,
  entries: readonly CausalityAllowlistEntry[],
): [number, number][] {
  const ranges: [number, number][] = [];
  for (const entry of entries) {
    let from = text.indexOf(entry.string);
    while (from !== -1) {
      ranges.push([from, from + entry.string.length]);
      from = text.indexOf(entry.string, from + 1);
    }
  }
  return ranges;
}

function isPermitted(hit: CausalityHit, ranges: [number, number][]): boolean {
  const end = hit.index + hit.text.length;
  return ranges.some(([from, to]) => hit.index >= from && end <= to);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * The same text with its comments blanked, and its offsets intact.
 *
 * This check is titled "anywhere a user **can read**", and a comment is the
 * one place in these files a user cannot. Scanning them made the guard fire on
 * the three files that *document the rule* — `dominant-reason.ts`'s header
 * explaining that WattSteer predicts no cause, `plan-vs-actual-panel.tsx`
 * writing "because the grid was run towards that programme" about the
 * programme rather than about a curtailment, and the block comment above
 * `overview` in `copy.pt.ts` recording why question 5 is answered the way it
 * is. A boundary nobody may explain is a boundary the next session removes.
 *
 * Blanked rather than deleted: every character becomes a space and newlines
 * survive, so `hit.index` still points at the same offset and the allowlist's
 * ranges — computed over the untouched text — keep lining up.
 *
 * **Line comments first.** The reverse order is silently wrong: a `//` comment
 * containing `/*` opens a block the block-stripper runs to the next close,
 * deleting real code from the scan. This guard had exactly that ordering once,
 * and `test/i18n-hardcoded-copy.test.ts` records the measurement — a violation
 * placed after such a line was not caught and the same one before it was.
 */
function withoutComments(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text.replace(/\/\/[^\n]*/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

function excerpt(text: string, index: number): string {
  const from = text.lastIndexOf("\n", index) + 1;
  const to = text.indexOf("\n", index);
  return text.slice(from, to === -1 ? undefined : to).trim();
}

/**
 * The check itself, over an explicit set of files.
 *
 * Taking the files as an argument rather than reading the disk is what lets the
 * tests below plant a banned lemma in a catalogue, watch this fail, move the
 * string to an allowlist and watch it pass — on the real logic, not on a
 * paraphrase of it. Every offence is reported, not just the first: a screen
 * written outside the boundary should be visible as a screen.
 */
function checkBoundary(
  files: readonly ScannedFile[],
  allowlist: readonly CausalityAllowlistEntry[],
): string[] {
  const offenders: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  // The allowlist is checked before the copy is, because a rotten entry is a
  // permission nobody can account for and is worth reporting on its own.
  for (const entry of allowlist) {
    const file = byPath.get(entry.file);
    if (!file) {
      offenders.push(
        `allowlist: ${entry.file} is not a file this check scans; the entry permits nothing`,
      );
      continue;
    }
    if (!file.text.includes(entry.string)) {
      offenders.push(
        `allowlist: ${entry.file} no longer contains ${JSON.stringify(entry.string)}; delete the entry with the copy`,
      );
    }
    if (findCausalityHits(entry.string).length === 0) {
      offenders.push(
        `allowlist: ${JSON.stringify(entry.string)} contains no banned lemma; it needs no exception`,
      );
    }
    if (entry.reason.trim().length < 20) {
      offenders.push(`allowlist: ${entry.file} entry has no reason written down`);
    }
  }

  for (const file of files) {
    const ranges = permittedRanges(
      file.text,
      allowlist.filter((e) => e.file === file.path),
    );
    // Comments blanked, offsets preserved — see `withoutComments`. The excerpt
    // below still reads the original text, so a real offence is reported with
    // the line as it is actually written.
    for (const hit of findCausalityHits(withoutComments(file.text))) {
      if (isPermitted(hit, ranges)) {
        continue;
      }
      offenders.push(
        `${file.path}:${lineOf(file.text, hit.index)}: "${hit.text}" — ${excerpt(file.text, hit.index)}`,
      );
    }
  }

  return offenders;
}

/** A file as the planting tests write one. */
const file = (path: string, text: string): ScannedFile => ({ path, text });

describe("causality boundary", () => {
  it("claims no causality anywhere a user can read", () => {
    expect(checkBoundary(collect(), CAUSALITY_ALLOWLIST)).toEqual([]);
  });

  it("scans the surfaces the rule names, both catalogues included", () => {
    // A check that silently stops walking passes forever. Both dictionaries by
    // name, because "both locales are scanned" is the property most likely to
    // be lost to a refactor of `SCOPE`.
    const scanned = new Set(collect().map((f) => f.path));
    expect(scanned.has("apps/web/src/i18n/copy.pt.ts")).toBe(true);
    expect(scanned.has("apps/web/src/i18n/copy.en.ts")).toBe(true);
    expect([...scanned].some((p) => p.startsWith("packages/ui/src/"))).toBe(true);
    expect(scanned.size).toBeGreaterThan(50);
  });

  it("fails on a planted lemma, and passes once it is allowlisted with a reason", () => {
    const planted = [
      file(
        "apps/web/src/i18n/copy.en.ts",
        'export const en = {\n  explain: {\n    note: "The root cause of the curtailment.",\n  },\n};\n',
      ),
    ];

    expect(checkBoundary(planted, [])).toEqual([
      'apps/web/src/i18n/copy.en.ts:3: "root cause" — note: "The root cause of the curtailment.",',
    ]);

    expect(
      checkBoundary(planted, [
        {
          string: "The root cause of the curtailment.",
          file: "apps/web/src/i18n/copy.en.ts",
          reason: "Planted by this test to prove the exception mechanism works.",
        },
      ]),
    ).toEqual([]);
  });

  it("fails an allowlist entry whose string no longer appears", () => {
    const edited = [
      file(
        "apps/web/src/i18n/copy.en.ts",
        'export const en = { explain: { note: "The model raised its forecast." } };\n',
      ),
    ];

    // The copy was fixed; the permission was left behind. That is the state
    // this check exists to make impossible.
    const offenders = checkBoundary(edited, [
      {
        string: "The root cause of the curtailment.",
        file: "apps/web/src/i18n/copy.en.ts",
        reason: "A disclaimer that was rewritten three commits ago.",
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("no longer contains");

    // An entry pointing at a file outside the scan permits nothing either.
    const orphan = checkBoundary(edited, [
      {
        string: "The root cause of the curtailment.",
        file: "apps/web/src/i18n/copy.de.ts",
        reason: "A locale this product does not have.",
      },
    ]);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toContain("is not a file this check scans");

    // And an entry that permits nothing forbidden is not an exception at all.
    const pointless = checkBoundary(edited, [
      {
        string: "The model raised its forecast.",
        file: "apps/web/src/i18n/copy.en.ts",
        reason: "Written down for a sentence that never needed permission.",
      },
    ]);
    expect(pointless).toHaveLength(1);
    expect(pointless[0]).toContain("contains no banned lemma");

    // An exception without a reason is a hole with a comment box.
    const unreasoned = checkBoundary(
      [file("apps/web/src/i18n/copy.pt.ts", 'note: "A causa raiz disso."')],
      [
        {
          string: "A causa raiz disso.",
          file: "apps/web/src/i18n/copy.pt.ts",
          reason: "legacy",
        },
      ],
    );
    expect(unreasoned).toHaveLength(1);
    expect(unreasoned[0]).toContain("no reason written down");
  });

  it("trips on Portuguese as reliably as on English", () => {
    // Every lemma, on its own, in a file of the locale that uses it. The set is
    // asserted whole so that a lemma dropped from `@wattsteer/core` fails here
    // rather than going quiet.
    for (const lemma of CAUSALITY_BANNED_LEMMAS) {
      const offenders = checkBoundary(
        [file("apps/web/src/i18n/copy.pt.ts", `note: "Isto ${lemma} isto."`)],
        [],
      );
      expect(offenders.length).toBeGreaterThan(0);
    }

    // And in the shapes copy is actually written in: sentence case, a wrapped
    // line, and the shared UI package rather than the app.
    const real = checkBoundary(
      [
        file("apps/web/src/i18n/copy.pt.ts", 'note: "Causa raiz: congestionamento."'),
        file("apps/web/src/i18n/copy.en.ts", 'note: "Why it happened, hour by hour."'),
        // Wrapped across two lines, which is the property this fixture is for.
        // It used to wrap the lemma in a block comment, and stopped catching
        // anything the day comments were blanked — a fixture testing the
        // wrapper rather than the wrapping. A copy string wraps the same way.
        file(
          "packages/ui/src/components/panel.tsx",
          'const note =\n  "The curtailment happened because the grid " +\n  "was congested.";\n',
        ),
      ],
      [],
    );
    // Four, not three: `Causa raiz` is reported as `causa` and as `causa raiz`
    // both, so an allowlist entry written for one reading cannot silently
    // permit the other.
    expect(real).toHaveLength(4);
    expect([...new Set(real.map((o) => o.split(":")[0]))]).toEqual([
      "apps/web/src/i18n/copy.pt.ts",
      "apps/web/src/i18n/copy.en.ts",
      "packages/ui/src/components/panel.tsx",
    ]);
  });

  it("a comment may explain the boundary; copy may not cross it", () => {
    /*
      The rule this check is titled for — "anywhere a user **can read**" — and
      the one it did not keep. Three files were flagged for *documenting* the
      prohibition: `dominant-reason.ts`'s header saying WattSteer predicts no
      cause, `plan-vs-actual-panel.tsx` writing "because the grid was run
      towards that programme" about the programme rather than about a
      curtailment, and the note above `overview` in `copy.pt.ts` recording why
      question 5 is answered the way it is. A boundary nobody may explain is a
      boundary the next session deletes for being unexplained.
    */
    expect(
      checkBoundary(
        [
          file(
            "apps/web/src/lib/dominant-reason.ts",
            '/**\n * The brief asks for a "causa provável". There is no such model.\n */\nexport const REASON = "settled";\n',
          ),
          file(
            "apps/web/src/i18n/copy.pt.ts",
            '// Nunca dizemos que algo causou o corte.\nexport const pt = { note: "Registro do ONS." };\n',
          ),
        ],
        [],
      ),
    ).toEqual([]);

    // The half that must not be lost: the same words, one string along.
    const inCopy = checkBoundary(
      [
        file(
          "apps/web/src/i18n/copy.pt.ts",
          'note: "O congestionamento causou o corte."',
        ),
      ],
      [],
    );
    expect(inCopy).toHaveLength(1);
  });

  it("a lemma after a line comment that opens a block is still caught", () => {
    /*
      The ordering lesson, as a test rather than as a paragraph. Blanking block
      comments before line comments lets a `//` containing `/*` open a block
      the stripper runs to the next close, deleting real copy from the scan.
      `api/grid.ts` has such a line, and the i18n guard measured this exact
      failure: the violation before it was caught and the one after it was not.
    */
    const offenders = checkBoundary(
      [
        file(
          "apps/web/src/i18n/copy.en.ts",
          '// see /* the note */ above\nexport const en = { note: "It happened because the grid was congested." };\n',
        ),
      ],
      [],
    );
    expect(offenders).toHaveLength(1);
  });

  it("leaves the domain's own vocabulary alone", () => {
    // The failure mode of a substring scan. `because` contains `caus`;
    // `RestrictionCause` is the domain model's value object and the name of a
    // column this product has to keep writing. None of these is the claim, and
    // a check that fired on them would be widened until it meant nothing.
    const clean = checkBoundary(
      [
        file(
          "apps/web/src/components/app/explain.tsx",
          [
            "// The band is a band because the model is uncertain, not because it is shy.",
            "import type { RestrictionCause } from '@wattsteer/core';",
            "const restrictionCauseMixed = row.restriction_cause_mixed;",
            "// Porque a rede publica os dados com atraso, a vintage é carimbada.",
            "// A raiz do problema é o congestionamento na transmissão.",
            "<Text>O modelo elevou a previsão. Razão predominante: ENE.</Text>",
          ].join("\n"),
        ),
      ],
      [],
    );
    expect(clean).toEqual([]);
  });
});
