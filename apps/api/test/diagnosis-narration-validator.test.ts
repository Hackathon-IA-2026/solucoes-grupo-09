import { describe, expect, it } from "bun:test";
import { CAUSALITY_BANNED_LEMMAS } from "@wattsteer/core";
import type { DiagnosisNarrationInput, Driver, RuleFlag } from "@wattsteer/core/api";
import {
  type NarrationFinding,
  narrationComplaint,
  narrationNumericWhitelist,
  narrationPayloadDigest,
  type RejectedNarration,
  toNarrationDocument,
  validatedNarration,
  validateNarration,
  writtenLocale,
} from "../src/diagnosis/index.js";

/**
 * Nothing a language model invents ever reaches a user.
 *
 * Every narration in this file is **hand-written**, and that is the point
 * rather than a convenience: `docs/specs/diagnosis.md` seam 9 asks for the
 * numeric gate to be proven adversarially, and a gate whose fixtures are
 * whatever the model happened to say is a gate whose test cases were chosen by
 * the thing it exists to catch. There is no network here, no model, no cache
 * and no database — the whole input is one closed document.
 *
 * The three properties this file is trying to make impossible:
 *
 *  1. **A number that is right but absent.** The sum of two shares is
 *     arithmetically correct and is still a hallucination from the outside, so
 *     it has to fail exactly as a made-up figure does.
 *  2. **A claim that could not survive copy review.** The §26 lemmas are
 *     rejected at run time by the same matcher the build-time scan uses, in
 *     both locales, so a sentence written per request cannot say what a
 *     sentence written once may not.
 *  3. **A rejected paragraph reaching a reader.** One retry, then the
 *     template — and the rejected text appears in the log and nowhere else.
 */

const SUM_ABS = 444;

const PHI: readonly [Driver["code"], number][] = [
  ["renewable_resource", 160],
  ["net_surplus", 96],
  ["export_stress", 64],
  ["demand_level", 48],
  ["ramp_shape", -32],
  ["calendar_season", -24],
  ["recent_history", 12],
  ["data_conditions", -8],
];

function groups(): Driver[] {
  return PHI.map(([code, phi], index) => ({
    code,
    labelCode: `driver.${code}`,
    phiMwh: phi,
    share: Math.abs(phi) / SUM_ABS,
    direction: phi >= 0 ? ("raises" as const) : ("lowers" as const),
    headlineFeature: "proxy_renewable_load_ratio",
    observed: 1.42,
    typical: 0.96,
    observedAbsentReason: null,
    typicalAbsentReason: null,
    unit: "ratio" as const,
    hourDisagreement: 1 + index / 10,
    demoted: false,
  }));
}

function payload(
  overrides: Partial<DiagnosisNarrationInput> = {},
): DiagnosisNarrationInput {
  return {
    schemaVersion: "diagnosis.narration.v1",
    promptVersion: "2026-08-28.1",
    locale: "pt-BR",
    subsystem: "NE",
    subsystemDisplayName: "NORDESTE",
    targetDate: "2026-08-28",
    thresholdMw: 5,
    forecastOrigin: {
      runLabel: "dessem_free_v1__gate_late__thr5/2026-08-27T22:11:07Z",
      gateProfile: "gate_late",
      publishedAt: "2026-08-27T22:11:07.000Z",
    },
    vintageFidelity: "point_in_time",
    risk: { dayOccurrenceProbability: 0.87, riskClass: "high", hoursP50Nonzero: 9 },
    magnitude: {
      dayExpectedMwh: 412,
      baselineExpectedMwh: 96,
      dayEnergyP10Mwh: 0,
      dayEnergyP50Mwh: 370,
      dayEnergyP90Mwh: 980,
      peakPowerP50Mw: 118,
      peakHourLocal: 13,
    },
    attribution: {
      target: "expected_mwh_day",
      totalAttributedMwh: 316,
      sumAbsAttributedMwh: SUM_ABS,
      stderrMwh: 4.1,
      topTwoShare: 0.58,
      groups: groups(),
    },
    ruleFlags: [],
    ...overrides,
  };
}

/**
 * A clean paragraph in each locale, quoting only figures the document carries.
 *
 * Deliberately dull. Gate 3's window is 35–110 words and every number in these
 * two sentences is a payload value at its display precision, so they are the
 * baseline every adversarial fixture below is one edit away from.
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

const EN_PAYLOAD = payload({ locale: "en-US" });

function codes(findings: NarrationFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

function tokensFor(findings: NarrationFinding[], code: string): (string | undefined)[] {
  return findings.filter((finding) => finding.code === code).map((one) => one.token);
}

describe("the baseline paragraphs pass every gate", () => {
  it("accepts a dull, true Portuguese paragraph", () => {
    expect(validateNarration(CLEAN_PT, payload())).toEqual([]);
  });

  it("accepts a dull, true English paragraph", () => {
    expect(validateNarration(CLEAN_EN, EN_PAYLOAD)).toEqual([]);
  });
});

describe("gate 1 — the numeric whitelist", () => {
  it("rejects a number correctly derived from the payload but absent from it", () => {
    // 0.31 + 0.22 = 0.53 of the attributed movement — arithmetically right for
    // the third and fourth groups, and a figure the document does not hold.
    // `top_two_share` exists so that the copy never needs this; the gate is
    // what makes "never needs" into "never does".
    const derived = CLEAN_PT.replace(
      "com 9 horas",
      "com 25,2% somados entre os dois primeiros grupos e 9 horas",
    );
    const findings = validateNarration(derived, payload());
    expect(codes(findings)).toContain("number_not_in_payload");
    expect(tokensFor(findings, "number_not_in_payload")).toEqual(["25,2"]);
  });

  it("rejects a sum the model performed correctly out of two payload shares", () => {
    const one = payload();
    // The third and fourth groups. Their sum is arithmetically correct, is not
    // `top_two_share`, and is not a field: exactly the shape of a figure the
    // prototype's own fixture narration added up.
    const third = one.attribution.groups[2].share;
    const fourth = one.attribution.groups[3].share;
    const sum = (Number(third.toFixed(2)) + Number(fourth.toFixed(2))).toFixed(2);
    expect(narrationNumericWhitelist(toNarrationDocument(one)).has(sum)).toBe(false);
  });

  it("passes a payload number written in the other locale's notation", () => {
    // The document is Portuguese; the figure is spelled the American way.
    const mixed = CLEAN_PT.replace("412,0 MWh", "412.0 MWh");
    expect(validateNarration(mixed, payload())).toEqual([]);
  });

  it("passes a payload number grouped either way, or not at all", () => {
    const wide = payload({
      magnitude: { ...payload().magnitude, dayExpectedMwh: 1900 },
    });
    const whitelist = narrationNumericWhitelist(toNarrationDocument(wide));
    for (const spelling of ["1.900", "1,900", "1900", "1.900,0", "1,900.0"]) {
      expect(whitelist.has(spelling)).toBe(true);
    }
  });

  it("rejects a plausible-looking number that appears nowhere", () => {
    const invented = CLEAN_EN.replace("a median 118.0 MW", "a median 137.4 MW");
    expect(
      tokensFor(validateNarration(invented, EN_PAYLOAD), "number_not_in_payload"),
    ).toEqual(["137.4"]);
  });

  it("rejects a payload number the model rounded away", () => {
    // `round nothing` is a prompt instruction; this is the enforcement. 4.1 is
    // in the document, 4 is not, because 4 is a different number.
    const rounded = `${CLEAN_EN} The attribution carries a sampling error of 4 MWh.`;
    expect(
      tokensFor(validateNarration(rounded, EN_PAYLOAD), "number_not_in_payload"),
    ).toEqual(["4"]);
  });

  it("admits a share as its percentage and as its fraction, and nothing between", () => {
    const whitelist = narrationNumericWhitelist(toNarrationDocument(payload()));
    // `day_occurrence_probability: 0.87`, priced at two decimals of the
    // fraction, which is a whole percentage.
    expect(whitelist.has("87")).toBe(true);
    expect(whitelist.has("0,87")).toBe(true);
    expect(whitelist.has("0.87")).toBe(true);
    expect(whitelist.has("86")).toBe(false);
    expect(whitelist.has("87,5")).toBe(false);
  });

  it("admits the day it explains, and not the minute the run was published", () => {
    const whitelist = narrationNumericWhitelist(toNarrationDocument(payload()));
    // `target_date: 2026-08-28`.
    for (const part of ["2026", "08", "8", "28"]) {
      expect(whitelist.has(part)).toBe(true);
    }
    // `published_at: 2026-08-27T22:11:07Z` — the date, but not the clock.
    expect(whitelist.has("27")).toBe(true);
    expect(whitelist.has("07")).toBe(false);
  });

  it("reads the wall-clock hour as one number rather than as two", () => {
    const whitelist = narrationNumericWhitelist(toNarrationDocument(payload()));
    expect(whitelist.has("13:00")).toBe(true);
    // The minute is not a payload number, and splitting `13:00` would have
    // quietly admitted a zero.
    expect(whitelist.has("00")).toBe(false);
  });

  it("drops the sign: a lowering group's magnitude is what the prose quotes", () => {
    const whitelist = narrationNumericWhitelist(toNarrationDocument(payload()));
    // `phi_mwh: -32` for `ramp_shape`. The direction is the word `lowers`.
    expect(whitelist.has("32,0")).toBe(true);
  });

  it("is drawn from the same values the cache key is a hash of", () => {
    // A change below display precision changes neither. This is the one
    // sentence that ties gate 1 to seam 12: the whitelist is the rounded
    // document, so a number the reader could not see cannot be a number the
    // validator disagrees about.
    const jittered = payload();
    jittered.attribution.groups[0].phiMwh = 160.000_000_1;
    const base = toNarrationDocument(payload());
    const moved = toNarrationDocument(jittered);
    expect(narrationPayloadDigest(moved)).toBe(narrationPayloadDigest(base));
    expect([...narrationNumericWhitelist(moved)].sort()).toEqual(
      [...narrationNumericWhitelist(base)].sort(),
    );
  });

  it("refuses to price a number nobody has decided a precision for", () => {
    expect(() =>
      narrationNumericWhitelist({
        ...toNarrationDocument(payload()),
        unpriced_addition: 1.234_56,
      }),
    ).toThrow(/no display precision/);
  });
});

describe("gate 2 — the lexical gate, through one matcher", () => {
  it("rejects every banned lemma, in both locales", () => {
    for (const lemma of CAUSALITY_BANNED_LEMMAS) {
      for (const [locale, clean] of [
        ["pt-BR", CLEAN_PT],
        ["en-US", CLEAN_EN],
      ] as const) {
        const planted = `${clean} ${lemma}.`;
        const findings = validateNarration(planted, payload({ locale }));
        expect(codes(findings)).toContain("banned_lemma");
      }
    }
  });

  it("reads the same list the build-time scan reads", () => {
    // Not a second list and not a second regex: the runtime gate calls
    // `findCausalityHits`, so a lemma added for the copy scan is enforced on
    // generated prose in the same commit.
    expect(CAUSALITY_BANNED_LEMMAS.length).toBeGreaterThan(0);
    const findings = validateNarration(
      `${CLEAN_EN} It was caused by the grid.`,
      EN_PAYLOAD,
    );
    expect(tokensFor(findings, "banned_lemma")).toContain("caused by");
  });

  it("does not fire on a word that merely contains a banned stem", () => {
    // `because` contains `caus`; the matcher is boundary-anchored, and a check
    // that fired on ordinary prose would be turned off.
    const findings = validateNarration(
      `${CLEAN_EN} The band is wide in the shoulder hours because the model is near an even chance.`,
      EN_PAYLOAD,
    );
    expect(codes(findings)).not.toContain("banned_lemma");
  });

  it("rejects advice verbs in both locales", () => {
    const english = validateNarration(
      `${CLEAN_EN} Operators should read the P10 as a floor.`,
      EN_PAYLOAD,
    );
    expect(codes(english)).toContain("advice_verb");
    const portuguese = validateNarration(
      `${CLEAN_PT} O operador deve ler a P10 como um piso.`,
      payload(),
    );
    expect(codes(portuguese)).toContain("advice_verb");
  });

  it("rejects certainty adverbs in both locales", () => {
    const english = validateNarration(
      `${CLEAN_EN} The day will definitely clear the threshold.`,
      EN_PAYLOAD,
    );
    expect(codes(english)).toContain("certainty_adverb");
    const portuguese = validateNarration(
      `${CLEAN_PT} O dia certamente ultrapassa o limite.`,
      payload(),
    );
    expect(codes(portuguese)).toContain("certainty_adverb");
  });
});

describe("gate 3 — the structural gate", () => {
  it("rejects a paragraph below the word floor", () => {
    const findings = validateNarration("O modelo lê o risco como alto.", payload());
    expect(codes(findings)).toContain("word_count_low");
  });

  it("rejects a paragraph above the word ceiling", () => {
    const long = [CLEAN_PT, CLEAN_PT, CLEAN_PT].join(" ");
    expect(codes(validateNarration(long, payload()))).toContain("word_count_high");
  });

  it("rejects more than one paragraph", () => {
    const split = CLEAN_PT.replace("Ele espera", "\n\nEle espera");
    expect(codes(validateNarration(split, payload()))).toContain("multiple_paragraphs");
  });

  it("rejects markup", () => {
    for (const marked of [
      CLEAN_EN.replace("NORDESTE", "**NORDESTE**"),
      CLEAN_EN.replace("For", "# For"),
      `${CLEAN_EN}\n- one bullet too many`,
      CLEAN_EN.replace("NORDESTE", "<b>NORDESTE</b>"),
    ]) {
      expect(codes(validateNarration(marked, EN_PAYLOAD))).toContain("markup");
    }
  });

  it("does not read a payload group code as markup", () => {
    // `net_surplus` is a code the document carries; `_` is not markup here.
    const findings = validateNarration(
      CLEAN_EN.replace("the driver groups", "the net_surplus group"),
      EN_PAYLOAD,
    );
    expect(codes(findings)).not.toContain("markup");
  });

  it("rejects a URL", () => {
    for (const linked of [
      `${CLEAN_EN} See https://ons.org.br for the settled data.`,
      `${CLEAN_EN} See www.ons.org.br for the settled data.`,
    ]) {
      expect(codes(validateNarration(linked, EN_PAYLOAD))).toContain("url");
    }
  });

  it("rejects a paragraph written in the other language", () => {
    // The whole failure mode: a Portuguese request answered in English.
    expect(codes(validateNarration(CLEAN_EN, payload()))).toContain("locale_mismatch");
    expect(codes(validateNarration(CLEAN_PT, EN_PAYLOAD))).toContain("locale_mismatch");
  });

  it("reads the locale off function words rather than off a stray noun", () => {
    expect(writtenLocale(CLEAN_PT)).toBe("pt-BR");
    expect(writtenLocale(CLEAN_EN)).toBe("en-US");
    // A Portuguese paragraph naming an English-language dataset is still
    // Portuguese: the check is looking for a whole paragraph in the wrong
    // language, not for a stray word.
    expect(writtenLocale(`${CLEAN_PT} O conjunto is a reporting entity.`)).toBe("pt-BR");
  });
});

describe("a failure buys exactly one retry, and then the template", () => {
  function attempts(...texts: string[]) {
    const complaints: (string | undefined)[] = [];
    let call = 0;
    return {
      complaints,
      calls: () => call,
      attempt: async (complaint: string | undefined) => {
        complaints.push(complaint);
        const text = texts[call] ?? texts.at(-1);
        call += 1;
        return text;
      },
    };
  }

  it("calls the model once when the first paragraph passes", async () => {
    const model = attempts(CLEAN_PT);
    const result = await validatedNarration({
      payload: payload(),
      attempt: model.attempt,
    });
    expect(model.calls()).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.narration).toEqual({
      source: "model",
      text: CLEAN_PT,
      locale: "pt-BR",
      promptVersion: "2026-08-28.1",
    });
  });

  it("retries once, with the complaint appended, and keeps the second try", async () => {
    const bad = CLEAN_PT.replace("118,0 MW", "137,4 MW");
    const model = attempts(bad, CLEAN_PT);
    const rejected: RejectedNarration[] = [];
    const result = await validatedNarration({
      payload: payload(),
      attempt: model.attempt,
      onRejected: (one) => rejected.push(one),
    });
    expect(model.calls()).toBe(2);
    expect(result.attempts).toBe(2);
    // The first call is asked cold; the second is told what was wrong.
    expect(model.complaints[0]).toBeUndefined();
    expect(model.complaints[1]).toBe("numeric:number_not_in_payload:137,4");
    expect(result.narration.source).toBe("model");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].attempt).toBe(1);
  });

  it("falls back to the template after a second failure, and stops calling", async () => {
    const bad = CLEAN_PT.replace("118,0 MW", "137,4 MW");
    const model = attempts(bad, bad, CLEAN_PT);
    const rejected: RejectedNarration[] = [];
    const result = await validatedNarration({
      payload: payload(),
      attempt: model.attempt,
      onRejected: (one) => rejected.push(one),
    });
    // Exactly two: "a second and final attempt".
    expect(model.calls()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.narration.source).toBe("template");
    expect(rejected.map((one) => one.attempt)).toEqual([1, 2]);
  });

  it("logs the rejected text with its payload hash, and returns none of it", async () => {
    const bad = `${CLEAN_PT} Isso causou uma restrição de rede.`;
    const model = attempts(bad);
    const rejected: RejectedNarration[] = [];
    const one = payload();
    const result = await validatedNarration({
      payload: one,
      attempt: model.attempt,
      onRejected: (record) => rejected.push(record),
    });
    const digest = narrationPayloadDigest(toNarrationDocument(one));
    expect(rejected.every((record) => record.digest === digest)).toBe(true);
    expect(rejected[0].text).toBe(bad);
    // And nothing of it survives into what a reader is handed.
    expect(JSON.stringify(result.narration)).not.toContain("causou");
    expect(JSON.stringify(result.narration)).not.toContain(bad);
    expect(result.narration.source).toBe("template");
  });

  it("does not swallow an outage: a model that throws is the caller's problem", async () => {
    await expect(
      validatedNarration({
        payload: payload(),
        attempt: async () => {
          throw new Error("upstream");
        },
      }),
    ).rejects.toThrow("upstream");
  });

  it("writes the complaint as codes and tokens, never as a sentence", () => {
    const complaint = narrationComplaint([
      { gate: "numeric", code: "number_not_in_payload", token: "137,4" },
      { gate: "lexical", code: "banned_lemma", token: "causa" },
      { gate: "structural", code: "word_count_low", token: "12" },
    ]);
    expect(complaint).toBe(
      "numeric:number_not_in_payload:137,4 lexical:banned_lemma:causa structural:word_count_low:12",
    );
  });
});

describe("what the gates deliberately do not do", () => {
  it("passes a dull, unhelpful, technically-correct paragraph", () => {
    // The stated limit, asserted so that nobody discovers it as a surprise.
    // Every number is real, no claim is made, and the paragraph is useless.
    const dull = [
      "Para o NORDESTE em 28 de agosto de 2026, o modelo registra 87% e 9 horas",
      "acima de zero. O valor esperado é 412,0 MWh e o típico é 96,0 MWh, com uma",
      "diferença de 316,0 MWh. A maior hora é 13:00, com 118,0 MW. Não há mais",
      "nada a dizer sobre este dia, e o parágrafo não ajuda ninguém a decidir",
      "coisa alguma sobre o dia seguinte.",
    ].join(" ");
    expect(validateNarration(dull, payload())).toEqual([]);
  });

  it("reports every gate at once rather than one per attempt", () => {
    const awful = "Causal AI: the grid definitely caused 137.4 of it. See https://x.io";
    const findings = validateNarration(awful, EN_PAYLOAD);
    const gates = new Set(findings.map((finding) => finding.gate));
    expect([...gates].sort()).toEqual(["lexical", "numeric", "structural"]);
  });
});

describe("a fired rule's facts are quotable, because they are in the document", () => {
  const flag: RuleFlag = {
    code: "stale_inputs",
    severity: "annotate",
    facts: { weather_run_age_hours: 12 },
  };

  it("admits a rule fact at its own display precision", () => {
    const flagged = payload({ ruleFlags: [flag] });
    const whitelist = narrationNumericWhitelist(toNarrationDocument(flagged));
    expect(whitelist.has("12,0")).toBe(true);
    expect(whitelist.has("12")).toBe(true);
    expect(whitelist.has("12,5")).toBe(false);
  });
});
