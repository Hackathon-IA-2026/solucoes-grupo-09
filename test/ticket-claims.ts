/**
 * Deriving, from a ticket's own checkboxes, the count it states about itself.
 *
 * This is api-surface 29, and it is api-surface 27 pointed at the other corpus.
 * 27 proved that `docs/specs/*.md` could not be trusted to count the things it
 * described, and left `spec-claims.ts` so that the mechanical half cannot rot
 * again. It did not cover `.scratch/<lane>/issues/*.md`, and the tickets have the
 * same disease — with a sharper cost, because a ticket is what the *next agent*
 * reads to decide what to build:
 *
 *  - `api-surface/issues/10-forecast-publication.md` carried `**Status:** done
 *    (**two boxes open** …)` while a grep for `- [ ]` in it returned **six**;
 *  - in one wave, two agents each closed a *different* box on that same ticket
 *    and each truthfully wrote "three boxes open" on its own branch, neither
 *    able to see the other. Both numbers were stale on merge and the true count
 *    was one, because a third agent in the same wave had closed a third box
 *    (commit `f7afa42`);
 *  - the same file's "What is still open" heading reads `**Two boxes, and
 *    neither is a judgement call.**` and has outlived two revisions of its own
 *    count.
 *
 * ### The one thing this guard must not do
 *
 * **An unticked box is not a signal of open work in this repository.** Most
 * `done` tickets leave every box unticked as written — `forecaster/issues/28-*`
 * is `done`, merged, with all five boxes `- [ ]` — and the `**Status:**` line is
 * the authority on whether a ticket is finished. So nothing here reads a box's
 * state as a verdict on the ticket. The only comparison made is between a count
 * a ticket *states in its own prose* and the count of `- [ ]` lines in the same
 * file. A ticket that states no count is checked against nothing, which is why
 * this fires on two sentences rather than on ninety-seven tickets.
 *
 * ### How the claim is found
 *
 * By pattern over the prose, never by line number and never by a registry.
 * {@link BINDERS} is a closed vocabulary of the English these tickets actually
 * use for "how much is left" — surveyed, not guessed — and a ticket written
 * tomorrow is governed the day it is written, whether or not anybody adds it
 * here. Two of the binders are scoped to a section whose *heading* announces
 * itself ("What is still open, and why"), which is still a pattern: the heading
 * is matched, not its position.
 *
 * Quotations are exempt per **sentence**, reusing `spec-claims.ts`'s splitter
 * and its reasoning: these tickets correct themselves by quoting the wrong
 * number back ("The previous revision of this line also said 'two boxes
 * open'"), and a binder that read those as live claims would fail on every
 * correction ever written. 27 learned the hard way that paragraph scope is far
 * too generous, so the scope here is one sentence, and {@link TICKET_MARKERS}
 * is a closed vocabulary of retrospection rather than a list of files.
 *
 * ### What is deliberately out of scope, and why
 *
 *  - **`**Status:** done` with no count.** No prose count, no claim. Ticket
 *    statuses in this repository are prose and not an enum (`done`, `landed
 *    (first half; …)`, `done — measured, and closed without a change`,
 *    `ready-for-agent`, `not started`), and none of those shapes states a
 *    quantity. Reading "done" as "zero boxes open" would fire on ~97 tickets
 *    that are legitimately done with their boxes unticked.
 *  - **Deltas: how many boxes a pass *moved*, *closed* or *ticked*.**
 *    "Four of those six are now closed" is true of a history, not of the file:
 *    ticket 10 has fifteen `- [x]` lines and no sentence claiming fifteen. A
 *    delta is not derivable from the file's current state, so it is not bound.
 *  - **Counts of another file's boxes.** `api-surface/09` says "the last three
 *    boxes were ticked on arrival" about *product-fixes 01*'s checklist. The
 *    referent is not the file the sentence is in, so a self-count binder must
 *    not claim it.
 *  - **"boxes" that are not checkboxes.** `replay/10` argues that "three boxes
 *    would imply three facts" about *headline tiles on a screen*. The binders
 *    require an openness word beside the count, or a still-open section around
 *    it, which is what keeps that sentence out.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { numberOf, ROOT, sentencesOf } from "./spec-claims";

export const TICKET_ROOT = join(ROOT, ".scratch");

/** A lane's ticket, its text, and the two counts derived from its own boxes. */
export interface Ticket {
  /** Repo-relative POSIX path, for grepping. */
  file: string;
  text: string;
  /** `- [ ]` lines. The quantity every binder below is compared against. */
  open: number;
  /** `- [x]` lines. Derived for the record; nothing is bound to it. */
  ticked: number;
  /** The prose of the `**Status:**` line, verbatim. Prose, not an enum. */
  status: string;
}

const OPEN_BOX = /^[ \t]*- \[ \]/gm;
const TICKED_BOX = /^[ \t]*- \[[xX]\]/gm;
const STATUS = /^\*\*Status:\*\*[ \t]*(.*)$/m;

/**
 * Every ticket in `.scratch`, discovered by shape.
 *
 * A ticket is a `.md` file under a lane's `issues/` directory that carries a
 * `**Status:**` line. That is the shape, and it is the whole registry: the five
 * `00-README.md` files fall out because they have no status, and a lane added
 * next month is walked without an edit here.
 */
export function tickets(): Ticket[] {
  const found: Ticket[] = [];
  for (const lane of readdirSync(TICKET_ROOT, { withFileTypes: true })) {
    if (!lane.isDirectory()) {
      continue;
    }
    const dir = join(TICKET_ROOT, lane.name, "issues");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const text = readFileSync(join(dir, entry), "utf8");
      const status = STATUS.exec(text);
      if (status === null) {
        continue;
      }
      found.push({
        file: `.scratch/${lane.name}/issues/${entry}`,
        text,
        open: (text.match(OPEN_BOX) ?? []).length,
        ticked: (text.match(TICKED_BOX) ?? []).length,
        status: status[1]?.trim() ?? "",
      });
    }
  }
  return found;
}

/**
 * Phrases with which a ticket's sentence declares its number a quotation.
 *
 * Added to `spec-claims.ts`'s {@link CORRECTION_MARKERS} rather than replacing
 * them: the tickets narrate their own corrections in a slightly different
 * register from the specs ("the previous revision of this line", "as this
 * section originally read", "this heading has outlived"), and both vocabularies
 * are closed English. The cost is the same one 27 stated: a sentence that
 * legitimately uses one of these words *and* carries a live count gets a free
 * pass, which is why the test asserts the exempt set is a minority.
 */
export const TICKET_MARKERS = [
  "previous revision",
  "earlier revision",
  "originally read",
  "originally said",
  "as this section",
  "status line said",
  "line also said",
  "sentence said",
  "paragraph said",
  "has outlived",
  "since been overtaken",
  "was stale",
  "no longer stands",
  "at the time",
  "this ticket predicted",
];

/**
 * A numeral, as these tickets write one.
 *
 * Spelled into every binder rather than captured as `[\w-]+` and rejected
 * afterwards, so that a match is never bound to a word that is not a number.
 * `[\w-]+` was tried first and bound "The count above is a count **of**
 * unticked boxes" — a sentence stating nothing — as a claim with no number.
 * The vocabulary is the one `numberOf` understands, which is why the two stay
 * in step.
 */
const NUMERAL = String.raw`\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty`;

/** Where a binder is allowed to look. */
type Scope = "anywhere" | "still-open-section";

export interface Binder {
  /** Name, for the failure message. */
  name: string;
  /** One capturing group, holding the stated number. */
  pattern: RegExp;
  scope: Scope;
  /** Human wording of what the number is claimed to be. */
  means: string;
  /**
   * A sentence-level precondition, for the binders whose surface form is too
   * common to bind on its own. Kept beside the pattern so the rule is readable.
   */
  requires?: RegExp;
}

/**
 * Every shape in which a ticket in this repository states how much is left.
 *
 * Surveyed from the corpus before it was designed (`grep -rniE '(one|two|…|
 * [0-9]+) (box|boxes)' <lane>/issues/*.md`, and the same for "still open"), which is
 * why there are six and not one: the defect has been written as a status
 * parenthetical, as a re-grep note, as a section lead, and as a bare "it is
 * now N".
 */
export const BINDERS: Binder[] = [
  {
    // "one box open", "two boxes open", "three boxes remain", "two boxes left"
    name: "N boxes open",
    pattern: new RegExp(
      String.raw`\*{0,2}(${NUMERAL})\*{0,2}\s+(?:more\s+)?box(?:es)?\*{0,2}\s+(?:are\s+|is\s+|still\s+|that\s+)?(?:open|remaining|remain|remains|unticked|left|outstanding)\b`,
      "i",
    ),
    scope: "anywhere",
    means: "the count of open boxes",
  },
  {
    // "The two open boxes", "six unticked boxes"
    name: "N open boxes",
    pattern: new RegExp(
      String.raw`\*{0,2}(${NUMERAL})\*{0,2}\s+(?:open|remaining|unticked|outstanding)\s+box(?:es)?\b`,
      "i",
    ),
    scope: "anywhere",
    means: "the count of open boxes",
  },
  {
    // "A grep for `- [ ]` in this file returns one"
    name: "a grep for `- [ ]` returns N",
    pattern: new RegExp(
      String.raw`grep[^\`]*\`- \\?\[ \\?\]\`[^)]*?returns?\s+\*{0,2}(${NUMERAL})`,
      "i",
    ),
    scope: "anywhere",
    means: "the count of open boxes",
  },
  {
    // "a grep found **six** unticked"
    name: "N unticked",
    pattern: new RegExp(
      String.raw`(?:grep\w*|returns?|found|finds)\s+\*{0,2}(${NUMERAL})\*{0,2}\s+unticked\b`,
      "i",
    ),
    scope: "anywhere",
    means: "the count of open boxes",
  },
  {
    // "**Two boxes, and neither is a judgement call.**", under the heading
    // "## What is still open, and why".
    name: "N boxes, under a still-open heading",
    pattern: new RegExp(String.raw`\*\*\s*(${NUMERAL})\s+box(?:es)?\b`, "i"),
    scope: "still-open-section",
    means: "the count of open boxes",
  },
  {
    // "It is the only thing standing between this ticket and its other four
    // boxes." — a self-count of what is left, written as a remainder.
    name: "its other N boxes",
    pattern: new RegExp(
      String.raw`(?:its|the|these)\s+other\s+\*{0,2}(${NUMERAL})\*{0,2}\s+box(?:es)?\b`,
      "i",
    ),
    scope: "anywhere",
    means: "the count of open boxes",
  },
  {
    // "The count was four and is now one." / "**It is now three**, and the
    // count was re-grepped rather than decremented from memory".
    name: "the count is now N",
    pattern: new RegExp(String.raw`\bis\s+now\*{0,2}\s+\*{0,2}(${NUMERAL})\b`, "i"),
    scope: "anywhere",
    means: "the count of open boxes",
    requires: /\bcount\b/i,
  },
];

/** One count a ticket states about its own boxes. */
export interface BoxClaim {
  /** Repo-relative path of the ticket the sentence is in. */
  file: string;
  /** 1-based line of its paragraph, for grepping. */
  line: number;
  /** The binder that found it. */
  binder: string;
  means: string;
  /** What the ticket wrote. */
  quoted: string;
  /** The whole sentence, for the failure message. */
  sentence: string;
  /** The number stated, or `null` when the matched token is not a numeral. */
  stated: number | null;
  /** Whether the sentence announces itself as a quotation of a past count. */
  quotation: boolean;
  /** The count derived from the file's own `- [ ]` lines. */
  derived: number;
}

interface Section {
  heading: string;
  body: string;
  /** 1-based line the body starts on. */
  line: number;
}

/** A ticket split at its Markdown headings, so a binder can be scoped to one. */
function sections(text: string): Section[] {
  const lines = text.split("\n");
  const found: Section[] = [];
  let heading = "";
  let start = 0;
  let body: string[] = [];
  const flush = (end: number): void => {
    if (body.length > 0) {
      found.push({ heading, body: body.join("\n"), line: start + 1 });
    }
    void end;
  };
  for (const [index, line] of lines.entries()) {
    if (/^#{1,6}\s+/.test(line)) {
      flush(index);
      heading = line.replace(/^#{1,6}\s+/, "").trim();
      start = index + 1;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush(lines.length);
  return found;
}

/** A heading that announces the section as the ticket's remaining work. */
const STILL_OPEN_HEADING =
  /what\s+(?:is|remains|was)\s+(?:still\s+)?(?:open|left)|still\s+open/i;

/**
 * A ticket's prose, with the parts of it that are not prose blanked out.
 *
 * Three kinds of line are replaced by an empty line, so that every remaining
 * line keeps its number:
 *
 *  - **fenced code blocks and indented specimens.** A probe transcript or a
 *    shell command quoting a status line is a specimen, not an assertion.
 *  - **Markdown table rows.** A table's cells are not sentences — the splitter
 *    quite reasonably makes a whole table one "sentence", so a table of shapes
 *    (the one in ticket 29, listing every binder beside an example of what it
 *    binds) would otherwise read as a dozen simultaneous claims about the file
 *    it is in. This is named in 29's out-of-scope list: a count that governs
 *    anything is stated in prose, and none of the three real defects was in a
 *    table.
 */
function prose(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return "";
      }
      if (fenced) {
        return "";
      }
      if (/^\s*\|/.test(line)) {
        return "";
      }
      if (/^ {4,}\S/.test(line) && !/^\s*[-*] /.test(line)) {
        return "";
      }
      return line;
    })
    .join("\n");
}

/**
 * A sentence that is talking about a different ticket.
 *
 * `api-surface 27`, `forecaster/18`, `10-forecast-publication.md`: a count in a
 * sentence that names another ticket is a count of *that* ticket's boxes, and
 * this guard only ever compares a file against itself. It is the mechanical
 * form of the out-of-scope class 29 names by hand — `api-surface/09`'s "the
 * last three boxes were ticked on arrival", which is about product-fixes 01.
 * The lane names are read from the `.scratch` directory listing rather than
 * written down here, so a new lane needs no edit.
 */
function namesAnotherTicket(): RegExp {
  const lanes = readdirSync(TICKET_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(String.raw`(?:${lanes})\s*[\/ ]\s*\d+|\b\d{2}-[a-z0-9-]+\.md`, "i");
}

/**
 * Every count a ticket states about its own open boxes, with the derived number
 * beside it.
 *
 * Returned rather than compared, so the test can assert the input is non-empty
 * before it asserts anything is clean. A binder whose regex stops matching
 * must go red, not quiet — this repository has shipped four guards that governed
 * nothing because nobody checked the thing they walked was not empty.
 */
export function boxCountClaims(
  all: Ticket[] = tickets(),
  binders: Binder[] = BINDERS,
): BoxClaim[] {
  const elsewhere = namesAnotherTicket();
  const claims: BoxClaim[] = [];
  for (const ticket of all) {
    for (const binder of binders) {
      const scoped: Section[] =
        binder.scope === "still-open-section"
          ? sections(ticket.text).filter((one) => STILL_OPEN_HEADING.test(one.heading))
          : [{ heading: "", body: ticket.text, line: 1 }];
      for (const section of scoped) {
        for (const sentence of sentencesOf(prose(section.body), TICKET_MARKERS)) {
          if (binder.requires !== undefined && !binder.requires.test(sentence.prose)) {
            continue;
          }
          if (elsewhere.test(sentence.prose)) {
            continue;
          }
          for (const match of sentence.prose.matchAll(
            new RegExp(
              binder.pattern.source,
              `${binder.pattern.flags.replace("g", "")}g`,
            ),
          )) {
            claims.push({
              file: ticket.file,
              line: section.line + sentence.line - 1,
              binder: binder.name,
              means: binder.means,
              quoted: match[0].trim(),
              sentence: sentence.prose,
              stated: numberOf(match[1] ?? ""),
              quotation: sentence.quotation,
              derived: ticket.open,
            });
          }
        }
      }
    }
  }
  return claims;
}

/** The claims a ticket is asserting now, as opposed to quoting from its past. */
export function liveBoxClaims(claims: BoxClaim[]): BoxClaim[] {
  return claims.filter((claim) => !claim.quotation && claim.stated !== null);
}

/** The live claims whose stated number is not the file's own `- [ ]` count. */
export function driftedBoxClaims(claims: BoxClaim[]): BoxClaim[] {
  return liveBoxClaims(claims).filter((claim) => claim.stated !== claim.derived);
}

/** A one-line rendering of a claim, for a failure message worth reading. */
export function describeBoxClaim(claim: BoxClaim): string {
  return `${claim.file}:${claim.line} — ${claim.binder} states ${claim.stated}, derived ${claim.derived} — “${claim.quoted}”`;
}
