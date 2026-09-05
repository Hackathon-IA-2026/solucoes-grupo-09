import { findCausalityHits, findLemmaHits } from "@wattsteer/core";
import type { DiagnosisNarrationInput, Narration } from "@wattsteer/core/api";
import {
  canonicalNarrationJson,
  NARRATION_DISPLAY,
  type NarrationFieldDisplay,
  narrationPayloadDigest,
} from "./narration-canonical.js";
import {
  type NarrationLocale,
  NarrationPayloadError,
  toNarrationDocument,
} from "./narration-payload.js";
import { templateNarration } from "./narration-template.js";

/**
 * Nothing a language model invents ever reaches a user.
 *
 * `docs/specs/diagnosis.md`: *prompts ask; validators enforce.* The system
 * prompt asks for one paragraph that introduces no number, claims no cause and
 * gives no advice. This module is the part that is not a request. It ships
 * ahead of the model call and is proven against hand-written adversarial
 * narrations rather than against whatever the model happened to say, because a
 * gate first exercised by real output is a gate whose fixtures are chosen by
 * the thing it is meant to catch.
 *
 * ### Three gates, and one regex each time there could have been two
 *
 * 1. **Numeric.** Every numeric token in the paragraph has to be a number the
 *    closed document literally carries, spelled at a precision the product
 *    would print it at, in either locale's notation. A number that is
 *    arithmetically correct but absent fails, and that is the point: from
 *    outside the model, a correct computation and a lucky hallucination are
 *    indistinguishable, so the only tractable rule is "no computation at all".
 *    `top_two_share` is a payload field precisely so that this rule costs the
 *    copy nothing.
 * 2. **Lexical.** The §26 banned lemmas — `docs/domain-model.md` §10 — plus
 *    advice verbs and certainty adverbs.
 * 3. **Structural.** Word count, one paragraph, no markup, no URL, and the
 *    paragraph is in the language that was asked for.
 *
 * Each gate reuses the definition that already exists rather than restating it:
 *
 *  - the **numbers** come from `./narration-canonical.ts`'s *canonical* form —
 *    the same bytes the cache key is a hash of, already rounded to display
 *    precision by the same rounder, with the same table and the same refusal to
 *    default. So "the number is in the payload" has one meaning here and in the
 *    digest, and a field added without a decided precision fails in both.
 *  - the **lemmas** are matched by `packages/core`'s `findLemmaHits`, which is
 *    the same accent-aware, boundary-anchored matcher the build-time scan uses.
 *    A build-time regex and a runtime regex drifting apart is how a sentence
 *    that could not survive copy review ships anyway, because it was written
 *    after the review.
 *  - the **notation** is spelled by `Intl`, which is what the client formats
 *    with, so the whitelist is not a second implementation of the decimal
 *    comma.
 *
 * ### What a failure is, and what it is not
 *
 * A failure is not an error. `./narration-gate.ts` already hands the model
 * narration to the decision as a thunk it may decline to call, and
 * `./narration-template.ts` is the other branch of that decision rather than a
 * consolation. A narration that fails validation falls back the same way: the
 * complaint is appended to a second and final attempt, and a second failure
 * logs the rejected text with its payload hash and renders the template. **The
 * rejected text is never shown.**
 *
 * The one thing this module does not do is decide whether the model is
 * available at all. `attempt` may throw and the throw propagates: an outage is the
 * caller's to catch and is already an established reason to render the
 * template. Swallowing it here would make "the model was down" and "the model
 * lied" the same event in the logs.
 *
 * ### The stated limit
 *
 * Nothing here validates that a narration is **good**. A dull, unhelpful,
 * technically-correct paragraph passes all three gates. That is the right
 * trade — the failure this product cannot survive is a confident false claim,
 * not a boring true one — but it is a limit, not an oversight, and
 * `docs/specs/diagnosis.md` names it as one of the four places the spec is
 * weakest.
 */

/** Which gate rejected a paragraph. */
export type NarrationGate = "numeric" | "lexical" | "structural";

/**
 * One reason a paragraph was rejected, as a code and the token that tripped it.
 *
 * Codes rather than sentences, for the same reason the payload carries codes:
 * this travels into the retry prompt and into an operator's log, and a message
 * assembled here would be a user-facing string written in a server module, in
 * one language, for a product whose default locale is the other one.
 */
export interface NarrationFinding {
  gate: NarrationGate;
  /** A `snake_case` code from the closed set below. */
  code: NarrationFindingCode;
  /** The offending fragment, verbatim, when there is one. */
  token?: string;
}

/** Every way a paragraph can fail. Closed, so a retry prompt can enumerate it. */
export type NarrationFindingCode =
  | "number_not_in_payload"
  | "banned_lemma"
  | "advice_verb"
  | "certainty_adverb"
  | "word_count_low"
  | "word_count_high"
  | "multiple_paragraphs"
  | "markup"
  | "url"
  | "locale_mismatch";

/**
 * The word window. Wider than the prompt's own 45–90 request, deliberately.
 *
 * The prompt asks for a length; the gate refuses a paragraph that is not one.
 * Validating at the same bound the prompt asks for would reject a good
 * paragraph for being three words long in the wrong direction, and every
 * rejection costs a second model call and, twice over, the model's narration
 * entirely.
 */
const WORD_COUNT_MIN = 35;
const WORD_COUNT_MAX = 110;

/**
 * Advice, which this product does not give.
 *
 * `docs/specs/diagnosis.md`: never give advice, never mention the optimizer.
 * The Explain screen states what the model read; Mitigate is where a posture is
 * stated, and it states one rather than offering one. A narration that tells an
 * operator what to do has crossed from one screen into the other.
 *
 * Both locales, and exactly the spec's list. The instinct on a near miss is to
 * widen this until it stops missing, at which point it fires on ordinary prose
 * and gets turned off — so it grows when the spec grows and not before.
 */
const ADVICE_VERBS = ["should", "recommend", "recommends", "deve", "recomenda"] as const;

/**
 * Certainty, which a probabilistic forecast does not have.
 *
 * The whole product is intervals: a day occurrence probability, a P10–P90 band
 * and an attribution with a sampling error printed beside it. An adverb that
 * removes the interval from a sentence contradicts every number in the same
 * paragraph.
 */
const CERTAINTY_ADVERBS = ["certainly", "definitely", "certamente"] as const;

/**
 * Function words that are common in one locale and absent from the other.
 *
 * Gate 3's language check, and it is a *script/stopword* check on purpose: the
 * failure mode it exists to catch is a whole paragraph generated in the wrong
 * language, not a stray English noun in a Portuguese sentence. Anything
 * cleverer would be a language identifier, which is a dependency and a second
 * thing to be wrong.
 *
 * Single letters and the words the two languages share are left out — `a`, `e`,
 * `o`, `as` and `no` are each a word in both — so a hit is evidence rather than
 * a coincidence.
 */
const STOPWORDS: Readonly<Record<NarrationLocale, readonly string[]>> = {
  "pt-BR": [
    "de",
    "da",
    "do",
    "dos",
    "das",
    "para",
    "com",
    "que",
    "não",
    "uma",
    "um",
    "os",
    "em",
    "por",
    "pelo",
    "pela",
    "ao",
    "seu",
    "sua",
    "mais",
    "sobre",
    "entre",
    "acima",
    "dia",
  ],
  "en-US": [
    "the",
    "of",
    "and",
    "to",
    "for",
    "with",
    "that",
    "is",
    "are",
    "was",
    "its",
    "this",
    "from",
    "than",
    "over",
    "above",
    "day",
    "hours",
    "against",
  ],
};

/** How many of the requested locale's stopwords a paragraph has to carry. */
const STOPWORD_FLOOR = 3;

/**
 * Markup, in the shapes a chat-trained model reaches for.
 *
 * Not an exhaustive markdown grammar — `_` is deliberately absent, because the
 * document's own group codes are `snake_case` and a paragraph naming
 * `net_surplus` is quoting the payload rather than emphasising a word.
 */
const MARKUP = [
  /<[a-zA-Z/!][^>]*>/,
  /\*/,
  // A code fence or an inline code span. Written as an escape rather than as a
  // literal backtick: `test/i18n-hardcoded-copy.test.ts` scans this file for
  // string literals by pairing quote characters, and one unpaired backtick
  // makes every line between two template literals look like one sentence.
  /\u0060/,
  /~~/,
  /\]\(/,
  /^\s*#/m,
  /^\s*>/m,
  /^\s*[-+•]\s/m,
  /^\s*\d+[.)]\s/m,
  /\|/,
] as const;

/** A link, in the two shapes that are not also ordinary punctuation. */
const URL = [/\bhttps?:\/\//i, /\bwww\.[a-z]/i] as const;

/**
 * A numeric token, as a reader would write one.
 *
 * Three decisions in one pattern:
 *
 *  - A wall-clock hour is matched first and whole. `13:00` is one number
 *    written in the client's own hour notation, and reading it as `13` and
 *    `00` would invent a zero the document may not carry.
 *  - Digits welded to letters are **not** a quantity. `P10`, `P50` and `P90`
 *    are the product's notation for a quantile — the hardcoded-copy guard
 *    already treats them as symbols rather than words — and a narration is
 *    required to name the band it is describing.
 *  - Grouping and decimal separators are both `.` and `,`, because which one
 *    is which is the reader's convention and gate 1 accepts either.
 */
const NUMERIC_TOKEN =
  /(?<![\p{L}\p{N}])(?:\d{1,2}:\d{2}|\d+(?:[.,]\d+)*)(?![\p{L}\p{N}])/gu;

/** The calendar parts of an ISO civil date or instant: year, month, day. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** The notations a number can legitimately be written in. Both locales. */
const NOTATIONS: readonly Intl.NumberFormatOptions[] = [
  { useGrouping: true },
  { useGrouping: false },
];
const NOTATION_LOCALES: readonly string[] = ["pt-BR", "en-US"];

/**
 * Every spelling of every number the document carries.
 *
 * Built from the **canonical** document — `canonicalNarrationJson` has already
 * rounded every float to its display precision through the one rounder and has
 * already refused any field nobody decided a precision for. So the whitelist
 * and the cache key are drawn from the same values by construction, and
 * "the number in the sentence is a number in the payload" means exactly "it is
 * one of the numbers that was hashed".
 *
 * Three widenings, each of which is a spelling rather than a value:
 *
 *  - **Both locales' notation, grouped and ungrouped.** `412`, `412,0`,
 *    `412.0`, `1.900`, `1,900` and `1900` are the same number, and a narration
 *    stating a payload number in the other locale's notation must pass —
 *    `docs/specs/diagnosis.md` seam 9 says so in as many words.
 *  - **Shorter, but only where nothing is lost.** `412.0` may be written
 *    `412`; `1.42` may not be written `1.4`, because the prompt says round
 *    nothing and a rounded figure is a figure the document does not hold.
 *  - **The field's own notation.** A `percent` field is also admissible as its
 *    percentage — `0.87` and `87` — and an `hour` field as `13:00`.
 *
 * The sign is dropped: `phi_mwh` is negative for a group that lowers the
 * forecast, and the prose carries that as the word `lowers` rather than as a
 * minus sign in front of the digits.
 *
 * And two things it deliberately does **not** widen to. Time-of-day parts of
 * an instant are not admissible — only a date's year, month and day are, so
 * that a paragraph may name the day it explains but not quote the minute a run
 * was published. And no count of anything is admissible: the document holds
 * eight groups and does not hold the number eight, so a paragraph writing `8`
 * fails. Both cost a fallback to the template, which is the safe direction.
 */
export function narrationNumericWhitelist(
  document: Record<string, unknown>,
): Set<string> {
  const canonical: unknown = JSON.parse(canonicalNarrationJson(document));
  const spellings = new Set<string>();
  walk(canonical, "", spellings);
  return spellings;
}

function walk(value: unknown, name: string, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      // An array index does not change what a value is: a list's members are
      // read under the list's own name, exactly as the rounder reads them.
      walk(item, name, into);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      walk(member, key, into);
    }
    return;
  }
  if (typeof value === "string") {
    addDateSpellings(value, into);
    return;
  }
  if (typeof value !== "number") {
    return;
  }
  const display = NARRATION_DISPLAY[name];
  if (display === undefined) {
    // Unreachable through `canonicalNarrationJson`, which throws first. Kept so
    // that a caller handing this function a document by another route gets the
    // same refusal rather than a silently smaller whitelist.
    throw new NarrationPayloadError(
      `${name} has no display precision; the numeric whitelist cannot say how a number nobody has priced would be written`,
    );
  }
  addNumberSpellings(value, display, into);
}

function addNumberSpellings(
  value: number,
  display: NarrationFieldDisplay,
  into: Set<string>,
): void {
  const magnitude = Math.abs(value);
  addAtPrecision(magnitude, display.decimals, into);
  if (display.style === "percent") {
    const points = Number((magnitude * 100).toFixed(Math.max(display.decimals - 2, 0)));
    addAtPrecision(points, Math.max(display.decimals - 2, 0), into);
  }
  if (display.style === "hour") {
    into.add(`${String(Math.round(magnitude)).padStart(2, "0")}:00`);
  }
}

/** The value at `decimals`, and at every shorter precision that loses nothing. */
function addAtPrecision(value: number, decimals: number, into: Set<string>): void {
  const exact = Number(value.toFixed(decimals));
  for (let digits = 0; digits <= decimals; digits += 1) {
    if (Number(exact.toFixed(digits)) !== exact) {
      continue;
    }
    for (const locale of NOTATION_LOCALES) {
      for (const grouping of NOTATIONS) {
        into.add(
          new Intl.NumberFormat(locale, {
            ...grouping,
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(exact),
        );
      }
    }
  }
}

/** A civil date's three parts, padded and bare: `2026`, `08`, `8`, `28`. */
function addDateSpellings(value: string, into: Set<string>): void {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    return;
  }
  for (const part of [match[1], match[2], match[3]]) {
    into.add(part);
    into.add(String(Number(part)));
  }
}

/**
 * The three gates, over one paragraph.
 *
 * Every gate runs: a paragraph that invents a number *and* claims a cause
 * comes back with both findings, so the retry is told everything at once
 * rather than one thing per attempt when there is only ever one retry.
 *
 * @param text the model's paragraph, exactly as it arrived.
 * @param payload the closed document it was written from.
 */
export function validateNarration(
  text: string,
  payload: DiagnosisNarrationInput,
): NarrationFinding[] {
  const document = toNarrationDocument(payload);
  return [
    ...numericFindings(text, narrationNumericWhitelist(document)),
    ...lexicalFindings(text),
    ...structuralFindings(text, payload.locale),
  ];
}

/** Gate 1. Every numeric token is a number the document literally carries. */
function numericFindings(text: string, whitelist: Set<string>): NarrationFinding[] {
  const found: NarrationFinding[] = [];
  for (const match of text.matchAll(NUMERIC_TOKEN)) {
    const token = match[0];
    if (!whitelist.has(token)) {
      found.push({ gate: "numeric", code: "number_not_in_payload", token });
    }
  }
  return found;
}

/** Gate 2. Three lists, one matcher, `packages/core`'s. */
function lexicalFindings(text: string): NarrationFinding[] {
  return [
    ...findCausalityHits(text).map(
      (hit): NarrationFinding => ({
        gate: "lexical",
        code: "banned_lemma",
        token: hit.text,
      }),
    ),
    ...findLemmaHits(text, ADVICE_VERBS).map(
      (hit): NarrationFinding => ({
        gate: "lexical",
        code: "advice_verb",
        token: hit.text,
      }),
    ),
    ...findLemmaHits(text, CERTAINTY_ADVERBS).map(
      (hit): NarrationFinding => ({
        gate: "lexical",
        code: "certainty_adverb",
        token: hit.text,
      }),
    ),
  ];
}

/** Gate 3. A paragraph, of a length, in the language that was asked for. */
function structuralFindings(text: string, locale: NarrationLocale): NarrationFinding[] {
  const found: NarrationFinding[] = [];
  const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length < WORD_COUNT_MIN) {
    found.push({
      gate: "structural",
      code: "word_count_low",
      token: String(words.length),
    });
  }
  if (words.length > WORD_COUNT_MAX) {
    found.push({
      gate: "structural",
      code: "word_count_high",
      token: String(words.length),
    });
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length > 1) {
    found.push({
      gate: "structural",
      code: "multiple_paragraphs",
      token: String(lines.length),
    });
  }
  for (const pattern of MARKUP) {
    const hit = pattern.exec(text);
    if (hit !== null) {
      found.push({ gate: "structural", code: "markup", token: hit[0].trim() });
    }
  }
  for (const pattern of URL) {
    const hit = pattern.exec(text);
    if (hit !== null) {
      found.push({ gate: "structural", code: "url", token: hit[0] });
    }
  }
  const written = writtenLocale(text);
  if (written !== locale) {
    found.push({ gate: "structural", code: "locale_mismatch", token: written ?? "" });
  }
  return found;
}

/**
 * Which of the two languages this paragraph is in, or `null` for neither.
 *
 * A count of each locale's function words. The winner has to be strictly ahead
 * and has to clear a floor, so a paragraph with two Portuguese words and two
 * English ones is neither rather than arbitrarily one.
 */
export function writtenLocale(text: string): NarrationLocale | null {
  const words = new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== ""),
  );
  const score = (locale: NarrationLocale) =>
    STOPWORDS[locale].filter((word) => words.has(word)).length;
  const pt = score("pt-BR");
  const en = score("en-US");
  if (pt >= STOPWORD_FLOOR && pt > en) {
    return "pt-BR";
  }
  if (en >= STOPWORD_FLOOR && en > pt) {
    return "en-US";
  }
  return null;
}

/**
 * The findings, as the string appended to the second and final attempt.
 *
 * Codes and the offending tokens, nothing else. The prompt holds the sentence
 * that explains what a code means, in one place, versioned with the rest of
 * the prompt — which is where a wording change belongs, rather than in a
 * server module that would then be assembling prose.
 */
export function narrationComplaint(findings: readonly NarrationFinding[]): string {
  return findings
    .map((finding) => {
      const head = `${finding.gate}:${finding.code}`;
      return finding.token === undefined || finding.token === ""
        ? head
        : `${head}:${finding.token}`;
    })
    .join(" ");
}

/**
 * The model's call, as a thunk that is told what was wrong with its last try.
 *
 * `complaint` is `undefined` on the first attempt and {@link narrationComplaint}
 * on the second. There is no third.
 */
export type NarrationAttempt = (complaint: string | undefined) => Promise<string>;

/** A paragraph nobody will ever see, kept for the operator who has to explain it. */
export interface RejectedNarration {
  /** 1 or 2. The spec allows exactly one retry. */
  attempt: number;
  /** {@link narrationPayloadDigest} of the document it was written from. */
  digest: string;
  locale: NarrationLocale;
  promptVersion: string;
  findings: NarrationFinding[];
  /** The rejected text. Logged, never returned, never rendered. */
  text: string;
}

/** Everything the two attempts need. One payload, one thunk, one log sink. */
export interface ValidatedNarrationSources {
  /** The closed document, exactly as the model was given it. */
  payload: DiagnosisNarrationInput;
  /** The model call. May throw; an outage is not this module's to catch. */
  attempt: NarrationAttempt;
  /**
   * Where a rejected paragraph goes. Injected so a test can read it without a
   * console, and so the deployment can send it somewhere an operator looks.
   */
  onRejected?: (rejected: RejectedNarration) => void;
}

/** What rendered, how many model calls it took, and what was thrown away. */
export interface ValidatedNarration {
  narration: Narration;
  /** Model calls actually made: 1, or 2 when the first was rejected. */
  attempts: number;
  /** In order. Empty when the first attempt passed; never returned to a client. */
  rejected: RejectedNarration[];
}

/** One retry, and no more. `docs/specs/diagnosis.md`: "a second and final attempt". */
const MAX_ATTEMPTS = 2;

/**
 * The model's paragraph if it passes, the template's plan if it does not.
 *
 * The shape mirrors `./narration-gate.ts` on purpose: the model arrives as a
 * thunk and the template is computed from the same closed document, so the two
 * surfaces are two branches of one decision at both levels. This function is
 * what a caller passes to `renderNarration` as its `model` renderer — a
 * withheld day never reaches it, because a withheld day never calls the thunk
 * that contains it.
 *
 * The rejected text is logged with its payload hash and dropped. It is not
 * returned to the client, not stored beside the attribution and not shown
 * behind a flag: a paragraph that failed a gate is a paragraph whose claims
 * nobody has checked.
 */
export async function validatedNarration(
  sources: ValidatedNarrationSources,
): Promise<ValidatedNarration> {
  const { payload, attempt, onRejected = logRejected } = sources;
  const locale = payload.locale;
  const digest = narrationPayloadDigest(toNarrationDocument(payload));
  const rejected: RejectedNarration[] = [];
  let complaint: string | undefined;

  for (let call = 1; call <= MAX_ATTEMPTS; call += 1) {
    const text = await attempt(complaint);
    const findings = validateNarration(text, payload);
    if (findings.length === 0) {
      return {
        narration: {
          source: "model",
          text,
          locale,
          promptVersion: payload.promptVersion,
        },
        attempts: call,
        rejected,
      };
    }
    const record: RejectedNarration = {
      attempt: call,
      digest,
      locale,
      promptVersion: payload.promptVersion,
      findings,
      text,
    };
    rejected.push(record);
    onRejected(record);
    complaint = narrationComplaint(findings);
  }

  return {
    narration: templateNarration(payload),
    attempts: MAX_ATTEMPTS,
    rejected,
  };
}

/**
 * The default sink: one line an operator can grep, as JSON.
 *
 * Serialised rather than interpolated because the rejected text is arbitrary
 * model output and a paragraph pasted raw into a log line is a paragraph that
 * can forge one.
 */
function logRejected(rejected: RejectedNarration): void {
  console.warn(JSON.stringify({ narration_rejected: rejected }));
}
