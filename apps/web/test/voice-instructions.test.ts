import { describe, expect, test } from "bun:test";
import { LOCALES } from "../src/i18n/locale";
import { TOOL_REFUSAL_CODES } from "../src/lib/voice/execute";
import {
  INSTRUCTED_TOOLS,
  INSTRUCTION_CLAUSES,
  INSTRUCTION_LOCALES,
  INSTRUCTIONS,
  voiceInstructions,
} from "../src/lib/voice/instructions";
import { TOOL_NAMES } from "../src/lib/voice/tools";

/**
 * The honesty contract, in both locales, moving together.
 *
 * `copy.en.ts` explains why its own shape is a type rather than a key table:
 * “a missing key is a runtime fallback, silently.” The stake is higher here.
 * A dictionary missing a label renders a blank; a prompt missing the
 * "never invent a figure" clause produces a Portuguese agent with weaker rules
 * than the English one, speaking confidently to the audience the product was
 * built for. So the two locales are asserted key-for-key, and the four clauses
 * the plan calls non-negotiable are asserted by name.
 */

const NON_NEGOTIABLE = ["never_invent", "band_is_three", "gate_refusal", "refusals"];

describe("both locales carry the same contract", () => {
  test("the prompt exists in every locale the site has", () => {
    expect(INSTRUCTION_LOCALES).toEqual(LOCALES);
    expect(Object.keys(INSTRUCTIONS).sort()).toEqual([...LOCALES].sort());
  });

  test("both locales carry exactly the same clause keys", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(INSTRUCTIONS[locale]).sort()).toEqual(
        [...INSTRUCTION_CLAUSES].sort(),
      );
    }
  });

  test("no clause is empty in either locale", () => {
    for (const locale of LOCALES) {
      for (const clause of INSTRUCTION_CLAUSES) {
        expect(INSTRUCTIONS[locale][clause].trim().length).toBeGreaterThan(40);
      }
    }
  });

  test("Portuguese is authored, not left in English", () => {
    for (const clause of INSTRUCTION_CLAUSES) {
      expect(INSTRUCTIONS.pt[clause]).not.toBe(INSTRUCTIONS.en[clause]);
    }
    // The clause that matters most is stated in the language the answer will be
    // given in.
    expect(INSTRUCTIONS.pt.band_is_three).toContain("TRÊS números");
  });

  test("the four non-negotiable clauses exist and are named", () => {
    for (const clause of NON_NEGOTIABLE) {
      expect(INSTRUCTION_CLAUSES).toContain(clause as never);
    }
  });
});

describe("the four rules the plan will not trade", () => {
  test("no figure outside the context block", () => {
    expect(INSTRUCTIONS.en.never_invent).toContain("NEVER state a figure");
    expect(INSTRUCTIONS.pt.never_invent).toContain("NUNCA diga um número");
    for (const locale of LOCALES) {
      expect(INSTRUCTIONS[locale].never_invent.toLowerCase()).toMatch(/estimate|estime/);
    }
  });

  test("a band is three numbers and a P50 may not be spoken alone", () => {
    for (const locale of LOCALES) {
      const clause = INSTRUCTIONS[locale].band_is_three;
      expect(clause).toContain("P10");
      expect(clause).toContain("P50");
      expect(clause).toContain("P90");
      // The prohibition itself, not merely the three names.
      expect(clause.toLowerCase()).toMatch(/never speak a p50|nunca fale um p50/);
    }
  });

  test("never 'the model predicts' while nothing is promoted", () => {
    expect(INSTRUCTIONS.en.gate_refusal).toContain("the model predicts");
    expect(INSTRUCTIONS.pt.gate_refusal).toContain("o modelo prevê");
    for (const locale of LOCALES) {
      // The gate refusing is the gate working, and the voice should sound like
      // someone who knows that — plan §4.3.
      expect(INSTRUCTIONS[locale].gate_refusal.toLowerCase()).toMatch(
        /gate working|portão funcionando/,
      );
      // What survives with no model is the observed record.
      expect(INSTRUCTIONS[locale].gate_refusal.toLowerCase()).toMatch(
        /observed|observado/,
      );
    }
  });

  test("every refusal code the executor can produce is something the voice can say", () => {
    for (const locale of LOCALES) {
      const clause = INSTRUCTIONS[locale].refusals;
      for (const code of TOOL_REFUSAL_CODES) {
        // A code the prompt has never heard of reaches the reader as silence,
        // which is the failure that makes an agent feel broken. `scenario_refused`
        // is the one that arrives with an `ErrorCode` attached, and the refusals
        // clause covers the whole list.
        expect(clause).toContain(code);
      }
      expect(clause.toLowerCase()).toMatch(/never becomes|nunca vira/);
    }
  });
});

describe("the remaining clauses", () => {
  test("every tool is named in both locales", () => {
    for (const locale of LOCALES) {
      for (const tool of INSTRUCTED_TOOLS) {
        expect(INSTRUCTIONS[locale].tools).toContain(tool);
      }
    }
    expect(INSTRUCTED_TOOLS).toEqual(TOOL_NAMES);
  });

  test("highlight is described as the one that does not navigate", () => {
    expect(INSTRUCTIONS.en.tools).toContain("WITHOUT navigating");
    expect(INSTRUCTIONS.pt.tools).toContain("SEM navegar");
  });

  test("the four subsystem codes are the only ones offered", () => {
    for (const locale of LOCALES) {
      expect(INSTRUCTIONS[locale].tools).toMatch(/N, NE, SE (and|e) S/);
    }
  });

  test("brevity is instructed — these are spoken aloud", () => {
    expect(INSTRUCTIONS.en.brevity).toContain("Two sentences");
    expect(INSTRUCTIONS.pt.brevity).toContain("Duas frases");
  });

  test("ambiguity resolves to a tool call, not a clarifying question", () => {
    expect(INSTRUCTIONS.en.prefer_showing).toContain("which region?");
    expect(INSTRUCTIONS.pt.prefer_showing).toContain("qual região?");
  });

  test("each locale is told to answer in its own language", () => {
    expect(INSTRUCTIONS.pt.locale).toContain("português do Brasil");
    expect(INSTRUCTIONS.en.locale).toContain("in English");
  });
});

describe("the assembled prompt", () => {
  test("it carries every clause, in the declared order", () => {
    for (const locale of LOCALES) {
      const prompt = voiceInstructions(locale);
      let cursor = -1;
      for (const clause of INSTRUCTION_CLAUSES) {
        const at = prompt.indexOf(INSTRUCTIONS[locale][clause]);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
    }
  });

  test("the honesty clauses sit above the tool descriptions", () => {
    // A prompt that explained the capabilities first would be a prompt whose
    // limits compete with a wall of capability.
    for (const locale of LOCALES) {
      const prompt = voiceInstructions(locale);
      expect(prompt.indexOf(INSTRUCTIONS[locale].never_invent)).toBeLessThan(
        prompt.indexOf(INSTRUCTIONS[locale].tools),
      );
      expect(prompt.indexOf(INSTRUCTIONS[locale].band_is_three)).toBeLessThan(
        prompt.indexOf(INSTRUCTIONS[locale].tools),
      );
    }
  });

  test("the context block is appended last, under a header", () => {
    const prompt = voiceInstructions("pt", "NO FORECAST IS AVAILABLE for this day.");
    expect(prompt).toContain("--- CONTEXT (pt-BR) ---");
    expect(prompt.indexOf("--- CONTEXT")).toBeGreaterThan(
      prompt.indexOf(INSTRUCTIONS.pt.refusals),
    );
    expect(prompt.endsWith("NO FORECAST IS AVAILABLE for this day.")).toBe(true);
  });

  test("an absent or blank context adds no header", () => {
    for (const context of [undefined, "", "   "]) {
      expect(voiceInstructions("en", context)).not.toContain("--- CONTEXT");
    }
  });

  test("the two prompts are different documents", () => {
    expect(voiceInstructions("pt")).not.toBe(voiceInstructions("en"));
    expect(voiceInstructions("pt").length).toBeGreaterThan(1000);
  });
});
