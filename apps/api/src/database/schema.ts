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

/** The variable renewable technologies ONS settles constrained-off for. */
export const technology = pgEnum("technology", ["WIND", "SOLAR"]);

/**
 * Why generation was restricted, verbatim from the ONS dictionary. The code is
 * the identifier; the English gloss belongs in UI copy, not here.
 *
 * `REL` is **external grid unavailability**, not "relaxamento" — the brief that
 * started this project had it wrong. `PAR` has been documented since 2024-04
 * but was observed zero times across five sampled months; it is a valid domain
 * member that is rare, not dead code, so it is modelled.
 */
export const reasonCode = pgEnum("reason_code", ["REL", "CNF", "ENE", "PAR"]);

/** Whether the restriction was local to the plant or systemic. */
export const restrictionOrigin = pgEnum("restriction_origin", ["LOC", "SIS"]);

/**
 * Which variant of `ReportingEntity` a row is (`docs/domain-model.md` §3).
 *
 * ONS settles constrained-off per *reporting entity*: a Conjunto for Tipo II-C
 * plants — 93% of wind rows, 98.6% of curtailed energy — and the plant itself
 * for Tipo I / II-B. Keeping the two as one enum on one table is what makes the
 * central invariant expressible: a reason is a property of the entity, and
 * there is no column anywhere that attaches one to a member plant.
 */
export const reportingEntityKind = pgEnum("reporting_entity_kind", ["CONJUNTO", "PLANT"]);

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

/**
 * The reporting entities observed in the constrained-off datasets.
 *
 * A dimension, not a fact table: it carries no `valid_time`, because it answers
 * "what is this code?" rather than "what was true at time t". Rows are upserted
 * as they are observed, and `first_seen_at` / `last_seen_at` bound the window
 * each code appeared in.
 *
 * Deliberately derived from the constrained-off files themselves rather than
 * from a registry: those files are the only source that says which codes ONS
 * actually *settles* against. The authoritative fleet registry — plants,
 * generating units, time-resolved conjunto membership — is a separate concern
 * and a later ticket; this table is what the fact table below needs to have a
 * foreign key at all, and it is expected to be superseded, not extended.
 */
export const reportingEntity = pgTable(
  "reporting_entity",
  {
    /** ONS `id_ons` — `CJU_MAPLN` for a conjunto, a plant code otherwise. */
    onsCode: text().primaryKey(),
    kind: reportingEntityKind().notNull(),
    /**
     * ANEEL CEG with the version segment stripped, the bridge to SIGA.
     *
     * Structurally absent on a Conjunto rather than empty: ONS writes `"-"`,
     * which is not a CEG. Null here means "this kind of entity has no CEG",
     * which is why the check is on `kind` and not on emptiness.
     */
    cegCore: text(),
    /** ONS `nom_usina`. Display only — never a join key; SIGA writes aliases. */
    name: text().notNull(),
    subsystem: subsystemCode().notNull(),
    /** ONS `id_estado`. Electrical assignment, not administrative. */
    stateCode: text().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reporting_entity_subsystem").on(t.subsystem, t.kind)],
);

/**
 * Constrained-off settled per reporting entity, per technology, per hour —
 * WattSteer's target variable.
 *
 * **Hourly, from half-hourly source.** ONS publishes every 30 minutes; the
 * system context (balanço, intercâmbio) is hourly. Downsampling the finer
 * series is the lossless direction, so energies are summed over the two
 * half-hours and `half_hours_observed` records how many were actually present —
 * a partial hour stays visible instead of masquerading as a low one.
 *
 * **`availability_mw` is a mean, not a sum.** It is a power, and summing two
 * half-hour availabilities would double a figure that never doubled.
 *
 * **The cause is one value object over three columns** (`docs/domain-model.md`
 * §4): reason, origin and description are populated together and blank together
 * on every file scanned, so half-populated is an illegal state. All three null
 * means the entity was not restricted in that hour, which is ordinary — most
 * rows in these files are unrestricted, and an empty `val_geracaolimitada` is
 * that fact, not a defect.
 */
export const curtailmentReportHour = pgTable(
  "curtailment_report_hour",
  {
    reportingEntityCode: text()
      .notNull()
      .references(() => reportingEntity.onsCode),
    technology: technology().notNull(),
    /** Start of the hour the fact is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),
    dataVersion: integer().notNull(),

    /** Energy actually generated. */
    generationMwh: doublePrecision().notNull(),
    /** Energy withheld by the restriction — the curtailment quantity. */
    constrainedOffMwh: doublePrecision().notNull(),
    /** Reference generation, and its final settled revision. */
    referenceGenerationMwh: doublePrecision(),
    finalReferenceGenerationMwh: doublePrecision(),
    /** Mean verified availability over the hour, in MW. */
    availabilityMw: doublePrecision(),
    /** 1 or 2. Below 2 means the source hour was incomplete. */
    halfHoursObserved: integer().notNull(),

    reason: reasonCode(),
    origin: restrictionOrigin(),
    /** `dsc_restricao`: free text, high cardinality, not a controlled vocabulary. */
    restrictionDescription: text(),
    /**
     * The two half-hours carried different reasons and the dominant one is
     * stored. Recorded rather than hidden: an hour that changed cause mid-way
     * is a real operating event, and a consumer that cares must be able to see
     * that the single stored reason is a simplification.
     */
    causeMixed: integer().notNull().default(0),

    publishedAt: timestamp({ withTimezone: true }).notNull(),
    publishedAtPrecision: publishedAtPrecision().notNull(),
    ingestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    valueDigest: text().notNull(),
    sourceVersionId: uuid()
      .notNull()
      .references(() => onsResourceVersion.id),
  },
  (t) => [
    primaryKey({
      columns: [t.reportingEntityCode, t.technology, t.validTime, t.dataVersion],
    }),
    index("curtailment_report_hour_as_of").on(
      t.validTime,
      t.reportingEntityCode,
      t.technology,
      t.ingestedAt,
    ),
    // Subsystem-level rollups scan by time across entities.
    index("curtailment_report_hour_time").on(t.validTime, t.technology),
  ],
);
