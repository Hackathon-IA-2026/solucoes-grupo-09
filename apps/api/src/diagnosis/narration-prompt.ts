/**
 * What the renderer is told, once, in bytes that never change.
 *
 * `docs/specs/diagnosis.md`: **it renders, it never decides.** The model's
 * whole world is the closed document `./narration-payload.ts` assembled, and
 * this module is the only other thing in the request — the standing
 * instruction, and the two short code-shaped blocks that vary per call.
 *
 * ### Why the system prompt is a constant and not a function
 *
 * The spec puts `cache_control: { type: "ephemeral" }` on the system block and
 * asserts it is **byte-identical across every request**. A prompt builder that
 * took the locale, the subsystem or the date would invalidate the cached prefix
 * on every one of the sixteen daily calls and nobody would notice, because a
 * cache miss looks exactly like a cache hit from the outside. So the only way
 * this block can vary is by being edited, and an edit is a
 * {@link NARRATION_PROMPT_VERSION} bump — which `test/…-client.test.ts` pins to
 * a digest of the text, so the bump cannot be forgotten.
 *
 * Everything volatile is therefore in the user turn, after the breakpoint, and
 * everything in the user turn is a **code**: the locale tag, the validator's
 * complaint from the previous attempt, and the canonical JSON document. The
 * prompt is the one place in the narration path that holds sentences, and they
 * are addressed to the model rather than to a reader — which is the distinction
 * `test/i18n-hardcoded-copy.test.ts` records as this file's exception.
 *
 * ### `docs/domain-model.md` §10 reaches this file automatically
 *
 * The build-time boundary scan in `test/` already covers `apps/api/src` files
 * named for the narration or for a prompt — it was scoped by name *for this
 * file*, before this file existed — so the standing instruction below is read
 * against the banned lemma set on every run. The instruction states the
 * boundary without ever writing one of the words it forbids, which is the
 * point: the rule is that the product says the **model** raised or lowered its
 * forecast, and a prompt that had to quote the forbidden claim in order to
 * forbid it would need an allowlist entry of its own to say so.
 */

import type { NarrationFindingCode } from "./narration-validator.js";

/**
 * The version of everything in this file, and a component of the cache key.
 *
 * `narration:v1:{prompt_version}:{model_id}:{locale}:{digest}` — a prompt edit
 * has to produce a different key, because identical facts under a different
 * instruction are different prose. Bumping it is a cache invalidation by
 * design, exactly as `NARRATION_SCHEMA_VERSION` is.
 */
export const NARRATION_PROMPT_VERSION = "2026-08-28.1";

/**
 * The key of the block that carries the locale the paragraph is generated in.
 *
 * A code rather than a sentence, so the user turn stays as free of prose as the
 * document it wraps. The system prompt below says what the key means; that
 * sentence is versioned with the rest of the prompt rather than assembled next
 * to the request.
 */
export const LOCALE_BLOCK_KEY = "write_in_locale";

/** The key of the block that carries the previous attempt's rejection codes. */
export const COMPLAINT_BLOCK_KEY = "rejected_previous_attempt";

/** The key of the block that carries the closed document. Always last. */
export const DOCUMENT_BLOCK_KEY = "input_document";

/** The single field the structured output carries. */
export const NARRATION_OUTPUT_FIELD = "narration";

/**
 * The output schema: one field, one string, nothing else admitted.
 *
 * `additionalProperties: false` and a single `required` field is what makes a
 * preamble impossible. A model that wanted to say "Here is the paragraph:"
 * has nowhere to put it.
 */
export const NARRATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { [NARRATION_OUTPUT_FIELD]: { type: "string" } },
  required: [NARRATION_OUTPUT_FIELD],
  additionalProperties: false,
};

/**
 * Every rejection code, with the sentence that says what it means.
 *
 * `./narration-validator.ts` deliberately emits codes and no prose:
 * `narrationComplaint` is `numeric:number_not_in_payload:8`, not a sentence, so
 * that the wording of the explanation lives in exactly one place and is
 * versioned with the prompt rather than written in a server module. This is
 * that one place. The record is typed by `NarrationFindingCode`, so a code
 * added to the validator without an explanation here is a compile error.
 */
const FINDING_GLOSSARY: Readonly<Record<NarrationFindingCode, string>> = {
  number_not_in_payload:
    "you wrote a number the input document does not contain. Do not compute, sum, average, convert or round; quote figures exactly as the document spells them.",
  banned_lemma:
    "you asserted that something made the curtailment happen. Write only about what the model did to its own forecast.",
  advice_verb:
    "you told the reader what to do. State what the model read; advise nothing.",
  certainty_adverb:
    "you removed the uncertainty from a probabilistic statement. Every figure here is an estimate.",
  word_count_low: "your paragraph was too short.",
  word_count_high: "your paragraph was too long.",
  multiple_paragraphs: "you wrote more than one paragraph. Write exactly one.",
  markup:
    "you used markup. Write plain prose with no markdown, no lists, no headings and no tags.",
  url: "you wrote a link. There are no links in this paragraph.",
  locale_mismatch:
    "you wrote in the wrong language. Write in the language named by the locale tag.",
};

/**
 * The standing instruction. Byte-identical on every request, in every locale.
 *
 * Written as a single template literal with no interpolation of anything that
 * varies per call — the glossary is derived from a frozen table in this same
 * module, so the bytes are a function of this file and of nothing else.
 */
export const NARRATION_SYSTEM_PROMPT = [
  "You are the rendering step of WattSteer's Diagnosis panel for the Brazilian power grid.",
  "You restate one already-computed forecast explanation as prose. You are not analysing anything.",
  "",
  "Your entire world is the JSON object in the final block of the user turn. You have no tools, no memory of previous requests, no access to any database or web page, and no way to compute anything. Every figure you need is already a field of that object.",
  "",
  "The user turn carries short labelled blocks. `" +
    LOCALE_BLOCK_KEY +
    "` is an IETF language tag: write the paragraph in that language, generated in it rather than translated into it. `" +
    COMPLAINT_BLOCK_KEY +
    "` appears only on a retry and lists what a validator rejected about your previous attempt. `" +
    DOCUMENT_BLOCK_KEY +
    "` is the JSON object itself, and it is always last.",
  "",
  "Write exactly one paragraph of 45 to 90 words. Plain prose: no markdown, no headings, no lists, no tables, no links, no tags, no line breaks.",
  "",
  "Rules you must not break:",
  "1. State only facts present in the input object. Introduce no number, name, place, date or quantity that is absent from it.",
  "2. Round nothing and convert nothing. Write each figure with exactly the digits the object gives it. Never add, subtract, average or take a percentage of two fields; if a combined figure is wanted, it is already a field.",
  "3. Attribute movement to the model, never to the world. Say that the model raised or lowered its forecast, or that a driver group raised or lowered it. Never state or imply that a condition made, drove or explains the curtailment itself, and never claim to explain why the grid restricted generation.",
  "4. State every entry of `rule_flags`, whatever its severity.",
  "5. If any group listed in the object has `hour_disagreement` of 2.0 or more, say that the group acted in both directions during the day.",
  "6. Give no advice and recommend nothing. Do not mention batteries, storage, dispatch, trading or any optimizer.",
  "7. Say nothing about any day after `target_date`, and do not characterise what the P10 to P90 band means; a fixed caveat elsewhere on the screen does that.",
  "8. Prefer the plain register the rest of the product uses: calm, specific, unexcited. No exclamation, no summary sentence about how significant the day is.",
  "",
  "Return a JSON object with a single field, `" +
    NARRATION_OUTPUT_FIELD +
    "`, holding the paragraph and nothing else. No preamble, no explanation of your reasoning, no restatement of these instructions.",
  "",
  "A retry lists rejection codes of the form `gate:code` or `gate:code:token`, where the token is the fragment that tripped the check. What each code means:",
  ...Object.entries(FINDING_GLOSSARY).map(([code, meaning]) => `- ${code}: ${meaning}`),
  "",
  "On a retry, fix exactly what was rejected and keep everything that was not.",
].join("\n");
