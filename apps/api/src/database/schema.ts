import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
 * The four vintage columns every fact row carries, defined once.
 *
 * `docs/domain-model.md` §7: "Every fact row carries `valid_time`,
 * `published_at`, `ingested_at`, `data_version`. No exceptions." A rule with no
 * exceptions should be written down once — repeating the columns per table
 * invites one of them to drift, and a fact table that quietly lost its
 * `ingested_at` would break `AsOf(t)` silently rather than loudly.
 *
 * A function, not a shared object: Drizzle column builders carry state, so each
 * table must get its own instances.
 */
function vintageColumns() {
  return {
    /** Monotonic per business key; bumped only when the value tuple changes. */
    dataVersion: integer().notNull(),
    /** When the upstream source asserted this value. Never null. */
    publishedAt: timestamp({ withTimezone: true }).notNull(),
    publishedAtPrecision: publishedAtPrecision().notNull(),
    /** When WattSteer learned it. The axis `AsOf(t)` filters on. */
    ingestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * Digest of the stored values. Comparing it against the latest version of
     * the same key is what makes an identical re-ingest write nothing.
     */
    valueDigest: text().notNull(),
    /** Provenance: the exact resource version these numbers were parsed from. */
    sourceVersionId: uuid()
      .notNull()
      .references(() => onsResourceVersion.id),
  };
}

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
    loadMwh: doublePrecision().notNull(),
    hydroGenerationMwh: doublePrecision().notNull(),
    thermalGenerationMwh: doublePrecision().notNull(),
    windGenerationMwh: doublePrecision().notNull(),
    solarGenerationMwh: doublePrecision().notNull(),
    netExchangeMwh: doublePrecision().notNull(),

    ...vintageColumns(),
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

    ...vintageColumns(),
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
    // `RestrictionCause` is one value object over three columns, and the domain
    // model's claim is that half-populated is *unrepresentable* — not merely
    // avoided. TypeScript enforces that on the way in; without this the
    // database would still accept a reason with no origin from any other
    // writer, and the claim would be a convention rather than a guarantee.
    // Description is deliberately outside the pair: it is absent whenever the
    // source column is, which is orthogonal to whether a restriction happened.
    check("curtailment_cause_whole", sql`(${t.reason} is null) = (${t.origin} is null)`),
  ],
);

/**
 * The `cod_areacarga` domain of the ONS carga REST API — all 33 published
 * codes, in ONS's own three groups.
 *
 * This is a **finer geography than any other source in scope**, which is why it
 * is its own enum rather than a reuse of `subsystem_code`: the four subsystems
 * decompose into 25 geoelectric areas and four loss areas, and
 * `docs/domain-model.md` reserves `Subsystem` for the four.
 *
 * `SECO` is the API's dialect for the south-east/centre-west. It appears here
 * because it is the value the source publishes and this column stores what was
 * published; the canonical `SE` is carried alongside in `subsystem`.
 */
export const loadAreaCode = pgEnum("load_area_code", [
  "SECO",
  "S",
  "NE",
  "N",
  "RJ",
  "SP",
  "MG",
  "ES",
  "MT",
  "MS",
  "DF",
  "GO",
  "AC",
  "RO",
  "PR",
  "SC",
  "RS",
  "BASE",
  "BAOE",
  "ALPE",
  "PBRN",
  "CE",
  "PI",
  "TON",
  "PA",
  "MA",
  "AP",
  "AM",
  "RR",
  "PESE",
  "PES",
  "PENE",
  "PEN",
]);

/** Which of ONS's three groups a `load_area_code` belongs to. */
export const loadAreaKind = pgEnum("load_area_kind", [
  "SUBSYSTEM",
  "GEOELECTRIC",
  "LOSSES",
]);

/** Which carga endpoint a request went to. */
export const loadSeries = pgEnum("load_series", ["VERIFIED", "PROGRAMMED"]);

/**
 * One row per answered call to the carga REST API — the provenance anchor for
 * every load fact, and the carga equivalent of `ons_resource_version`.
 *
 * A separate table rather than a reuse, because the two sources are provenanced
 * by genuinely different things. A bulk resource is identified by a URL and an
 * S3 fingerprint that can be re-probed with a `HEAD`; an API call is identified
 * by the question it asked — endpoint, area, date range — and has no fingerprint
 * at all, because there is no object to fingerprint. Forcing the carga API
 * through `ons_resource_version` would mean inventing a `change_key` for
 * something that has none, which is exactly the kind of plausible fiction this
 * layer refuses.
 *
 * `content_sha256` and `byte_size` cover the raw response as received, so the
 * archived payload can be verified. `json_repaired` records that the tolerant
 * parser had to fix the response before it would parse — the malformed-JSON
 * defect ONS emits for older ranges, kept as a fact about the payload rather
 * than as a log line.
 */
export const loadApiRequest = pgTable(
  "load_api_request",
  {
    id: uuid().primaryKey().defaultRandom(),
    series: loadSeries().notNull(),
    areaCode: loadAreaCode().notNull(),
    /** `dat_inicio`, `YYYY-MM-DD`, inclusive — the API's own parameter form. */
    rangeStart: text().notNull(),
    /** `dat_fim`, `YYYY-MM-DD`, inclusive. */
    rangeEnd: text().notNull(),
    /** The URL actually requested. The `SECO` dialect is visible here. */
    requestUrl: text().notNull(),
    httpStatus: integer().notNull(),
    /** Rows in the response, before normalisation. Zero is never written. */
    rowCount: integer().notNull(),
    contentSha256: text().notNull(),
    byteSize: bigint({ mode: "number" }).notNull(),
    /** 1 when the response was not valid JSON until it was repaired. */
    jsonRepaired: integer().notNull().default(0),
    /** Where the retained raw response lives, when it has been archived. */
    archiveUri: text(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("load_api_request_window").on(t.series, t.areaCode, t.rangeStart),
    index("load_api_request_fetched").on(t.fetchedAt),
  ],
);

/**
 * The four vintage columns again, anchored to an API call rather than to a
 * bulk file.
 *
 * `docs/domain-model.md` §1's rule has no exceptions and the columns are
 * identical; what differs is the provenance foreign key, because the carga API
 * publishes no files. Kept as a second small function rather than by making the
 * shared one's reference nullable: a nullable provenance column would let a
 * fact row exist with no source at all, which neither source needs.
 */
function apiVintageColumns() {
  return {
    /** Monotonic per business key; bumped only when the value tuple changes. */
    dataVersion: integer().notNull(),
    /**
     * When ONS asserted this value.
     *
     * For `/cargaverificada` this is the row's own `din_atualizacao` — the only
     * genuine row-level vintage marker anywhere in ONS open data — and the
     * precision is `row`. Where the field is absent (every `/cargaprogramada`
     * row, and any verificada row that stopped carrying it) the coarsest honest
     * stamp is the instant the response was fetched, and the precision says
     * `file`, meaning response-grained rather than row-grained.
     */
    publishedAt: timestamp({ withTimezone: true }).notNull(),
    publishedAtPrecision: publishedAtPrecision().notNull(),
    /** When WattSteer learned it. The axis `AsOf(t)` filters on. */
    ingestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Digest of the stored values, so an identical re-ingest writes nothing. */
    valueDigest: text().notNull(),
    /** Provenance: the exact API call these numbers came back from. */
    sourceRequestId: uuid()
      .notNull()
      .references(() => loadApiRequest.id),
  };
}

/**
 * Carga de energia verificada — observed load per área de carga, per half hour.
 * ONS dataset 6.
 *
 * **Half-hourly, not rolled up.** Constrained-off is downsampled to the hourly
 * grain of the balanço it is explained against; this series is stored at the
 * grain ONS publishes, because it is the finest system-context signal available
 * and downsampling here would throw away the only half-hourly load in the
 * platform. Consumers that want hours sum pairs.
 *
 * **`valid_time` is the start of the half hour, UTC.** The source labels the
 * interval's **end** (`din_referenciautc`, "final do intervalo da semi-hora"),
 * the opposite of every bulk dataset, and the difference is exactly the half hour that
 * misaligns load against curtailment. The adapter removes it; nothing
 * downstream ever sees an end-labelled interval.
 *
 * **`subsystem` is null for a geoelectric or loss area.** ONS publishes no
 * area to subsystem assignment anywhere in scope, and a plausible guess is
 * worse than a null.
 */
export const verifiedLoadHalfHour = pgTable(
  "verified_load_half_hour",
  {
    areaCode: loadAreaCode().notNull(),
    areaKind: loadAreaKind().notNull(),
    /** Populated only where the area *is* a whole subsystem. */
    subsystem: subsystemCode(),
    /** Start of the half hour the fact is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),

    /** `val_cargaglobal`. The headline series, and the only required measure. */
    loadMwh: doublePrecision().notNull(),
    /** `val_cargaglobalcons` — the consisted series ONS feeds its own models. */
    consistedLoadMwh: doublePrecision(),
    /**
     * `val_cargaglobalsmmgd` — load net of distributed generation.
     *
     * Nullable because ONS genuinely omits it: the malformed responses for
     * ranges through 2019-02 carry the key with no value at all. A null is that
     * omission; it is never read as a zero.
     */
    loadNetOfMmgdMwh: doublePrecision(),
    /** `val_cargasupervisionada`. */
    supervisedLoadMwh: doublePrecision(),
    /** `val_carganaosupervisionada`. */
    unsupervisedLoadMwh: doublePrecision(),
    /** `val_cargammgd` — the part met by micro and mini distributed generation. */
    mmgdLoadMwh: doublePrecision(),
    /** `val_consistencia` — ONS's correction for measurement faults. */
    consistencyAdjustmentMwh: doublePrecision(),

    ...apiVintageColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.areaCode, t.validTime, t.dataVersion] }),
    index("verified_load_half_hour_as_of").on(t.validTime, t.areaCode, t.ingestedAt),
    // Subsystem-grain reads scan by time across the four subsystem areas only.
    index("verified_load_half_hour_subsystem").on(t.subsystem, t.validTime),
    // `subsystem` is populated exactly for the four subsystem areas. Without
    // this the database would accept a geoelectric area carrying a subsystem
    // from any other writer, and the "never inferred" rule would be a
    // convention rather than a guarantee.
    check(
      "verified_load_subsystem_only_for_subsystem_area",
      sql`(${t.subsystem} is null) = (${t.areaKind} <> 'SUBSYSTEM')`,
    ),
  ],
);

/**
 * Carga de energia programada — ONS dataset 7.
 *
 * **Its own table, because it is a forecast.** ONS publishes it D−1 for the day
 * ahead; the verified series is an observation. `docs/domain-model.md` rejects a
 * `horizon` column on a shared fact table precisely so that reading a programmed
 * value as an actual is a type error rather than a query bug — the same
 * reasoning that gives DESSEM its own table.
 *
 * It also carries no `din_atualizacao`: this endpoint returns none, so every
 * row's `published_at_precision` is `file` and revisions are detectable only by
 * the value digest, which is what the shared versioned write does anyway.
 */
export const programmedLoadHalfHour = pgTable(
  "programmed_load_half_hour",
  {
    areaCode: loadAreaCode().notNull(),
    areaKind: loadAreaKind().notNull(),
    subsystem: subsystemCode(),
    /** Start of the half hour the forecast is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),

    /** `val_cargaglobalprogramada`. */
    programmedLoadMwh: doublePrecision().notNull(),

    ...apiVintageColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.areaCode, t.validTime, t.dataVersion] }),
    index("programmed_load_half_hour_as_of").on(t.validTime, t.areaCode, t.ingestedAt),
    check(
      "programmed_load_subsystem_only_for_subsystem_area",
      sql`(${t.subsystem} is null) = (${t.areaKind} <> 'SUBSYSTEM')`,
    ),
  ],
);

// The two remaining subsystem bulk series — ONS datasets 8 (`carga-energia`)
// and 9 (`intercambio-nacional`). Appended rather than merged into the blocks
// above so that two adapters landing at once cannot conflict on this file.

/**
 * Which definition of "load" a `subsystem_load_day` row was measured under.
 *
 * An enum on the fact table rather than a lookup table or a derived view,
 * because it is a property of the *row*: ONS restated what the series means on
 * two dates and published no column to say so, and a value that is not carried
 * with the number it qualifies is a value someone will forget to join.
 */
export const loadMethodologyRegime = pgEnum("load_methodology_regime", [
  "DISPATCHED_ONLY",
  "WITH_NON_DISPATCHED",
  "WITH_MMGD",
]);

/**
 * Intercâmbios entre subsistemas — directed hourly exchange over each
 * inter-subsystem link. ONS dataset 9.
 *
 * **The link is stored in one canonical orientation and the direction is the
 * sign.** `from_subsystem` precedes `to_subsystem` in the `subsystem_code` enum
 * order, so the four links are always `N→NE`, `N→SE`, `NE→SE` and `S→SE`;
 * positive is energy flowing that way. ONS changed basis mid-series — files
 * through 2025 fix the orientation and sign the value, the 2026 file flips the
 * row and keeps the verified value non-negative — so storing (origin,
 * destination) verbatim would put two incompatible series in one column. The
 * check constraint below is what makes the wrong orientation unrepresentable
 * rather than merely avoided by the adapter.
 *
 * **`programmed_exchange_mwh` is nullable, and that nullability is the point.**
 * `val_intercambioprogmwmed` was added in 2026-05 and was **not** backfilled, so
 * every hour before 2026 has no programmed value at all. That is the opposite of
 * `dsc_restricao` in the constrained-off datasets, which ONS *did* rewrite into
 * closed months. Null here means "ONS had not invented this column yet"; it is
 * never a zero, which would be a real and different statement.
 */
export const subsystemExchangeHour = pgTable(
  "subsystem_exchange_hour",
  {
    /** Earlier end of the link in `subsystem_code` order. */
    fromSubsystem: subsystemCode().notNull(),
    /** Later end of the link in `subsystem_code` order. */
    toSubsystem: subsystemCode().notNull(),
    /** Start of the hour the fact is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),

    /** `val_intercambiomwmed`, positive from → to. */
    verifiedExchangeMwh: doublePrecision().notNull(),
    /** `val_intercambioprogmwmed`, positive from → to. Null before 2026. */
    programmedExchangeMwh: doublePrecision(),

    ...vintageColumns(),
  },
  (t) => [
    primaryKey({
      columns: [t.fromSubsystem, t.toSubsystem, t.validTime, t.dataVersion],
    }),
    index("subsystem_exchange_hour_as_of").on(
      t.validTime,
      t.fromSubsystem,
      t.toSubsystem,
      t.ingestedAt,
    ),
    // The canonical orientation, enforced. Without it another writer could store
    // `NE→N` beside `N→NE` and the two would be the same link with opposite
    // signs — the exact defect the adapter normalises away.
    check(
      "subsystem_exchange_canonical_orientation",
      sql`${t.fromSubsystem} < ${t.toSubsystem}`,
    ),
  ],
);

/**
 * Carga de energia diária — daily load per subsystem. ONS dataset 8.
 *
 * **`methodology_regime` is what this table exists to carry.** ONS changed the
 * definition of the series in March 2021 (adding forecast generation from plants
 * it does not dispatch) and again on 29 April 2023 (adding estimated MMGD), with
 * no schema change either time. The result is a level shift that a model would
 * otherwise learn as a change in the grid. Stamping the regime on the row makes
 * the break a fact you can filter on.
 *
 * **This is not a daily rollup of `verified_load_half_hour`** and must never be
 * joined to it as one — the regimes are precisely the difference between them.
 *
 * **`day_minutes` records the length of the local day the MWmed mean was
 * converted over.** Brazil moved its clocks at midnight until 2019, so a
 * spring-forward day is 1 380 minutes and a fall-back day 1 500; ONS's own
 * `2018-11-04` values are means over 46 half-hours, not 48. Storing the divisor
 * is what lets a day whose energy dips by a twenty-fourth explain itself.
 */
export const subsystemLoadDay = pgTable(
  "subsystem_load_day",
  {
    subsystem: subsystemCode().notNull(),
    /** First instant of the local day the fact is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),

    loadMwh: doublePrecision().notNull(),
    /** Length of the local day in minutes: 1380, 1440 or 1500. */
    dayMinutes: integer().notNull(),
    methodologyRegime: loadMethodologyRegime().notNull(),

    ...vintageColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.subsystem, t.validTime, t.dataVersion] }),
    index("subsystem_load_day_as_of").on(t.validTime, t.subsystem, t.ingestedAt),
    // A day is 23, 24 or 25 hours long and nothing else. Any other divisor
    // means the local-day resolution went wrong, and a wrong divisor is a
    // quietly wrong energy.
    check("subsystem_load_day_length", sql`${t.dayMinutes} in (1380, 1440, 1500)`),
  ],
);
