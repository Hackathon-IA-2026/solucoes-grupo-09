import { payloadRefusal, UpstreamError } from "../errors.js";
import { acquireBulkResource } from "./bulk-resource.js";
import { fetchPackage, selectResourceForDay } from "./ons/catalogue.js";
import {
  CONTROLLED_FLOW_DATASET_SLUG,
  CONTROLLED_FLOW_FILE_PREFIX,
  parseControlledFlowTable,
} from "./ons/controlled-flow.js";
import { referenceDayAnchor } from "./ons/dessem-balance.js";
import {
  dayCandidates,
  mergeCandidates,
  type PdpVector,
  pdpVectors,
} from "./ons/pdp-fingerprint.js";
import { assertFileIsForDay, programmeFilePublishedAt } from "./ons/programme.js";
import {
  PROGRAMME_DAILY_DATASET_SLUG,
  PROGRAMME_DAILY_FILE_PREFIX,
  parseProgrammeDailyTable,
} from "./ons/programme-daily.js";
import {
  PROGRAMME_VS_FORECAST_DATASET_SLUG,
  PROGRAMME_VS_FORECAST_FILE_PREFIX,
  parseProgrammeVsForecastTable,
} from "./ons/programme-vs-forecast.js";
import {
  type PdpCrosswalkRow,
  readPdpCrosswalk,
  writePdpCrosswalk,
} from "./pdp-crosswalk-repository.js";
import {
  writeControlledFlow,
  writeProgrammedGeneration,
  writeProgrammedVsForecast,
} from "./programme-repository.js";
import {
  createProgrammeSweep,
  PROGRAMME_FORMATS,
  type ProgrammeIngestorDeps,
  type ProgrammeSweepPayload,
  type ProgrammeSweepResult,
  programmeTable,
} from "./programme-sweep.js";

/**
 * The three day-ahead programme ingestors. Each is one `createProgrammeSweep`
 * with the step that differs — parse this file, write these rows — supplied.
 *
 * The stamp is `programmeFilePublishedAt(day)` in all three and never the
 * acquisition's `publishedAt` (the file's `Last-Modified`), for the measured
 * reason recorded in `ons/programme.ts`. The acquisition still records
 * `Last-Modified` in `ons_resource_version.change_key`, which is what it is for:
 * detecting that ONS rewrote a file.
 */

export type IngestProgrammedGenerationPayload = ProgrammeSweepPayload;
export type IngestProgrammedGenerationResult = ProgrammeSweepResult;
export type IngestControlledFlowPayload = ProgrammeSweepPayload;
export type IngestControlledFlowResult = ProgrammeSweepResult;

/** `crosswalk`: when to spend a `programacao_diaria` download on the PDP fingerprint. */
export interface IngestProgrammedVsForecastPayload extends ProgrammeSweepPayload {
  /**
   * `when_needed` (default) fetches the plant file only for a day on which some
   * PDP code has no stored belief or a belief that is not yet one subsystem.
   * `always` fetches it for every day this run writes.
   */
  crosswalk?: "when_needed" | "always";
}
export type IngestProgrammedVsForecastResult = ProgrammeSweepResult;

export function createProgrammedGenerationIngestor(deps: ProgrammeIngestorDeps) {
  return createProgrammeSweep(deps, {
    slug: PROGRAMME_DAILY_DATASET_SLUG,
    filePrefix: PROGRAMME_DAILY_FILE_PREFIX,
    process: async (acquired, day) => {
      const parsed = parseProgrammeDailyTable(await programmeTable(acquired));
      assertFileIsForDay("programacao_diaria", day, parsed.referenceDay);
      const written = await writeProgrammedGeneration(deps.db, {
        rows: parsed.rows,
        publishedAt: programmeFilePublishedAt(day),
        publishedAtPrecision: "file",
        sourceVersionId: acquired.versionId,
      });
      return {
        rowsParsed: parsed.rows.length,
        rowsRejected: parsed.rejected.length,
        written,
        extra: { plantRowsRead: parsed.plantRowsRead },
      };
    },
  });
}

export function createControlledFlowIngestor(deps: ProgrammeIngestorDeps) {
  return createProgrammeSweep(deps, {
    slug: CONTROLLED_FLOW_DATASET_SLUG,
    filePrefix: CONTROLLED_FLOW_FILE_PREFIX,
    process: async (acquired, day) => {
      const parsed = parseControlledFlowTable(await programmeTable(acquired));
      assertFileIsForDay("programacao_fluxo_controlado", day, parsed.referenceDay);
      const written = await writeControlledFlow(deps.db, {
        rows: parsed.rows,
        publishedAt: programmeFilePublishedAt(day),
        publishedAtPrecision: "file",
        sourceVersionId: acquired.versionId,
      });
      return {
        rowsParsed: parsed.rows.length,
        rowsRejected: parsed.rejected.length,
        written,
      };
    },
  });
}

export function createProgrammedVsForecastIngestor(deps: ProgrammeIngestorDeps) {
  const fetchImpl = deps.fetch ?? fetch;

  /**
   * One sweep per call, so the two things that vary per run — whether the plant
   * file is always fetched, and its catalogue — are local to it. The worker runs
   * two tasks at once, and the `live` and `recent` sweeps can both be in here;
   * a closure shared across them would let one run's setting decide the other's.
   */
  const build = (mode: "when_needed" | "always") => {
    // The plant file's catalogue is ~2,000 resources; read it once per run, not per day.
    let plantCatalogue: Awaited<ReturnType<typeof fetchPackage>> | null = null;

    const sweep = createProgrammeSweep(deps, {
      slug: PROGRAMME_VS_FORECAST_DATASET_SLUG,
      filePrefix: PROGRAMME_VS_FORECAST_FILE_PREFIX,
      process: async (acquired, day) => {
        const parsed = parseProgrammeVsForecastTable(await programmeTable(acquired));
        assertFileIsForDay("programacao_x_previsao", day, parsed.referenceDay);
        const publishedAt = programmeFilePublishedAt(day);
        const written = await writeProgrammedVsForecast(deps.db, {
          rows: parsed.rows,
          publishedAt,
          publishedAtPrecision: "file",
          sourceVersionId: acquired.versionId,
        });

        // The facts are written first and stand on their own: the crosswalk is a
        // derived belief, and a day on which it cannot be built is still a day of
        // ONS's forecasts. It is reported as skipped, never thrown.
        const { midnightUtc, halfHours } = referenceDayAnchor(day);
        const entities = pdpVectors(parsed.rows, halfHours, midnightUtc.getTime());
        const stored = await readPdpCrosswalk(deps.db);
        const needed =
          mode === "always" ||
          entities.some(
            (entity) => (stored.get(entity.pdpCode)?.subsystems.length ?? 0) !== 1,
          );

        const notes: string[] = [];
        const extra: Record<string, number> = {
          crosswalkSkipped: 0,
          crosswalkSet: 0,
          crosswalkNarrowed: 0,
          crosswalkConflicts: 0,
          crosswalkNotNeeded: needed ? 0 : 1,
        };
        if (needed) {
          const crosswalk = await buildCrosswalk(day, entities, stored);
          if (crosswalk === null) {
            extra.crosswalkSkipped = 1;
          } else {
            const belief = await writePdpCrosswalk(deps.db, {
              rows: crosswalk.rows,
              publishedAt,
              publishedAtPrecision: "file",
              sourceVersionId: acquired.versionId,
            });
            extra.crosswalkSet = crosswalk.set;
            extra.crosswalkNarrowed = crosswalk.narrowed;
            extra.crosswalkConflicts = crosswalk.conflicts;
            notes.push(...crosswalk.conflictNotes);
            extra.crosswalkRowsWritten = belief.inserted + belief.revised;
            extra.pdpEnergyMw = crosswalk.energyMw;
            extra.pdpEnergyDeterminedMw = crosswalk.determinedEnergyMw;
          }
        }
        return {
          rowsParsed: parsed.rows.length,
          rowsRejected: parsed.rejected.length,
          written,
          extra,
          notes,
        };
      },
    });

    /**
     * Fetch the same day's plant file and narrow the belief with it. Null when the
     * plant file cannot be had or read for this day, which skips the crosswalk and
     * nothing else.
     */
    async function buildCrosswalk(
      day: string,
      entities: PdpVector[],
      stored: Awaited<ReturnType<typeof readPdpCrosswalk>>,
    ): Promise<{
      rows: PdpCrosswalkRow[];
      set: number;
      narrowed: number;
      conflicts: number;
      conflictNotes: string[];
      energyMw: number;
      determinedEnergyMw: number;
    } | null> {
      plantCatalogue ??= await fetchPackage(PROGRAMME_DAILY_DATASET_SLUG, fetchImpl);
      const [year, month, dayOfMonth] = day.split("-").map(Number) as [
        number,
        number,
        number,
      ];
      let plants: ReturnType<typeof parseProgrammeDailyTable>["plantVectors"];
      try {
        // `force`: the generation ingestor owns this file and has probably marked
        // it settled, which would return no bytes. Re-reading it here leaves that
        // mark alone — `markResourceFetched` touches only the digest and size.
        const acquired = await acquireBulkResource({
          db: deps.db,
          fetch: fetchImpl,
          slug: PROGRAMME_DAILY_DATASET_SLUG,
          resources: plantCatalogue,
          select: (candidates) =>
            selectResourceForDay(
              candidates,
              year,
              month,
              dayOfMonth,
              PROGRAMME_FORMATS,
              PROGRAMME_DAILY_FILE_PREFIX,
            ),
          force: true,
          archive: deps.archive,
        });
        if (!acquired.bytes) {
          return null;
        }
        const plantDay = parseProgrammeDailyTable(
          await programmeTable({ format: acquired.format, bytes: acquired.bytes }),
        );
        assertFileIsForDay("programacao_diaria", day, plantDay.referenceDay);
        plants = plantDay.plantVectors;
      } catch (error) {
        // No plant file for this day (`UpstreamError` from the selector), or one
        // that is refused: neither is a fact about the PDP file being ingested.
        if (error instanceof UpstreamError || payloadRefusal(error)) {
          return null;
        }
        throw error;
      }

      const byEntity = dayCandidates(entities, plants);
      const determinedOn = referenceDayAnchor(day).midnightUtc;
      const rows: PdpCrosswalkRow[] = [];
      const beliefAfter = new Map<string, number>();
      let set = 0;
      let narrowed = 0;
      let conflicts = 0;
      const conflictNotes: string[] = [];
      for (const entity of entities) {
        const before = stored.get(entity.pdpCode);
        const merge = mergeCandidates(before, byEntity.get(entity.pdpCode));
        let subsystems = before?.subsystems ?? [];
        if (merge.kind === "set" || merge.kind === "narrowed") {
          subsystems = merge.subsystems;
          rows.push({
            pdpCode: entity.pdpCode,
            subsystems: merge.subsystems,
            technologies: merge.technologies,
            determinedOn,
          });
          if (merge.kind === "set") {
            set += 1;
          } else {
            narrowed += 1;
          }
        } else if (merge.kind === "conflict") {
          conflicts += 1;
          // Which entity, not just how many: on real data a small flat programme
          // (18-19 MW) matched one plant in another subsystem exactly, and the
          // stored belief — correct, by the entity's own name — is what stood.
          conflictNotes.push(
            `PDP ${entity.pdpCode} conflicts: stored ${merge.stored.subsystems.join("/")} ` +
              `${merge.stored.technologies.join("/")}, day matched ${merge.day.subsystems.join("/")} ` +
              `${merge.day.technologies.join("/")}; the stored belief stands`,
          );
        } else if (!before) {
          // Examined, and no plant carries this vector: recorded, so the read can
          // say "no match" rather than "never looked".
          rows.push({
            pdpCode: entity.pdpCode,
            subsystems: [],
            technologies: [],
            determinedOn,
          });
        }
        beliefAfter.set(entity.pdpCode, subsystems.length);
      }

      let total = 0;
      let determined = 0;
      for (const entity of entities) {
        const energy = entity.programmedMw.reduce<number>(
          (sum, value) => sum + (value ?? 0),
          0,
        );
        total += energy;
        if (beliefAfter.get(entity.pdpCode) === 1) {
          determined += energy;
        }
      }
      // Sums, not a share: the sweep adds counters across days, and a share added
      // across days is not a share. The reader divides.
      return {
        rows,
        set,
        narrowed,
        conflicts,
        conflictNotes,
        energyMw: total,
        determinedEnergyMw: determined,
      };
    }

    return sweep;
  };

  return (
    payload: IngestProgrammedVsForecastPayload,
    report: Parameters<ReturnType<typeof build>>[1],
  ) => build(payload.crosswalk ?? "when_needed")(payload, report);
}
