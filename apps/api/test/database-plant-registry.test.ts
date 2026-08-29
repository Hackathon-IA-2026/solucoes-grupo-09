import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { explain, validate } from "@wattsteer/core/schema";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createPlantRoutes } from "../src/api/plants.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  type RegistryGeneratingUnit,
  type RegistryPlant,
  type ResolvedPlantLocation,
  upsertPlants,
  writeGeneratingUnits,
  writePlantLocations,
} from "../src/ingest/index.js";

/**
 * `GET /v1/plants` against a real database — the claims that are only true of
 * one, gated exactly as the other `database-*.test.ts` suites are.
 *
 * Five of them cannot be proved anywhere else:
 *
 * 1. The endpoint composes the **canonical view**, which means it only answers
 *    at all if both transaction-local axes were set — `canonical_as_of()` and
 *    `canonical_fleet_date()` each raise `22023` otherwise, so a route that
 *    forgot either fails loudly here.
 * 2. **Capacity is a function of time.** The fixture has a plant whose second
 *    unit commissions mid-window, and the same request at two fleet dates
 *    returns two different capacities for it. A stored scalar could not do that.
 * 3. **A plant that did not exist on the fleet date is not a row** — not a row
 *    with `0`. An absence is never a zero.
 * 4. **A refused coordinate is `null`**, and the SIGA fallback point is labelled
 *    as a fallback rather than as a survey.
 * 5. The **licence notice and the attribution are on the payload**, in JSON and
 *    in CSV, against real rows rather than a fixture object.
 *
 * Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** One ingest, so every read below is honestly point-in-time against it. */
const INGESTED_AT = new Date("2026-08-28T09:00:00.000Z");
const AS_OF = new Date("2026-08-28T12:00:00.000Z");
/** Before the second unit of `GROWS` commissions, and before `LATE` exists. */
const EARLY_FLEET = "2025-01-15";
const LATE_FLEET = "2026-08-28";

/** A located plant, a fallback-located one, an unlocated one, and a late arrival. */
const LOCATED = "EOL.CV.RN.000001";
const FALLBACK = "UFV.CV.RS.000002";
const UNLOCATED = "EOL.CV.CE.000003";
const GROWS = "UFV.CV.MG.000004";
const LATE = "EOL.CV.BA.000005";

const registryPlant = (
  cegCore: string,
  overrides: Partial<RegistryPlant> = {},
): RegistryPlant => ({
  cegCore,
  cegRaw: `${cegCore}.01`,
  onsPlantCode: `ONS-${cegCore.slice(-6)}`,
  name: `USINA ${cegCore}`,
  subsystem: "NE",
  stateCode: "RN",
  technology: "WIND",
  operationModality: "TIPO_II_C",
  ownerName: "AGENTE PROPRIETARIO, LTDA",
  operatorName: "AGENTE OPERADOR",
  ...overrides,
});

const unit = (
  plantCegCore: string,
  suffix: string,
  ratedPowerMw: number,
  commissionedOn: string,
): RegistryGeneratingUnit => ({
  plantCegCore,
  equipmentCode: `${plantCegCore}-${suffix}`,
  unitNumber: suffix,
  name: `${plantCegCore} UG${suffix}`,
  ratedPowerMw,
  testEntryOn: null,
  commissionedOn: new Date(`${commissionedOn}T00:00:00.000Z`),
  decommissionedOn: null,
});

const location = (
  cegCore: string,
  overrides: Partial<ResolvedPlantLocation> = {},
): ResolvedPlantLocation => ({
  cegCore,
  cegRaw: `${cegCore}.1`,
  // The alias-carrying field. Nothing on this endpoint may ever render it.
  sigaName: `SIGA ALIAS ${cegCore} (Antiga OUTRA)`,
  coordinate: { latitude: -5.12, longitude: -36.38 },
  locationSource: "siga_coordinate",
  coordinateRejection: null,
  municipality: { name: "Guamaré", uf: "RN" },
  municipalitiesRaw: "Guamaré - RN",
  // Free text carrying a CNPJ. ODbL §2.4 does not license it and this endpoint
  // must not publish it.
  ownership: "100% para NEW ENERGY OPTIONS - 04.245.220/0001-36 (PIE)",
  withdrawnOn: null,
  ...overrides,
});

suite("GET /v1/plants (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const app = new Elysia().use(errorHandler).use(createPlantRoutes({ db }));

  const get = (path: string, headers?: Record<string, string>) =>
    app.handle(new Request(`http://localhost${path}`, { headers }));

  beforeAll(async () => {
    await db.execute(sql`truncate table plant_geo cascade`);
    await db.execute(sql`truncate table generating_unit cascade`);
    await db.execute(sql`truncate table siga_snapshot cascade`);
    await db.execute(sql`truncate table plant cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "capacidade-geracao",
        resourceName: "capacidade-geracao.csv",
        resourceUrl: "https://example.invalid/PLANT_REGISTRY.csv",
        format: "CSV",
        changeKey: `plant-registry-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    const sourceVersionId = version?.id ?? "";

    await upsertPlants(db, [
      registryPlant(LOCATED),
      registryPlant(FALLBACK, {
        subsystem: "S",
        stateCode: "RS",
        technology: "SOLAR",
        operationModality: "TIPO_I",
      }),
      registryPlant(UNLOCATED, { stateCode: "CE" }),
      registryPlant(GROWS, {
        subsystem: "SE",
        stateCode: "MG",
        technology: "SOLAR",
        operationModality: "TIPO_II_A",
      }),
      registryPlant(LATE, { stateCode: "BA" }),
    ]);

    await writeGeneratingUnits(db, {
      units: [
        unit(LOCATED, "1", 30, "2023-06-01"),
        unit(FALLBACK, "1", 20, "2023-06-01"),
        unit(UNLOCATED, "1", 12.5, "2023-06-01"),
        // Two units, months apart. This is what makes capacity a function of
        // time rather than an attribute.
        unit(GROWS, "1", 100, "2023-06-01"),
        unit(GROWS, "2", 300, "2026-02-01"),
        // Commissioned after the early fleet date: at that date this plant did
        // not exist and must not be a row at all.
        unit(LATE, "1", 45, "2026-05-01"),
      ],
      publishedAt: INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });

    await writePlantLocations(db, {
      locations: [
        location(LOCATED),
        location(FALLBACK, {
          // The four Cerro Chato nuclei's case: SIGA's own pair was refused and
          // the municipality centroid stood in for it.
          coordinate: { latitude: -30.9, longitude: -55.5 },
          locationSource: "siga_municipality_centroid",
          coordinateRejection: "null_island",
          municipality: { name: "Santana do Livramento", uf: "RS" },
          municipalitiesRaw: "Santana do Livramento - RS",
        }),
        location(UNLOCATED, {
          coordinate: null,
          locationSource: "unlocated",
          coordinateRejection: "out_of_bounds",
          municipality: null,
        }),
        location(GROWS),
        location(LATE),
      ],
      observedOn: new Date("2026-08-28T00:00:00.000Z"),
      publishedAt: INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });
  });

  afterAll(() => handle.close());

  const registry = async (query = ""): Promise<Record<string, unknown>> => {
    const response = await get(
      `/v1/plants?as_of=${AS_OF.toISOString()}&fleet_date=${LATE_FLEET}${query}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  const rowFor = (body: Record<string, unknown>, cegCore: string) =>
    (body.plants as Record<string, unknown>[]).find(
      (plant) => plant.ceg_core === cegCore,
    ) as Record<string, unknown>;

  it("answers the schema's own shape, and the schema is the authority", async () => {
    const body = await registry();
    const result = validate("plant-registry.schema.json", body);
    expect(result.valid ? "" : explain(result)).toBe("");
  });

  it("stamps the as-of and the fleet date on the response", async () => {
    const body = await registry();
    expect(body.as_of).toBe(AS_OF.toISOString());
    expect(body.fleet_date).toBe(LATE_FLEET);
    expect(body.plant_count).toBe(5);
  });

  it("computes installed capacity as of the fleet date", async () => {
    const late = rowFor(await registry(), GROWS);
    // Both units live: 100 + 300.
    expect(late.installed_capacity_mw).toBeCloseTo(400, 6);
    expect(late.generating_units).toBe(2);

    const earlyBody = (await (
      await get(`/v1/plants?as_of=${AS_OF.toISOString()}&fleet_date=${EARLY_FLEET}`)
    ).json()) as Record<string, unknown>;
    const early = rowFor(earlyBody, GROWS);
    // Only the 2023 unit existed on 2025-01-15. A stored scalar cannot say this.
    expect(early.installed_capacity_mw).toBeCloseTo(100, 6);
    expect(early.generating_units).toBe(1);
    expect(earlyBody.fleet_date).toBe(EARLY_FLEET);
  });

  it("omits a plant that did not exist on the fleet date rather than zeroing it", async () => {
    const earlyBody = (await (
      await get(`/v1/plants?as_of=${AS_OF.toISOString()}&fleet_date=${EARLY_FLEET}`)
    ).json()) as Record<string, unknown>;
    const codes = (earlyBody.plants as Record<string, unknown>[]).map(
      (plant) => plant.ceg_core,
    );
    // An absence is never a zero: `LATE` commissions in 2026 and is simply not
    // in the 2025 fleet.
    expect(codes).not.toContain(LATE);
    expect(earlyBody.plant_count).toBe(4);
  });

  it("returns an absent coordinate as null, never a zero pair", async () => {
    const row = rowFor(await registry(), UNLOCATED);
    expect(row.coordinate).toBeNull();
    expect(row.location_source).toBe("unlocated");
  });

  it("labels a fallback point as a fallback rather than as a survey", async () => {
    const row = rowFor(await registry(), FALLBACK);
    expect(row.location_source).toBe("siga_municipality_centroid");
    expect(row.coordinate).toEqual({ latitude: -30.9, longitude: -55.5 });
    // And a surveyed one says so.
    expect(rowFor(await registry(), LOCATED).location_source).toBe("siga_coordinate");
  });

  it("renders ONS's name and never SIGA's alias-carrying field", async () => {
    const body = await registry();
    for (const plant of body.plants as Record<string, unknown>[]) {
      expect(String(plant.name)).toStartWith("USINA ");
      expect(String(plant.name)).not.toContain("Antiga");
      expect(String(plant.name)).not.toContain("SIGA ALIAS");
    }
  });

  it("publishes ONS's agent and never SIGA's CNPJ-bearing ownership text", async () => {
    const raw = JSON.stringify(await registry());
    expect(raw).toContain("AGENTE PROPRIETARIO");
    // ODbL §2.4 does not license rights in the individual Contents, and this
    // field names legal persons by CNPJ.
    expect(raw).not.toContain("04.245.220/0001-36");
    expect(raw).not.toContain("(PIE)");
  });

  it("filters by subsystem and by technology, and echoes what it filtered on", async () => {
    const bySubsystem = await registry("&subsystem=NE");
    expect((bySubsystem.filters as Record<string, unknown>).subsystem).toBe("NE");
    expect(
      (bySubsystem.plants as Record<string, unknown>[]).every(
        (plant) => plant.subsystem === "NE",
      ),
    ).toBe(true);

    const byTechnology = await registry("&technology=SOLAR");
    expect((byTechnology.filters as Record<string, unknown>).technology).toBe("SOLAR");
    // Ordered by subsystem, then technology, then the CEG core — `S` before
    // `SE`, which is `SUBSYSTEMS` order and not alphabetical accident.
    expect(
      (byTechnology.plants as Record<string, unknown>[]).map((p) => p.ceg_core),
    ).toEqual([FALLBACK, GROWS]);

    // Unfiltered says so rather than leaving it to be inferred.
    const all = await registry();
    expect(all.filters).toEqual({ subsystem: null, technology: null });
  });

  it("refuses a subsystem that is not one of the four", async () => {
    const response = await get("/v1/plants?subsystem=SIN");
    expect(response.status).toBe(422);
  });

  it("carries the licence and the attribution on the JSON payload", async () => {
    const body = await registry();
    const licence = body.licence as Record<string, unknown>;
    expect(licence.database).toBe("ODbL-1.0");
    expect(licence.derivative_database).toBe(true);
    expect(licence.attribution_required).toBe(true);
    const attribution = body.attribution as Record<string, Record<string, unknown>>;
    expect(attribution.aneel_siga?.licence).toBe("ODbL-1.0");
    expect(attribution.ons?.licence).toBe("CC-BY-4.0");
  });

  it("serves CSV with the notice before any row, and no zero-pair coordinate", async () => {
    const response = await get(
      `/v1/plants?as_of=${AS_OF.toISOString()}&fleet_date=${LATE_FLEET}&format=csv`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("link")).toContain('rel="license"');
    const csv = await response.text();
    const lines = csv.split("\n");
    const preamble = lines.filter((line) => line.startsWith("#"));
    expect(preamble.join("\n")).toContain("ODbL-1.0");
    expect(preamble.join("\n")).toContain("ANEEL SIGA");
    expect(lines[preamble.length]).toStartWith("ons_plant_code,");
    // The unlocated plant's two coordinate cells are empty, not `0`.
    const row = lines.find((line) => line.includes(UNLOCATED)) as string;
    expect(row).toContain(",,,unlocated");
  });

  it("validates on the registry snapshot, and answers 304 to its own ETag", async () => {
    const first = await get(
      `/v1/plants?as_of=${AS_OF.toISOString()}&fleet_date=${LATE_FLEET}`,
    );
    const etag = first.headers.get("etag") as string;
    // A cache key is a provenance: the daily snapshot's ingestion instant.
    expect(etag).toContain(INGESTED_AT.toISOString());
    expect(first.headers.get("cache-control")).toBe("public, max-age=86400");
    const second = await get(
      `/v1/plants?as_of=${AS_OF.toISOString()}&fleet_date=${LATE_FLEET}`,
      { "if-none-match": etag },
    );
    expect(second.status).toBe(304);
  });
});
