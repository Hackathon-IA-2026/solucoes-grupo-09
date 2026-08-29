import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEASURED_WIND_SPEED_UNIT_CORRECTION,
  parseConstrainedOffDetailCsv,
} from "../src/ingest/ons/constrained-off-detail.js";
import { plantDetailDigest } from "../src/ingest/plant-detail-repository.js";

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

// All fixtures captured 2026-08-28 from dados.ons.org.br; see FIXTURES.md.
const WIND = read("RESTRICAO_COFF_EOLICA_DETAIL_2026_08.head.csv");
const WIND_BLANK = read("RESTRICAO_COFF_EOLICA_DETAIL_2021_10.blank.csv");
const SOLAR = read("RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2026_08.head.csv");
const SOLAR_DUPLICATE = read("RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2024_04.duplicate.csv");

const wind = parseConstrainedOffDetailCsv(WIND, "WIND");
const solar = parseConstrainedOffDetailCsv(SOLAR, "SOLAR");

const rowFor = (parse: ReturnType<typeof parseConstrainedOffDetailCsv>, code: string) =>
  parse.rows.find((row) => row.plantOnsCode === code);

describe("constrained-off detail · no reason can reach a plant", () => {
  it("emits no cause of any kind on a plant row", () => {
    // The structural claim of the whole ticket, asserted on the canonical
    // shape: there is no field here to hold a reason, an origin, a description
    // or a reference generation, because the source publishes none and at Tipo
    // II-C grain none exists.
    for (const row of [...wind.rows, ...solar.rows]) {
      const keys = Object.keys(row);
      expect(keys).not.toContain("cause");
      expect(keys).not.toContain("reason");
      expect(keys).not.toContain("origin");
      expect(keys).not.toContain("restrictionDescription");
      expect(keys).not.toContain("referenceGenerationMwh");
      expect(keys).not.toContain("constrainedOffMwh");
    }
  });

  it("does not carry the conjunto the plant settles under", () => {
    // `nom_conjuntousina` is in every source row and is deliberately dropped:
    // it is the one field from which the settling entity could be rebuilt by
    // name, which is the first step of the join this grain must not enable.
    expect(wind.columns).toContain("nom_conjuntousina");
    for (const plant of [...wind.plants, ...solar.plants]) {
      expect(Object.keys(plant)).not.toContain("conjuntoName");
    }
    expect(JSON.stringify(wind.rows)).not.toContain("Paulino Neves");
  });

  it("carries no restriction column in the source header at all", () => {
    for (const parse of [wind, solar]) {
      for (const column of parse.columns) {
        expect(column).not.toContain("razao");
        expect(column).not.toContain("restricao");
        expect(column).not.toContain("referencia");
      }
    }
  });

  it("keeps the modality, which is what says whether a reason is knowable", () => {
    // Tipo II-C settles as a conjunto, so its reason is unknowable per plant.
    // Tipo I / II-B is its own reporting entity, so the reason exists — at the
    // entity grain, which is a different table.
    expect(wind.plants.map((plant) => plant.operationModality).sort()).toEqual([
      "TIPO_I",
      "TIPO_II_B",
      "TIPO_II_C",
      "TIPO_II_C",
    ]);
  });

  it("agrees that a conjunto is named exactly when the plant is Tipo II-C", () => {
    // 14,256 blank `nom_conjuntousina` against 14,256 non-II-C rows in the full
    // 2026-08 wind file. The agreement is counted, never stored.
    expect(wind.modalityConjuntoMismatches).toBe(0);
    expect(solar.modalityConjuntoMismatches).toBe(0);
  });
});

describe("constrained-off detail · the boolean encodings differ permanently", () => {
  it("reads the wind dialect, which is numeric", () => {
    // `flg_dadoventoinvalido` has been `0.0` / `1.0` since 2021-10.
    expect(WIND).toContain(";1.0;");
    expect(rowFor(wind, "MAEDT1")?.measurement?.invalid).toBe(false);
    expect(rowFor(wind, "MAEDT7")?.measurement?.invalid).toBe(true);
  });

  it("reads the solar dialect, which is a boolean literal", () => {
    // `flg_dadoirradianciainvalido` has been `False` / `True` since 2024-04.
    expect(SOLAR).toContain(";False;");
    expect(SOLAR).toContain(";True;");
    expect(rowFor(solar, "BAFB11")?.measurement?.invalid).toBe(false);
    expect(rowFor(solar, "BASDB2")?.measurement?.invalid).toBe(true);
  });

  it("unifies them into one boolean, so nothing downstream sees the dialect", () => {
    for (const row of [...wind.rows, ...solar.rows]) {
      if (row.measurement) {
        expect(typeof row.measurement.invalid).toBe("boolean");
      }
    }
  });

  it("rejects a flag it has never seen rather than reading it as false", () => {
    const mangled = WIND.replace(";5.079;0.0;", ";5.079;NAO;");
    const parse = parseConstrainedOffDetailCsv(mangled, "WIND");
    expect(parse.rejected.map((row) => row.reason)).toContain(
      "half_populated_measurement",
    );
  });
});

describe("constrained-off detail · the asymmetry with the entity grain", () => {
  it("has id_estado but neither nom_estado nor nom_subsistema", () => {
    // The entity-grain files carry both. Assuming symmetry would fail the
    // column assertion on every file of both technologies.
    for (const parse of [wind, solar]) {
      expect(parse.columns).toContain("id_estado");
      expect(parse.columns).not.toContain("nom_estado");
      expect(parse.columns).not.toContain("nom_subsistema");
    }
  });

  it("resolves the subsystem from the padded code alone", () => {
    expect(rowFor(wind, "CEUCZ") && wind.plants[3]?.subsystem).toBeDefined();
    expect(wind.plants.map((plant) => plant.subsystem).sort()).toEqual([
      "N",
      "N",
      "NE",
      "NE",
    ]);
  });

  it("never sees a conjunto code where the entity grain is full of them", () => {
    // 0 of 1,365,984 rows of the 2026-08 wind file start `CJU_`; every row here
    // is a plant, and every plant has a CEG.
    for (const plant of [...wind.plants, ...solar.plants]) {
      expect(plant.onsCode.startsWith("CJU_")).toBe(false);
      expect(plant.cegCore).not.toBe("-");
      expect(plant.cegRaw.endsWith(".01")).toBe(true);
      expect(plant.cegCore.endsWith(".01")).toBe(false);
    }
  });
});

describe("constrained-off detail · a documented unit that is wrong at source", () => {
  it("records the correction rather than only performing it", () => {
    expect(MEASURED_WIND_SPEED_UNIT_CORRECTION).toEqual({
      column: "val_ventoverificado",
      documentedUnit: "m3/s",
      storedUnit: "m/s",
      conversionFactor: 1,
    });
  });

  it("stores wind speeds at the magnitude ONS published", () => {
    // The dictionary says m³/s; the values are surface wind speeds. The label
    // was wrong, not the numbers, so there is nothing to scale — the correction
    // is in the name and the record of it, and a factor other than 1 here would
    // be inventing data.
    const speed = rowFor(wind, "MAEDT1")?.measurement?.value;
    expect(speed).toBeCloseTo((5.079 + 4.845) / 2, 6);
  });
});

describe("constrained-off detail · hourly rollup from a half-hourly source", () => {
  it("sums energies over the two half-hours", () => {
    const row = rowFor(wind, "MAEDT1");
    expect(row?.validTime.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(row?.halfHoursObserved).toBe(2);
    // MWmed over 30 minutes is half as many MWh, so the hour is the mean of the
    // two half-hour powers.
    expect(row?.verifiedGenerationMwh).toBeCloseTo((4.755 + 4.892) / 2, 6);
    expect(row?.estimatedGenerationMwh).toBeCloseTo((3.808 + 3.161) / 2, 6);
  });

  it("averages the measured resource — a speed is intensive, not additive", () => {
    const row = rowFor(wind, "CEUCZ");
    expect(row?.measurement?.value).toBeCloseTo((8.219 + 5.302) / 2, 6);
  });

  it("marks the hour invalid when either half-hour was", () => {
    // MAEDT7 is flagged in both halves; a single flagged half would be enough.
    expect(rowFor(wind, "MAEDT7")?.measurement?.invalid).toBe(true);
    const oneHalf = WIND.replace(
      "EOL.CV.MA.033680-7.01;2026-08-01 00:30:00;5.489;1.0;",
      "EOL.CV.MA.033680-7.01;2026-08-01 00:30:00;5.489;0.0;",
    );
    const parse = parseConstrainedOffDetailCsv(oneHalf, "WIND");
    expect(rowFor(parse, "MAEDT7")?.measurement?.invalid).toBe(true);
  });
});

describe("constrained-off detail · blank is data, and half-blank is not", () => {
  const blank = parseConstrainedOffDetailCsv(WIND_BLANK, "WIND");

  it("keeps a row whose estimate ONS never published", () => {
    // 117,209 rows of the 2021-10 wind file publish no estimate. Empty is never
    // read as zero — a plant that was measured but not estimated is a fact.
    const row = rowFor(blank, "BAEABL");
    expect(row?.estimatedGenerationMwh).toBeNull();
    expect(row?.verifiedGenerationMwh).toBe(0);
    expect(row?.measurement).toEqual({ value: 0, invalid: true });
  });

  it("keeps a row measured for nothing but its estimate", () => {
    // RNEM09 on 2021-10-04: no wind, no flag, no verified generation — but an
    // estimate. The measurement is absent as a whole rather than zeroed.
    const row = rowFor(blank, "RNEM09");
    expect(row?.measurement).toBeNull();
    expect(row?.verifiedGenerationMwh).toBeNull();
    expect(row?.estimatedGenerationMwh).toBeCloseTo((14.057 + 15.897) / 2, 6);
  });

  it("rejects the row that observed nothing at all", () => {
    // 336 rows of the 2021-10 wind file are an identity and a timestamp and
    // four empty columns. There is no observation in them to store.
    expect(blank.rows.some((row) => row.plantOnsCode === "RNTEB1")).toBe(false);
    const rejected = blank.rejected.filter((row) => row.reason === "empty_value");
    expect(rejected).toHaveLength(2);
  });

  it("rejects a measurement given without its flag, or a flag without one", () => {
    const halfPopulated = WIND.replace(";5.079;0.0;", ";5.079;;");
    const parse = parseConstrainedOffDetailCsv(halfPopulated, "WIND");
    const rejected = parse.rejected.filter(
      (row) => row.reason === "half_populated_measurement",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.detail).toContain("val_ventoverificado");
  });
});

describe("constrained-off detail · ONS publishes one plant-hour twice", () => {
  const duplicate = parseConstrainedOffDetailCsv(SOLAR_DUPLICATE, "SOLAR");

  it("rejects both copies rather than preferring one", () => {
    // `MGJCN` appears twice for all 48 half-hours of 2024-04-13, differing in
    // val_geracaoestimada and val_geracaoverificada. A duplicate inside one
    // file is not a revision, so neither copy can be trusted over the other.
    expect(duplicate.rows.some((row) => row.plantOnsCode === "MGJCN")).toBe(false);
    const rejected = duplicate.rejected.filter((row) => row.reason === "duplicate_key");
    expect(rejected).toHaveLength(4);
  });

  it("leaves the unduplicated plants of the same file untouched", () => {
    const row = rowFor(duplicate, "BAUFB1");
    expect(row?.halfHoursObserved).toBe(2);
  });

  it("keeps a negative irradiance, which is a real sensor offset", () => {
    // 3,069 rows of the 2024-04 solar file read between −1 and −2 W/m² at
    // night with the flag saying the data is *valid*. Clamping would invent a
    // measurement ONS did not take.
    expect(rowFor(duplicate, "BAUFB1")?.measurement).toEqual({
      value: (-1.691 + -1.728) / 2,
      invalid: false,
    });
  });
});

describe("constrained-off detail · the digest is over the values, all of them", () => {
  it("changes when only the measured resource is restated", () => {
    const base = rowFor(wind, "MAEDT1");
    if (!base) {
      throw new Error("fixture row missing");
    }
    const restated = {
      ...base,
      measurement: { value: 6.1, invalid: base.measurement?.invalid ?? false },
    };
    expect(plantDetailDigest(restated)).not.toBe(plantDetailDigest(base));
  });

  it("distinguishes an absent measurement from a zero one", () => {
    const base = rowFor(wind, "MAEDT1");
    if (!base) {
      throw new Error("fixture row missing");
    }
    const zeroed = { ...base, measurement: { value: 0, invalid: false } };
    const absent = { ...base, measurement: null };
    expect(plantDetailDigest(zeroed)).not.toBe(plantDetailDigest(absent));
  });
});
