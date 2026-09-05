import type Anthropic from "@anthropic-ai/sdk";
import type { DiagnosisNarrationInput, Narration } from "@wattsteer/core/api";
import { UpstreamError } from "../errors.js";
import { canonicalNarrationJson } from "./narration-canonical.js";
import { type NarrationSource, renderNarration } from "./narration-gate.js";
import { toNarrationDocument } from "./narration-payload.js";
import {
  COMPLAINT_BLOCK_KEY,
  DOCUMENT_BLOCK_KEY,
  LOCALE_BLOCK_KEY,
  NARRATION_OUTPUT_FIELD,
  NARRATION_OUTPUT_SCHEMA,
  NARRATION_SYSTEM_PROMPT,
} from "./narration-prompt.js";
import { templateNarration } from "./narration-template.js";
import {
  type NarrationAttempt,
  type RejectedNarration,
  validatedNarration,
} from "./narration-validator.js";
import type { FiredRule } from "./publication.js";

/**
 * The call that hands a closed document to a language model and gets prose back.
 *
 * This is the last piece of the narration path and the only one that leaves the
 * process. Everything it is allowed to do was decided by the four modules
 * before it, and this module's job is to make those decisions properties of the
 * **request** rather than of a prompt anyone has to keep reading:
 *
 * | Decision | Where it became structural |
 * |---|---|
 * | The model may not use tools | `tools: []` on every request, asserted |
 * | The model may not compute | it is sent the canonical document, whose floats are already at display precision, and the numeric gate refuses anything else |
 * | The model may not be reached on a withheld day | the call is a thunk, handed to `./narration-gate.ts`'s `renderNarration`, which declines to invoke it |
 * | The model gets at most two tries | `./narration-validator.ts`'s `validatedNarration`, which owns the retry and the fall back to the template |
 * | The system block can be cached | it is a constant in `./narration-prompt.ts` and nothing per-request is interpolated into it |
 *
 * ### It is a renderer, and the request is what says so
 *
 * `docs/specs/diagnosis.md`: *"It renders. It never decides."* Four properties
 * make that true of the call rather than of the instruction:
 *
 * 1. **No tools, declared as none.** `tools: []` is sent explicitly rather than
 *    omitted, so the absence is a value a test can read and a future edit has
 *    to delete on purpose. With no tool the model has no retrieval, no web
 *    access, no database and no code execution — those are not forbidden by the
 *    prompt, they are absent from the request.
 * 2. **No conversation.** One user turn, built fresh from the document. There
 *    is no history to carry a fact from yesterday's paragraph into today's.
 * 3. **A one-field output schema.** `{ narration: string }` with
 *    `additionalProperties: false`, so a preamble, a rationale or a second
 *    field has nowhere to go.
 * 4. **Adaptive thinking, at low effort.** `thinking` is left at the model's
 *    default rather than disabled: disabling it on this model risks leaked
 *    reasoning tags and tool-call text in the visible response, which is
 *    precisely the failure this gate cannot catch — a tag is not a number.
 *    `output_config.effort: "low"` buys the cost back, and the task is
 *    restatement under constraint rather than reasoning.
 *
 * ### The document is sent canonical, not raw
 *
 * `canonicalNarrationJson` is the same form `./narration-canonical.ts` hashes
 * for the cache key and the same form `./narration-validator.ts` builds the
 * numeric whitelist from. Sending anything else would put digits in front of
 * the model that the whitelist does not admit — a `phi_mwh` of
 * `128.00000000000003` would be quoted faithfully and rejected as invented. So
 * the three surfaces read one set of bytes: what was hashed is what was shown
 * is what is allowed.
 *
 * ### What this module does not do
 *
 * It does not cache and it does not count. The Redis entry keyed by
 * `narrationCacheKey` and the global daily cap are the gateway's, next to the
 * endpoint that serves the panel; both sit *outside* this call and both fall
 * back to the same template this module falls back to.
 */

/** The renderer. `docs/specs/diagnosis.md`: no cost argument for a weaker one. */
export const NARRATION_MODEL_ID = "claude-opus-5";

/** Restatement under constraint is not reasoning. */
export const NARRATION_EFFORT = "low";

/** One short paragraph, non-streaming. */
export const NARRATION_MAX_TOKENS = 700;

/** A model call that could not produce a paragraph. Never shown to a reader. */
export class NarrationModelError extends UpstreamError {
  constructor(message: string) {
    super(`narration model: ${message}`);
    this.name = "NarrationModelError";
  }
}

/**
 * The slice of the SDK this module uses, named so a test can stand in for it.
 *
 * Structural rather than a mock of the client class: the unit worth testing is
 * "what did we send and what did we do with what came back", and a test that
 * had to construct an `Anthropic` instance would need an API key to assert a
 * request that is never sent.
 */
export interface NarrationMessages {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

/** Everything one request varies on. Three values, all of them codes. */
export interface NarrationRequestParts {
  /** The closed document, in the app's casing. */
  payload: DiagnosisNarrationInput;
  /** The validator's complaint from the previous attempt, on a retry only. */
  complaint?: string;
}

/**
 * The whole request, assembled and returnable without sending it.
 *
 * Pure on purpose: `docs/specs/diagnosis.md` seam 11 is *"the renderer
 * contract, without calling the API"*, and a contract that could only be
 * inspected by making a call would be a contract nobody asserts on a commit.
 *
 * The block order is the caching order — stable prefix first, volatile content
 * last. `system` is a constant; the user turn is the locale tag, then the
 * complaint when there is one, then the document.
 */
export function narrationRequest(
  parts: NarrationRequestParts,
): Anthropic.MessageCreateParamsNonStreaming {
  const { payload, complaint } = parts;
  const document = toNarrationDocument(payload);
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: `${LOCALE_BLOCK_KEY}: ${payload.locale}` },
  ];
  if (complaint !== undefined && complaint !== "") {
    blocks.push({ type: "text", text: `${COMPLAINT_BLOCK_KEY}: ${complaint}` });
  }
  // Last, always: the one block that changes every day.
  blocks.push({
    type: "text",
    text: `${DOCUMENT_BLOCK_KEY}:\n${canonicalNarrationJson(document)}`,
  });
  return {
    model: NARRATION_MODEL_ID,
    max_tokens: NARRATION_MAX_TOKENS,
    // Declared as none rather than omitted: an empty list is a statement, and a
    // statement is what a test can hold a future edit to.
    tools: [],
    system: [
      {
        type: "text",
        text: NARRATION_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      effort: NARRATION_EFFORT,
      format: { type: "json_schema", schema: NARRATION_OUTPUT_SCHEMA },
    },
    messages: [{ role: "user", content: blocks }],
  };
}

/**
 * The paragraph out of a response, or a refusal to guess at one.
 *
 * The structured output makes the happy path a single text block holding one
 * JSON object. Everything else — a refusal, a truncation, a missing field — is
 * an error rather than a salvage attempt: a half-written paragraph that stops
 * mid-sentence would pass the lexical gate and might pass the numeric one.
 */
export function narrationText(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") {
    throw new NarrationModelError(
      `the model declined: ${message.stop_details?.category ?? ""}`,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new NarrationModelError(
      "the response hit max_tokens; a truncated paragraph is not a short one",
    );
  }
  const text = message.content.find((block) => block.type === "text");
  if (text === undefined) {
    throw new NarrationModelError("the response carried no text block");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    throw new NarrationModelError("the response was not the JSON the schema asked for");
  }
  const field =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)[NARRATION_OUTPUT_FIELD]
      : undefined;
  if (typeof field !== "string" || field.trim() === "") {
    throw new NarrationModelError(`the response carried no ${NARRATION_OUTPUT_FIELD}`);
  }
  return field;
}

/** How the model is reached. Injected so the default path needs no key. */
export interface NarrationCallSources {
  payload: DiagnosisNarrationInput;
  /** The SDK's `messages`. Omitted, a client is constructed on first call. */
  messages?: NarrationMessages;
}

/**
 * One model call, as the thunk `validatedNarration` retries.
 *
 * The client is constructed lazily and only when a call is actually made, so
 * importing this module — which every narration test does — never reads or
 * requires `ANTHROPIC_API_KEY`. A deployment with no key fails at the call,
 * where the caller already falls back to the template, rather than at boot.
 */
export function narrationAttempt(sources: NarrationCallSources): NarrationAttempt {
  return async (complaint) => {
    const messages = sources.messages ?? (await defaultMessages());
    const response = await messages.create(
      narrationRequest({ payload: sources.payload, complaint }),
    );
    return narrationText(response);
  };
}

async function defaultMessages(): Promise<NarrationMessages> {
  const { default: Client } = await import("@anthropic-ai/sdk");
  return new Client().messages;
}

/** What rendered, which surface it came from, and what was thrown away. */
export interface RenderedDiagnosisNarration {
  narration: Narration;
  /** `model` or `template`. The panel's footnote states this. */
  source: NarrationSource;
  /** The rules that withheld the model narration, in the order they fired. */
  withheldBy: string[];
  /** Model calls actually made: 0 when withheld or unavailable, else 1 or 2. */
  attempts: number;
  /** Rejected paragraphs, logged and never returned to a client. */
  rejected: RejectedNarration[];
}

/** Everything the whole narration decision needs. */
export interface DiagnosisNarrationSources extends NarrationCallSources {
  /** Every rule that fired, as stored on the attribution row. */
  ruleFlags: readonly FiredRule[];
  /** Where a rejected paragraph goes. Defaults to the validator's log sink. */
  onRejected?: (rejected: RejectedNarration) => void;
}

/**
 * The narration, through whichever surface the rules and the model permit.
 *
 * The one place the three decisions compose, and the order is the point:
 *
 * 1. **The gate first.** `renderNarration` is handed the model branch as a
 *    thunk and declines to call it when a rule withheld, so a withheld day is
 *    never a request. That guarantee lives in `./narration-gate.ts` and this
 *    function's only job is not to route around it.
 * 2. **The validator inside the thunk.** Two attempts at most, the complaint
 *    appended to the second, and the template on a second failure.
 * 3. **An outage is the third branch.** A throw from the SDK — no key, a 500, a
 *    timeout — lands here and renders the template. The validator deliberately
 *    does not swallow it, so that "the model was down" and "the model lied"
 *    stay two different events in the log; this is the caller the note means.
 *
 * `attempts` counts calls that were made, so it is 0 on a withheld day and 0 on
 * an outage, which is the number an operator wants when the bill is questioned.
 */
export async function renderDiagnosisNarration(
  sources: DiagnosisNarrationSources,
): Promise<RenderedDiagnosisNarration> {
  const { payload, ruleFlags, messages, onRejected } = sources;
  let attempts = 0;
  let rejected: RejectedNarration[] = [];
  const rendered = await renderNarration<Narration>(ruleFlags, {
    model: async () => {
      try {
        const result = await validatedNarration({
          payload,
          attempt: narrationAttempt({ payload, messages }),
          onRejected,
        });
        attempts = result.attempts;
        rejected = result.rejected;
        return result.narration;
      } catch (error) {
        // The model was unreachable rather than wrong. The template is already
        // the answer for a withheld day and for a capped one; it is the answer
        // here too, and the reason is logged rather than returned.
        console.warn(
          JSON.stringify({
            narration_unavailable: {
              locale: payload.locale,
              promptVersion: payload.promptVersion,
              reason: error instanceof Error ? error.message : String(error),
            },
          }),
        );
        return templateNarration(payload);
      }
    },
    template: () => templateNarration(payload),
  });
  return {
    narration: rendered.narration,
    // What actually rendered, which is not always what the gate permitted: a
    // rejected paragraph or an outage turns a permitted `model` into a
    // `template`, and the footnote has to say the true one.
    source: rendered.narration.source,
    withheldBy: rendered.withheldBy,
    attempts,
    rejected,
  };
}
