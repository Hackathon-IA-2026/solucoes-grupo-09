import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
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
 * **`available_capacity_mw` is a mean, not a sum.** It is a power, and summing two
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
    verifiedGenerationMwh: doublePrecision().notNull(),
    /** Energy withheld by the restriction — the curtailment quantity. */
    constrainedOffMwh: doublePrecision().notNull(),
    /** Reference generation, and its final settled revision. */
    referenceGenerationMwh: doublePrecision(),
    finalReferenceGenerationMwh: doublePrecision(),
    /** Mean verified availability over the hour, in MW. */
    availableCapacityMw: doublePrecision(),
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
 *
 * **And it carries no fetch instant either, which is the part worth reading.**
 * With no stamp of any kind from ONS, the adapter's first answer was the
 * response's fetch time — the coarsest honest reading of a value the source
 * said nothing about. Over a backfill of 2021 → now that answer is not merely
 * coarse: it puts `published_at` *after* `valid_time` on every row, which is
 * the shape `docs/domain-model.md` §4 reserves for an `Observation`, and it
 * puts the whole series behind every historical gate. The publication instant
 * is therefore derived from the row's own reference day — see
 * `programmePublishedAt` in `ingest/ons/load.ts`, which holds the decision and
 * the evidence — and the check below is what makes the forecast shape a
 * guarantee of the database rather than a habit of one adapter.
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
    // The domain model's discriminator, enforced. A programme published after
    // the half hour it programmes is not a programme, and a writer that reached
    // for the fetch instant would produce exactly that for every backfilled row.
    check("programmed_load_is_a_forecast", sql`${t.publishedAt} < ${t.validTime}`),
  ],
);
/**
 * ONS's operation modality (`docs/domain-model.md` §3), and what determines
 * which `ReportingEntity` variant a plant participates in.
 *
 * Four members. `TIPO III` appears in `modalidade-usina` but names distributed
 * generation ONS does not dispatch and does not settle constrained-off for; it
 * is absent from both `capacidade-geracao` and the constrained-off datasets, so
 * making it unrepresentable keeps out-of-scope plants out by shape.
 */
export const operationModality = pgEnum("operation_modality", [
  "TIPO_I",
  "TIPO_II_A",
  "TIPO_II_B",
  "TIPO_II_C",
]);

/**
 * The plant registry — one row per *usina*, from ONS `capacidade-geracao`.
 *
 * **A dimension, not a fact table.** It answers "what is this plant?", which
 * has one current answer: subsystem, state, technology, modality and owner are
 * attributes ONS restates rather than a series. Everything about a plant that
 * genuinely varies with time lives elsewhere and is versioned there — capacity
 * in `generating_unit`, conjunto in `conjunto_membership`. That split is what
 * lets `InstalledCapacityAsOf` be a query instead of a stored number.
 *
 * **Identity is `ceg_core`, and that departs from `docs/domain-model.md` §3.**
 * The domain model names `ons_plant_code` (`id_ons`) as the identity, and the
 * research records `id_ons` as added to this dataset on 2026-01-26. It is not
 * in the live file: the header has 18 columns and no `id_ons`. `ceg` is on
 * every row, so the version-stripped core is the only identity the source
 * offers. `ons_plant_code` is recovered from `usina_conjunto` where that bridge
 * names one and is null otherwise — nullable because it is genuinely unknown
 * for a Tipo I / II-B plant that belongs to no conjunto, not because it is
 * optional.
 *
 * `ceg_raw` is kept beside the derived core: the version segment is stripped to
 * make the SIGA join work at all (verbatim matching is 0 of 1,614), and
 * provenance must survive normalisation.
 */
export const plant = pgTable(
  "plant",
  {
    /** ANEEL CEG, version segment stripped. The bridge to SIGA and the identity. */
    cegCore: text().primaryKey(),
    /** ONS's own rendering, zero-padded version segment and all. */
    cegRaw: text().notNull(),
    /** ONS `id_ons`. Null where no ONS dataset in scope names one. */
    onsPlantCode: text(),
    /** ONS `nom_usina`. Display only — never a join key; SIGA writes aliases. */
    name: text().notNull(),
    /**
     * The **electrical** assignment, from `id_subsistema` — never derived from
     * `state_code`. Twelve VRE units in Bahia are assigned to `SE` in the live
     * file, and any state→subsystem mapping would place them in `NE`.
     */
    subsystem: subsystemCode().notNull(),
    /** ONS `id_estado`. An attribute of the plant, and never a subsystem input. */
    stateCode: text().notNull(),
    technology: technology().notNull(),
    operationModality: operationModality().notNull(),
    /** `nom_agenteproprietario` / `nom_agenteoperador`, verbatim. */
    ownerName: text().notNull(),
    operatorName: text().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("plant_subsystem_technology").on(t.subsystem, t.technology),
    index("plant_ons_code").on(t.onsPlantCode),
  ],
);

/**
 * One turbine or inverter block. The true grain of `capacidade-geracao`, and
 * the table that makes installed capacity a function of time.
 *
 * **Versioned, and this is the point of the ticket.** ONS overwrites this file
 * twice a day and yesterday's is unrecoverable — there is no archive, no
 * `x-amz-version-id` and no way to request a prior cut. So every snapshot is
 * appended with its own vintage: a retroactively corrected commissioning date
 * arrives as `data_version` 2, and what WattSteer believed the fleet was on any
 * past day stays answerable. A snapshot that reproduces identical values writes
 * nothing, so the version history records ONS's corrections rather than the
 * refresh schedule.
 *
 * **`commissioned_on` is this table's valid time.** It is the instant in the
 * world the row's assertion becomes true — this unit exists, at this rating,
 * from this day — which is exactly what `valid_time` means in
 * `docs/domain-model.md` §1. Naming it for the domain rather than for the
 * mechanism keeps `InstalledCapacityAsOf` readable; the shared versioned write
 * takes the column name as a parameter precisely so a table can do this.
 *
 * **`decommissioned_on` nullable means "still running"** — the one place in
 * this schema where a null is the correct modelling of an open interval rather
 * than a missing value. ONS records exactly three deactivated VRE units in the
 * entire file, all before the window opens; the adapter asserts on any new one
 * rather than modelling retirement, because the modelled error is currently
 * 0 MW and a wrong estimator would be worse than none.
 *
 * Capacity is **never** stored per plant. A plant total cannot be time-resolved
 * — its units commission on different days — and the plant-registry research
 * measured the cost of pretending otherwise at 25.8% of fleet MW at window
 * start, moving the SE-solar capacity centroid 94 km.
 */
export const generatingUnit = pgTable(
  "generating_unit",
  {
    plantCegCore: text()
      .notNull()
      .references(() => plant.cegCore),
    /** ONS `cod_equipamento` — unique within a plant across the whole live file. */
    equipmentCode: text().notNull(),
    /** `num_unidadegeradora`, the operational number. Display, not identity. */
    unitNumber: text().notNull(),
    name: text().notNull(),
    /** Nameplate power (ANEEL norm), MW. A power: summed across units, never over time. */
    ratedPowerMw: doublePrecision().notNull(),
    /** `dat_entradateste` — release for commissioning. */
    testEntryOn: timestamp({ withTimezone: true }),
    /** `dat_entradaoperacao`, UTC midnight. This table's `valid_time`. */
    commissionedOn: timestamp({ withTimezone: true }).notNull(),
    /** `dat_desativacao`, UTC midnight. Null means still running. */
    decommissionedOn: timestamp({ withTimezone: true }),

    ...vintageColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.plantCegCore, t.equipmentCode, t.dataVersion] }),
    // `AsOf` orders by ingested_at within a key; the interval predicate is on
    // the two date columns. This index serves the DISTINCT ON directly.
    index("generating_unit_as_of").on(t.commissionedOn, t.plantCegCore, t.ingestedAt),
    // The fleet build-up query scans the commissioning axis across all plants.
    index("generating_unit_interval").on(t.commissionedOn, t.decommissionedOn),
  ],
);

/**
 * A conjunto — a group of Tipo II-C plants ONS settles as one unit, and the
 * only grain at which a restriction reason exists (`docs/domain-model.md` §3).
 *
 * A dimension for the same reason `plant` is one. Note that a conjunto has no
 * CEG at all: ONS writes `"-"` for it in the constrained-off files, which is
 * structural absence rather than a blank, and so there is no `ceg_core` column
 * here to be null.
 *
 * `technology` is nullable because the bridge also carries `UTE` and `UHE`
 * conjuntos, which have no WattSteer technology; `source_type_code` keeps ONS's
 * own `id_tipousina` so the null is explainable rather than merely empty.
 */
export const conjunto = pgTable(
  "conjunto",
  {
    /** ONS `id_ons_conjunto`, e.g. `CJU_MAPLN`. */
    onsConjuntoCode: text().primaryKey(),
    name: text().notNull(),
    subsystem: subsystemCode().notNull(),
    stateCode: text().notNull(),
    technology: technology(),
    /** `id_tipousina` verbatim: `UEE`, `UFV`, `UTE`, `UHE`. */
    sourceTypeCode: text().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conjunto_subsystem_technology").on(t.subsystem, t.technology)],
);

/**
 * The plant-to-conjunto bridge, SCD2 — `usina_conjunto`.
 *
 * Time-resolved at source and therefore time-resolved here: a plant that joined
 * a conjunto mid-window is attributed to the conjunto it was actually in, not
 * retroactively to today's. Every read of this table goes through a date.
 *
 * **`member_to` is the inclusive last day**, not an exclusive bound. Measured:
 * all 331 sequential memberships in the live file have the successor starting
 * the day after the predecessor's `dat_fimrelacionamento`, and none starting on
 * the same day. Reading it as exclusive opens a one-day hole in every plant
 * that ever moved conjunto — the kind of error that produces a plausible chart.
 *
 * **The key is `plant_ons_code`, not the CEG.** One `ceg_core` in the live file
 * carries two ONS codes (`RNST6` and `RNST06`) with concurrent open memberships
 * of the same conjunto; keyed on the CEG that reads as a violation of the
 * one-conjunto invariant, which it is not. `plant_ceg_core` rides along as the
 * bridge to `plant`, nullable because ONS's own file leaves `ceg` empty on one
 * row, and deliberately **not** a foreign key: the bridge carries members that
 * `capacidade-geracao` does not list, and dropping a real membership to satisfy
 * a constraint would be the wrong trade.
 *
 * `member_from` is the valid time, and it is part of the business key: a plant
 * can move conjunto and back, so the same (plant, conjunto) pair can legally
 * appear twice with different start days.
 */
export const conjuntoMembership = pgTable(
  "conjunto_membership",
  {
    /** ONS `id_ons_usina`. */
    plantOnsCode: text().notNull(),
    conjuntoCode: text()
      .notNull()
      .references(() => conjunto.onsConjuntoCode),
    /** `dat_iniciorelacionamento`, UTC midnight. First day of membership. */
    memberFrom: timestamp({ withTimezone: true }).notNull(),
    /** `dat_fimrelacionamento`, UTC midnight. **Inclusive** last day, or null. */
    memberTo: timestamp({ withTimezone: true }),
    /** The member's `ceg_core`, where ONS's bridge supplies one. */
    plantCegCore: text(),

    ...vintageColumns(),
  },
  (t) => [
    primaryKey({
      columns: [t.plantOnsCode, t.conjuntoCode, t.memberFrom, t.dataVersion],
    }),
    index("conjunto_membership_as_of").on(t.memberFrom, t.plantOnsCode, t.ingestedAt),
    index("conjunto_membership_conjunto").on(t.conjuntoCode, t.memberFrom),
    // An interval that ends before it starts is not a shorter membership, it is
    // a corrupt one. The adapter rejects it; this makes that true for any writer.
    check(
      "conjunto_membership_ordered",
      sql`${t.memberTo} is null or ${t.memberTo} >= ${t.memberFrom}`,
    ),
  ],
);
/**
 * Who produced a forecast — the first component of `ForecastOrigin`
 * (`docs/domain-model.md` §4: `{ producer, run_label, published_at }`).
 *
 * All three members the domain model names are declared, though only
 * `ons_dessem` has a table yet: the enum is the domain's vocabulary, not an
 * inventory of what has been built, and the same reasoning that keeps `PAR` in
 * `reason_code` with zero observations keeps the other two here.
 */
export const forecastProducer = pgEnum("forecast_producer", [
  "ons_dessem",
  "open_meteo",
  "wattsteer",
]);

/**
 * Balanço DESSEM detalhe — ONS's own day-ahead expectation of load and
 * generation per subsystem, per half hour. ONS dataset 11.
 *
 * **Its own table, because it is a `Forecast`.** `docs/domain-model.md` §4
 * makes `Observation` and `Forecast` two table families discriminated by shape
 * rather than by a flag: an observation has `published_at > valid_time`, a forecast has
 * `published_at < valid_time`, and only a forecast carries a `ForecastOrigin`.
 * Storing this beside the balanço actuals under a `horizon` column is the exact
 * failure the spec calls out — and the check constraint below is what makes
 * "this can never be read as an observation" a guarantee of the database rather
 * than a habit of the adapter.
 *
 * **Three time axes.** `valid_time` (the half hour DESSEM describes),
 * `published_at` (the file's S3 `Last-Modified` — ONS creates day D's file on
 * the evening of D−1, which is why `gate_late` can use it and `gate_early`
 * structurally cannot), and `ingested_at`. `lead_time` is
 * `valid_time − published_at` and is **derived, never stored**: a stored copy
 * could disagree with its own timestamps.
 *
 * **`run_label` is the reference day**, `din_programacaodia` verbatim — the
 * `ForecastOrigin` component that names *which* DESSEM run these numbers came
 * out of. It is not a second valid time: patamar 48 of day D describes
 * 23:30–00:00 local on D, and every row of the file shares one label.
 *
 * **Storage is MW.** DESSEM publishes instantaneous power, not the MWmed every
 * other ONS bulk dataset publishes, so there is no conversion at this boundary
 * and the columns say `_mw` (`docs/domain-model.md` §1).
 */
export const dessemBalanceHalfHour = pgTable(
  "dessem_balance_half_hour",
  {
    subsystem: subsystemCode().notNull(),
    /** Start of the half hour the forecast is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),

    /** `ForecastOrigin.producer`. Always `ons_dessem` in this table. */
    forecastProducer: forecastProducer().notNull(),
    /** `ForecastOrigin.run_label` — the DESSEM reference day, `YYYY-MM-DD`. */
    runLabel: text().notNull(),

    /** `val_demanda`. */
    demandMw: doublePrecision().notNull(),
    /** `val_ger_hidraulica` — the published header, not the dictionary's. */
    hydroGenerationMw: doublePrecision().notNull(),
    /** `val_ger_pch`. */
    smallHydroGenerationMw: doublePrecision().notNull(),
    /** `val_ger_termica` — the published header, not the dictionary's. */
    thermalGenerationMw: doublePrecision().notNull(),
    /** `val_ger_pct`. */
    smallThermalGenerationMw: doublePrecision().notNull(),
    /** `val_ger_eolica` — the forward-looking wind expectation. */
    windGenerationMw: doublePrecision().notNull(),
    /** `val_ger_fotovoltaica` — the forward-looking utility-scale PV expectation. */
    solarGenerationMw: doublePrecision().notNull(),
    /** `val_ger_mmgd` — ONS's modelled distributed generation. */
    mmgdGenerationMw: doublePrecision().notNull(),
    /** `val_cons_elevatoria` — pumping load. */
    pumpingConsumptionMw: doublePrecision().notNull(),

    ...vintageColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.subsystem, t.validTime, t.dataVersion] }),
    index("dessem_balance_half_hour_as_of").on(t.validTime, t.subsystem, t.ingestedAt),
    // Forecast-sourced features are cut on `published_at ≤ gate`
    // (`docs/specs/feature-engineering.md`), which is a different access path
    // from `AsOf` and gets its own index rather than a scan.
    index("dessem_balance_half_hour_published").on(t.publishedAt, t.validTime),
    // The structural discriminator, enforced. A row whose publication does not
    // precede the instant it describes is not a forecast, and this table holds
    // nothing else — so the illegal state is unrepresentable rather than merely
    // avoided by the one adapter that writes here today.
    check("dessem_balance_is_a_forecast", sql`${t.publishedAt} < ${t.validTime}`),
  ],
);
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

// The plant-grain constrained-off `_detail` datasets (ONS 2 & 4). Appended
// rather than merged into the constrained-off block above so that two adapters
// landing at once cannot conflict on this file.

/**
 * A plant as the constrained-off `_detail` files name it.
 *
 * **Why this is not `plant`.** `plant` is the ONS *registry* dimension, keyed
 * by `ceg_core` because `capacidade-geracao` publishes no `id_ons`, and it
 * carries owner and operator, which these files do not. This table is keyed by
 * `ons_plant_code` because that is the domain's plant identity
 * (`docs/domain-model.md` §3) and because these files are the only source in
 * scope that puts **both** identifiers on one row for an individual plant.
 * Keeping them apart is what lets the two be reconciled — see
 * `reconcilePlantIdentity` — instead of one silently overwriting the other.
 *
 * **There is no conjunto column here, and that is the point of the table.**
 * ONS names the plant's conjunto inline in these files. Storing it would put a
 * plant one join from `curtailment_report_hour`, and therefore one join from a
 * restriction reason that does not exist at this grain. Membership is read from
 * `conjunto_membership`, which is time-resolved and must be resolved as of a
 * date; `operation_modality` is kept because it is a plant attribute and is
 * what says *whether* a plant's reason is knowable at all.
 */
export const observedPlant = pgTable(
  "observed_plant",
  {
    /** ONS `id_ons`, e.g. `MAEDT1`. Never a `CJU_` code — conjuntos do not
     * appear in these files at all: 0 of 1,365,984 rows in 2026-08 wind. */
    onsCode: text().primaryKey(),
    /** ANEEL CEG with the version segment stripped. Always present here. */
    cegCore: text().notNull(),
    /** ONS's own rendering, zero-padded version segment and all. */
    cegRaw: text().notNull(),
    /** ONS `nom_usina`. Display only — never a join key; SIGA writes aliases. */
    name: text().notNull(),
    subsystem: subsystemCode().notNull(),
    /** ONS `id_estado`. These files have no `nom_estado` — do not assume one. */
    stateCode: text().notNull(),
    technology: technology().notNull(),
    /** What decides which `ReportingEntity` variant this plant settles under. */
    operationModality: operationModality().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("observed_plant_ceg_core").on(t.cegCore),
    index("observed_plant_subsystem_technology").on(t.subsystem, t.technology),
  ],
);

/**
 * Per-plant constrained-off detail, per technology, per hour — ONS 2 & 4.
 *
 * **This table has no reason, no origin, no description and no reference
 * generation, and no foreign key by which one could arrive.** That is not an
 * omission to be filled in later; it is the shape of the source. The `_detail`
 * files publish no restriction reason on any vintage, and for a Tipo II-C plant
 * — 93% of wind rows and 98.6% of curtailed energy — the reason genuinely does
 * not exist at this grain: it is settled against the *conjunto*. Deriving a
 * per-plant reason is an **allocation** with a stated method, labelled as an
 * estimate, and v1 computes none (`docs/domain-model.md` §3). Curtailment
 * volume is likewise absent, because without a reference generation it cannot
 * be computed from these columns.
 *
 * **The measured resource is one value object over three columns**, exactly as
 * `RestrictionCause` is on `curtailment_report_hour`. ONS blanks the
 * measurement and its invalid flag together and fills them together, so
 * half-populated is unrepresentable here rather than merely avoided. The two
 * unit-bearing columns are separate and separately named so that a wind speed
 * can never be read as an irradiance; a CHECK ties each to its technology.
 *
 * **`measured_wind_speed_ms` corrects a documented unit.** The ONS dictionary
 * says `val_ventoverificado` is in `m3/s` — a volumetric flow rate, which
 * cannot describe the wind driving a turbine. The published magnitudes are
 * ordinary surface wind speeds, so WattSteer stores and names m/s. No numeric
 * conversion is applied: the label was wrong, not the values.
 *
 * **Hourly, from a half-hourly source**, as everywhere else. Energies sum; the
 * measured resource is a *mean* because a speed and an irradiance are
 * intensive; `measurement_invalid` is the disjunction over the half-hours, so
 * an hour built on one failed measurement says so.
 */
export const plantDetailHour = pgTable(
  "plant_detail_hour",
  {
    plantOnsCode: text()
      .notNull()
      .references(() => observedPlant.onsCode),
    technology: technology().notNull(),
    /** Start of the hour the fact is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),

    /** `val_geracaoestimada` — wind × power curve, or history. Often absent. */
    estimatedGenerationMwh: doublePrecision(),
    /** `val_geracaoverificada`. Negative values occur and are published as-is. */
    verifiedGenerationMwh: doublePrecision(),
    /** `val_ventoverificado`, mean over the hour. **m/s**, not the documented m3/s. */
    measuredWindSpeedMs: doublePrecision(),
    /** `val_irradianciaverificado`, mean over the hour, W/m². */
    measuredIrradianceWm2: doublePrecision(),
    /**
     * `flg_dadoventoinvalido` / `flg_dadoirradianciainvalido`, unified.
     *
     * The two technologies encode this boolean differently and permanently —
     * wind writes `0.0`/`1.0`, solar writes `False`/`True`, each since its
     * dataset's first published month. The adapter reads both dialects; the
     * database stores one.
     */
    measurementInvalid: integer(),
    /** 1 or 2. Below 2 means the source hour was incomplete. */
    halfHoursObserved: integer().notNull(),

    ...vintageColumns(),
  },
  (t) => [
    primaryKey({
      columns: [t.plantOnsCode, t.technology, t.validTime, t.dataVersion],
    }),
    index("plant_detail_hour_as_of").on(
      t.validTime,
      t.plantOnsCode,
      t.technology,
      t.ingestedAt,
    ),
    index("plant_detail_hour_time").on(t.validTime, t.technology),
    // The measurement is one value object: a reading without its flag, or a
    // flag without its reading, is an illegal state and not a partial one.
    check(
      "plant_detail_measurement_whole",
      sql`(coalesce(${t.measuredWindSpeedMs}, ${t.measuredIrradianceWm2}) is null) = (${t.measurementInvalid} is null)`,
    ),
    // A wind row measures a speed and a solar row an irradiance. Never both,
    // and never the other one — the units are not interchangeable and a column
    // that could hold either would eventually hold the wrong one.
    check(
      "plant_detail_measurement_technology",
      sql`case ${t.technology}
            when 'WIND' then ${t.measuredIrradianceWm2} is null
            else ${t.measuredWindSpeedMs} is null
          end`,
    ),
    check("plant_detail_invalid_boolean", sql`${t.measurementInvalid} in (0, 1)`),
  ],
);

/**
 * Why SIGA's own coordinate was refused.
 *
 * Stored beside the fallback rather than discarded: "this plant is at its
 * municipality's centroid" and "this plant is at its municipality's centroid
 * because ANEEL wrote (0,0)" are different facts, and only the second tells
 * an operator to go and look at the registration.
 */
export const coordinateRejection = pgEnum("coordinate_rejection", [
  "missing",
  "unparsable",
  "null_island",
  "out_of_bounds",
]);

/** Where a stored plant location actually came from. Never inferred at read. */
export const plantLocationSource = pgEnum("plant_location_source", [
  "siga_coordinate",
  "siga_municipality_centroid",
  "unlocated",
]);

/**
 * Everything the ANEEL SIGA extract contributes to a plant — and nothing else.
 *
 * **A separate table, and the separation is deliberate on two counts.**
 *
 * **Attribute ownership.** SIGA gives coordinates, municipality and ownership.
 * Capacity, commissioning and deactivation stay in `generating_unit`, from ONS,
 * which has them per unit and without SIGA's registration lag — twelve plants
 * were being curtailed by ONS while SIGA still showed them as `Construção` at
 * 0 kW. Keeping the two sources in two tables is what makes that split a fact
 * of the schema rather than a convention someone has to remember.
 *
 * **Licensing.** SIGA is **ODbL 1.0**, ONS is CC-BY and Open-Meteo is CC-BY with
 * its own terms; ODbL §4.4 makes any database extracting a substantial part of
 * SIGA a **Derivative Database** subject to share-alike, and §4.4(c) pulls that
 * obligation in as soon as a Produced Work built from it is publicly used.
 * ODbL §4.5(a)'s Collective Database exemption is what keeps that from being an
 * argument about the whole schema — but only while the SIGA-sourced columns sit
 * in their own table, which is this one. The obligations that follow (the §4.3
 * bilingual notice on every public surface, the §4.4(a) declaration, the §4.6
 * machine-readable alterations file) are recorded in
 * `docs/research/plant-registry.md` §7 and are **not** discharged here: this
 * table is the boundary, not the notice.
 *
 * **Versioned like a fact table, because a location is a belief with a date.**
 * SIGA is a snapshot that is overwritten in place with no archive, and it
 * represents a retirement by *deleting the row*. So `withdrawn_on` is written
 * by diffing successive snapshots, and the only way it can ever be populated is
 * that WattSteer kept its own vintages.
 *
 * `ceg_core` is the key on both sides. `ceg_raw` here is **ANEEL's** rendering
 * (unpadded version segment) against `plant.ceg_raw`'s ONS one (zero-padded) —
 * the two strings that match 0 of 1,614 times when compared directly, kept
 * side by side so that fact stays visible instead of becoming folklore.
 */
export const plantGeo = pgTable(
  "plant_geo",
  {
    plantCegCore: text()
      .notNull()
      .references(() => plant.cegCore),
    /** ANEEL `CodCEG` verbatim. Not ONS's rendering — see the table note. */
    cegRaw: text().notNull(),
    /** `NomEmpreendimento`. Provenance and diffing only; carries `(Antiga …)` aliases. */
    sigaName: text().notNull(),

    /**
     * The location WattSteer will actually sample weather at, or null.
     *
     * Null is a real state, not a defect: `location_source = 'unlocated'` means
     * the plant keeps its capacity and loses only its weather sample. A plant
     * is never given a plausible-looking wrong point to avoid a null.
     */
    latitude: doublePrecision(),
    longitude: doublePrecision(),
    locationSource: plantLocationSource().notNull(),
    /** Populated whenever SIGA's own pair was refused, fallback or not. */
    coordinateRejection: coordinateRejection(),

    municipalityName: text(),
    municipalityUf: text(),
    /** `DscMuninicpios` verbatim — a plant may straddle several municipalities. */
    municipalitiesRaw: text().notNull(),
    /**
     * `DscPropriRegimePariticipacao` verbatim.
     *
     * Free text of the form `100% para <agent> - <CNPJ> (<regime>)`, and the
     * only ownership record with a percentage. It contains **CNPJs of named
     * legal persons**, which ODbL §2.4 explicitly does not license: it is
     * stored because ownership is a modelled attribute, and it is not to be
     * republished as a bulk dump without a second look.
     */
    ownership: text().notNull(),

    /**
     * `DatGeracaoConjuntoDados` of the snapshot this belief began in — this
     * table's `valid_time`. It does not move when a later snapshot restates the
     * same values, so it reads as "SIGA has asserted this location since".
     */
    observedOn: timestamp({ withTimezone: true }).notNull(),
    /**
     * The snapshot date the row stopped appearing in SIGA. Null while present.
     *
     * There is no phase value, no date and no tombstone for a retirement in
     * this source — the row simply stops existing. This column is that event,
     * and it can only ever be written by a diff against WattSteer's own prior
     * snapshot.
     */
    withdrawnOn: timestamp({ withTimezone: true }),

    ...vintageColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.plantCegCore, t.dataVersion] }),
    index("plant_geo_as_of").on(t.plantCegCore, t.ingestedAt),
    index("plant_geo_municipality").on(t.municipalityUf, t.municipalityName),
    // A located row has both halves or neither. Half a coordinate is not a
    // partial location, it is a corrupt one — `docs/domain-model.md` §3.
    check(
      "plant_geo_coordinate_pair",
      sql`(${t.latitude} is null) = (${t.longitude} is null)`,
    ),
    // And an `unlocated` row is exactly the one with no point. Without this the
    // enum and the columns could disagree, which is the failure this whole
    // ticket is about: a value that looks present and means nothing.
    check(
      "plant_geo_location_source",
      sql`(${t.locationSource} = 'unlocated') = (${t.latitude} is null)`,
    ),
    // The bounding box, enforced for any writer — not only this adapter.
    check(
      "plant_geo_within_brazil",
      sql`${t.latitude} is null or (${t.latitude} between -34 and 6
           and ${t.longitude} between -74 and -33
           and not (${t.latitude} = 0 and ${t.longitude} = 0))`,
    ),
  ],
);

/**
 * One SIGA ingest, and what the join measured.
 *
 * **The point of this table is the regression check.** The join's failure mode
 * is silence — comparing `CodCEG` to ONS `ceg` verbatim matches 0 of 1,614 and
 * raises nothing — so the rate is asserted on every ingest, and asserting
 * against a floor alone would miss the slow case where the rate slides a
 * percent a month. The previous run's rate has to be readable, so it is stored.
 *
 * `verbatim_matched` is kept beside it as a live canary: it is measured at
 * exactly zero, and it is the number that would move if ANEEL ever started
 * zero-padding the version segment the way ONS does.
 */
export const sigaSnapshot = pgTable(
  "siga_snapshot",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `DatGeracaoConjuntoDados` of the extract. */
    snapshotDate: timestamp({ withTimezone: true }).notNull(),
    sourceVersionId: uuid()
      .notNull()
      .references(() => onsResourceVersion.id),

    /** Rows in the extract, after duplicate `CodCEG` cores are folded. */
    sourceRows: integer().notNull(),
    /** Rows passing the technology, phase and size filters. */
    fleetRows: integer().notNull(),

    /** Denominator of the match rate: plants in the ONS registry. */
    registryPlants: integer().notNull(),
    matchedPlants: integer().notNull(),
    matchRate: doublePrecision().notNull(),
    /** Raw `CodCEG` against raw ONS `ceg`. Expected to stay at zero. */
    verbatimMatchedPlants: integer().notNull(),

    /** Rows at exactly (0, 0), and rows outside the bounding box. */
    nullIslandRows: integer().notNull(),
    outOfBoundsRows: integer().notNull(),

    /** How the matched plants ended up located. */
    locatedPlants: integer().notNull(),
    centroidFallbackPlants: integer().notNull(),
    unlocatedPlants: integer().notNull(),
    /** Plants that disappeared from SIGA since the prior snapshot. */
    withdrawnPlants: integer().notNull(),

    ingestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("siga_snapshot_ingested").on(t.ingestedAt)],
);

// --- Weather from named model runs (Open-Meteo Single Runs). Appended rather
// than merged into the blocks above so that two adapters landing at once cannot
// conflict on this file.

/**
 * The weather models WattSteer may store. **One member, deliberately.**
 *
 * `best_match` is absent for the same reason `SIN` is absent from
 * `subsystem_code`: it is not a value this platform can hold safely. Open-Meteo
 * silently substitutes DWD ICON for ECMWF IFS between lead offsets under
 * `best_match` — no null, no warning, plausible numbers — so a row claiming to
 * be `best_match` would be a row that does not know which model produced it.
 * Making it unrepresentable is what turns the pin from a convention into a
 * guarantee. A new member here is a retrain trigger.
 */
export const weatherModel = pgEnum("weather_model", ["ecmwf_ifs"]);

/**
 * The two run cycles ingested. The earlier buys operators notice; the later is
 * measurably better in exactly the evening hours where curtailment concentrates.
 * 06Z and 18Z exist from 2025 but not in 2024, so they cannot cover the
 * training window and are not in the vocabulary.
 */
export const weatherRunCycle = pgEnum("weather_run_cycle", ["00Z", "12Z"]);

/**
 * One answered Single Runs API call — the provenance every weather fact points
 * at.
 *
 * Written before any fact, and the only record that a given run was asked for
 * at a given instant. `request_url` carries the `models=` and `run=` parameters
 * verbatim, which is what makes "the model was pinned" auditable after the fact
 * rather than merely asserted in a comment; a commercial `apikey` is redacted
 * out of it before it is stored.
 */
export const weatherRunRequest = pgTable(
  "weather_run_request",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Always `ecmwf_ifs`. The enum is what makes that true. */
    model: weatherModel().notNull(),
    /** The run actually retrieved. Also the `published_at` of every fact row. */
    runInit: timestamp({ withTimezone: true }).notNull(),
    runCycle: weatherRunCycle().notNull(),
    /**
     * The run the schedule asked for. Differs from `run_init` only when that
     * run was missing from the archive — measured at 4.5% of slots in the
     * sampled 2025-08 fortnight — and an older cycle was used instead.
     */
    scheduledRunInit: timestamp({ withTimezone: true }).notNull(),
    /** Which frozen geometry the points came from. Never edited in place. */
    centroidSetVersion: text().notNull(),
    centroidCount: integer().notNull(),
    /** The `hourly=` list exactly as sent, so a variable-list change is visible. */
    variables: text().notNull(),
    forecastDays: integer().notNull(),
    /** The URL requested, with any `apikey` redacted. */
    requestUrl: text().notNull(),
    httpStatus: integer().notNull(),
    /** Canonical rows the response yielded, after hour-zero exclusion. */
    rowCount: integer().notNull(),
    contentSha256: text().notNull(),
    byteSize: bigint({ mode: "number" }).notNull(),
    /**
     * 429s absorbed by backoff before this call succeeded. Recorded because the
     * endpoint returns no rate-limit headers: this column is the only measure
     * of pressure a backfill leaves behind.
     */
    rateLimitRetries: integer().notNull().default(0),
    /** Where the retained raw response lives, when it has been archived. */
    archiveUri: text(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("weather_run_request_run").on(t.runInit, t.runCycle),
    index("weather_run_request_fetched").on(t.fetchedAt),
  ],
);

/**
 * The four vintage columns a third time, anchored to a model run.
 *
 * Kept as its own small function for the reason the carga one is: a nullable
 * provenance column would let a fact row exist with no source at all.
 */
function weatherVintageColumns() {
  return {
    /** Monotonic per business key; bumped only when the value tuple changes. */
    dataVersion: integer().notNull(),
    /**
     * **The run's initialisation time.** Not a fallback and not an
     * approximation: it is when ECMWF asserted this forecast, and it is the
     * whole reason the D−1 12Z run superseding the D−1 00Z run needs no special
     * case — it is simply a newer vintage of the same valid hours.
     *
     * The precision is `file` rather than `row` because the stamp is
     * run-grained: every hour of a run shares it, exactly as every row of an
     * ONS bulk file shares its `Last-Modified`.
     */
    publishedAt: timestamp({ withTimezone: true }).notNull(),
    publishedAtPrecision: publishedAtPrecision().notNull(),
    /** When WattSteer learned it. The axis `AsOf(t)` filters on. */
    ingestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Digest of the stored values, so an identical re-ingest writes nothing. */
    valueDigest: text().notNull(),
    /** Provenance: the exact model-run request these numbers came back from. */
    sourceRequestId: uuid()
      .notNull()
      .references(() => weatherRunRequest.id),
  };
}

/**
 * Weather at a frozen cluster centroid, from a named model run.
 *
 * **This is a forecast, and it is the same object at training time and at
 * serving time.** The stitched Historical Forecast archive is not stored here
 * and is not what this table holds: that archive is bit-identical to
 * `_previous_day0` — the shortest-lead slice of each run — and the measured
 * train/serve gap against a real D−1 forecast is RMSE 4.38 km/h on
 * `wind_speed_120m` against a field sd of 8.87, a dispersion gap that would
 * inflate every interval the product promises.
 *
 * **The business key is (`centroid_id`, `valid_time`).** The run is *not* part
 * of the key: a later run forecasting the same hour is a revision of the same
 * fact, so 12Z superseding 00Z falls straight out of `AsOf(t)` and
 * `data_version`. Both runs remain readable and comparable, because both
 * versions remain — `run_cycle` and `published_at` on each row say which is
 * which.
 *
 * **Units are in the column names.** Wind is km/h and temperature °C because
 * that is what Open-Meteo returns, and converting on ingest would put a
 * conversion between the number ECMWF produced and the number stored.
 *
 * **The run's own hour zero is never here.** Five of the twelve variables are
 * accumulated or time-averaged and have no preceding window at initialisation,
 * so the hour is excluded by the adapter rather than stored as a row that is
 * five-twelfths NULL.
 */
export const weatherForecastHour = pgTable(
  "weather_forecast_hour",
  {
    /** A point in the frozen centroid set — `W1`, `S5`, and so on. */
    centroidId: text().notNull(),
    /** Start of the forecast hour, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),

    /**
     * The model grid cell the query snapped to, as echoed by the API.
     *
     * Stored because it is the only evidence of *which* cell a series is from:
     * if a frozen point ever moved, the cell underneath it would move too and
     * nothing else in the row would say so.
     */
    gridLatitude: doublePrecision().notNull(),
    gridLongitude: doublePrecision().notNull(),
    gridElevationM: doublePrecision().notNull(),

    /** Which cycle produced this row. Redundant with `published_at`, by design. */
    runCycle: weatherRunCycle().notNull(),
    /**
     * `run_init(scheduled) − run_init(used)`, in hours. Zero on the normal
     * path; 12 or 24 when the scheduled run was missing from the archive. A
     * feature in its own right — it is how a model is told that this row is
     * older than the rows around it, instead of the pipeline failing open and
     * saying nothing.
     */
    runAgeHours: integer().notNull(),

    windSpeed100mKmh: doublePrecision(),
    windSpeed120mKmh: doublePrecision(),
    windDirection120mDeg: doublePrecision(),
    windGusts10mKmh: doublePrecision(),
    temperature2mC: doublePrecision(),
    surfacePressureHpa: doublePrecision(),
    relativeHumidity2mPct: doublePrecision(),
    precipitationMm: doublePrecision(),
    shortwaveRadiationWm2: doublePrecision(),
    directNormalIrradianceWm2: doublePrecision(),
    diffuseRadiationWm2: doublePrecision(),
    cloudCoverPct: doublePrecision(),

    ...weatherVintageColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.centroidId, t.validTime, t.dataVersion] }),
    index("weather_forecast_hour_as_of").on(t.validTime, t.centroidId, t.ingestedAt),
    // Reading one run back — the 00Z-versus-12Z comparison the ticket exists to
    // make possible — scans by publication rather than by valid time.
    index("weather_forecast_hour_run").on(t.publishedAt, t.runCycle),
    // `published_at` **is** the run initialisation. Enforced rather than
    // documented: without this a writer could stamp a fetch time here, and the
    // supersession story — which rests entirely on that identity — would
    // quietly stop being true.
    check(
      "weather_forecast_published_at_is_run_init",
      sql`date_part('minute', ${t.publishedAt} at time zone 'UTC') = 0
          and date_part('second', ${t.publishedAt} at time zone 'UTC') = 0
          and date_part('hour', ${t.publishedAt} at time zone 'UTC')
              = case when ${t.runCycle} = '00Z' then 0 else 12 end`,
    ),
    // A run used can be older than the one scheduled, never newer.
    check("weather_forecast_run_age_non_negative", sql`${t.runAgeHours} >= 0`),
  ],
);

/* -------------------------------------------------------------------------
 * Tiered refresh, raw-payload custody and ingestion observability.
 *
 * Appended as one block, never interleaved with the tables above: none of
 * these four objects is a fact table, and three of them are read together by
 * the health view.
 * ---------------------------------------------------------------------- */

/**
 * The ingestable sources, named once.
 *
 * One member per *ingestor*, not per CKAN dataset: the plant registry is two
 * files acquired by one job and the two carga series are one job with a
 * parameter, and an operator watching for a source that went quiet cares about
 * the thing that runs, not about the files it happens to read.
 */
export const ingestionSource = pgEnum("ingestion_source", [
  "energy_balance",
  "constrained_off_wind",
  "constrained_off_solar",
  "interchange",
  "daily_load",
  "dessem_balance",
  "verified_load",
  "programmed_load",
  "plant_registry",
  /** The ANEEL SIGA daily extract — locations, one snapshot of now. */
  "siga",
  /**
   * Open-Meteo Single Runs — the only non-ONS source, and the only one whose
   * unit of publication is a model run rather than a file over a period.
   */
  "weather",
]);

/**
 * How volatile the period a run covered is — the refresh regime, in the schema.
 *
 * `live` is the period ONS is still writing to, `recent` the periods closed
 * within the last couple of months, `history` everything older. The tiers are
 * not cosmetic: a change found by the `history` sweep is a re-publication of
 * settled data, which is the highest-impact and quietest kind of revision, and
 * the tier is the evidence that it was one.
 */
export const refreshTier = pgEnum("refresh_tier", [
  "live",
  "recent",
  "history",
  "manual",
]);

/** Lifecycle of one recorded ingestion run. */
export const ingestionRunStatus = pgEnum("ingestion_run_status", [
  "running",
  "ok",
  "failed",
]);

/** Which provenance table a custody row's payload belongs to. */
export const custodyProvenance = pgEnum("custody_provenance", [
  "bulk_resource",
  "load_api_request",
  /**
   * One answered Single Runs call. Here for the carga API's reason: the
   * endpoint serves no file to re-fetch and Open-Meteo publishes no archive of
   * its own responses, so the JSON body *is* the vintage.
   */
  "weather_run_request",
]);

/**
 * One attempt at one source over one period — the log a freshness view reads.
 *
 * **Written even when nothing changed**, and that is the point: the failure
 * mode this table exists for is silence. A source that quietly stops updating
 * produces successful runs that download nothing, which is indistinguishable
 * from a healthy quiet source unless you can see both the last successful run
 * together with the newest fact it carries. The health view reads both, from here and
 * from the fact tables.
 *
 * A `running` row that never reaches `ok` or `failed` is a crashed worker, and
 * leaving it visible is deliberate — a run log that only records endings cannot
 * show you a run that never ended.
 */
export const ingestionRun = pgTable(
  "ingestion_run",
  {
    id: uuid().primaryKey().defaultRandom(),
    source: ingestionSource().notNull(),
    tier: refreshTier().notNull(),
    /** What the run covered, in the source's own unit: `2026`, `2026-08`, `2026-08-01..2026-08-28`. */
    periodLabel: text(),
    status: ingestionRunStatus().notNull(),
    /** `HEAD`s spent, or API calls made — work done whether or not it found anything. */
    resourcesProbed: integer().notNull().default(0),
    /** Payloads actually downloaded, i.e. fingerprints that moved. */
    resourcesDownloaded: integer().notNull().default(0),
    rowsParsed: integer().notNull().default(0),
    rowsInserted: integer().notNull().default(0),
    rowsRevised: integer().notNull().default(0),
    rowsUnchanged: integer().notNull().default(0),
    /** Re-publications of already-fetched resources observed during this run. */
    republications: integer().notNull().default(0),
    /** Client-safe failure message; null while running and on success. */
    errorMessage: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("ingestion_run_source").on(t.source, t.startedAt),
    index("ingestion_run_status_time").on(t.status, t.startedAt),
  ],
);

/**
 * A resource that changed after WattSteer had already downloaded it.
 *
 * ONS republishes closed months under the same filename with no version
 * marker — the whole of 2025 was rewritten in 2026, 2021–22 in May 2024 — so
 * "this file is not the file we ingested" is an *event*, not a diff, and it has
 * to be recorded where something can look at it. Absorbing it silently into a
 * new `data_version` would leave the bulk campaigns invisible, which is exactly
 * how they stayed invisible upstream.
 *
 * `settled_days` is the gap between the prior download and this observation. It
 * is what separates a normal restatement of last week's file from a campaign
 * over data everyone had stopped watching; `tier` says the same thing from the
 * other direction, when a sweep rather than an ad-hoc run made the discovery.
 */
export const resourceRepublication = pgTable(
  "resource_republication",
  {
    id: uuid().primaryKey().defaultRandom(),
    datasetSlug: text().notNull(),
    resourceName: text().notNull(),
    resourceUrl: text().notNull(),
    /** The version this one supersedes — bytes now unrecoverable upstream. */
    priorVersionId: uuid()
      .notNull()
      .references(() => onsResourceVersion.id),
    /** The newly observed state. */
    versionId: uuid()
      .notNull()
      .references(() => onsResourceVersion.id),
    /** When the superseded bytes were downloaded. */
    priorFetchedAt: timestamp({ withTimezone: true }).notNull(),
    /** Whole days the prior version stood before being overwritten. */
    settledDays: integer().notNull(),
    /** The sweep that found it, when a sweep did. */
    tier: refreshTier(),
    runId: uuid(),
    detectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One republication per (superseded, superseding) pair, so a re-probe of
    // the same pair cannot inflate a campaign.
    uniqueIndex("resource_republication_pair").on(t.priorVersionId, t.versionId),
    index("resource_republication_detected").on(t.detectedAt),
    index("resource_republication_dataset").on(t.datasetSlug, t.detectedAt),
  ],
);

/**
 * The ledger of retained raw payloads — what WattSteer holds, and where.
 *
 * The bytes live outside Postgres (a Railway bucket in production, a directory
 * locally; see `ingest/archive.ts`), because a full backfill is gigabytes and
 * does not belong in the row store. This table is the index over them: it is
 * what makes "can this vintage still be reprocessed?" one query, and what
 * retention enumerates rather than listing a bucket.
 *
 * `purged_at` is set rather than the row deleted. The point of custody is being
 * able to say what was known and when; "we held these bytes and dropped them
 * under policy on this date" is a different and better answer than a gap.
 */
export const payloadCustody = pgTable(
  "payload_custody",
  {
    id: uuid().primaryKey().defaultRandom(),
    provenance: custodyProvenance().notNull(),
    /** `ons_resource_version.id` or `load_api_request.id`, per `provenance`. */
    provenanceId: uuid().notNull(),
    datasetSlug: text().notNull(),
    resourceName: text().notNull(),
    /** Archive-relative locator, e.g. `bulk/<slug>/<sha>.csv`. Never an absolute path. */
    archiveUri: text().notNull(),
    contentSha256: text().notNull(),
    byteSize: bigint({ mode: "number" }).notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull(),
    purgedAt: timestamp({ withTimezone: true }),
    /** Why the bytes were dropped — the policy clause, not a sentence. */
    purgeReason: text(),
  },
  (t) => [
    // One custody row per provenance row: re-archiving the same payload is an
    // idempotent no-op rather than a second claim on the same bytes.
    uniqueIndex("payload_custody_provenance").on(t.provenance, t.provenanceId),
    index("payload_custody_retention").on(t.purgedAt, t.fetchedAt),
    index("payload_custody_uri").on(t.archiveUri),
  ],
);

// ---------------------------------------------------------------------------
// The centroid set — the frozen geometry weather is queried at, and the drift
// watch over it. Appended as its own block so that two adapters landing at once
// cannot conflict on this file.
// ---------------------------------------------------------------------------

/**
 * How a centroid set's geometry came to exist.
 *
 * `hand_transcribed` is `centroid_set_v1` and only ever v1: the nineteen points
 * copied out of `docs/research/weather-sources.md`, two of which were never
 * computed from SIGA municipality centroids at all. Everything after it is
 * `generated` — produced from the registry by `centroid-generator.ts`, which is
 * the whole point of recording the distinction.
 */
export const centroidSetSource = pgEnum("centroid_set_source", [
  "hand_transcribed",
  "generated",
]);

/**
 * Whether the grid-cell uniqueness question was actually asked of this set.
 *
 * Open-Meteo snaps a query to the nearest cell and echoes the cell centre back,
 * so the only way to know two points share a cell is to have asked. A set frozen
 * without that answer would be asserting an invariant it never checked.
 */
export const centroidCollisionCheck = pgEnum("centroid_collision_check", [
  "asserted",
  "unchecked",
]);

/** How a single point of a set came to be where it is. */
export const centroidPointOrigin = pgEnum("centroid_point_origin", [
  "municipality_centroid",
  "hand_transcribed",
]);

/** What a drift check concluded. Named, because a boolean would not be read. */
export const centroidDriftOutcome = pgEnum("centroid_drift_outcome", [
  "within_tolerance",
  "regeneration_triggered",
]);

/**
 * One frozen centroid set — the geometry, its provenance and its freeze-time
 * drift baseline.
 *
 * **Immutable once written, and the schema is what makes that true**: the
 * version is the primary key and `geometry_digest` is a digest of the points
 * under it, so a regeneration that produced different geometry cannot restate
 * an existing version — it has to insert a new one. That is not fastidiousness
 * about history: moving a query point moves the Open-Meteo grid cell underneath
 * a series that has already been ingested against it, which is a covariate
 * shift no test would see. A new set is a new feature-set version and a
 * retrain.
 *
 * `freeze_mean_distance_km` is the capacity-weighted mean plant-to-centroid
 * distance measured when the set was frozen — the baseline `centroid_drift_check`
 * compares against.
 */
export const centroidSet = pgTable(
  "centroid_set",
  {
    /** `centroid_set_v1`, `centroid_set_v2`, … Also the business key everywhere. */
    version: text().primaryKey(),
    source: centroidSetSource().notNull(),
    /** Digest of the frozen points. A differing set under one version is refused. */
    geometryDigest: text().notNull(),
    centroidCount: integer().notNull(),
    /** Located MW the points carried at freeze time. Provenance, never a weight. */
    representedMw: doublePrecision().notNull(),
    /** Vintage axis: what WattSteer had learned when the set was computed. */
    registryAsOf: timestamp({ withTimezone: true }).notNull(),
    /** Fleet date: which units existed on the day the geometry was computed. */
    fleetOn: timestamp({ withTimezone: true }).notNull(),
    /** The drift baseline, km. Null only when nothing could be placed. */
    freezeMeanDistanceKm: doublePrecision(),
    freezeLocatedMw: doublePrecision().notNull(),
    freezePlants: integer().notNull(),
    /** Generator parameters, so a regeneration is reproducible from the row. */
    clusterRadiusKm: doublePrecision(),
    minClusterMw: doublePrecision(),
    collisionCheck: centroidCollisionCheck().notNull(),
    frozenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("centroid_set_frozen").on(t.frozenAt)],
);

/**
 * One point of one set. `(set_version, centroid_id)` is the key, and the row is
 * never updated — a point that moves belongs to a different set.
 */
export const centroidPoint = pgTable(
  "centroid_point",
  {
    setVersion: text()
      .notNull()
      .references(() => centroidSet.version),
    /** `W1`, `S5` — the business key of every weather row taken at this point. */
    centroidId: text().notNull(),
    label: text().notNull(),
    latitude: doublePrecision().notNull(),
    longitude: doublePrecision().notNull(),
    technology: technology().notNull(),
    /** Installed MW the cluster represented at freeze time. Not the weight. */
    representedMw: doublePrecision().notNull(),
    origin: centroidPointOrigin().notNull(),
    /** `Janaúba, MG; Jaíba, MG` — the municipalities behind the point. */
    municipalities: text().notNull(),
    plants: integer().notNull(),
    /** Cluster keys folded in by a grid-cell merge, semicolon-separated. */
    mergedFrom: text().notNull(),
    /** The cell Open-Meteo snapped the point to, as echoed. Null if unchecked. */
    gridLatitude: doublePrecision(),
    gridLongitude: doublePrecision(),
  },
  (t) => [
    primaryKey({ columns: [t.setVersion, t.centroidId] }),
    // One cell per set: the invariant the generator asserts, restated where the
    // database can enforce it rather than trusting the writer to have checked.
    uniqueIndex("centroid_point_cell").on(t.setVersion, t.gridLatitude, t.gridLongitude),
    index("centroid_point_technology").on(t.setVersion, t.technology),
  ],
);

/**
 * One scheduled recomputation of the drift metric against a frozen set.
 *
 * The trigger is a 25% increase over the freeze-time baseline: the fleet has
 * grown away from the points and the geometry no longer represents it. What
 * follows is a **new centroid set version, a new feature-set version and a
 * retrain** — never an edit to the points in place. This table is the evidence
 * trail for that decision, which is why a check that concludes nothing is
 * recorded too.
 */
export const centroidDriftCheck = pgTable(
  "centroid_drift_check",
  {
    id: uuid().primaryKey().defaultRandom(),
    setVersion: text()
      .notNull()
      .references(() => centroidSet.version),
    /** Fleet date the metric was recomputed at. */
    fleetOn: timestamp({ withTimezone: true }).notNull(),
    /** Vintage axis of the registry read behind it. */
    registryAsOf: timestamp({ withTimezone: true }).notNull(),
    meanDistanceKm: doublePrecision(),
    baselineMeanDistanceKm: doublePrecision(),
    /** `mean / baseline`. Null when either side has no located mass. */
    driftRatio: doublePrecision(),
    /** The ratio at which regeneration is raised. Stored, so a policy change is visible. */
    triggerRatio: doublePrecision().notNull(),
    outcome: centroidDriftOutcome().notNull(),
    locatedMw: doublePrecision().notNull(),
    plants: integer().notNull(),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("centroid_drift_check_set").on(t.setVersion, t.checkedAt)],
);

// ---------------------------------------------------------------------------
// The calendar — feature-engineering ticket 03.
//
// Appended as its own block so that two tickets landing at once cannot conflict
// on this file.
// ---------------------------------------------------------------------------

/**
 * `holidays`' own taxonomy, kept rather than collapsed.
 *
 * Carnival, Corpus Christi, Ash Wednesday and both Christmas/New-Year eves are
 * `optional` in that library: not statutory nationwide, and observed anyway by
 * enough of the country to move the load curve as much as any statutory day.
 * `calendar_is_holiday_national` therefore counts both categories — but the
 * distinction is stored, so a later refinement that wants to weight them
 * differently is a query rather than a regeneration.
 */
export const calendarHolidayCategory = pgEnum("calendar_holiday_category", [
  "public",
  "optional",
]);

/**
 * One generated calendar version, and the pinned library that produced it.
 *
 * **Immutable once written, and the schema is what makes that true**: the
 * version is the primary key and `digest` is a digest of the days under it, so
 * a regeneration that produced a different calendar cannot restate an existing
 * version — it has to insert a new one. That is the whole argument of
 * `docs/specs/feature-engineering.md` §"The holiday calendar — data, not a
 * library call": a `holidays` upgrade that moves one moveable feast would
 * otherwise silently restate three years of training features with no
 * migration, no diff and no test failure.
 *
 * A regeneration whose diff touches only future dates extends the horizon. A
 * non-empty diff over **past** dates is a retrain trigger, and lands as
 * `br_calendar_v2` with a new feature-set version — never as an edit here.
 */
export const featureCalendarGeneration = pgTable("feature_calendar_generation", {
  /** `br_calendar_v1`, `br_calendar_v2`, … Also the business key everywhere. */
  version: text().primaryKey(),
  /** The pin, spelled as the requirement that produces it: `holidays==0.103`. */
  generator: text().notNull(),
  /** Digest of the days under this version, in the artifact's own order. */
  digest: text().notNull(),
  /** Inclusive horizon. A day outside it reads NULL, never `false`. */
  dayFrom: date({ mode: "string" }).notNull(),
  dayTo: date({ mode: "string" }).notNull(),
  dayCount: integer().notNull(),
  loadedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * One `(day, uf, name, category)` holiday row — the materialised calendar.
 *
 * **`uf = 'BR'` is national; a two-letter UF is a holiday that state observes
 * and the country does not.** The national days are not repeated under each
 * state, which is what keeps `calendar_is_holiday_national` and
 * `calendar_holiday_state_share` separate measurements rather than one
 * measurement counted twice — the share reads 0 on Tiradentes rather than 1.
 *
 * A scope can carry two names on one day (Minas Gerais observes Tiradentes'
 * execution alongside Tiradentes), so the name is part of the key.
 */
export const featureCalendarDay = pgTable(
  "feature_calendar_day",
  {
    calendarVersion: text()
      .notNull()
      .references(() => featureCalendarGeneration.version),
    /** The civil date in `America/Sao_Paulo`. A date, never an instant. */
    day: date({ mode: "string" }).notNull(),
    /** `BR` for national, otherwise the UF observing it. Municipal is out of scope. */
    uf: text().notNull(),
    /** `holidays`' own name, verbatim — provenance, never a join key. */
    name: text().notNull(),
    category: calendarHolidayCategory().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.calendarVersion, t.day, t.uf, t.name] }),
    index("feature_calendar_day_lookup").on(t.calendarVersion, t.day, t.uf),
  ],
);

// ---------------------------------------------------------------------------
// The publication lag — feature-engineering ticket 05.
//
// Appended as its own block so that two tickets landing at once cannot conflict
// on this file.
// ---------------------------------------------------------------------------

/**
 * `publication_lag_hours[dataset]` — the configured latency an observation is
 * cut against, and the only input `actuals_cutoff` has beyond the gate.
 *
 * **A table rather than a constant in SQL**, because these numbers are
 * configuration carrying conservative defaults, and the whole point of the
 * design is that changing one is a visible event. A dataset with no row here raises
 * rather than defaulting to zero: an observation cut on an unmeasured latency is
 * an unmeasured leak.
 *
 * **Loosening a lag is a retrain trigger, not a config change.** The defaults
 * are deliberately pessimistic — 40 h for the twice-daily bulk files, which
 * assumes nothing at all about whether the earlier publication carries any hour
 * of D−1 — and they may only ever be *loosened by measurement*
 * (`docs/specs/feature-engineering.md` §"Where the cut actually falls", and the
 * scheduled conformance job of seam 6). Loosening one moves the cutoff, which
 * moves every lag and every trailing window built behind it, which changes the
 * feature distribution the model was fitted on. So the rows are seeded by a
 * migration and are expected to be *edited by a migration*: the diff is the
 * record and the retrain is the consequence. Nothing writes this table at
 * runtime, and there is deliberately no repository through which it could.
 *
 * This is a `feature_` table for the reason `feature_calendar_day` is one — it
 * is read by the feature functions and by nothing else, and the feature layer's
 * single reading rule (`canonical_*` views and `feature_*` relations) is what
 * keeps an ingest table out of a feature.
 */
export const featurePublicationLag = pgTable(
  "feature_publication_lag",
  {
    /** The ONS dataset slug: the publication regime belongs to the file. */
    dataset: text().primaryKey(),
    /**
     * The canonical read this dataset feeds, spelled as `canonical_read_go_live`
     * spells it — so the lag and the go-live of one source are joinable by a
     * name rather than by a convention held in someone's head.
     */
    canonicalRead: text().notNull(),
    /** Hours subtracted from the gate. Never negative: the cutoff looks back. */
    publicationLagHours: integer().notNull(),
    /** Why this number. Prose carried with the row, not only in the spec. */
    rationale: text().notNull(),
  },
  (t) => [
    // A negative lag would put the cutoff *after* the gate, which is a feature
    // reading the future through a configuration row.
    check("feature_publication_lag_non_negative", sql`${t.publicationLagHours} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// The published forecast — forecaster ticket 14.
//
// Appended as its own block, for the reason the publication-lag block above is:
// two tickets landing at once must not conflict on this file.
// ---------------------------------------------------------------------------

/**
 * Whether a forecast row is a **record** or a **reconstruction**.
 *
 * `served` is a publication that happened: the worker asked the modelling
 * service for tomorrow ten minutes after the gate and wrote what came back.
 * `backfilled_holdout` is `docs/specs/replay.md`'s out-of-fold prediction,
 * persisted with a **counterfactual** `published_at` — the instant that
 * forecast *would* have been published — so that a replay of a historical day
 * never consults the currently promoted artifact.
 *
 * The discriminator is load-bearing rather than descriptive. Without it a
 * reconstruction is indistinguishable from a record, which is the exact class
 * of error this project keeps ruling out, and `/v1/forecast/day-ahead` filters
 * on `served` **unconditionally, in the query** — never in a branch a later
 * refactor can drop.
 */
export const forecastOriginKind = pgEnum("forecast_origin_kind", [
  "served",
  "backfilled_holdout",
]);

/**
 * Which decision gate produced a forecast row.
 *
 * Part of the business key and not a stored detail: `gate_early` and
 * `gate_late` forecast the *same* hours from different information — the 00Z
 * weather run without DESSEM, and the 12Z run with it — so they are two
 * forecasts of one day rather than two versions of one forecast. A schema that
 * made the late gate supersede the early one would make "what did the early
 * gate say?" unanswerable the moment the late one published.
 *
 * Named `forecast_gate_profile` rather than `gate_profile` because
 * `gate_at(target_date, gate_profile)` in `drizzle/0016_the_feature_gate.sql`
 * already uses that identifier as a parameter name, and a type sharing a name
 * with a parameter inside the same function body is a resolution question
 * nobody should have to answer.
 */
export const forecastGateProfile = pgEnum("forecast_gate_profile", [
  "gate_early",
  "gate_late",
]);

/**
 * The vintage columns a WattSteer-produced fact carries.
 *
 * Not `vintageColumns()`: that one requires a `source_version_id` pointing at
 * `ons_resource_version`, and these rows were not parsed from an ONS file. They
 * were produced by an artifact, and the artifact is named by `run_label` — the
 * provenance is the model, not a payload. Everything else is identical, because
 * `AsOf(t)` has to work here exactly as it works on an observation: a
 * republication is a new `data_version` and no prior belief is destroyed.
 */
function forecastVintageColumns() {
  return {
    /** Monotonic per business key; bumped only when the values change. */
    dataVersion: integer().notNull(),
    /**
     * `gate_at(target_date, gate_profile)` — a property of the target date and
     * never of the request that produced the row. The publication instant is
     * what makes the `ForecastOrigin` true, and a request-time stamp would make
     * it a lie (`docs/specs/api-surface.md`, "The boundary").
     */
    publishedAt: timestamp({ withTimezone: true }).notNull(),
    /** When WattSteer wrote it. The axis `AsOf(t)` filters on. */
    ingestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Digest of the stored values, so an identical republication writes nothing. */
    valueDigest: text().notNull(),
  };
}

/**
 * The identity columns every forecast row carries — who said it, out of what.
 *
 * `run_label` is the `artifact_id` and `forecast_producer` is `wattsteer`
 * (`docs/domain-model.md` §4). `correction_regime` is the one column that is
 * neither identity nor measurement: see `curtailmentForecastHour`.
 */
function forecastOriginColumns() {
  return {
    /** `ForecastOrigin.producer`. Always `wattsteer` in these two tables. */
    forecastProducer: forecastProducer().notNull(),
    /** `ForecastOrigin.run_label` — the artifact id that produced the numbers. */
    runLabel: text().notNull(),
    /** The lane's feature set, so a row says which model family made it. */
    featureSet: text().notNull(),
    /**
     * Which conformal correction regime composed this band.
     *
     * A stored string, and the answer to a question forecaster ticket 21 makes
     * unavoidable: the composed P90 currently receives only
     * `upper_correction_fraction(p)` of `δ_hi` — zero below p = 0.20 — and the
     * shortfall compounds at day grain and again nationally. Whatever ticket 21
     * decides, every row written before the decision inherits today's band, and
     * a row written after it is a different statement about the same hour.
     *
     * Without this column the two are indistinguishable in storage, and a
     * replay reading "what did we say at D−1" would be unable to tell a
     * re-servable row from a misleading one. `run_label` does not answer it: an
     * artifact id changes on every retrain, including retrains that changed
     * nothing about the correction, and does not change at all when the
     * correction rule changes underneath a bundle that is still promoted.
     *
     * The value is `wattsteer_ml.training.conformal.CORRECTION_REGIME`, which
     * names the *rule* rather than the release.
     */
    correctionRegime: text().notNull(),
  };
}

/**
 * One published hour of one subsystem's day-ahead forecast.
 *
 * **A `Forecast`, and its own table family** (`docs/domain-model.md` §4): a
 * forecast has `published_at < valid_time`, an observation has the inequality
 * the other way, and the check constraint below makes reading one as the other
 * unrepresentable rather than merely avoided. There is no `horizon` column and
 * no flag.
 *
 * **The business key is (`subsystem`, `valid_time`, `origin_kind`,
 * `gate_profile`)**, with `data_version` completing the primary key. Four
 * components rather than two, and each of the two extra ones is a different
 * forecast rather than a different vintage:
 *
 * - `origin_kind` — a record and a reconstruction of one hour coexist, and the
 *   day-ahead route filters to the record.
 * - `gate_profile` — the early and the late gate forecast the same hours from
 *   different information. "Superseding" happens *within* a gate: a republished
 *   `gate_late` forecast of the same hour is a new `data_version` of the same
 *   key, which is what makes `AsOf` handle supersession for free.
 *
 * **The band is monotone in storage**, not merely in the response. The
 * composition sorts crossed quantiles and records that it did (`crossed`), so a
 * row that reached this table with `p10 > p50` did not come from the
 * composition at all.
 *
 * **The split is two scalars and there is no split band.** Two splits are
 * stored — of the P50 and of the expectation — because the share model produces
 * both and the served contract splits the expectation; storing only the served
 * one would make the other a re-run rather than a query. There is no column any
 * quantile of a technology could go in.
 */
export const curtailmentForecastHour = pgTable(
  "curtailment_forecast_hour",
  {
    subsystem: subsystemCode().notNull(),
    /** Start of the hour the forecast is about, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),
    originKind: forecastOriginKind().notNull(),
    gateProfile: forecastGateProfile().notNull(),

    /**
     * The civil day in `America/Sao_Paulo` this hour belongs to.
     *
     * Stored rather than derived, because it is the grain the *product* asks
     * questions at — a day-ahead forecast is about a Brazilian calendar day —
     * and deriving it at read time would put a timezone conversion inside every
     * predicate on the most-read table. It is also the join key onto the
     * day-grain companion row, which has no `valid_time` to join on.
     */
    targetDate: date({ mode: "string" }).notNull(),
    /** The same hour on the grid's clock: 0–23. Given, never inferred. */
    localHour: integer().notNull(),

    ...forecastOriginColumns(),

    /** `curtailment_threshold_mw` in force — carried with every number it made. */
    thresholdMw: doublePrecision().notNull(),
    /** `p(x)`, calibrated. The band's shape is decided by it. */
    occurrenceProbability: doublePrecision().notNull(),
    p10Mwh: doublePrecision().notNull(),
    p50Mwh: doublePrecision().notNull(),
    p90Mwh: doublePrecision().notNull(),
    /** `E[Y | x]` — a sibling of the band and never inside it. */
    expectedMwh: doublePrecision().notNull(),
    /** The share model applied to the P50. Two scalars, not a band. */
    p50WindMwh: doublePrecision().notNull(),
    p50SolarMwh: doublePrecision().notNull(),
    /** The share model applied to the expectation — what the contract publishes. */
    expectedWindMwh: doublePrecision().notNull(),
    expectedSolarMwh: doublePrecision().notNull(),
    /**
     * Whether the three composed quantiles arrived out of order and were
     * sorted. `crossing_rate` over a fold is a hot-swap veto; this is the only
     * place a reader learns the boosters disagreed about *this* hour.
     */
    crossed: boolean().notNull(),

    ...forecastVintageColumns(),
  },
  (t) => [
    primaryKey({
      columns: [t.subsystem, t.validTime, t.originKind, t.gateProfile, t.dataVersion],
    }),
    // `AsOf` orders by ingested_at within a key; the day-ahead read's predicate
    // is on target_date and subsystem. Two indexes, because they are two
    // different questions: "what did we believe at t" and "what is tomorrow".
    index("curtailment_forecast_hour_as_of").on(t.validTime, t.subsystem, t.ingestedAt),
    index("curtailment_forecast_hour_day").on(
      t.targetDate,
      t.subsystem,
      t.gateProfile,
      t.originKind,
    ),
    // The structural discriminator. A row whose publication does not precede
    // the hour it describes is not a forecast, and this table holds nothing
    // else — including the backfilled rows, whose counterfactual instant is
    // still the gate of the day they describe.
    check(
      "curtailment_forecast_hour_is_a_forecast",
      sql`${t.publishedAt} < ${t.validTime}`,
    ),
    check(
      "curtailment_forecast_hour_band_monotone",
      sql`${t.p10Mwh} <= ${t.p50Mwh} and ${t.p50Mwh} <= ${t.p90Mwh}`,
    ),
    check(
      "curtailment_forecast_hour_probability",
      sql`${t.occurrenceProbability} between 0 and 1`,
    ),
    check("curtailment_forecast_hour_local_hour", sql`${t.localHour} between 0 and 23`),
    check("curtailment_forecast_hour_threshold_positive", sql`${t.thresholdMw} > 0`),
  ],
);

/**
 * The day-grain companion row: two bands, a probability and an expectation.
 *
 * **This table is the whole of forecaster ticket 14's inherited box.**
 * `docs/specs/replay.md` requires `forecast.day_total` to come from the path
 * ensemble and forbids reconstructing it by summing the hourly band; ticket 07
 * computes it and, before this table, nothing carried it out of the modelling
 * process. Without the row a replay has two options and the spec forbids both:
 * re-run the ensemble (a model in the request path) or add up twenty-four
 * quantiles (arithmetic that is simply wrong — the day total depends on the
 * intra-day dependence structure the marginals discard).
 *
 * `derivation` is stored and is not a comment. It is `path_ensemble` on every
 * row this product writes, and a reader of the database can check that rather
 * than take it on trust — which is the point, because the prototype's summed
 * row is exactly what would otherwise be indistinguishable from this one.
 *
 * **`peak_power_*_mw` is power and `day_total_*_mwh` is energy**, and the column
 * names say which (`docs/domain-model.md` §1). A day's largest hourly MWh is
 * numerically its peak MW at hour grain, and the rename is where that
 * conversion is admitted rather than assumed.
 */
export const curtailmentForecastDay = pgTable(
  "curtailment_forecast_day",
  {
    subsystem: subsystemCode().notNull(),
    /** The civil day in `America/Sao_Paulo` being forecast. */
    targetDate: date({ mode: "string" }).notNull(),
    originKind: forecastOriginKind().notNull(),
    gateProfile: forecastGateProfile().notNull(),

    ...forecastOriginColumns(),

    thresholdMw: doublePrecision().notNull(),

    /** Quantiles of `Σ_t y*_t` over the 500 draws. Never a sum of quantiles. */
    dayTotalP10Mwh: doublePrecision("day_total_p10_mwh").notNull(),
    dayTotalP50Mwh: doublePrecision("day_total_p50_mwh").notNull(),
    dayTotalP90Mwh: doublePrecision("day_total_p90_mwh").notNull(),
    /** Quantiles of `max_t y*_t`, in MW. Never a maximum of quantiles either. */
    peakPowerP10Mw: doublePrecision("peak_power_p10_mw").notNull(),
    peakPowerP50Mw: doublePrecision("peak_power_p50_mw").notNull(),
    peakPowerP90Mw: doublePrecision("peak_power_p90_mw").notNull(),
    /**
     * The share of draws with at least one hour above τ. **Not**
     * `1 − Π(1 − p_t)`, which assumes independence across hours and overstates
     * the day badly.
     */
    dayOccurrenceProbability: doublePrecision().notNull(),
    /** `Σ_t E[Y_t]` — expectations add exactly, and this is the one thing summed. */
    expectedMwh: doublePrecision().notNull(),
    expectedWindMwh: doublePrecision().notNull(),
    expectedSolarMwh: doublePrecision().notNull(),
    /** How many of the day's hours have a non-zero P50 — a count, not a sum. */
    hoursP50Nonzero: integer("hours_p50_nonzero").notNull(),

    /** How the day figures were produced. `path_ensemble`, and checked below. */
    derivation: text().notNull(),
    /** The draw count, seed and calibration-day count the bands came off. */
    ensembleDraws: integer().notNull(),
    ensembleSeed: integer().notNull(),
    ensembleCalibrationDays: integer().notNull(),

    /**
     * How far the artifact's training window reached, and the published class
     * edges it read a risk class off.
     *
     * On the row rather than fetched from the volume, because the gateway has
     * no volume: `docs/specs/api-surface.md` requires the response to name its
     * artifact and to publish the `risk_bins` beside the class "so the class is
     * checkable rather than asserted", and a gateway that had to ask the
     * modelling service for them would be a data path across the boundary the
     * boundary decision closed.
     */
    trainedThrough: date({ mode: "string" }).notNull(),
    /** `low = [0, elevated_from)`, `elevated = [elevated_from, high_from)`. */
    riskBinElevatedFrom: doublePrecision().notNull(),
    riskBinHighFrom: doublePrecision().notNull(),

    ...forecastVintageColumns(),
  },
  (t) => [
    primaryKey({
      columns: [t.subsystem, t.targetDate, t.originKind, t.gateProfile, t.dataVersion],
    }),
    index("curtailment_forecast_day_as_of").on(t.targetDate, t.subsystem, t.ingestedAt),
    // The day's publication instant is the same gate its hours carry, so the
    // forecast-shape check is expressible here too: the gate precedes the local
    // day it describes.
    check(
      "curtailment_forecast_day_is_a_forecast",
      sql`${t.publishedAt} < (${t.targetDate}::timestamp at time zone 'America/Sao_Paulo')`,
    ),
    check(
      "curtailment_forecast_day_total_monotone",
      sql`${t.dayTotalP10Mwh} <= ${t.dayTotalP50Mwh} and ${t.dayTotalP50Mwh} <= ${t.dayTotalP90Mwh}`,
    ),
    check(
      "curtailment_forecast_day_peak_monotone",
      sql`${t.peakPowerP10Mw} <= ${t.peakPowerP50Mw} and ${t.peakPowerP50Mw} <= ${t.peakPowerP90Mw}`,
    ),
    check(
      "curtailment_forecast_day_probability",
      sql`${t.dayOccurrenceProbability} between 0 and 1`,
    ),
    // A day figure this product publishes came off the path ensemble. The
    // constraint is what makes "never a sum of quantiles" a property of the
    // database rather than a habit of the one writer that exists today.
    check(
      "curtailment_forecast_day_from_the_ensemble",
      sql`${t.derivation} = 'path_ensemble'`,
    ),
    check("curtailment_forecast_day_drew_something", sql`${t.ensembleDraws} > 0`),
    check(
      "curtailment_forecast_day_hours_counted",
      sql`${t.hoursP50Nonzero} between 0 and 24`,
    ),
    check(
      "curtailment_forecast_day_risk_edges_ordered",
      sql`0 < ${t.riskBinElevatedFrom} and ${t.riskBinElevatedFrom} < ${t.riskBinHighFrom} and ${t.riskBinHighFrom} < 1`,
    ),
  ],
);
