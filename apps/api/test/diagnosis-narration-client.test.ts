import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { sha256Hex } from "@wattsteer/core/sha256";
import {
  COMPLAINT_BLOCK_KEY,
  canonicalNarrationJson,
  DOCUMENT_BLOCK_KEY,
  type FiredRule,
  LOCALE_BLOCK_KEY,
  NARRATION_EFFORT,
  NARRATION_MAX_TOKENS,
  NARRATION_MODEL_ID,
  NARRATION_OUTPUT_FIELD,
  NARRATION_OUTPUT_SCHEMA,
  NARRATION_PROMPT_VERSION,
  NARRATION_SYSTEM_PROMPT,
  type NarrationMessages,
  NarrationModelError,
  narrationRequest,
  narrationText,
  type RejectedNarration,
  renderDiagnosisNarration,
  toNarrationDocument,
} from "../src/diagnosis/index.js";
import { narrationPayload as payload, SUM_ABS } from "./support/narration-payload.js";

/**
 * Seam 11 — the renderer contract, without calling the API.
 *
 * `docs/specs/diagnosis.md` asks for exactly this file: *"the assembled request
 * carries no tools, the system block is byte-identical across two different
 * payloads (so caching can work), the payload block is last, the model id and
 * effort match this spec, and the locale in the prompt matches the request"* —
 * asserted on the request rather than on the response, so a commit can run it.
 *
 * **Nothing here spends money and nothing here needs a key.** The request
 * builder is pure, and every call that has a model in it is given a stand-in
 * for the SDK's `messages`. The one test in this spec that talks to the real
 * model is `diagnosis-narration-live.test.ts`, which is scheduled, gated on an
 * env var, and skipped by the default `bun test test`.
 *
 * The three properties this file is trying to make impossible:
 *
 *  1. **A renderer that could reason.** A tool, a second turn, a conversation
 *     or a schema with room for a rationale would each make the model a
 *     participant in the answer rather than the thing that writes it down.
 *  2. **A withheld day reaching the model.** Diagnosis 07 made the model
 *     narration a thunk the gate declines to call; a client that awaited it
 *     first would have spent the call before the rule was read. The assertion
 *     is on the stand-in never being invoked.
 *  3. **A cached prefix nobody notices has stopped working.** A cache miss and
 *     a cache hit look identical from outside, so the system block's stability
 *     is asserted directly, across payloads and across locales.
 */

/**
 * A clean paragraph in each locale, quoting only figures the document carries.
 *
 * The same two the validator suite is built on, and hand-written there for the
 * same reason: a fixture chosen by the model is a fixture chosen by the thing
 * the gate exists to catch.
 */
const CLEAN_PT = [
  "Para o NORDESTE em 28 de agosto de 2026, o modelo lê o risco de restrição",
  "acima de 5 MW como alto: 87% para pelo menos uma hora, com 9 horas cuja P50",
  "fica acima de zero. Ele espera 412,0 MWh no dia inteiro, contra um típico",
  "96,0 MWh, uma diferença de 316,0 MWh que os grupos dividem entre si. A maior",
  "hora é 13:00, com uma mediana de 118,0 MW.",
].join(" ");

const CLEAN_EN = [
  "For NORDESTE on 28 August 2026, the model reads the risk of curtailment",
  "above 5 MW as high: 87% for at least one hour, with 9 hours whose P50 is",
  "above zero. It expects 412.0 MWh over the whole day against a typical 96.0",
  "MWh, a difference of 316.0 MWh that the driver groups divide between them.",
  "The largest hour is 13:00, at a median 118.0 MW.",
].join(" ");

/** A number the document does not carry: the sum of the top two `phi`. */
const INVENTED = CLEAN_PT.replace("316,0 MWh que os grupos", "256,0 MWh que os grupos");

/** One `annotate` rule, and one that withholds. */
const STALE: FiredRule = {
  code: "stale_inputs",
  action: "annotate",
  facts: { weather_run_age_hours: 12 },
};
const NOISE: FiredRule = {
  code: "attribution_is_noise",
  action: "withhold",
  facts: { sum_abs_attributed_mwh: SUM_ABS, attribution_stderr_mwh: 4.1 },
};

/** The SDK's `messages`, standing in: it records what it was sent. */
function stub(texts: readonly string[]): NarrationMessages & {
  sent: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    sent,
    create: async (params) => {
      sent.push(params);
      const text = texts[sent.length - 1] ?? texts.at(-1) ?? "";
      return {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: NARRATION_MODEL_ID,
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [
          {
            type: "text",
            text: JSON.stringify({ [NARRATION_OUTPUT_FIELD]: text }),
            citations: null,
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Anthropic.Message;
    },
  };
}

/** The blocks of the one user turn, as text. */
function userBlocks(request: Anthropic.MessageCreateParamsNonStreaming): string[] {
  const content = request.messages[0]?.content;
  if (!Array.isArray(content)) {
    throw new Error("the user turn is not a list of blocks");
  }
  return content.map((block) => (block.type === "text" ? block.text : block.type));
}

function systemText(request: Anthropic.MessageCreateParamsNonStreaming): string {
  const system = request.system;
  if (!Array.isArray(system)) {
    throw new Error("the system prompt is not a list of blocks");
  }
  return system.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("narrationRequest · the call parameters, asserted without making one", () => {
  it("matches the spec's table: model, effort, max_tokens, one-field schema", () => {
    const request = narrationRequest({ payload: payload() });
    expect(request.model).toBe("claude-opus-5");
    expect(NARRATION_MODEL_ID).toBe("claude-opus-5");
    expect(request.max_tokens).toBe(700);
    expect(NARRATION_MAX_TOKENS).toBe(700);
    expect(request.output_config?.effort).toBe("low");
    expect(NARRATION_EFFORT).toBe("low");
    // Structured outputs, one field, closed: a preamble has nowhere to go.
    expect(request.output_config?.format).toEqual({
      type: "json_schema",
      schema: NARRATION_OUTPUT_SCHEMA,
    });
    expect(NARRATION_OUTPUT_SCHEMA).toEqual({
      type: "object",
      properties: { narration: { type: "string" } },
      required: ["narration"],
      additionalProperties: false,
    });
  });

  it("carries no tools, declared as none rather than omitted", () => {
    const request = narrationRequest({ payload: payload() });
    expect(request.tools).toEqual([]);
    // The absence is a value, so deleting it is an edit somebody has to make.
    expect("tools" in request).toBe(true);
    // And nothing that would give the model a second way to act.
    expect(request.tool_choice).toBeUndefined();
    expect(request.mcp_servers).toBeUndefined();
    expect(request.container).toBeUndefined();
  });

  it("leaves thinking at the model's default rather than disabling it", () => {
    // The spec is explicit: disabling it on this model risks leaked reasoning
    // tags and tool-call text in the visible response, and a leaked tag is
    // exactly the failure the three gates cannot see — it is not a number, not
    // a lemma, and a paragraph carrying one can still be 60 words long.
    const request = narrationRequest({ payload: payload() });
    expect(request.thinking).toBeUndefined();
  });

  it("sends one user turn and no conversation history", () => {
    const request = narrationRequest({ payload: payload() });
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    // Non-streaming: one short paragraph does not need a stream.
    expect(request.stream).toBeUndefined();
  });

  it("keeps the system block byte-identical across payloads and locales", () => {
    const one = narrationRequest({ payload: payload() });
    const two = narrationRequest({
      payload: payload({
        locale: "en-US",
        subsystem: "S",
        subsystemDisplayName: "SUL",
        targetDate: "2026-09-04",
        ruleFlags: [{ code: "stale_inputs", severity: "annotate", facts: {} }],
      }),
    });
    const retry = narrationRequest({
      payload: payload(),
      complaint: "numeric:number_not_in_payload:8",
    });
    expect(systemText(two)).toBe(systemText(one));
    expect(systemText(retry)).toBe(systemText(one));
    expect(systemText(one)).toBe(NARRATION_SYSTEM_PROMPT);
    // The breakpoint is on that block, which is what makes the stability pay.
    const system = one.system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(1);
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("puts the payload block last, and puts nothing else after it", () => {
    const blocks = userBlocks(narrationRequest({ payload: payload() }));
    expect(blocks.at(-1)?.startsWith(`${DOCUMENT_BLOCK_KEY}:`)).toBe(true);
    const retry = userBlocks(
      narrationRequest({ payload: payload(), complaint: "lexical:advice_verb:deve" }),
    );
    expect(retry.at(-1)?.startsWith(`${DOCUMENT_BLOCK_KEY}:`)).toBe(true);
    // The complaint goes between the stable head and the volatile tail.
    expect(retry).toHaveLength(3);
    expect(retry[1]).toBe(`${COMPLAINT_BLOCK_KEY}: lexical:advice_verb:deve`);
  });

  it("sends the canonical document, the same bytes the digest and gate read", () => {
    // Not a cosmetic choice. The numeric whitelist is built from this form,
    // with every float already at its display precision; a raw document would
    // show the model `128.00000000000003` and the gate would then reject the
    // faithful quotation of it as an invented number.
    const input = payload();
    const blocks = userBlocks(narrationRequest({ payload: input }));
    const canonical = canonicalNarrationJson(toNarrationDocument(input));
    expect(blocks.at(-1)).toBe(`${DOCUMENT_BLOCK_KEY}:\n${canonical}`);
    // Which is also the document as the renderer's world: snake_case, closed.
    expect(canonical).toContain('"schema_version":"diagnosis.narration.v1"');
  });

  it("puts the requested locale in the prompt, and the same one in the request", () => {
    for (const locale of ["pt-BR", "en-US"] as const) {
      const input = payload({ locale });
      const blocks = userBlocks(narrationRequest({ payload: input }));
      expect(blocks[0]).toBe(`${LOCALE_BLOCK_KEY}: ${locale}`);
      // And in the document itself, which is where it also reaches the gate.
      expect(blocks.at(-1)).toContain(`"locale":"${locale}"`);
    }
  });

  it("names no locale in the system block, which is what lets it be one block", () => {
    // A prompt that interpolated the locale would be two prompts and would
    // halve the cache. The instruction points at the block instead.
    expect(NARRATION_SYSTEM_PROMPT).not.toContain("pt-BR");
    expect(NARRATION_SYSTEM_PROMPT).not.toContain("en-US");
    expect(NARRATION_SYSTEM_PROMPT).toContain(LOCALE_BLOCK_KEY);
  });

  it("pins the prompt version to the prompt's bytes", () => {
    // A prompt edit that keeps the version silently serves yesterday's prose
    // from the cache under today's instruction, because `prompt_version` is a
    // component of the key. So the digest is written down: editing the prompt
    // fails here until the version is bumped and this line is updated with it.
    const digest = sha256Hex(new TextEncoder().encode(NARRATION_SYSTEM_PROMPT));
    expect({ version: NARRATION_PROMPT_VERSION, digest }).toEqual({
      version: "2026-08-28.1",
      digest: "6ea8a299e003ba5102c565910cc27acc518e7530589525f54ca673e3565c8108",
    });
  });
});

describe("narrationText · what comes back, and what is refused", () => {
  const message = (over: Partial<Anthropic.Message>): Anthropic.Message =>
    ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ narration: CLEAN_EN }) }],
      ...over,
    }) as unknown as Anthropic.Message;

  it("reads the one field the schema asked for", () => {
    expect(narrationText(message({}))).toBe(CLEAN_EN);
  });

  it("refuses a truncated response rather than salvaging half a paragraph", () => {
    // A paragraph that stops mid-sentence can pass all three gates: it has no
    // invented number, no banned lemma and may well be 40 words long.
    expect(() => narrationText(message({ stop_reason: "max_tokens" }))).toThrow(
      NarrationModelError,
    );
  });

  it("refuses a decline, a non-JSON body and a missing field", () => {
    expect(() => narrationText(message({ stop_reason: "refusal" }))).toThrow(
      NarrationModelError,
    );
    expect(() =>
      narrationText(message({ content: [{ type: "text", text: "sorry" }] as never })),
    ).toThrow(NarrationModelError);
    expect(() =>
      narrationText(
        message({ content: [{ type: "text", text: '{"other":"x"}' }] as never }),
      ),
    ).toThrow(NarrationModelError);
    expect(() => narrationText(message({ content: [] }))).toThrow(NarrationModelError);
  });
});

describe("renderDiagnosisNarration · the gate, the validator and the model, composed", () => {
  it("returns the model's paragraph and says it came from the model", async () => {
    const messages = stub([CLEAN_PT]);
    const result = await renderDiagnosisNarration({
      payload: payload(),
      ruleFlags: [STALE],
      messages,
    });
    expect(result.source).toBe("model");
    expect(result.narration).toEqual({
      source: "model",
      text: CLEAN_PT,
      locale: "pt-BR",
      promptVersion: NARRATION_PROMPT_VERSION,
    });
    expect(result.attempts).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.withheldBy).toEqual([]);
    expect(messages.sent).toHaveLength(1);
  });

  it("generates in the requested locale, with no translation and no round trip", async () => {
    const messages = stub([CLEAN_EN]);
    const result = await renderDiagnosisNarration({
      payload: payload({ locale: "en-US" }),
      ruleFlags: [],
      messages,
    });
    expect(result.narration).toMatchObject({ source: "model", locale: "en-US" });
    // One call. A translation layer would be a second one, or a second turn.
    expect(messages.sent).toHaveLength(1);
    expect(messages.sent[0]?.messages).toHaveLength(1);
    expect(userBlocks(messages.sent[0] as never)[0]).toBe(`${LOCALE_BLOCK_KEY}: en-US`);
  });

  it("retries once with the complaint, then renders the template", async () => {
    const rejected: RejectedNarration[] = [];
    const messages = stub([INVENTED, INVENTED]);
    const result = await renderDiagnosisNarration({
      payload: payload(),
      ruleFlags: [],
      messages,
      onRejected: (one) => rejected.push(one),
    });
    expect(messages.sent).toHaveLength(2);
    // The first attempt carries no complaint; the second carries the first's.
    expect(userBlocks(messages.sent[0] as never)).toHaveLength(2);
    const second = userBlocks(messages.sent[1] as never);
    expect(second).toHaveLength(3);
    expect(second[1]).toContain(`${COMPLAINT_BLOCK_KEY}: numeric:number_not_in_payload`);
    // And the rejected text is logged and never returned.
    expect(result.source).toBe("template");
    expect(result.narration.source).toBe("template");
    expect(JSON.stringify(result.narration)).not.toContain("256,0");
    expect(rejected.map((one) => one.attempt)).toEqual([1, 2]);
    expect(result.attempts).toBe(2);
  });

  it("never calls the model on a withheld day", async () => {
    // Diagnosis 07's guarantee, routed through rather than around: the model
    // branch is a thunk and a `withhold` rule means it is not invoked. Asserted
    // on the stand-in never being called, which is the only honest form of it.
    const messages = stub([CLEAN_PT]);
    const result = await renderDiagnosisNarration({
      payload: payload(),
      ruleFlags: [STALE, NOISE],
      messages,
    });
    expect(messages.sent).toEqual([]);
    expect(result.attempts).toBe(0);
    expect(result.source).toBe("template");
    expect(result.withheldBy).toEqual(["attribution_is_noise"]);
    // The drivers are untouched: withholding acts on the narration only, and
    // this function is never handed a driver list to act on in the first place.
    expect(result.narration.source).toBe("template");
  });

  it("renders the template when the model is unreachable, without a retry", async () => {
    // An outage is not a rejection. The validator deliberately lets the throw
    // through so the two stay different events; this is the caller that
    // catches it, and it does not pay for a second call on the way down.
    let calls = 0;
    const messages: NarrationMessages = {
      create: async () => {
        calls += 1;
        throw new Error("connection refused");
      },
    };
    const result = await renderDiagnosisNarration({
      payload: payload(),
      ruleFlags: [],
      messages,
    });
    expect(result.source).toBe("template");
    expect(result.attempts).toBe(0);
    expect(calls).toBe(1);
  });

  it("needs no API key on any path a commit runs", async () => {
    // The client is constructed lazily, inside the attempt. Importing this
    // module — which every narration suite does — reads no credential, and a
    // stand-in means none is ever needed.
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => narrationRequest({ payload: payload() })).not.toThrow();
      const result = await renderDiagnosisNarration({
        payload: payload(),
        ruleFlags: [],
        messages: stub([CLEAN_PT]),
      });
      expect(result.source).toBe("model");
    } finally {
      if (before !== undefined) {
        process.env.ANTHROPIC_API_KEY = before;
      }
    }
  });
});
