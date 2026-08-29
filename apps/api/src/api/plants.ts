import type { PlantRegistry, RegistryPlantRow } from "@wattsteer/core/api";
import {
  ODBL_ALTERATIONS_AT,
  ODBL_LICENCE_URL,
  SOURCE_ATTRIBUTION,
  SUBSYSTEM_CODES,
} from "@wattsteer/core/constants";
import { TECHNOLOGIES } from "@wattsteer/core/domain";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import type { PlantRegistryObservation } from "../contract/plant-registry.js";
import { readPlantRegistry } from "../contract/plant-registry.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { CodedError } from "../errors.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { optionalInstant } from "./params.js";

/**
 * `GET /v1/plants` — the plant registry, machine-readable, **because a licence
 * requires it**.
 *
 * This route is not here for a screen. `docs/research/plant-registry.md` §7
 * establishes the chain and `docs/specs/api-surface.md` §14 accepts it: loading
 * a substantial part of ANEEL SIGA into Postgres makes WattSteer's plant table
 * a **Derivative Database** (ODbL §4.4(b)); the public charts built from it are
 * **Publicly Used Produced Works**, which §4.4(c) uses to pull the derivative
 * itself under share-alike; and §4.6 then obliges an offer of machine-readable
 * access, free of charge, over the internet. That obligation bites from day
 * one, not at monetisation, and nothing else in the product discharges it.
 *
 * It follows that the interesting engineering question here is not "how do I
 * serialise rows" but **"how do I make the notice hard to drop"**, because a
 * refactor that quietly loses the attribution turns a working endpoint into a
 * licence breach that still returns 200. Four mechanisms, none of which is a
 * comment asking someone to be careful:
 *
 * 1. **`licence` and `attribution` are `required` in
 *    `plant-registry.schema.json`**, which is `additionalProperties: false`.
 *    The response is typed as the generated `PlantRegistry`, so removing either
 *    field fails `bun run typecheck` — not a review, and not a validator in
 *    production.
 * 2. **Both formats are built from one object.** The CSV is rendered *from* the
 *    same `PlantRegistry` the JSON is encoded from, by `toCsv` below, and that
 *    function writes the notice preamble before it writes a header row. There
 *    is no second path through which a row can reach a caller.
 * 3. **The block is a shared constant**, `SOURCE_ATTRIBUTION` in
 *    `@wattsteer/core`, which `GET /v1/meta` will echo from the same object.
 *    An attribution that lived as a literal in this file is an attribution this
 *    file can be refactored out of.
 * 4. **Two tests assert it in both formats** — the JSON against the schema, the
 *    CSV against its preamble — so deleting the mechanism deletes a green test.
 *
 * ### Two shapes that are decisions rather than data
 *
 * - **Capacity is a function of time.** It is summed over the generating units
 *   live on the fleet date, in the canonical view, and the date is stamped on
 *   the response. `fleet_date` defaults to the request date, which is what the
 *   ticket asks for; the default is honest because the value is *on* the answer.
 * - **An absent coordinate is `null` and never a zero pair.** Out-of-bounds and
 *   Null Island are *absent*, not zero, and `location_source` says whether a
 *   present point was surveyed by ANEEL or fell back to a municipality centroid
 *   — four plants do. A fallback rendered as a survey is the kind of wrong
 *   number that looks right.
 *
 * The registry moves with a daily snapshot, so `api-surface.md`'s caching table
 * gives this route `max-age=86400` with the snapshot's ingestion instant as the
 * validator. A cache key is a provenance, never a duration.
 */

/**
 * The two closed enums and the format, as TypeBox — derived from
 * `@wattsteer/core`, exactly as `canonical.ts` derives them.
 *
 * A gateway that restates how many subsystems there are is a second definition
 * of a closed enum, so `SIN` and `technology=wind` are refused by the framework
 * before this handler runs, with the field path preserved by
 * `plugins/errors.ts`.
 */
const literalUnion = <T extends string>(values: readonly T[]) => {
  const members = values.map((value) => t.Literal(value));
  const [first, ...rest] = members;
  if (first === undefined) {
    throw new RangeError("A closed enum with no members cannot be a query parameter");
  }
  return t.Union([first, ...rest]);
};

const SUBSYSTEM = t.Optional(literalUnion(SUBSYSTEM_CODES));
/** Uppercase, case-sensitively: `technology=wind` is a 422, not a synonym. */
const TECHNOLOGY = t.Optional(literalUnion(TECHNOLOGIES));
const FORMAT = t.Optional(literalUnion(["json", "csv"] as const));

/** `2026-08-28` — the fleet date, as the payload stamps it. */
function civilDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * The wire body, built field by field against the generated interface.
 *
 * Field by field rather than by handing the observation to the encoder: the
 * encoder carries an unrecognised key through unrenamed by design, and the
 * schema is `additionalProperties: false`, so `latestIngestedAt` — which is the
 * ETag's business and not the payload's — would be a contract violation found
 * by a validator instead of by a compiler.
 */
function toPlantRegistry(
  observation: PlantRegistryObservation,
  filters: { subsystem: SubsystemCode | null; technology: "WIND" | "SOLAR" | null },
): PlantRegistry {
  return {
    asOf: observation.asOf.toISOString(),
    fleetDate: civilDate(observation.fleetDate),
    vintageFidelity: observation.vintageFidelity,
    filters,
    plantCount: observation.plants.length,
    // ODbL §4.4(a) and §4.6, on the payload rather than only on `/v1/meta`: a
    // caller holding this file is a recipient of the Derivative Database and
    // has to be told, in the file, what it may do with it.
    licence: {
      database: SOURCE_ATTRIBUTION.aneel_siga?.licence ?? "ODbL-1.0",
      url: ODBL_LICENCE_URL,
      derivativeDatabase: true,
      alterationsAt: ODBL_ALTERATIONS_AT,
      attributionRequired: true,
    },
    // Every source the shared constant names, whole. This block used to be
    // narrowed to `{ name, licence, url }` — the three field names that are
    // spelled identically in both casings — because the one translator carried
    // a *map's* values through unrenamed, so `derivativeDatabase` would have
    // reached the wire under that name and validated anyway. The generator now
    // knows a map value is still a named shape (`packages/core/src/wire.ts`),
    // so the narrowing is gone and the ODbL specifics ride here as well as
    // under `licence`.
    attribution: Object.fromEntries(
      Object.entries(SOURCE_ATTRIBUTION).map(([key, source]) => [key, { ...source }]),
    ),
    plants: observation.plants.map(
      (plant): RegistryPlantRow => ({
        onsPlantCode: plant.onsPlantCode,
        cegCore: plant.cegCore,
        // ONS's `nom_usina`. The alias-carrying SIGA name is never projected by
        // the canonical view, so there is nothing here to render by mistake.
        name: plant.name,
        subsystem: plant.subsystem,
        stateCode: plant.stateCode,
        technology: plant.technology,
        operationModality: plant.operationModality,
        municipality: plant.municipality,
        ownerName: plant.ownerName,
        operatorName: plant.operatorName,
        installedCapacityMw: plant.installedCapacityMw,
        generatingUnits: plant.generatingUnits,
        coordinate: plant.coordinate,
        locationSource: plant.locationSource,
      }),
    ),
  };
}

/** The CSV columns, in order. One row per plant, and the header names are the wire's. */
const CSV_COLUMNS = [
  "ons_plant_code",
  "ceg_core",
  "name",
  "subsystem",
  "state_code",
  "technology",
  "operation_modality",
  "municipality",
  "owner_name",
  "operator_name",
  "installed_capacity_mw",
  "generating_units",
  "latitude",
  "longitude",
  "location_source",
] as const;

/** RFC 4180 quoting. An empty cell is an absence; there is no `0` for a null. */
function cell(value: string | number | null): string {
  if (value === null) {
    return "";
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The CSV rendering — **from the same object the JSON is encoded from**.
 *
 * The notice is written before the header row and cannot be reached around: a
 * caller who takes the CSV rather than the JSON is a recipient under §4.6 just
 * the same, and a bare table of coordinates with no licence line is the exact
 * artefact ODbL forbids being handed on. `#` comment lines are the convention
 * every CSV reader in this space already skips, and `plant_count` is repeated
 * there so a truncated download is detectable without parsing.
 *
 * Coordinates become two columns because a nested object has no CSV form; an
 * absent one is **two empty cells**, which is the same statement `null` makes
 * in the JSON and is emphatically not `0,0`.
 */
export function toCsv(registry: PlantRegistry): string {
  const lines: string[] = [];
  lines.push(`# WattSteer plant registry — ${registry.plantCount} plants`);
  lines.push(`# as_of: ${registry.asOf}  fleet_date: ${registry.fleetDate}`);
  lines.push(`# vintage_fidelity: ${registry.vintageFidelity}`);
  lines.push(
    `# licence: ${registry.licence.database} (${registry.licence.url}) — ` +
      "this file is a Derivative Database and is offered under the same licence",
  );
  lines.push(`# alterations (ODbL 4.6(b)): ${registry.licence.alterationsAt}`);
  for (const [key, source] of Object.entries(registry.attribution)) {
    lines.push(`# source ${key}: ${source.name} — ${source.licence} — ${source.url}`);
  }
  lines.push(
    "# ODbL 4.3: a Produced Work built from this file must carry a notice naming " +
      "the source database and its licence.",
  );
  lines.push(CSV_COLUMNS.join(","));
  for (const plant of registry.plants) {
    lines.push(
      [
        cell(plant.onsPlantCode),
        cell(plant.cegCore),
        cell(plant.name),
        cell(plant.subsystem),
        cell(plant.stateCode),
        cell(plant.technology),
        cell(plant.operationModality),
        cell(plant.municipality),
        cell(plant.ownerName),
        cell(plant.operatorName),
        cell(plant.installedCapacityMw),
        cell(plant.generatingUnits),
        // Absent is two empty cells. Never `0,0` — Null Island is not a place.
        cell(plant.coordinate === null ? null : plant.coordinate.latitude),
        cell(plant.coordinate === null ? null : plant.coordinate.longitude),
        cell(plant.locationSource),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function createPlantRoutes(deps: { db: Database | undefined }) {
  return new Elysia({ name: "plants" }).get(
    "/v1/plants",
    async ({ query, set, request }) => {
      if (!deps.db) {
        throw new CodedError("DATA_UNAVAILABLE", "Persistence is not configured");
      }

      const format = query.format ?? "json";
      const subsystem = query.subsystem;
      const technology = query.technology;

      // Both default to the request instant, and both are stamped on the
      // answer. `/v1/canonical/*` refuses to default an axis because a
      // forgotten one there turns a backtest into a latest-version read; this
      // is a download, and a licence obligation that could only be discharged
      // by a caller who knows to name a vintage would not be discharged at all.
      const asOf = optionalInstant("as_of", query.as_of) ?? new Date();
      const fleetDate = optionalInstant("fleet_date", query.fleet_date) ?? asOf;

      const observation = await readPlantRegistry(deps.db, {
        asOf,
        fleetDate,
        ...(subsystem === undefined ? {} : { subsystem }),
        ...(technology === undefined ? {} : { technology }),
      });

      const registry = toPlantRegistry(observation, {
        subsystem: subsystem ?? null,
        technology: technology ?? null,
      });

      // The daily SIGA/ONS snapshot is the provenance; an empty registry has no
      // snapshot behind it, so it validates on the cut instead of pretending to
      // a freshness it does not have.
      const validator =
        observation.latestIngestedAt === null
          ? `empty:${asOf.toISOString()}`
          : observation.latestIngestedAt.toISOString();
      const etag = `W/"${validator}:${format}:${subsystem ?? "*"}:${technology ?? "*"}:${registry.fleetDate}"`;
      set.headers["cache-control"] = "public, max-age=86400";
      set.headers.etag = etag;
      // The licence, in the headers too. Belt and braces, and it is what a
      // `curl -I` shows someone deciding whether they may use the file.
      set.headers.link = `<${ODBL_LICENCE_URL}>; rel="license"`;
      if (request.headers.get("if-none-match") === etag) {
        set.status = 304;
        return null;
      }

      if (format === "csv") {
        set.headers["content-type"] = "text/csv; charset=utf-8";
        set.headers["content-disposition"] =
          `attachment; filename="wattsteer-plants-${registry.fleetDate}.csv"`;
        return toCsv(registry);
      }

      return encodeWire("PlantRegistry", registry);
    },
    {
      query: t.Object({
        subsystem: SUBSYSTEM,
        technology: TECHNOLOGY,
        format: FORMAT,
        as_of: t.Optional(
          t.String({
            description:
              "Vintage cut (ISO-8601). Defaults to now — the cut is on the response.",
          }),
        ),
        fleet_date: t.Optional(
          t.String({
            description:
              "The date installed capacity is summed at (ISO-8601). Defaults to " +
              "the as-of, and is stamped on the response: capacity is a function " +
              "of time, not an attribute.",
          }),
        ),
      }),
      detail: {
        summary: "The plant registry, machine-readable (ODbL §4.6)",
        description:
          "One row per plant: the ONS code, the version-stripped CEG, the name, " +
          "the subsystem, the state, the technology, the operation modality, the " +
          "municipality, ownership, and the installed capacity as of the fleet " +
          "date. Coordinates are optional and an absent one is null, never a " +
          "zero pair. JSON or CSV. This endpoint exists to discharge ODbL §4.6, " +
          "which obliges machine-readable access to a Derivative Database; the " +
          "licence notice and the source attribution are on the payload itself.",
      },
    },
  );
}

/** The wired route, over the process-wide handle. */
export const plantRoutes = createPlantRoutes({ db: database?.db });
