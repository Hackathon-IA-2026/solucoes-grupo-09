import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * WattSteer's baseline schema — the first migration after the strip.
 *
 * Two decisions are made here rather than inherited, and both are recorded in
 * `docs/specs/data-platform.md` with their reasoning:
 *
 * 1. **Facts live in one wide table per grain**, not in a narrow
 *    (series, entity, valid_time, value) table. See the spec for why.
 * 2. **`data_version` is derived from a digest of the stored value tuple**,
 *    compared against the current latest version of the same business key.
 *    Not the source file's hash, and not a counter — a re-ingest that
 *    reproduces identical values must not bump it.
 *
 * The vocabulary is `docs/domain-model.md`'s and only its: `valid_time`,
 * `published_at`, `ingested_at`, `data_version`.
 */

/**
 * WattSteer's canonical subsystem vocabulary — ONS's bulk-file codes.
 *
 * `SIN` is deliberately absent: it is a national aggregate row ONS mixes into
 * `balanco-energia-subsistema`, and making it unrepresentable here is what
 * makes double-counting impossible rather than merely discouraged. The carga
 * REST API's `SECO` is likewise absent — it is a transport detail owned by that
 * one HTTP client.
 */
export const subsystemCode = pgEnum("subsystem_code", ["N", "NE", "S", "SE"]);

/**
 * How coarse the row's `published_at` is. ONS stamps almost nothing per row, so
 * the adapter supplies the coarsest honest stamp it has and says which — an
 * honest coarseness marker rather than a nullable `published_at`.
 */
export const publishedAtPrecision = pgEnum("published_at_precision", ["row", "file"]);

/** Wire format a bulk resource was ingested from. Parquet is preferred. */
export const resourceFormat = pgEnum("resource_format", ["PARQUET", "CSV"]);

/**
 * One row per *distinct observed state* of an ONS bulk resource.
 *
 * ONS republishes revised files under the same filename with no version marker
 * and no `x-amz-version-id`, so the only revision detector is the triple
 * (`Last-Modified`, `Content-Length`, `ETag`) from an S3 `HEAD`. That triple is
 * stored verbatim *and* folded into `change_key`, which is what lets a changed
 * file be detected without downloading it.
 *
 * `content_sha256` and `byte_size` are null until the bytes are actually
 * fetched. `archive_uri` points at the retained raw payload; it is null while
 * only the fingerprint is kept (see the spec's retention decision).
 */
export const onsResourceVersion = pgTable(
  "ons_resource_version",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** CKAN package id, e.g. `balanco-energia-subsistema`. */
    datasetSlug: text().notNull(),
    /** CKAN resource name, e.g. `Balanco_de_Energia_Subsistema-2026`. */
    resourceName: text().notNull(),
    /** The URL CKAN gave us. Never constructed — filenames are irregular. */
    resourceUrl: text().notNull(),
    format: resourceFormat().notNull(),
    /**
     * `${lastModified}|${contentLength}|${etag}` from the S3 `HEAD`. Any
     * difference means "re-download and diff"; equality means "unchanged".
     */
    changeKey: text().notNull(),
    lastModified: timestamp({ withTimezone: true }),
    contentLength: bigint({ mode: "number" }),
    etag: text(),
    /** Content digest of the bytes actually fetched; null for a HEAD-only probe. */
    contentSha256: text(),
    byteSize: bigint({ mode: "number" }),
    /** Where the retained raw payload lives, when it has been archived. */
    archiveUri: text(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** When the bytes were downloaded; null for a HEAD-only probe. */
    fetchedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // The idempotency anchor: re-probing an unchanged file finds this row and
    // stops before spending a download.
    uniqueIndex("ons_resource_version_identity").on(t.resourceUrl, t.changeKey),
    index("ons_resource_version_dataset").on(t.datasetSlug, t.firstSeenAt),
  ],
);

/**
 * Balanço de energia nos subsistemas — hourly system context per subsystem.
 * ONS dataset 5, and WattSteer's first fact table.
 *
 * **Wide, one table per grain.** The six measures are published together in one
 * row of one file, are revised together, and are read together by every
 * consumer. Splitting them into a narrow table would sextuple the row count and
 * the as-of work, and would make "these six values are one restatement" an
 * application-level convention rather than a row.
 *
 * **Append-only.** The business key is (`subsystem`, `valid_time`); the primary
 * key adds `data_version`, so a revision is a new row and no prior belief can be
 * destroyed. Reads go through `AsOf(t)` — never straight at this table.
 *
 * Storage is MWh (`docs/domain-model.md` §1): ONS publishes MWmed, and the
 * adapter converts using the source interval length at the boundary.
 */
export const subsystemEnergyBalanceHour = pgTable(
  "subsystem_energy_balance_hour",
  {
    subsystem: subsystemCode().notNull(),
    /** Start of the hour the fact is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),
    /** Monotonic per business key; bumped only when the value tuple changes. */
    dataVersion: integer().notNull(),

    loadMwh: doublePrecision().notNull(),
    hydroGenerationMwh: doublePrecision().notNull(),
    thermalGenerationMwh: doublePrecision().notNull(),
    windGenerationMwh: doublePrecision().notNull(),
    solarGenerationMwh: doublePrecision().notNull(),
    netExchangeMwh: doublePrecision().notNull(),

    /** When ONS asserted this value. Never null. */
    publishedAt: timestamp({ withTimezone: true }).notNull(),
    publishedAtPrecision: publishedAtPrecision().notNull(),
    /** When WattSteer learned it. The axis `AsOf(t)` filters on. */
    ingestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * Digest of the six stored values. Comparing it against the latest version
     * of the same key is what makes an identical re-ingest write nothing.
     */
    valueDigest: text().notNull(),
    /** Provenance: the exact resource version these numbers were parsed from. */
    sourceVersionId: uuid()
      .notNull()
      .references(() => onsResourceVersion.id),
  },
  (t) => [
    primaryKey({ columns: [t.subsystem, t.validTime, t.dataVersion] }),
    // `AsOf` orders by ingested_at within a key; the range predicate is on
    // valid_time. This index serves the DISTINCT ON directly.
    index("subsystem_energy_balance_hour_as_of").on(
      t.validTime,
      t.subsystem,
      t.ingestedAt,
    ),
  ],
);
