/**
 * The causality boundary, as a lexicon and a matcher.
 *
 * The rule itself is written down once, in `docs/domain-model.md` §10, and is
 * restated here only so that a reader of this file knows what it is enforcing:
 *
 * > WattSteer says the model **raised** or **lowered** its forecast. It never
 * > says a condition **caused** curtailment. The product name for this engine
 * > is **Diagnosis**; the phrase "Causal AI" does not appear anywhere,
 * > including in marketing copy, and no surface claims to explain why an event
 * > physically occurred.
 *
 * `docs/specs/diagnosis.md` gives the rule two automated enforcers, and this
 * module is the single lexicon both of them read:
 *
 *  1. **Build time** — `test/causality-boundary.test.ts` scans the web app's
 *     source, the shared UI package, both message catalogues and the narration
 *     system prompt, and fails on any occurrence that is not in
 *     `apps/web/src/lib/copy/causality-allowlist.ts`.
 *  2. **Run time** — the lexical gate of the narration output validator
 *     (diagnosis spec, seam 10) rejects a generated sentence containing any of
 *     the same lemmas, in either locale.
 *
 * Two enforcers, one list, one matcher. The alternative — a regex in the test
 * and a second, subtly different regex in the validator — is how a sentence
 * that cannot survive review ships anyway because it was generated after it.
 *
 * This file necessarily contains every word it forbids, which is why it lives
 * in `packages/core` and the build-time scan's scope does not include it.
 * Nothing here needs an exemption, and nothing here should acquire one.
 */

/**
 * The banned lemma set, both locales, verbatim from `docs/specs/diagnosis.md`.
 *
 * Deduplicated in one place only: the spec's English and Portuguese rows both
 * list `causal`, which is the same word in both languages and is listed once.
 *
 * The multi-word entries are phrases rather than words on purpose. `because`
 * and `cause` are ordinary English that this codebase's own comments use
 * constantly; `because the grid` and `root cause` are the claim. Banning the
 * bare stem would make the check fire on prose that is not the offence, and a
 * check that fires on everything is turned off.
 */
export const CAUSALITY_BANNED_LEMMAS = [
  // English
  "causal",
  "causality",
  "causal ai",
  "root cause",
  "caused by",
  "causes the",
  "because the grid",
  "why it happened",
  "driver of the event",
  // Portuguese
  "causa",
  "causou",
  "causado por",
  "causa raiz",
  "porque ocorreu",
] as const;

export type CausalityLemma = (typeof CAUSALITY_BANNED_LEMMAS)[number];

/** One occurrence of one lemma in one piece of text. */
export interface LemmaHit {
  /** The lemma that matched, as it is written in the list. */
  lemma: string;
  /** The text as it was actually written, casing and spacing preserved. */
  text: string;
  /** Character offset of the match within the searched text. */
  index: number;
}

/** One occurrence of one *banned* lemma. `lemma` is narrowed to the set. */
export interface CausalityHit extends LemmaHit {
  /** The lemma from `CAUSALITY_BANNED_LEMMAS` that matched. */
  lemma: CausalityLemma;
}

/**
 * Word boundaries that understand accents.
 *
 * JavaScript's `\b` is defined over `[A-Za-z0-9_]`, so it puts a boundary in
 * the middle of `restrição` and none at the edge of `raiz`. These lookarounds
 * are the same idea over `\p{L}\p{N}`, which is what both locales are written
 * in.
 *
 * Boundaries, not substrings, are the whole reason `because` (which contains
 * `caus`) and `RestrictionCause` (the domain's own value object, and a name
 * this product must keep) do not trip a check aimed at `causa` and `causal`.
 */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const BEFORE = `(?<!${WORD_CHAR.source})`;
const AFTER = `(?!${WORD_CHAR.source})`;

function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A lemma matches across a line break.
 *
 * Copy in a `.ts` catalogue and prose in a doc comment both wrap, so
 * `because the\n * grid` is the same sentence as `because the grid` and has to
 * be the same finding. Interior whitespace in a phrase therefore matches any
 * run of whitespace, plus the comment gutter that a wrapped line starts with.
 */
function pattern(lemma: string): RegExp {
  const body = lemma.split(" ").map(escapeLiteral).join("(?:\\s|\\*)+");
  return new RegExp(`${BEFORE}${body}${AFTER}`, "giu");
}

/**
 * Compiled once per lemma, whichever list asked for it.
 *
 * The §26 set is not the only list a runtime gate reads: the narration output
 * validator also refuses advice verbs (`should`, `deve`) and certainty adverbs
 * (`certainly`, `certamente`), which are a different rule written in the same
 * notation — a lemma, matched on accent-aware word boundaries, in either
 * locale. Those lists live with the rule that owns them; this cache is what
 * stops each of them from arriving with a regex of its own.
 */
const PATTERNS = new Map<string, RegExp>();

function patternFor(lemma: string): RegExp {
  const cached = PATTERNS.get(lemma);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = pattern(lemma);
  PATTERNS.set(lemma, compiled);
  return compiled;
}

/**
 * Every occurrence of any lemma in `lemmas`, in the order they appear.
 *
 * The one matcher. Case-insensitive, accent-aware, boundary-anchored and
 * overlapping: `causa raiz` reports both `causa` and `causa raiz`, because a
 * caller that permits one of those two readings should not silently permit the
 * other.
 *
 * Exported so that a second list of forbidden words — the narration
 * validator's advice verbs and certainty adverbs — is a second *list* rather
 * than a second matcher. Two regexes for one idea, one written at build time
 * and one at run time, is how a sentence that could not survive copy review
 * ships anyway because it was generated after the review.
 */
export function findLemmaHits(text: string, lemmas: readonly string[]): LemmaHit[] {
  const hits: LemmaHit[] = [];
  for (const lemma of lemmas) {
    const regex = patternFor(lemma);
    // A fresh `lastIndex` per call: the patterns are cached and global.
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      hits.push({ lemma, text: match[0], index: match.index ?? 0 });
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.lemma.length - b.lemma.length);
}

/**
 * Every banned-lemma occurrence in `text`, in the order they appear.
 *
 * The §26 list, through the shared matcher. Both enforcers call this one.
 */
export function findCausalityHits(text: string): CausalityHit[] {
  return findLemmaHits(text, CAUSALITY_BANNED_LEMMAS) as CausalityHit[];
}

/** Does this text cross the boundary at all? The runtime validator's question. */
export function crossesCausalityBoundary(text: string): boolean {
  return findCausalityHits(text).length > 0;
}
