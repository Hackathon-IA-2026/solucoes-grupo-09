import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlantRegistry } from "@wattsteer/core/api";
import { SOURCE_ATTRIBUTION } from "@wattsteer/core/constants";
import { explain, validate } from "@wattsteer/core/schema";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia } from "elysia";
import { app } from "../src/api/index.js";
import { createPlantRoutes, toCsv } from "../src/api/plants.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * The claims about `/v1/plants` that need no database — and they are the claims
 * that matter most, because this endpoint exists for a **licence**.
 *
 * A route that silently loses its attribution still returns 200 and still looks
 * right in a browser. So the properties asserted here are the ones a refactor
 * could plausibly break without anyone noticing: that the notice is on **both**
 * formats, that it comes from the shared constant rather than a literal, that
 * an absent coordinate survives the CSV rendering as two empty cells, and that
 * the read touches no base table.
 */

const SOURCE = join(import.meta.dir, "..", "src");

/** Source with block and line comments removed — prose may not satisfy a rule. */
function code(relative: string): string {
  return readFileSync(join(SOURCE, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const ROUTE = code("api/plants.ts");
const READ = code("contract/plant-registry.ts");

/** A registry with one located plant, one fallback-located plant and one absent. */
const REGISTRY: PlantRegistry = {
  asOf: "2026-08-28T12:00:00.000Z",
  fleetDate: "2026-08-28",
  vintageFidelity: "point_in_time",
  filters: { subsystem: null, technology: null },
  plantCount: 3,
  licence: {
    database: "ODbL-1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    derivativeDatabase: true,
    alterationsAt: "docs/research/plant-registry.md#7",
    attributionRequired: true,
  },
  attribution: {
    ons: {
      name: "ONS Dados Abertos",
      licence: "CC-BY-4.0",
      url: "https://dados.ons.org.br/",
    },
    aneel_siga: {
      name: "ANEEL SIGA",
      licence: "ODbL-1.0",
      url: "https://dadosabertos.aneel.gov.br/",
    },
  },
  plants: [
    {
      onsPlantCode: "ALEG2",
      cegCore: "EOL.CV.RN.028443-2",
      name: "ALEGRIA II",
      subsystem: "NE",
      stateCode: "RN",
      technology: "WIND",
      operationModality: "TIPO_II_C",
      municipality: "Guamaré - RN",
      ownerName: "NEW ENERGY, LTDA",
      operatorName: "NEW ENERGY",
      installedCapacityMw: 51.3,
      generatingUnits: 30,
      coordinate: { latitude: -5.124_305_56, longitude: -36.383_305_56 },
      locationSource: "siga_coordinate",
    },
    {
      onsPlantCode: null,
      cegCore: "UFV.CV.BA.099999-1",
      name: 'CERRO CHATO "NUCLEO"',
      subsystem: "SE",
      stateCode: "BA",
      technology: "SOLAR",
      operationModality: "TIPO_I",
      municipality: "Santana do Livramento - RS",
      ownerName: "AGENTE",
      operatorName: "AGENTE",
      installedCapacityMw: 30,
      generatingUnits: 10,
      coordinate: { latitude: -30.9, longitude: -55.5 },
      // A municipality centroid, and labelled as one. Presenting this as a
      // surveyed coordinate is the failure the column exists to prevent.
      locationSource: "siga_municipality_centroid",
    },
    {
      onsPlantCode: "NOWHERE",
      cegCore: "EOL.CV.CE.028770-9",
      name: "SEM LOCALIZACAO",
      subsystem: "NE",
      stateCode: "CE",
      technology: "WIND",
      operationModality: "TIPO_II_B",
      municipality: null,
      ownerName: "AGENTE",
      operatorName: "AGENTE",
      installedCapacityMw: 12.5,
      generatingUnits: 5,
      coordinate: null,
      locationSource: "unlocated",
    },
  ],
};

describe("plants · the boundary, structurally", () => {
  it("reads the canonical view and never a base table", () => {
    expect(READ).toContain("canonicalPlantRegistry");
    // The tables the view is built over. Naming one here would put the two
    // `AsOf` picks, the ONS↔SIGA join and the capacity sum in a second place —
    // and those are exactly the "alterations" ODbL §4.6(b) is published about.
    for (const table of [
      "from generating_unit",
      "from plant_geo",
      "from plant ",
      "join plant",
      "generating_unit",
      "plant_geo",
    ]) {
      expect(READ.replace(/generating_units/g, "")).not.toContain(table);
      expect(ROUTE.replace(/generating_units/g, "")).not.toContain(table);
    }
  });

  it("sets both axes rather than bypassing them", () => {
    // `canonical_as_of()` and `canonical_fleet_date()` each raise 22023 when
    // unset; this is the one place on this path that may write either.
    expect(READ).toContain("applyAxes");
    expect(READ).toContain("fleetDate");
  });

  it("never projects SIGA's alias-carrying name", () => {
    // `plant_geo.siga_name` carries `(Antiga …)` aliases. The view does not
    // project it, and neither of these files may reach for it.
    for (const source of [ROUTE, READ]) {
      expect(source).not.toContain("siga_name");
      expect(source).not.toContain("sigaName");
    }
  });

  it("never publishes SIGA's ownership free text", () => {
    // `DscPropriRegimePariticipacao` carries CNPJs of named legal persons,
    // which ODbL §2.4 explicitly does not license. Ownership on this payload is
    // ONS's agent name.
    for (const source of [ROUTE, READ]) {
      expect(source).not.toContain("ownership");
    }
  });

  it("takes the attribution from the shared constant, not a literal", () => {
    // An attribution written out in this file is an attribution this file can
    // be refactored out of. `/v1/meta` echoes the same object.
    expect(ROUTE).toContain("SOURCE_ATTRIBUTION");
    expect(ROUTE).not.toContain('"CC-BY-4.0"');
  });

  it("translates through the one translator", () => {
    expect(ROUTE).toContain("encodeWire");
    expect(ROUTE).not.toContain('from "../contract/wire.js"');
    expect(encodeWire("RegistryPlantRow", { installedCapacityMw: 1 })).toEqual({
      installed_capacity_mw: 1,
    });
  });
});

describe("plants · the licence rides on the payload", () => {
  const wire = encodeWire("PlantRegistry", REGISTRY) as Record<string, unknown>;

  it("is the schema's own shape, and the schema is the authority", () => {
    const result = validate("plant-registry.schema.json", wire);
    expect(result.valid ? "" : explain(result)).toBe("");
  });

  it("carries the ODbL notice and the source attribution in the JSON", () => {
    // `required` in a schema that is `additionalProperties: false`: dropping
    // either of these fails to compile against the generated interface, and
    // fails this assertion if it somehow does not.
    const licence = wire.licence as Record<string, unknown>;
    expect(licence.database).toBe("ODbL-1.0");
    expect(licence.derivative_database).toBe(true);
    expect(licence.attribution_required).toBe(true);
    expect(String(licence.url)).toContain("opendatacommons.org");
    // §4.6(b): where the alterations are published.
    expect(String(licence.alterations_at)).toContain("plant-registry");

    const attribution = wire.attribution as Record<string, Record<string, unknown>>;
    expect(attribution.aneel_siga?.licence).toBe("ODbL-1.0");
    expect(attribution.ons?.licence).toBe("CC-BY-4.0");
    // `attribution` is a map whose **keys** are data — source identifiers, which
    // travel untouched. Its **values** are a named shape and are renamed field
    // by field, which they were not when this ticket shipped: the block was
    // narrowed to the three casing-stable names because the one translator
    // carried a map through whole. `api-surface` ticket 06 fixed the generator,
    // so this asserts the rename on a multi-word field instead of pinning the
    // narrowing that was standing in for it.
    for (const key of Object.keys(attribution)) {
      expect(key).toBe(key.toLowerCase());
    }
    const wired = encodeWire("PlantRegistry", {
      ...REGISTRY,
      attribution: {
        aneel_siga: {
          name: "ANEEL SIGA",
          licence: "ODbL-1.0",
          url: "https://dadosabertos.aneel.gov.br/",
          derivativeDatabase: true,
          machineReadableAt: "/v1/plants",
        },
      },
    }) as { attribution: Record<string, Record<string, unknown>> };
    expect(wired.attribution.aneel_siga?.derivative_database).toBe(true);
    expect(wired.attribution.aneel_siga?.machine_readable_at).toBe("/v1/plants");
    expect(wired.attribution.aneel_siga?.derivativeDatabase).toBeUndefined();
    expect(validate("plant-registry.schema.json", wired).valid).toBe(true);
  });

  it("carries the same notice in the CSV, before any row", () => {
    // A caller who takes the CSV is a recipient under §4.6 just the same, and a
    // bare table of coordinates with no licence line is the artefact ODbL
    // forbids handing on.
    const csv = toCsv(REGISTRY);
    const preamble = csv.split("\n").filter((line) => line.startsWith("#"));
    expect(preamble.join("\n")).toContain("ODbL-1.0");
    expect(preamble.join("\n")).toContain("opendatacommons.org");
    expect(preamble.join("\n")).toContain("ANEEL SIGA");
    expect(preamble.join("\n")).toContain("ONS Dados Abertos");
    // Every comment line precedes the header row, so a reader that skips `#`
    // lines gets a well-formed table and nothing else.
    const header = csv.split("\n").findIndex((line) => line.startsWith("ons_plant_code"));
    expect(header).toBe(preamble.length);
  });

  it("names every source the constant does", () => {
    // Adding a source to `SOURCE_ATTRIBUTION` without it reaching this payload
    // is the drift one shared constant exists to prevent.
    const csv = toCsv(REGISTRY);
    for (const key of Object.keys(REGISTRY.attribution)) {
      expect(csv).toContain(`# source ${key}:`);
    }
    expect(Object.keys(SOURCE_ATTRIBUTION)).toContain("aneel_siga");
  });
});

describe("plants · a coordinate is absent or it is real", () => {
  const csv = toCsv(REGISTRY);
  const rows = csv.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
  const header = (rows[0] as string).split(",");
  const cellOf = (row: string, column: string): string =>
    (row.split(",")[header.indexOf(column)] ?? "") as string;

  it("writes an absent coordinate as two empty cells, never as zeros", () => {
    const unlocated = rows.find((row) => row.startsWith("NOWHERE,")) as string;
    expect(cellOf(unlocated, "latitude")).toBe("");
    expect(cellOf(unlocated, "longitude")).toBe("");
    expect(cellOf(unlocated, "location_source")).toBe("unlocated");
    // Null Island is not a location. A `0` in either column would be one.
    expect(unlocated).not.toContain(",0,0,");
  });

  it("labels a fallback point as a fallback rather than as a survey", () => {
    const fallback = rows.find((row) => row.includes("UFV.CV.BA.099999-1")) as string;
    expect(cellOf(fallback, "location_source")).toBe("siga_municipality_centroid");
    expect(cellOf(fallback, "latitude")).toBe("-30.9");
  });

  it("quotes a field carrying a comma or a quote rather than splitting the row", () => {
    const withComma = rows.find((row) => row.includes("ALEG2")) as string;
    expect(withComma).toContain('"NEW ENERGY, LTDA"');
    const withQuote = toCsv(REGISTRY);
    expect(withQuote).toContain('"CERRO CHATO ""NUCLEO"""');
  });

  it("keeps the JSON coordinate as an object or null, never a zero pair", () => {
    const wire = encodeWire("PlantRegistry", REGISTRY) as {
      plants: { coordinate: unknown }[];
    };
    expect(wire.plants[2]?.coordinate).toBeNull();
    expect(wire.plants[0]?.coordinate).toEqual({
      latitude: -5.124_305_56,
      longitude: -36.383_305_56,
    });
  });
});

describe("plants · the route", () => {
  it("is registered on the app under /v1", () => {
    const routes = app.routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toContain("GET /v1/plants");
  });

  it("answers an unconfigured database as an absence of data", async () => {
    const withoutDb = new Elysia()
      .use(errorHandler)
      .use(createPlantRoutes({ db: undefined }));
    const response = await withoutDb.handle(new Request("http://localhost/v1/plants"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DATA_UNAVAILABLE");
  });
});
