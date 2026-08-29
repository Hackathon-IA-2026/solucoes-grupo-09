import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectDailySigaResource } from "../src/ingest/aneel/catalogue.js";
import {
  assertMatchRate,
  DEFAULT_MATCH_RATE_FLOOR,
  measureMatchRate,
} from "../src/ingest/aneel/match-rate.js";
import {
  BRAZIL_BBOX,
  classifyCoordinate,
  FLEET_MIN_CAPACITY_KW,
  isFleetScale,
  municipalityCentroids,
  parseAneelDecimal,
  parseMunicipalities,
  parseSigaCsv,
  resolveLocations,
  summariseSigaFleetCapacity,
} from "../src/ingest/aneel/siga.js";
import { fingerprintFromHeaders, readResources } from "../src/ingest/ons/catalogue.js";
import { parseCapacityRegistryCsv } from "../src/ingest/ons/plant-registry.js";
import type { StoredPlantLocation } from "../src/ingest/siga-repository.js";
import { findWithdrawnPlants } from "../src/ingest/siga-repository.js";
import type { RegistryPlantKey, SigaRegistration } from "../src/ingest/types.js";

const ANEEL = join(import.meta.dir, "fixtures", "aneel");
const ONS = join(import.meta.dir, "fixtures", "ons");
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

// Captured 2026-08-28 from dadosabertos.aneel.gov.br; see fixtures/aneel/FIXTURES.md
// for the exact lines and what each one pins.
const SIGA = read(ANEEL, "siga-empreendimentos-geracao-diario.registry.csv");
const PACKAGE = JSON.parse(read(ANEEL, "package-show-siga.json")) as unknown;
const CAPACITY = read(ONS, "CAPACIDADE_GERACAO.registry.csv");

const siga = () => parseSigaCsv(SIGA);
const find = (rows: readonly SigaRegistration[], core: string) => {
  const row = rows.find((candidate) => candidate.cegCore === core);
  if (!row) {
    throw new Error(`fixture is missing ${core}`);
  }
  return row;
};

describe("SIGA catalogue · the daily resource, never the monthly one", () => {
  const resources = readResources(PACKAGE);

  it("selects the daily CSV out of a package that carries both cuts", () => {
    // Both are CSV, both carry the same 23-column header, and the monthly one
    // comes first in the package. Format preference alone would take it.
    expect(resources.filter((resource) => resource.format === "CSV")).toHaveLength(2);
    const selected = selectDailySigaResource(resources);
    expect(selected.url.endsWith("siga-empreendimentos-geracao-diario.csv")).toBe(true);
  });

  it("is fresher than the monthly cut, which is the whole reason", () => {
    const daily = selectDailySigaResource(resources);
    const monthly = resources.find(
      (resource) => resource.format === "CSV" && !resource.url.endsWith("-diario.csv"),
    );
    expect(daily.lastModified?.getTime()).toBeGreaterThan(
      monthly?.lastModified?.getTime() ?? 0,
    );
  });

  it("fails rather than substituting the monthly cut when the daily one is gone", () => {
    const withoutDaily = resources.filter(
      (resource) => !resource.url.endsWith("-diario.csv"),
    );
    expect(() => selectDailySigaResource(withoutDaily)).toThrow(/daily CSV resource/);
  });

  it("fingerprints on a clean ETag — no multipart suffix, unlike ONS's S3", () => {
    const raw = JSON.parse(
      read(ANEEL, "head-siga-empreendimentos-geracao-diario.csv.json"),
    ) as Record<string, string>;
    const fingerprint = fingerprintFromHeaders(new Headers(raw));
    expect(fingerprint.etag).toBe('"1787913722.5088766-8446772-1847136755"');
    expect(fingerprint.contentLength).toBe(8_446_772);
    expect(fingerprint.changeKey).toContain("8446772");
  });
});

describe("SIGA · the ANEEL dialect", () => {
  const parse = siga();

  it("reads the decimal comma ONS never writes", () => {
    // `Number("-5,12430556")` is NaN. The ONS `parseDecimal` would silently
    // turn every coordinate in this file into a rejected row.
    expect(parseAneelDecimal("-5,12430556")).toBeCloseTo(-5.124_305_56, 8);
    expect(parseAneelDecimal("100650,00")).toBeCloseTo(100_650, 6);
    // Thousands grouping only when a comma decides where the point is.
    expect(parseAneelDecimal("1.234,56")).toBeCloseTo(1234.56, 6);
    expect(parseAneelDecimal("-37.5")).toBeCloseTo(-37.5, 6);
    // Present-but-empty stays distinguishable from unreadable.
    expect(parseAneelDecimal("")).toBeNull();
    expect(parseAneelDecimal("norte")).toBeNaN();
  });

  it("carries ANEEL's own header typos verbatim", () => {
    // `DscMuninicpios` and `Pariticipacao` are misspelled in the live file.
    // Correcting them here produces a parser that matches nothing.
    expect(parse.columns).toHaveLength(23);
    expect(parse.columns).toContain("DscMuninicpios");
    expect(parse.columns).toContain("DscPropriRegimePariticipacao");
  });

  it("reads one generation stamp for the whole extract", () => {
    expect(parse.snapshotDate.toISOString()).toBe("2026-08-28T00:00:00.000Z");
  });

  it("splits `Município - UF`, including the multi-municipality case", () => {
    const xingo = find(parse.rows, "UHE.PH.SE.027053-9");
    expect(xingo.municipalities).toEqual([
      { name: "Piranhas", uf: "AL" },
      { name: "Canindé de São Francisco", uf: "SE" },
    ]);
    // An entry with no UF is dropped rather than kept with a guessed state.
    expect(parseMunicipalities("Bom Jesus")).toEqual([]);
  });

  it("keeps ownership verbatim, percentage, CNPJ and regime", () => {
    const alegria = find(parse.rows, "EOL.CV.RN.028443-2");
    expect(alegria.ownership).toContain("100% para");
    expect(alegria.ownership).toContain("04.245.220/0001-36");
  });

  it("folds the duplicate CodCEG rows and reports them", () => {
    // Rio Timbó appears twice, differing only in `DscTipoOutorga`.
    expect(parse.duplicateCegCores).toBe(1);
    expect(parse.conflictingDuplicates).toBe(0);
    expect(parse.rows.filter((row) => row.cegCore === "PCH.PH.SC.028744-0")).toHaveLength(
      1,
    );
  });
});

describe("SIGA · the join key, which is the whole risk", () => {
  const parse = siga();
  // The nine VRE plants the ONS capacity fixture also carries.
  const registry: RegistryPlantKey[] = parseCapacityRegistryCsv(CAPACITY, {
    allowRenewableDeactivations: true,
  }).plants.map((plant) => ({ cegCore: plant.cegCore, cegRaw: plant.cegRaw }));

  it("matches nothing at all on the naive verbatim key", () => {
    // The failure this whole module exists for. Not an error, not a malformed
    // column — an empty result. ANEEL writes `.1`, ONS writes `.01`.
    const verbatim = new Set(parse.rows.map((row) => row.cegRaw));
    const matched = registry.filter((plant) => verbatim.has(plant.cegRaw));
    expect(registry.length).toBeGreaterThan(0);
    expect(matched).toHaveLength(0);

    // And the renderings that fail to match are genuinely the same plant.
    const alegriaOns = registry.find((plant) => plant.cegCore === "EOL.CV.RN.028443-2");
    expect(alegriaOns?.cegRaw).toBe("EOL.CV.RN.028443-2.01");
    expect(find(parse.rows, "EOL.CV.RN.028443-2").cegRaw).toBe("EOL.CV.RN.028443-2.1");
  });

  it("matches every plant on the version-stripped core", () => {
    const match = measureMatchRate(registry, parse.rows);
    expect(match.registryPlants).toBe(9);
    expect(match.matched).toBe(9);
    expect(match.rate).toBe(1);
    expect(match.unmatched).toEqual([]);
  });

  it("reports the verbatim rate as a live canary rather than discarding it", () => {
    const match = measureMatchRate(registry, parse.rows);
    expect(match.verbatimMatched).toBe(0);
    expect(match.verbatimRate).toBe(0);
  });

  it("de-padding alone is not the fix — the version itself moves", () => {
    // ANEEL bumps the version on re-registration and ONS does not follow, so
    // `.01` → `.1` still leaves 17 of 1,614 plants unmatched in the live data.
    // Modelled here on Alegria II: ANEEL at version 2, ONS still at 1.
    const dePadded = (raw: string) => raw.replace(/\.0(\d)$/, ".$1");
    const reRegistered = parse.rows.map((row) =>
      row.cegCore === "EOL.CV.RN.028443-2"
        ? { ...row, cegRaw: "EOL.CV.RN.028443-2.2" }
        : row,
    );
    const dePaddedKeys = new Set(reRegistered.map((row) => row.cegRaw));
    expect(dePaddedKeys.has(dePadded("EOL.CV.RN.028443-2.01"))).toBe(false);
    // The core key is unmoved by the bump.
    expect(measureMatchRate(registry, reRegistered).matched).toBe(9);
  });

  it("fails the ingest when the rate falls below the floor", () => {
    const withGhosts: RegistryPlantKey[] = [
      ...registry,
      { cegCore: "EOL.CV.RS.030784-0", cegRaw: "EOL.CV.RS.030784-0.01" },
    ];
    const match = measureMatchRate(withGhosts, parse.rows);
    expect(match.rate).toBeLessThan(DEFAULT_MATCH_RATE_FLOOR);
    expect(() => assertMatchRate(match)).toThrow(/below the 99.00% floor/);
    // And it names what went missing rather than only the number.
    expect(() => assertMatchRate(match)).toThrow(/EOL\.CV\.RS\.030784-0/);
  });

  it("fails on a slide that would clear an absolute floor", () => {
    // The case a fixed floor cannot see: a rate that was 100% and is now 99.5%.
    const match = measureMatchRate(registry, parse.rows);
    const slipped = { ...match, rate: 0.993, matched: 8 };
    expect(() => assertMatchRate(slipped, { previousRate: 1 })).toThrow(/regressed/);
    // Ordinary churn — a plant ONS lists before ANEEL registers it — is not.
    expect(() =>
      assertMatchRate({ ...match, rate: 0.997 }, { previousRate: 1 }),
    ).not.toThrow();
  });

  it("does not fail on the very first ingest, before the registry exists", () => {
    const match = measureMatchRate([], parse.rows);
    expect(match.rate).toBe(1);
    expect(() => assertMatchRate(match, { previousRate: null })).not.toThrow();
  });
});

describe("SIGA · a coordinate outside Brazil is absent, not a location", () => {
  const parse = siga();

  it("treats exact zeros as Null Island rather than as the Gulf of Guinea", () => {
    const enacel = find(parse.rows, "EOL.CV.CE.028770-9");
    // And the file writes it as `,00000000` — a decimal comma with no integer
    // part, which a naive reader turns into NaN rather than into zero.
    expect(enacel.rawLatitude).toBe(0);
    expect(enacel.rawLongitude).toBe(0);
    expect(enacel.coordinate).toBeNull();
    expect(enacel.coordinateRejection).toBe("null_island");
    expect(parse.nullIslandRows).toBe(2);
  });

  it("rejects a latitude that is in range while the longitude is not", () => {
    // A latitude-only bounds check passes every one of these.
    expect(classifyCoordinate(-5.1, 12.4)).toEqual({ rejection: "out_of_bounds" });
    expect(classifyCoordinate(0, 0)).toEqual({ rejection: "null_island" });
    expect(classifyCoordinate(null, -40)).toEqual({ rejection: "missing" });
    expect(classifyCoordinate(Number.NaN, -40)).toEqual({ rejection: "unparsable" });
    expect(classifyCoordinate(BRAZIL_BBOX.minLatitude, BRAZIL_BBOX.maxLongitude)).toEqual(
      { coordinate: { latitude: -34, longitude: -33 } },
    );
  });

  it("counts the one real plant the bounding box excludes", () => {
    // Fernando de Noronha at −32.417 is correctly sited and outside the box.
    // Reported rather than assumed to be zero — see the BRAZIL_BBOX note.
    expect(parse.outOfBoundsRows).toBe(1);
    expect(find(parse.rows, "UTE.PE.PE.002887-8").coordinateRejection).toBe(
      "out_of_bounds",
    );
  });
});

describe("SIGA · the municipality fallback", () => {
  const parse = siga();
  const resolved = resolveLocations(parse.rows);

  it("locates a null-island plant at its municipality's registration centroid", () => {
    const draco = resolved.get("UFV.RS.MG.049441-0");
    expect(draco?.locationSource).toBe("siga_municipality_centroid");
    // The mean of Draco Solar 5 and 7, the two properly sited Arinos plants.
    expect(draco?.coordinate?.latitude).toBeCloseTo((-15.802_95 + -15.816_269_44) / 2, 8);
    expect(draco?.coordinate?.longitude).toBeCloseTo(
      (-45.888_641_67 + -45.880_755_56) / 2,
      8,
    );
    // The reason the original coordinate was refused survives the fallback.
    expect(draco?.coordinateRejection).toBe("null_island");
    expect(draco?.municipality).toEqual({ name: "Arinos", uf: "MG" });
  });

  it("never averages an invalid coordinate into a centroid", () => {
    const centroids = municipalityCentroids(parse.rows);
    const arinos = centroids.get("ARINOS|MG");
    // Draco Solar 6's (0,0) is not in the mean — it would drag it 4,700 km.
    expect(arinos?.latitude).toBeLessThan(-15);
    expect(arinos?.longitude).toBeLessThan(-45);
  });

  it("prefers an externally supplied centroid when one is wired in", () => {
    const external = resolveLocations(parse.rows, {
      centroids: (municipality) =>
        municipality.name === "Arinos" ? { latitude: -15.9, longitude: -46.1 } : null,
    });
    expect(external.get("UFV.RS.MG.049441-0")?.coordinate).toEqual({
      latitude: -15.9,
      longitude: -46.1,
    });
  });

  it("leaves a plant unlocated rather than inventing a point", () => {
    // Fernando de Noronha's only registration is the rejected one, so its
    // municipality has no centroid to offer. Nothing is guessed.
    const noronha = resolved.get("UTE.PE.PE.002887-8");
    expect(noronha?.locationSource).toBe("unlocated");
    expect(noronha?.coordinate).toBeNull();
    expect(noronha?.coordinateRejection).toBe("out_of_bounds");
  });

  it("passes a good coordinate straight through", () => {
    const alegria = resolved.get("EOL.CV.RN.028443-2");
    expect(alegria?.locationSource).toBe("siga_coordinate");
    expect(alegria?.coordinate?.latitude).toBeCloseTo(-5.124_305_56, 8);
    expect(alegria?.coordinateRejection).toBeNull();
  });
});

describe("SIGA · technology and size filters come before any aggregation", () => {
  const parse = siga();

  it("excludes a 1 kW rooftop registration that says `Operação` and `UFV`", () => {
    const rooftop = find(parse.rows, "UFV.RS.SP.030442-5");
    expect(rooftop.phase).toBe("Operação");
    expect(rooftop.sourceTechnology).toBe("UFV");
    expect(rooftop.inspectedCapacityKw).toBe(1);
    expect(isFleetScale(rooftop)).toBe(false);
  });

  it("excludes a plant ANEEL still calls `Construção` at zero kW", () => {
    const lagging = find(parse.rows, "UFV.RS.CE.033232-1");
    expect(lagging.inspectedCapacityKw).toBe(0);
    expect(isFleetScale(lagging)).toBe(false);
  });

  it("excludes thermal, hydro and nuclear however large", () => {
    const angra = find(parse.rows, "UTN.UR.RJ.000101-5");
    expect(angra.inspectedCapacityKw).toBeGreaterThan(FLEET_MIN_CAPACITY_KW);
    expect(isFleetScale(angra)).toBe(false);
    expect(isFleetScale(find(parse.rows, "UHE.PH.SE.027053-9"))).toBe(false);
  });

  it("filters inside the aggregate rather than trusting the caller", () => {
    const summary = summariseSigaFleetCapacity(parse.rows);
    // Nine wind plants (Enacel included — a refused coordinate is not a
    // refused plant) plus Belmonte, Pitombeira and the three Draco solars.
    expect(summary.plants).toBe(14);
    expect(summary.excludedRows).toBe(7);
    // An unfiltered sum over the same rows is a different quantity entirely.
    const unfiltered = parse.rows.reduce(
      (total, row) => total + (row.inspectedCapacityKw ?? 0),
      0,
    );
    expect(unfiltered).toBeGreaterThan(summary.capacityKw * 2);
  });
});

describe("SIGA · a deletion is how a retirement is expressed", () => {
  const stored = (cegCore: string, withdrawnOn: Date | null): StoredPlantLocation => ({
    cegCore,
    cegRaw: `${cegCore}.1`,
    sigaName: "Enacel",
    coordinate: { latitude: -4.757, longitude: -37.5 },
    locationSource: "siga_coordinate",
    coordinateRejection: null,
    municipality: { name: "Aracati", uf: "CE" },
    municipalitiesRaw: "Aracati - CE",
    ownership: "100% para X - 00.000.000/0001-00 (PIE)",
    withdrawnOn,
    observedOn: new Date("2026-08-27T00:00:00.000Z"),
    dataVersion: 1,
    ingestedAt: new Date("2026-08-27T10:00:00.000Z"),
  });
  const day = new Date("2026-08-28T00:00:00.000Z");

  it("detects a plant that was in the prior snapshot and is not in this one", () => {
    const previous = new Map([
      ["EOL.CV.CE.028770-9", stored("EOL.CV.CE.028770-9", null)],
    ]);
    const withdrawn = findWithdrawnPlants(previous, new Set(), day);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.withdrawnOn).toEqual(day);
    // The last known location is restated, not nulled: "ANEEL removed the
    // registration" and "ANEEL never had a coordinate" are different facts.
    expect(withdrawn[0]?.coordinate).toEqual({ latitude: -4.757, longitude: -37.5 });
    expect(withdrawn[0]?.locationSource).toBe("siga_coordinate");
  });

  it("writes a withdrawal once rather than on every subsequent ingest", () => {
    const previous = new Map([["EOL.CV.CE.028770-9", stored("EOL.CV.CE.028770-9", day)]]);
    expect(findWithdrawnPlants(previous, new Set(), day)).toEqual([]);
  });

  it("says nothing about a plant that is still there", () => {
    const previous = new Map([
      ["EOL.CV.CE.028770-9", stored("EOL.CV.CE.028770-9", null)],
    ]);
    expect(findWithdrawnPlants(previous, new Set(["EOL.CV.CE.028770-9"]), day)).toEqual(
      [],
    );
  });
});
