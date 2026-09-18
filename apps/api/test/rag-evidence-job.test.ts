/**
 * What the evidence schedule chooses to ask, and what it counts as answered.
 *
 * The defect this file pins was measured, not imagined: on the Nordeste the
 * three largest rows of a day were routinely three conjuntos with the same
 * "Controle de frequência do SIN", so the job asked one uncitable question
 * three times and never asked about the transmission limits whose operating
 * instructions are in the corpus.
 */

import { describe, expect, it } from "bun:test";
import type { ObservedReasonRow } from "../src/contract/curtailment-observed.js";
import {
  alreadyAnswered,
  pickRestrictions,
  settledDays,
} from "../src/jobs/rag-evidence.js";

const FREQUENCY = "Controle de frequência do SIN.";
const INEQUALITY =
  "Controle de inequação: LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II - IO-ON.NE.2SO";

function row(overrides: Partial<ObservedReasonRow>): ObservedReasonRow {
  return {
    grain: "conjunto",
    entityCode: "CJ-1",
    entityLabel: "CONJUNTO 1",
    reason: "ENE",
    origin: "ONS",
    constrainedOffMwh: 100,
    description: FREQUENCY,
    causeMixed: false,
    ...overrides,
  } as ObservedReasonRow;
}

describe("pickRestrictions", () => {
  it("asks one question per (reason, description), with the energy summed", () => {
    const picked = pickRestrictions([
      row({ entityCode: "A", constrainedOffMwh: 500 }),
      row({ entityCode: "B", constrainedOffMwh: 400 }),
      row({ entityCode: "C", constrainedOffMwh: 300 }),
    ]);
    expect(picked).toEqual([
      { reason: "ENE", description: FREQUENCY, constrainedOffMwh: 1200 },
    ]);
  });

  it("puts a record that names a document ahead of a larger one that does not", () => {
    const picked = pickRestrictions([
      row({ entityCode: "A", constrainedOffMwh: 900 }),
      row({
        entityCode: "B",
        reason: "CNF",
        description: INEQUALITY,
        constrainedOffMwh: 10,
      }),
    ]);
    expect(picked.map((one) => one.reason)).toEqual(["CNF", "ENE"]);
  });

  it("leaves out self-reporting plants and rows at zero", () => {
    const picked = pickRestrictions([
      row({ grain: "self_reporting_plant", description: INEQUALITY }),
      row({ description: "Zero", constrainedOffMwh: 0 }),
    ]);
    expect(picked).toEqual([]);
  });

  it("caps the distinct questions per subsystem-day", () => {
    const rows = ["a", "b", "c", "d"].map((d, i) =>
      row({ entityCode: d, description: d, constrainedOffMwh: 10 - i }),
    );
    expect(pickRestrictions(rows).map((one) => one.description)).toEqual(["a", "b", "c"]);
  });
});

describe("alreadyAnswered", () => {
  const restriction = { reason: "ENE", description: FREQUENCY, constrainedOffMwh: 1 };
  const question = `Subsistema NE, dia 2026-09-16. Registro do ONS: ${FREQUENCY} Razão declarada: ENE.`;

  it("counts a stored answer to the same record", () => {
    const stored = [{ reason: "gates_rejected_all_claims", payload: { question } }];
    expect(alreadyAnswered(stored, restriction)).toBe(true);
  });

  it("does not count a row the quota stopped, so the next run asks again", () => {
    const stored = [{ reason: "quota_exhausted_before_answer", payload: { question } }];
    expect(alreadyAnswered(stored, restriction)).toBe(false);
  });

  it("does not count an answer about another record", () => {
    const stored = [
      { reason: null, payload: { question: question.replace("ENE.", "CNF.") } },
    ];
    expect(alreadyAnswered(stored, restriction)).toBe(false);
  });

  it("treats an unreadable store as nothing answered", () => {
    expect(alreadyAnswered(null, restriction)).toBe(false);
  });
});

describe("settledDays", () => {
  it("starts two days back in Brasília and walks backwards", () => {
    // 01:00 UTC on the 18th is still the 17th in Brasília.
    expect(settledDays(3, new Date("2026-09-18T01:00:00Z"))).toEqual([
      "2026-09-15",
      "2026-09-14",
      "2026-09-13",
    ]);
  });
});
