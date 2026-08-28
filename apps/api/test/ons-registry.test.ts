import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMembershipOverlaps,
  parseConjuntoMembershipCsv,
} from "../src/ingest/ons/conjunto-membership.js";
import {
  findRenewableDeactivations,
  parseCapacityRegistryCsv,
} from "../src/ingest/ons/plant-registry.js";

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

// Both fixtures captured 2026-08-28 from dados.ons.org.br; see FIXTURES.md for
// the exact line ranges and what each one pins.
const CAPACITY = read("CAPACIDADE_GERACAO.registry.csv");
const BRIDGE = read("RELACIONAMENTO_USINA_CONJUNTO.registry.csv");

/**
 * The BELMONTE 1-1 rows are the only VRE deactivations in the whole live file
 * and they predate the window, so parsing the fixture with the default
 * assertion is what the ordinary daily ingest does.
 */
const capacity = () => parseCapacityRegistryCsv(CAPACITY);
const bridge = () => parseConjuntoMembershipCsv(BRIDGE);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("capacidade-geracao · the grain is the unit, not the plant", () => {
  const parse = capacity();

  it("emits one unit row per generating unit and one plant per CEG", () => {
    // ALEGRIA II alone contributes nine units to one plant.
    const alegria = parse.units.filter(
      (unit) => unit.plantCegCore === "EOL.CV.RN.028443-2",
    );
    expect(alegria).toHaveLength(9);
    expect(parse.plants.filter((p) => p.cegCore === "EOL.CV.RN.028443-2")).toHaveLength(
      1,
    );
  });

  it("never stores a plant capacity — it is the sum over units at a date", () => {
    // The plant carries no capacity column at all. Aggregation is a read.
    const plant = parse.plants.find((p) => p.cegCore === "EOL.CV.RN.028443-2");
    expect(plant).toBeDefined();
    expect(plant).not.toHaveProperty("capacityMw");
    const total = parse.units
      .filter((unit) => unit.plantCegCore === "EOL.CV.RN.028443-2")
      .reduce((sum, unit) => sum + unit.ratedPowerMw, 0);
    expect(total).toBeCloseTo(100.65, 6);
  });

  it("carries per-unit commissioning dates that differ inside one plant", () => {
    // ALEGRIA II commissions over eleven months. A plant-level "entry into
    // operation" date would credit all 100.65 MW on the first unit's day —
    // which is exactly what SIGA does, and why ONS owns the dates.
    const dates = new Set(
      parse.units
        .filter((unit) => unit.plantCegCore === "EOL.CV.RN.028443-2")
        .map((unit) => unit.commissionedOn.toISOString().slice(0, 10)),
    );
    expect([...dates].sort()).toEqual([
      "2011-12-30",
      "2012-04-14",
      "2012-11-07",
      "2012-11-15",
    ]);
  });

  it("reads dates as plain calendar days at UTC midnight, not Brasília wall clocks", () => {
    // These are `YYYY-MM-DD` with no time and no zone, unlike `din_instante`.
    const unit = parse.units.find((u) => u.equipmentCode === "PEBE110UG1D");
    expect(unit?.commissionedOn.toISOString()).toBe("2023-12-05T00:00:00.000Z");
  });
});

describe("capacidade-geracao · what the file covers", () => {
  const parse = capacity();

  it("filters hydro, thermal and nuclear at the boundary and says how many", () => {
    // Reported rather than silently dropped: if this reaches zero, ONS has
    // changed what the dataset covers.
    expect(parse.outOfScopeRowsFiltered).toBe(7);
    expect(parse.units.every((unit) => unit.plantCegCore.startsWith("UHE."))).toBe(false);
    expect(
      parse.plants.every(
        (plant) => plant.technology === "WIND" || plant.technology === "SOLAR",
      ),
    ).toBe(true);
  });

  it("rejects an unrecognised technology instead of calling it out of scope", () => {
    const header = CAPACITY.split("\n")[0] ?? "";
    const row =
      "NE;NORDESTE;BA;BAHIA;TIPO II-C;AGENTE;AGENTE;GEOTÉRMICA;X;EOL.CV.BA.099999-9.01;UG 1;BAX0UG1;1;VENTO;;2025-01-01;;10.0";
    const parsed = parseCapacityRegistryCsv(`${header}\n${row}\n`);
    expect(parsed.outOfScopeRowsFiltered).toBe(0);
    expect(parsed.rejected[0]?.reason).toBe("unknown_technology");
  });

  it("rejects a modality outside the four ONS dispatches", () => {
    const header = CAPACITY.split("\n")[0] ?? "";
    const row =
      "NE;NORDESTE;BA;BAHIA;TIPO III;AGENTE;AGENTE;FOTOVOLTAICA;X;UFV.RS.BA.099999-9.01;UG 1;BAX0UG1;1;;;2025-01-01;;10.0";
    const parsed = parseCapacityRegistryCsv(`${header}\n${row}\n`);
    expect(parsed.rejected[0]?.reason).toBe("unknown_modality");
  });

  it("reads the four dispatched modalities that do appear", () => {
    const modalities = new Set(parse.plants.map((plant) => plant.operationModality));
    expect(modalities).toEqual(new Set(["TIPO_I", "TIPO_II_B", "TIPO_II_C"]));
  });

  it("has no id_ons column, so the CEG core is the identity", () => {
    // `docs/research/ons-datasets.md` §12 records `id_ons` as added by
    // changelog 1.6 on 2026-01-26. The live header does not have it.
    expect(parse.columns).toHaveLength(18);
    expect(parse.columns).not.toContain("id_ons");
    expect(parse.plants.every((plant) => plant.onsPlantCode === null)).toBe(true);
  });

  it("strips the CEG version segment but keeps ONS's own rendering", () => {
    const plant = parse.plants.find((p) => p.cegCore === "EOL.CV.RN.028443-2");
    expect(plant?.cegRaw).toBe("EOL.CV.RN.028443-2.01");
  });
});

describe("capacidade-geracao · subsystem is electrical, never derived from state", () => {
  const parse = capacity();

  it("keeps a Bahia plant in SE when ONS assigns it there", () => {
    // SERRA DAS ALMAS I is in BA — the paradigm NE state — and is electrically
    // SE. Twelve VRE units in the live file are like this. Any state→subsystem
    // mapping puts them in the wrong subsystem, and nothing would crash.
    const plant = parse.plants.find((p) => p.cegCore === "EOL.CV.BA.034778-7");
    expect(plant?.stateCode).toBe("BA");
    expect(plant?.subsystem).toBe("SE");
  });

  it("rejects a row whose subsystem code is unknown rather than inferring one", () => {
    const header = CAPACITY.split("\n")[0] ?? "";
    const row =
      "XX;DESCONHECIDO;BA;BAHIA;TIPO II-C;AGENTE;AGENTE;FOTOVOLTAICA;X;UFV.RS.BA.099999-9.01;UG 1;BAX0UG1;1;;;2025-01-01;;10.0";
    const parsed = parseCapacityRegistryCsv(`${header}\n${row}\n`);
    expect(parsed.rejected[0]?.reason).toBe("unknown_subsystem");
  });
});

describe("capacidade-geracao · deactivation is an assertion, not a model", () => {
  it("accepts the three pre-window BELMONTE deactivations ONS has always had", () => {
    // 50 MW deactivated 2023-05-03 — before the window opens, so no capacity
    // weight in the modelled period is affected.
    const parse = capacity();
    const dead = parse.units.filter((unit) => unit.decommissionedOn !== null);
    expect(dead).toHaveLength(3);
    expect(dead.every((unit) => unit.plantCegCore === "UFV.RS.PE.040725-9")).toBe(true);
    expect(findRenewableDeactivations(parse.units)).toEqual([]);
  });

  it("fires the moment a deactivation lands inside the modelling window", () => {
    // The whole mitigation the research chose: notice the day the assumption
    // stops holding, rather than build an estimator for a 0 MW error.
    expect(() =>
      parseCapacityRegistryCsv(CAPACITY, {
        deactivationsSince: new Date("2020-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/renewable deactivation/i);
  });

  it("lets an operator take the snapshot deliberately once it has been seen", () => {
    const parse = parseCapacityRegistryCsv(CAPACITY, {
      deactivationsSince: new Date("2020-01-01T00:00:00.000Z"),
      allowRenewableDeactivations: true,
    });
    expect(parse.units).not.toHaveLength(0);
  });

  it("surfaces a deactivation stamped before its own commissioning", () => {
    // Real, and undocumented: all three BELMONTE 1-1 deactivations are stamped
    // 2023-05-03 against a 2023-12-05 commissioning. Kept verbatim rather than
    // coerced, and counted so the contradiction is visible.
    expect(capacity().inconsistentUnitDates).toBe(3);
  });

  it("rejects a malformed date rather than reading it as absent", () => {
    const header = CAPACITY.split("\n")[0] ?? "";
    const row =
      "NE;NORDESTE;BA;BAHIA;TIPO II-C;AGENTE;AGENTE;FOTOVOLTAICA;X;UFV.RS.BA.099999-9.01;UG 1;BAX0UG1;1;;;01/01/2025;;10.0";
    const parsed = parseCapacityRegistryCsv(`${header}\n${row}\n`);
    expect(parsed.rejected[0]?.reason).toBe("unparsable_date");
  });
});

describe("usina_conjunto · membership is time-resolved", () => {
  const parse = bridge();

  it("reads the bridge's own column name, estad_id, not id_estado", () => {
    // This dataset alone spells it that way; the adapter reads the file it has.
    expect(parse.columns).toContain("estad_id");
    expect(parse.columns).not.toContain("id_estado");
    expect(parse.conjuntos[0]?.stateCode).toBe("MA");
  });

  it("carries an open membership as null rather than as a far-future date", () => {
    const open = parse.memberships.find((m) => m.plantOnsCode === "MAEDT1");
    expect(open?.conjuntoCode).toBe("CJU_MAPLN");
    expect(open?.memberFrom.toISOString()).toBe("2017-08-08T00:00:00.000Z");
    expect(open?.memberTo).toBeNull();
  });

  it("keeps a closed membership and its successor as two separate rows", () => {
    // BAEABL left CJU_BAABL on 2024-10-29 and joined CJU_BA4EPND on 2024-10-30.
    // A snapshot join attributes its whole history to the second conjunto.
    const rows = parse.memberships
      .filter((m) => m.plantOnsCode === "BAEABL")
      .sort((a, b) => a.memberFrom.getTime() - b.memberFrom.getTime());
    expect(rows).toHaveLength(2);
    expect(rows[0]?.conjuntoCode).toBe("CJU_BAABL");
    expect(rows[0]?.memberTo?.toISOString()).toBe("2024-10-29T00:00:00.000Z");
    expect(rows[1]?.conjuntoCode).toBe("CJU_BA4EPND");
    expect(rows[1]?.memberFrom.toISOString()).toBe("2024-10-30T00:00:00.000Z");
  });

  it("treats consecutive-day handover as no overlap — member_to is inclusive", () => {
    // Measured on the live file: all 331 sequential memberships hand over on
    // consecutive days, and none shares a day. So the end is the last day of
    // membership, and an exclusive reading would lose 2024-10-29 entirely.
    expect(findMembershipOverlaps(parse.memberships)).toEqual([]);
  });

  it("keeps a membership whose ceg ONS left empty in its own bridge", () => {
    // SPUD42 "Dracena 4 2". An ONS data gap; not a reason to drop a real row.
    const orphan = parse.memberships.find((m) => m.plantOnsCode === "SPUD42");
    expect(orphan?.conjuntoCode).toBe("CJU_SPUFD");
    expect(orphan?.plantCegCore).toBeNull();
  });

  it("keeps the two ONS codes ONS gives one CEG core apart", () => {
    // RNST6 and RNST06 share EOL.CV.RN.047240-9 and both have open memberships
    // of CJU_RNCAJ1. Keyed on the CEG that reads as an invariant violation;
    // keyed on the ONS code it is two codes for one registered plant.
    const both = parse.memberships.filter((m) => m.plantCegCore === "EOL.CV.RN.047240-9");
    expect(both.map((m) => m.plantOnsCode).sort()).toEqual(["RNST06", "RNST6"]);
    expect(findMembershipOverlaps(both)).toEqual([]);
  });

  it("carries conjuntos that are not VRE with a null technology, not a guess", () => {
    const thermal = parse.conjuntos.find((c) => c.onsConjuntoCode === "CJU_PRKCL");
    expect(thermal?.sourceTypeCode).toBe("UTE");
    expect(thermal?.technology).toBeNull();
    const wind = parse.conjuntos.find((c) => c.onsConjuntoCode === "CJU_MAPLN");
    expect(wind?.technology).toBe("WIND");
  });
});

describe("usina_conjunto · one conjunto per plant per instant, asserted", () => {
  const header = BRIDGE.split("\n")[0] ?? "";
  const overlapping = [
    "NE;Nordeste;BA;BAHIA;UEE;Eolielétrica;1;CJU_A;PLANT1;Conj. A;Plant 1;EOL.CV.BA.099999-9.01;2024-01-01;2024-06-30",
    "NE;Nordeste;BA;BAHIA;UEE;Eolielétrica;2;CJU_B;PLANT1;Conj. B;Plant 1;EOL.CV.BA.099999-9.01;2024-06-30;",
  ].join("\n");

  it("fails the ingest when a plant is in two conjuntos on the same day", () => {
    // The domain model calls this an ingest failure rather than something to
    // merge: a merged membership is a wrong attribution that looks right.
    expect(() => parseConjuntoMembershipCsv(`${header}\n${overlapping}\n`)).toThrow(
      /two conjuntos at once/i,
    );
  });

  it("does not fire when the successor starts the next day", () => {
    const handover = [
      "NE;Nordeste;BA;BAHIA;UEE;Eolielétrica;1;CJU_A;PLANT1;Conj. A;Plant 1;EOL.CV.BA.099999-9.01;2024-01-01;2024-06-30",
      "NE;Nordeste;BA;BAHIA;UEE;Eolielétrica;2;CJU_B;PLANT1;Conj. B;Plant 1;EOL.CV.BA.099999-9.01;2024-07-01;",
    ].join("\n");
    const parsed = parseConjuntoMembershipCsv(`${header}\n${handover}\n`);
    expect(parsed.memberships).toHaveLength(2);
  });

  it("rejects a membership that ends before it starts", () => {
    const row =
      "NE;Nordeste;BA;BAHIA;UEE;Eolielétrica;1;CJU_A;PLANT9;Conj. A;Plant 9;EOL.CV.BA.099999-9.01;2024-06-30;2024-01-01";
    const parsed = parseConjuntoMembershipCsv(`${header}\n${row}\n`);
    expect(parsed.memberships).toEqual([]);
    expect(parsed.rejected[0]?.reason).toBe("unparsable_date");
  });

  it("rejects a row with no ONS plant code rather than inventing a key", () => {
    const row =
      "NE;Nordeste;BA;BAHIA;UEE;Eolielétrica;1;CJU_A;;Conj. A;Plant 9;EOL.CV.BA.099999-9.01;2024-06-30;";
    const parsed = parseConjuntoMembershipCsv(`${header}\n${row}\n`);
    expect(parsed.rejected[0]?.reason).toBe("missing_identity");
  });
});

describe("registry · the fleet reconstructs as of a date", () => {
  // The reconstruction the whole ticket rests on, exercised in memory here and
  // against real Postgres in `database.test.ts`. Both must agree.
  const parse = capacity();

  const capacityOn = (iso: string): number =>
    parse.units
      .filter(
        (unit) =>
          unit.commissionedOn <= day(iso) &&
          (unit.decommissionedOn === null || unit.decommissionedOn > day(iso)),
      )
      .reduce((sum, unit) => sum + unit.ratedPowerMw, 0);

  it("grows as units commission, rather than crediting the fleet on day one", () => {
    // ALEGRIA II's 110.55 MW arrives in four steps across eleven months.
    expect(capacityOn("2011-12-01")).toBeCloseTo(capacityOn("2011-12-29"), 6);
    expect(capacityOn("2011-12-30")).toBeGreaterThan(capacityOn("2011-12-29"));
    expect(capacityOn("2012-11-15")).toBeGreaterThan(capacityOn("2012-11-07"));
  });

  it("counts a unit from its commissioning day inclusive", () => {
    const before = capacityOn("2025-08-07");
    const on = capacityOn("2025-08-08");
    // SERRA DAS ALMAS I's two units commission on 2025-08-08: 22.5 + 18.
    expect(on - before).toBeCloseTo(40.5, 6);
  });

  it("never counts the deactivated BELMONTE units, in any window", () => {
    // Their deactivation precedes their commissioning, so `[commissioned,
    // decommissioned)` is empty — the contradiction is inert rather than
    // silently inflating the fleet.
    const belmonte = parse.units.filter(
      (unit) => unit.plantCegCore === "UFV.RS.PE.040725-9",
    );
    const live = belmonte.filter(
      (unit) =>
        unit.commissionedOn <= day("2026-08-28") &&
        (unit.decommissionedOn === null || unit.decommissionedOn > day("2026-08-28")),
    );
    expect(belmonte).toHaveLength(6);
    expect(live).toHaveLength(3);
  });
});
