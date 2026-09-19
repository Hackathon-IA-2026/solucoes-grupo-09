import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { pdpCrosswalk } from "../database/schema.js";
import type { StoredCandidates } from "./ons/pdp-fingerprint.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Persistence for the PDP → subsystem crosswalk, which is a *belief* about the
 * data and not a fact in it. See `ons/pdp-fingerprint.ts` for how it is derived
 * and why it is stored as candidate sets.
 *
 * Versioned like every fact, so a determination that changes is a new
 * `data_version` and an as-of read can say what WattSteer believed on a given
 * day. **`determined_on` is not in the digest**: a later day that reaches the
 * same conclusion must write nothing, or the version history would record how
 * often the job ran rather than what it concluded.
 */

export interface PdpCrosswalkRow {
  pdpCode: string;
  subsystems: string[];
  technologies: string[];
  /** The reference day whose evidence produced this belief, as its UTC midnight. */
  determinedOn: Date;
}

export function pdpCrosswalkDigest(row: PdpCrosswalkRow): string {
  return digestValues([
    row.pdpCode,
    row.subsystems.join(","),
    row.technologies.join(","),
  ]);
}

const SPEC: VersionedTableSpec<PdpCrosswalkRow, typeof pdpCrosswalk.$inferInsert> = {
  table: pdpCrosswalk,
  tableName: "pdp_crosswalk",
  keyColumns: ["pdp_code"],
  // The belief has no valid time of its own: it is a property of the entity, so
  // the lookup takes the whole table, as the plant registry's snapshots do.
  validTimeColumn: "determined_on",
  latestLookup: "whole_table",
  businessKey: (row) => row.pdpCode,
  validTime: (row) => row.determinedOn,
  digest: pdpCrosswalkDigest,
  toInsert: (row, version, vintage) => ({
    pdpCode: row.pdpCode,
    subsystemCandidates: row.subsystems,
    technologyCandidates: row.technologies,
    determinedOn: row.determinedOn,
    dataVersion: version.dataVersion,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

export interface PdpCrosswalkWrite extends VintageStamp {
  rows: PdpCrosswalkRow[];
}

export async function writePdpCrosswalk(
  db: Database,
  write: PdpCrosswalkWrite,
): Promise<VersionedWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, SPEC, rows, vintage);
}

/**
 * The belief WattSteer currently holds, latest version per code.
 *
 * Read from the ingest table rather than a canonical view: this is the ingestor
 * consulting the record it is about to extend, not a product read, and it must
 * see the newest version whatever the as-of axes say.
 */
export async function readPdpCrosswalk(
  db: Database,
): Promise<Map<string, StoredCandidates>> {
  const rows = await db.execute<{
    pdp_code: string;
    subsystem_candidates: string[];
    technology_candidates: string[];
  }>(sql`
    select distinct on (pdp_code) pdp_code, subsystem_candidates, technology_candidates
    from pdp_crosswalk
    order by pdp_code, data_version desc
  `);
  return new Map(
    rows.map((row) => [
      row.pdp_code,
      { subsystems: row.subsystem_candidates, technologies: row.technology_candidates },
    ]),
  );
}
