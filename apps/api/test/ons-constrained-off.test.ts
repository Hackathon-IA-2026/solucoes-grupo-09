import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cegCore, parseConstrainedOffCsv } from "../src/ingest/ons/constrained-off.js";

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

// All fixtures captured 2026-08-28 from dados.ons.org.br; see FIXTURES.md.
const PRE_DRIFT = read("RESTRICAO_COFF_EOLICA_2024_12.head.csv");
const POST_DRIFT = read("RESTRICAO_COFF_EOLICA_2025_01.head.csv");
const RESTRICTED = read("RESTRICAO_COFF_EOLICA_2026_08.restricted.csv");
const SOLAR = read("RESTRICAO_COFF_FOTOVOLTAICA_2026_08.head.csv");

describe("constrained-off · the schema moves under closed months", () => {
  it("reads a file from before dsc_restricao existed", () => {
    const parse = parseConstrainedOffCsv(PRE_DRIFT, "WIND");
    expect(parse.columns).toHaveLength(15);
    expect(parse.hasDescriptionColumn).toBe(false);
    expect(parse.rejected).toEqual([]);
  });

  it("reads a file after ONS backfilled the column into a closed month", () => {
    // The dictionary gained dsc_restricao in 2025-09; this January 2025 file
    // already has it, because the back catalogue was rewritten in 2026.
    const parse = parseConstrainedOffCsv(POST_DRIFT, "WIND");
    expect(parse.columns).toHaveLength(16);
    expect(parse.hasDescriptionColumn).toBe(true);
    expect(parse.rejected).toEqual([]);
  });

  it("distinguishes the column being absent from it being empty", () => {
    // Both files yield null descriptions — but for different reasons, and the
    // difference is only recoverable from the file-level flag.
    const before = parseConstrainedOffCsv(PRE_DRIFT, "WIND");
    const after = parseConstrainedOffCsv(POST_DRIFT, "WIND");
    expect(before.hasDescriptionColumn).toBe(false);
    expect(after.hasDescriptionColumn).toBe(true);
    for (const row of [...before.rows, ...after.rows]) {
      expect(row.cause).toBeNull();
    }
  });
});

describe("constrained-off · blank is data, not a defect", () => {
  const parse = parseConstrainedOffCsv(PRE_DRIFT, "WIND");

  it("reads an empty val_geracaolimitada as no curtailment, not a rejection", () => {
    // Most rows in these files are unrestricted, and ONS says so with a blank.
    // Rejecting empties (as the balanço adapter does) would drop nearly all.
    expect(parse.rejected).toEqual([]);
    expect(parse.rows.every((row) => row.constrainedOffMwh === 0)).toBe(true);
  });

  it("leaves the cause absent rather than half-populated", () => {
    expect(parse.rows.every((row) => row.cause === null)).toBe(true);
    expect(parse.rows.every((row) => row.causeMixed === false)).toBe(true);
  });

  it("carries the reference generation ONS did publish", () => {
    const first = parse.rows[0];
    // val_geracaoreferencia is populated; the *final* revision is not yet.
    expect(first?.referenceGenerationMwh).toBeCloseTo((388.028 + 384.569) / 2, 6);
    expect(first?.finalReferenceGenerationMwh).toBeNull();
  });
});

describe("constrained-off · hourly rollup from a half-hourly source", () => {
  const parse = parseConstrainedOffCsv(PRE_DRIFT, "WIND");

  it("sums energy over the two half-hours", () => {
    const first = parse.rows[0];
    expect(first?.validTime.toISOString()).toBe("2024-12-01T03:00:00.000Z");
    expect(first?.halfHoursObserved).toBe(2);
    // MWmed over 30 minutes is half as many MWh, so the hour is the mean of the
    // two half-hour powers — not their sum.
    expect(first?.verifiedGenerationMwh).toBeCloseTo((402.459 + 397.262) / 2, 6);
  });

  it("averages availability rather than summing it — it is a power", () => {
    expect(parse.rows[0]?.availableCapacityMw).toBeCloseTo((402.582 + 406.212) / 2, 6);
  });

  it("records an incomplete hour instead of letting it look like a low one", () => {
    // The fixture ends mid-hour at 02:00, so the last hour has one half only.
    const last = parse.rows.at(-1);
    expect(last?.halfHoursObserved).toBe(1);
  });
});

describe("constrained-off · restriction cause", () => {
  const parse = parseConstrainedOffCsv(RESTRICTED, "WIND");

  it("captures reason and origin together, with the free-text description", () => {
    const cnf = parse.rows.find((row) => row.reportingEntityCode === "CJU_BABBS");
    expect(cnf?.cause?.reason).toBe("CNF");
    expect(cnf?.cause?.origin).toBe("LOC");
    // The description wraps across physical lines in the source file.
    expect(cnf?.cause?.description).toContain("Controle de inequação");
    expect(cnf?.cause?.description).toContain("MOP 442-S/2025");
  });

  it("derives the curtailed energy where ONS has not written GNRa", () => {
    /*
      **This assertion used to hold the defect.** It read
      `val_geracaolimitada / 2` and called it the curtailed energy, and ONS's
      published dictionary says that field is the *ceiling*: "Representa o
      limite para a geração da usina/conjunto estabelecido pelo ONS em Tempo
      Real". The shortfall under it is `val_geracaonaorealizadaapurada`, which
      the same dictionary defines as "a diferença entre a geração de referência
      e a geração verificada (se menor que zero, GNRa = 0)".

      Reading the ceiling made every observed figure in the product about 2.9×
      too high — `docs/todo.md` 5b measured 2–3× empirically and could not find
      the cause, because the arithmetic was right and the field was not.

      This fixture predates the column, so the derivation runs: reference
      355,262 − verified 171,415 = 183,847 MWmed over a half-hour. The old
      answer was 163,261 — larger than the truth and entirely plausible, which
      is what let it stand.
    */
    const cnf = parse.rows.find((row) => row.reportingEntityCode === "CJU_BABBS");
    expect(cnf?.constrainedOffMwh).toBeCloseTo((355.262 - 171.415) / 2, 6);
    expect(parse.hasNotGeneratedColumn).toBe(false);
  });

  it("reads GNRa where ONS has written it, and it is not the ceiling", () => {
    /*
      Real numbers, from `RESTRICAO_COFF_EOLICA_2026_09.csv` as published:
      Conj. Paulino Neves, 2026-09-01 10:00, reason ENE — verified 319,268,
      **limitada 322,000**, reference 428,899, **GNRa 109,631**. The two
      candidate fields differ by 2,9×, which is the whole point of the fixture.
    */
    const header = [
      "id_subsistema;nom_subsistema;id_estado;nom_estado;nom_usina;id_ons;ceg",
      "din_instante;val_geracao;val_geracaolimitada;val_disponibilidade",
      "val_geracaoreferencia;val_geracaoreferenciafinal;cod_razaorestricao",
      "cod_origemrestricao;dsc_restricao;val_geracaonaorealizadaapurada",
    ].join(";");
    const row = [
      "N;Norte;MA;Maranhão;Conj. Paulino Neves;CJU_MAPLN;-",
      "2026-09-01 10:00:00;319.268;322.0;410.6",
      "428.899;;ENE",
      "SIS;Razão energética;109.631",
    ].join(";");
    const parsed = parseConstrainedOffCsv(`${header}\n${row}\n`, "WIND");
    expect(parsed.rejected).toEqual([]);
    expect(parsed.hasNotGeneratedColumn).toBe(true);
    // The hour holds one half-hour, so the MWh is half the MWmed.
    expect(parsed.rows[0]?.constrainedOffMwh).toBeCloseTo(109.631 / 2, 6);
    // And emphatically not the ceiling, which is what this replaced.
    expect(parsed.rows[0]?.constrainedOffMwh).not.toBeCloseTo(322.0 / 2, 6);
  });

  it("keeps ENE rows with their systemic origin", () => {
    const ene = parse.rows.find((row) => row.cause?.reason === "ENE");
    expect(ene?.cause?.origin).toBe("SIS");
    expect(ene?.cause?.description).toBe("Controle de frequência do SIN.");
  });

  it("rejects a half-populated cause rather than half-believing it", () => {
    const header = RESTRICTED.split("\n")[0] ?? "";
    // Reason present, origin blank — an illegal state, not a partial one.
    const row =
      "NE;NORDESTE;BA;BAHIA;CONJ. X;CJU_X;-;2026-08-01 07:00:00;1;2;3;4;;ENE;;text";
    const parsed = parseConstrainedOffCsv(`${header}\n${row}\n`, "WIND");
    expect(parsed.rows).toEqual([]);
    expect(parsed.rejected[0]?.reason).toBe("half_populated_cause");
  });

  it("accepts PAR — documented since 2024-04, observed zero times so far", () => {
    const header = RESTRICTED.split("\n")[0] ?? "";
    const row =
      "NE;NORDESTE;BA;BAHIA;CONJ. X;CJU_X;-;2026-08-01 07:00:00;1;2;3;4;;PAR;LOC;parecer";
    const parsed = parseConstrainedOffCsv(`${header}\n${row}\n`, "WIND");
    expect(parsed.rows[0]?.cause?.reason).toBe("PAR");
  });
});

describe("constrained-off · the reporting entity", () => {
  it("resolves a CJU_ code to a conjunto with no CEG", () => {
    const parse = parseConstrainedOffCsv(PRE_DRIFT, "WIND");
    const entity = parse.entities[0];
    expect(entity?.onsCode).toBe("CJU_MAPLN");
    expect(entity?.kind).toBe("CONJUNTO");
    // ONS writes "-", which is not a CEG. Structural absence, not an empty string.
    expect(entity?.cegCore).toBeNull();
    expect(entity?.subsystem).toBe("N");
    expect(entity?.stateCode).toBe("MA");
  });

  it("resolves a non-CJU_ code to a self-reporting plant carrying a CEG", () => {
    const header = PRE_DRIFT.split("\n")[0] ?? "";
    const row =
      "NE;NORDESTE;RS;RIO GRANDE DO SUL;PARQUE X;PXBRD1;EOL.CV.RS.030784-0.01;2024-12-01 00:00:00;1;;2;3;;;";
    const parse = parseConstrainedOffCsv(`${header}\n${row}\n`, "WIND");
    const entity = parse.entities[0];
    expect(entity?.kind).toBe("PLANT");
    // Version segment stripped — ONS zero-pads it, ANEEL does not.
    expect(entity?.cegCore).toBe("EOL.CV.RS.030784-0");
  });

  it("strips the CEG version segment in either rendering", () => {
    expect(cegCore("EOL.CV.RS.030784-0.01")).toBe("EOL.CV.RS.030784-0");
    expect(cegCore("EOL.CV.RS.030784-0.1")).toBe("EOL.CV.RS.030784-0");
    expect(cegCore("-")).toBeNull();
    expect(cegCore("")).toBeNull();
  });
});

describe("constrained-off · solar shares the schema", () => {
  it("parses the fotovoltaica file with the same adapter", () => {
    const parse = parseConstrainedOffCsv(SOLAR, "SOLAR");
    expect(parse.rejected).toEqual([]);
    expect(parse.rows[0]?.technology).toBe("SOLAR");
    expect(parse.entities[0]?.onsCode).toBe("CJU_BA4FBBC");
    expect(parse.entities[0]?.subsystem).toBe("NE");
  });
});
