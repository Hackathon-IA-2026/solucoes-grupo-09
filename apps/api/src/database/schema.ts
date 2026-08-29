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
