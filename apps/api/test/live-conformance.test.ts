import { describe, it } from "bun:test";
import {
  availableResourceDays,
  CAPACITY_DATASET_SLUG,
  CARGA_API_BASE,
  type CatalogueResource,
  CENTROIDS,
  CONJUNTO_DATASET_SLUG,
  DAILY_LOAD_DATASET_SLUG,
  DESSEM_DETAIL_DATASET_SLUG,
  DATASET_SLUG as ENERGY_BALANCE_DATASET_SLUG,
  fetchAneelPackage,
  fetchLoadRange,
  fetchModelRun,
  fetchPackage,
  INTERCHANGE_DATASET_SLUG,
  locationsOf,
  measureMatchRate,
  parseCapacityRegistryCsv,
  parseSigaCsv,
  runParam,
  SERIES_PATH,
  SIGA_DATASET_SLUG,
  SINGLE_RUNS_HOST,
  SINGLE_RUNS_PATH,
  SOLAR_DATASET_SLUG,
  SOLAR_DETAIL_DATASET_SLUG,
  selectDailySigaResource,
  selectResourceForDay,
  selectResourceForMonth,
  selectResourceForYear,
  WEATHER_MODEL,
  WEATHER_VARIABLES,
  WIND_DATASET_SLUG,
  WIND_DETAIL_DATASET_SLUG,
} from "../src/ingest/index.js";
import { selectSingleResource } from "../src/ingest/ons/catalogue.js";

/**
 * Seam 3 — **live conformance**. The one suite in this platform that talks to
 * the real sources, and the one that is *expected to fail eventually*.
 *
 * Every other test here runs against recorded fixtures and will keep passing
 * forever, including after ONS adds a column, ANEEL restyles an identifier, or
 * Open-Meteo changes what a model serves. This suite is the opposite: it asks
 * the live sources whether the claims in `docs/research/` are still true.
 *
 * **A failure here is a notification, not a bug.** So the assertion is not the
 * deliverable — the *message* is. `assertClaim` below refuses to report a bare
 * comparison: every failure names the research note and section that recorded
 * the claim, states the claim in prose, states what the source returned
 * instead, says what in WattSteer breaks because of it, and points at the
 * adapter that encodes the assumption. A human woken by the scheduled CI run
 * should be able to act on the output without opening a single file first.
 *
 * **Gating.** `WATTSTEER_LIVE_CONFORMANCE` — the same `describe.skip`-on-env-var
 * shape the `database-*.test.ts` suites use for `WATTSTEER_TEST_DATABASE_URL`.
 * The default `bun test test` discovers this file and skips every case in it,
 * so the default path stays offline. Run it deliberately:
 *
 *     bun run --cwd apps/api test:live
 *
 * and on a schedule from `.github/workflows/live-conformance.yml`, never on a
 * commit.
 */
const ENABLED = process.env.WATTSTEER_LIVE_CONFORMANCE;
const suite = ENABLED ? describe : describe.skip;

/** Live calls cross the public internet; ONS S3 is not fast. */
const TIMEOUT_MS = 120_000;

/**
 * A documented claim, and everything a human needs in order to act when the
 * world stops honouring it.
 *
 * `code` is not decoration. The point of naming it is that the reader of a
 * failed CI run learns *where the assumption is spent* — a research note that
 * expires with no code depending on it is a documentation edit, and one with an
 * adapter behind it is an outage waiting for the next ingest.
 */
interface Claim {
  /** Repo-relative path of the research note that recorded it. */
  note: string;
  /** Section or heading within the note. */
  section: string;
  /** The claim, in the note's own terms. */
  claim: string;
  /** What in WattSteer stops working when the claim stops being true. */
  breaks: string;
  /** The module that encodes the assumption. */
  code: string;
}

/**
 * The failure this suite exists to produce.
 *
 * Named rather than a bare `Error` so the output says what kind of event this
 * is before it says anything else: an assumption reached its expiry date.
 */
class AssumptionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssumptionExpiredError";
  }
}

/** Wrap a long prose line so a CI log stays readable. */
function wrap(text: string, indent: string, width = 76): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines
    .map((entry, index) => (index === 0 ? entry : `${indent}${entry}`))
    .join("\n");
}

/**
 * Assert one documented claim against what the live source actually did.
 *
 * `expect(x).toBe(y)` is deliberately not used anywhere in this file. A diff
 * tells the reader that two values differ; it does not tell them *which
 * research finding just expired*, and that is the entire product of this suite.
 * `observed` is prose too, for the same reason — "16 columns, `dsc_restricao`
 * absent" is actionable where `false !== true` is not.
 */
function assertClaim(claim: Claim, holds: boolean, observed: string): void {
  if (holds) {
    return;
  }
  throw new AssumptionExpiredError(
    [
      "",
      `ASSUMPTION EXPIRED — ${claim.section}`,
      "",
      `  Documented in : ${claim.note} § ${claim.section}`,
      `  The claim     : ${wrap(claim.claim, "                  ")}`,
      `  Observed now  : ${wrap(observed, "                  ")}`,
      `  What it breaks: ${wrap(claim.breaks, "                  ")}`,
      `  Encoded in    : ${claim.code}`,
      "",
      `  ${wrap(
        "This suite is expected to fail when the world moves. Nothing is wrong " +
          "with the code that ran — a source WattSteer depends on changed. Fix " +
          "it by re-measuring the source, updating the research note above and " +
          "the adapter together, and re-pinning the claim in this file. Do not " +
          "relax the assertion without changing the note.",
        "  ",
      )}`,
      "",
    ].join("\n"),
  );
}

/**
 * A source that could not be reached at all.
 *
 * Distinct from an expired assumption, and the distinction is the actionable
 * part: an expiry says *the world changed and the platform is now wrong*, while
 * this says *the question was not answered, so nothing below was proven either
 * way*. Both fail the scheduled run — a source WattSteer cannot reach is also
 * news — but the reader is told which of the two they are looking at before
 * they start investigating.
 */
class SourceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnreachableError";
  }
}

/**
 * Run one live measurement, turning a transport failure into prose as well.
 *
 * Without this, a DNS failure or a refused TLS handshake reaches the log as a
 * stack trace from inside an adapter — which reads exactly like a WattSteer
 * bug and is the opposite of what this suite promises to report.
 */
function measuring(source: string, body: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (error) {
      if (error instanceof AssumptionExpiredError) {
        throw error;
      }
      if (error instanceof SourceUnreachableError) {
        throw error;
      }
      throw new SourceUnreachableError(
        [
          "",
          `SOURCE UNREACHABLE — ${source}`,
          "",
          `  What happened : ${wrap(
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            "                  ",
          )}`,
          "",
          `  ${wrap(
            "No documented assumption was disproved here — the source did not " +
              "answer, so this run measured nothing. Treat a single occurrence as " +
              "the source being down or throttling (the registry cases pull whole " +
              "files, and both agencies rate-limit), and a persistent one as a " +
              "finding in its own right: the endpoint moved, and the adapter that " +
              "reads it is about to start failing in production too.",
            "  ",
          )}`,
          "",
        ].join("\n"),
      );
    }
  };
}

/**
 * Parse a live payload with the platform's own parser, and report a refusal as
 * an expired claim rather than as an unreachable source.
 *
 * The adapters assert their required columns and throw when one is missing.
 * That throw *is* a conformance finding — the header moved — but it reaches
 * this suite as an ordinary exception, which `measuring` would otherwise
 * mislabel as a transport failure. The distinction matters: "ANEEL is down"
 * and "ANEEL renamed a column" call for very different mornings.
 */
function parsing<T>(claim: Claim, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    assertClaim(
      claim,
      false,
      `the platform's own parser refused the live file: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }`,
    );
    throw error;
  }
}

/** GET, with a prose failure rather than a status code. */
async function get(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok && response.status !== 206) {
    throw new AssumptionExpiredError(
      `\n\nSOURCE UNREACHABLE — GET ${url} answered HTTP ${response.status}.\n` +
        "  Conformance could not be measured, so nothing below was proven either\n" +
        "  way. If this persists it is itself a finding: the URL moved.\n",
    );
  }
  return response;
}

/**
 * Read only a published file's header row.
 *
 * A `Range` request rather than a download because the wind `_detail` file is
 * 171 MB as CSV and the question is about its first line. S3 honours the range;
 * a source that stops honouring it returns the whole object and the slice below
 * still finds the header, so this degrades in throughput and not in truth.
 */
async function fetchHeaderColumns(url: string): Promise<string[]> {
  const response = await get(url, { headers: { Range: "bytes=0-8191" } });
  const text = await response.text();
  const first = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  return first.split(";").map((column) => column.trim().replace(/^"|"$/g, ""));
}

/** Columns present in `columns`, missing from `required`. */
function missingColumns(columns: string[], required: readonly string[]): string[] {
  const present = new Set(columns);
  return required.filter((column) => !present.has(column));
}

/** UTC year/month of a date, as the catalogue's selectors want them. */
function ym(date: Date): { year: number; month: number } {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

/**
 * The most recent monthly resource that exists.
 *
 * The current month is the one to check — it is the file the daily refresh
 * actually reads, and the one ONS rewrites on every cycle. On the first days of
 * a month it may not be published yet, so the previous month is an acceptable
 * substitute for a *schema* question; the freshness questions are asked
 * elsewhere and are not weakened by this.
 */
function latestMonthly(
  resources: CatalogueResource[],
  formats: readonly ("CSV" | "PARQUET")[],
): CatalogueResource {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  for (const candidate of [ym(now), ym(previous)]) {
    try {
      return selectResourceForMonth(resources, candidate.year, candidate.month, formats);
    } catch {
      // Fall through to the previous month.
    }
  }
  throw new AssumptionExpiredError(
    "\n\nSOURCE MOVED — neither the current nor the previous month is published\n" +
      "  as a CSV resource in this ONS package. The monthly split itself is the\n" +
      "  assumption that expired; see docs/research/ons-datasets.md § 1-4.\n",
  );
}

/**
 * The ONS bulk sources, each with the columns its adapter requires.
 *
 * The lists are the *documented* headers from `docs/research/ons-datasets.md`,
 * restated here rather than imported from the adapters on purpose: this suite
 * defends the research finding, and importing the adapter's own copy would let
 * a well-meaning edit to the adapter quietly move the goalposts on the source.
 */
const ONS_COLUMN_CLAIMS: {
  slug: string;
  label: string;
  select: (resources: CatalogueResource[]) => CatalogueResource;
  required: readonly string[];
  claim: Claim;
}[] = [
  {
    slug: WIND_DATASET_SLUG,
    label: "constrained-off wind, reporting-entity grain",
    select: (resources) => latestMonthly(resources, ["CSV"]),
    required: [
      "id_subsistema",
      "id_estado",
      "nom_usina",
      "id_ons",
      "ceg",
      "din_instante",
      "val_geracao",
      "val_geracaolimitada",
      "val_disponibilidade",
      "val_geracaoreferencia",
      "val_geracaoreferenciafinal",
      "cod_razaorestricao",
      "cod_origemrestricao",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "1 & 3 — schema (identical across eólica and fotovoltaica)",
      claim:
        "The entity-grain constrained-off file carries the five val_* generation " +
        "columns in MWmed plus cod_razaorestricao and cod_origemrestricao — the " +
        "settlement view, and the only ONS source that says why a plant was curtailed.",
      breaks:
        "Curtailment volume and RestrictionCause both come from this file and " +
        "nowhere else; the _detail datasets carry no reason code at all. A missing " +
        "column here means the platform can measure that curtailment happened but " +
        "not why, which is the product.",
      code: "apps/api/src/ingest/ons/constrained-off.ts",
    },
  },
  {
    slug: SOLAR_DATASET_SLUG,
    label: "constrained-off solar, reporting-entity grain",
    select: (resources) => latestMonthly(resources, ["CSV"]),
    required: [
      "id_subsistema",
      "id_estado",
      "nom_usina",
      "id_ons",
      "ceg",
      "din_instante",
      "val_geracao",
      "val_geracaolimitada",
      "val_disponibilidade",
      "val_geracaoreferencia",
      "val_geracaoreferenciafinal",
      "cod_razaorestricao",
      "cod_origemrestricao",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "1 & 3 — schema (identical across eólica and fotovoltaica)",
      claim:
        "The solar entity-grain file has the identical header to the wind one, so " +
        "one adapter reads both technologies.",
      breaks:
        "The two technologies share a parser. A divergence turns one code path " +
        "into two, silently, for whichever technology moved first.",
      code: "apps/api/src/ingest/ons/constrained-off.ts",
    },
  },
  {
    slug: WIND_DETAIL_DATASET_SLUG,
    label: "constrained-off wind, plant grain (_detail)",
    select: (resources) => latestMonthly(resources, ["CSV"]),
    required: [
      "id_subsistema",
      "id_estado",
      "nom_modalidadeoperacao",
      "nom_conjuntousina",
      "nom_usina",
      "id_ons",
      "ceg",
      "din_instante",
      "val_ventoverificado",
      "flg_dadoventoinvalido",
      "val_geracaoestimada",
      "val_geracaoverificada",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "2 & 4 — `_detail` schema",
      claim:
        "The wind _detail file is the true per-usina view and carries measured wind " +
        "speed (val_ventoverificado, documented as m3/s but really m/s) with its " +
        "own invalid-measurement flag; it has id_estado but no nom_estado and no " +
        "nom_subsistema.",
      breaks:
        "Per-plant detail is the only source of measured wind at plant grain, and " +
        "the only way a Tipo II-C plant inside a conjunto is visible at all.",
      code: "apps/api/src/ingest/ons/constrained-off-detail.ts",
    },
  },
  {
    slug: SOLAR_DETAIL_DATASET_SLUG,
    label: "constrained-off solar, plant grain (_detail)",
    select: (resources) => latestMonthly(resources, ["CSV"]),
    required: [
      "id_subsistema",
      "id_estado",
      "nom_modalidadeoperacao",
      "nom_conjuntousina",
      "nom_usina",
      "id_ons",
      "ceg",
      "din_instante",
      "val_irradianciaverificado",
      "flg_dadoirradianciainvalido",
      "val_geracaoestimada",
      "val_geracaoverificada",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "2 & 4 — `_detail` schema",
      claim:
        "The solar _detail file mirrors the wind one except that the measurement " +
        "column pair is val_irradianciaverificado / flg_dadoirradianciainvalido.",
      breaks:
        "The measurement column name is what the adapter switches on per " +
        "technology; a rename lands as an all-null irradiance column.",
      code: "apps/api/src/ingest/ons/constrained-off-detail.ts",
    },
  },
  {
    slug: ENERGY_BALANCE_DATASET_SLUG,
    label: "balanço de energia nos subsistemas",
    select: (resources) =>
      selectResourceForYear(resources, new Date().getUTCFullYear(), ["CSV"]),
    required: [
      "id_subsistema",
      "din_instante",
      "val_gerhidraulica",
      "val_gertermica",
      "val_gereolica",
      "val_gersolar",
      "val_carga",
      "val_intercambio",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "5. Balanço de energia nos subsistemas",
      claim:
        "The hourly subsystem balance carries six val_* columns in MWmed, with the " +
        "header identical from the 2000 file to the current year and only one " +
        "dictionary version ever published.",
      breaks:
        "This is the platform's hourly generation-by-technology and net-exchange " +
        "series — the denominator behind every curtailment ratio.",
      code: "apps/api/src/ingest/ons/energy-balance.ts",
    },
  },
  {
    slug: DAILY_LOAD_DATASET_SLUG,
    label: "carga de energia diária",
    select: (resources) =>
      selectResourceForYear(resources, new Date().getUTCFullYear(), ["CSV"]),
    required: ["id_subsistema", "din_instante", "val_cargaenergiamwmed"],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "8. Carga de energia diária",
      claim:
        "The daily load file is three load-bearing columns wide, with din_instante " +
        "a date and not an instant, and it is not a rollup of the half-hourly API.",
      breaks:
        "The daily series is the long history the API cannot serve cheaply; its " +
        "methodology regimes are pinned to these column names.",
      code: "apps/api/src/ingest/ons/daily-load.ts",
    },
  },
  {
    slug: INTERCHANGE_DATASET_SLUG,
    label: "intercâmbios entre subsistemas",
    select: (resources) =>
      selectResourceForYear(resources, new Date().getUTCFullYear(), ["CSV"]),
    required: [
      "din_instante",
      "id_subsistema_origem",
      "id_subsistema_destino",
      "val_intercambiomwmed",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "9. Intercâmbios entre subsistemas",
      claim:
        "Interchange is published at hourly × directed (origem, destino) pair, with " +
        "din_instante explicitly the *start* of the aggregation period — the only " +
        "dataset in scope where ONS states the labelling convention.",
      breaks:
        "Interchange is how a curtailment in one subsystem is explained by another; " +
        "the directed pair is the grain the whole adapter is built on.",
      code: "apps/api/src/ingest/ons/interchange.ts",
    },
  },
  {
    slug: CAPACITY_DATASET_SLUG,
    label: "capacidade instalada de geração",
    select: (resources) => selectSingleResource(resources, ["CSV"]),
    required: [
      "id_subsistema",
      "id_estado",
      "nom_modalidadeoperacao",
      "nom_agenteproprietario",
      "nom_agenteoperador",
      "nom_tipousina",
      "nom_usina",
      "ceg",
      "nom_unidadegeradora",
      "cod_equipamento",
      "val_potenciaefetiva",
    ],
    claim: {
      note: "docs/research/plant-registry.md",
      section: "SIGA is needed only for coordinates",
      claim:
        "ONS capacidade-geracao is the platform's primary registry — it covers the " +
        "whole curtailed fleet, carries per-unit commissioning and deactivation " +
        "dates, and identifies each plant by ceg because it publishes no id_ons.",
      breaks:
        "Plant identity, InstalledCapacityAsOf and the SIGA join key all come from " +
        "this file. It is the registry.",
      code: "apps/api/src/ingest/ons/plant-registry.ts",
    },
  },
  {
    slug: CONJUNTO_DATASET_SLUG,
    label: "relacionamento conjunto ↔ usina",
    select: (resources) => selectSingleResource(resources, ["CSV"]),
    required: [
      "id_subsistema",
      "estad_id",
      "id_tipousina",
      "id_ons_conjunto",
      "id_ons_usina",
      "nom_conjunto",
      "ceg",
      "dat_iniciorelacionamento",
      "dat_fimrelacionamento",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "Cross-dataset join concerns",
      claim:
        "usina_conjunto is an SCD2 bridge with dat_iniciorelacionamento / " +
        "dat_fimrelacionamento, and note the column is estad_id here — not " +
        "id_estado as in every other ONS dataset.",
      breaks:
        "Without this bridge the entity-grain datasets cannot be joined to the " +
        "plant-grain ones at all: a CJU_ reporting entity has no members.",
      code: "apps/api/src/ingest/ons/conjunto-membership.ts",
    },
  },
  {
    slug: DESSEM_DETAIL_DATASET_SLUG,
    label: "DESSEM — balanço detalhado",
    select: (resources) => {
      const days = availableResourceDays(resources, ["CSV"]);
      const latest = days.at(-1);
      if (!latest) {
        throw new AssumptionExpiredError(
          "\n\nSOURCE MOVED — the DESSEM package publishes no daily CSV resource.\n" +
            "  The daily split is itself the assumption that expired; see\n" +
            "  docs/research/ons-datasets.md § 10 & 11.\n",
        );
      }
      const [year, month, day] = latest.split("-").map(Number);
      return selectResourceForDay(
        resources,
        year as number,
        month as number,
        day as number,
        ["CSV"],
      );
    },
    required: [
      "din_programacaodia",
      "num_patamar",
      "cod_subsistema",
      "val_demanda",
      "val_ger_hidraulica",
      "val_ger_pch",
      "val_ger_termica",
      "val_ger_pct",
      "val_ger_eolica",
      "val_ger_fotovoltaica",
      "val_ger_mmgd",
      "val_cons_elevatoria",
    ],
    claim: {
      note: "docs/research/ons-datasets.md",
      section: "10 & 11. DESSEM — balanço geral and detalhado",
      claim:
        "The DESSEM detail balance is published one file per reference day, keyed " +
        "by (din_programacaodia, num_patamar, cod_subsistema), and its published " +
        "header uses val_ger_* with underscores — not the dictionary's val_ger*.",
      breaks:
        "DESSEM is the D-1 dispatch signal: the platform's only forward view of " +
        "what the operator intends to do with renewable generation.",
      code: "apps/api/src/ingest/ons/dessem-balance.ts",
    },
  },
];

suite("live conformance — the research notes, checked against the real sources", () => {
  describe("ONS bulk files still carry the columns the research recorded", () => {
    for (const source of ONS_COLUMN_CLAIMS) {
      it(
        `${source.label} (${source.claim.note} § ${source.claim.section})`,
        measuring(`ONS CKAN and S3 — ${source.slug}`, async () => {
          const resources = await fetchPackage(source.slug);
          const resource = source.select(resources);
          const columns = await fetchHeaderColumns(resource.url);
          const missing = missingColumns(columns, source.required);
          assertClaim(
            source.claim,
            missing.length === 0,
            `${resource.url.split("/").pop()} now publishes ${columns.length} columns ` +
              `[${columns.join(", ")}]. ${missing.length} column${
                missing.length === 1 ? "" : "s"
              } the platform requires ${missing.length === 1 ? "is" : "are"} absent: ` +
              `${missing.join(", ")}.`,
          );
        }),
        TIMEOUT_MS,
      );
    }
  });

  describe("the carga API's subsystem-code hazard", () => {
    // A settled day: recent enough that the source is current, old enough that
    // the series has closed over it.
    const day = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const WORKING: Claim = {
      note: "docs/research/ons-datasets.md",
      section: "6 & 7. Carga de energia — cod_areacarga uses SECO",
      claim:
        "The south-east/centre-west subsystem is cod_areacarga=SECO on this API, " +
        "and asking for it returns 48 half-hourly rows a day carrying " +
        "val_cargaglobal, the consisted series val_cargaglobalcons, and " +
        "din_atualizacao — the only per-row vintage marker anywhere in ONS data.",
      breaks:
        "SECO is a quarter of Brazilian load. If this stops answering, the load " +
        "series simply stops, and din_atualizacao is what the bitemporal store " +
        "uses as the source's own vintage rather than WattSteer's polling clock.",
      code: "apps/api/src/ingest/ons/carga-api.ts",
    };

    it(
      `SECO still answers with rows and the documented fields (${WORKING.note})`,
      measuring("the ONS carga API — /cargaverificada?cod_areacarga=SECO", async () => {
        const response = await fetchLoadRange({
          series: "VERIFIED",
          areaCode: "SECO",
          range: { from: day, to: day },
        });
        assertClaim(
          WORKING,
          response.rows.length > 0,
          `GET ${response.url} returned HTTP 200 with an empty array for ${day}, ` +
            "a day the verificada series covers (from 2016-01-01).",
        );
        const first = response.rows[0] ?? {};
        const required = [
          "cod_areacarga",
          "din_atualizacao",
          "dat_referencia",
          "din_referenciautc",
          "val_cargaglobal",
          "val_cargaglobalcons",
          "val_cargaglobalsmmgd",
          "val_cargasupervisionada",
          "val_carganaosupervisionada",
          "val_cargammgd",
          "val_consistencia",
        ];
        const absent = required.filter((field) => !(field in first));
        assertClaim(
          WORKING,
          absent.length === 0,
          `a ${day} SECO row now carries [${Object.keys(first).join(", ")}] and is ` +
            `missing ${absent.join(", ")}. Note the research already recorded that ` +
            "the CKAN dictionary spells one of these val_cargaglobalsmmg while the " +
            "live response spells it val_cargaglobalsmmgd; the live response is " +
            "authoritative.",
        );
      }),
      TIMEOUT_MS,
    );

    const SILENT: Claim = {
      note: "docs/research/ons-datasets.md",
      section: "6 & 7. Carga de energia — the SE silent-empty hazard",
      claim:
        "cod_areacarga=SE — the code every other ONS dataset uses for the same " +
        "subsystem — is not a member of this API's enum, and asking for it returns " +
        "HTTP 200 with an empty array rather than a 400. The failure mode is " +
        "silence: a quarter of the country reporting no load, with no error.",
      breaks:
        "This is why LoadAreaCode has no SE member and why an empty response is " +
        "raised as EmptyLoadResponseError instead of being written as zero rows. " +
        "If ONS ever makes SE work, the guard is no longer load-bearing — and if " +
        "ONS starts answering SE with a 400, the platform's silence detector is " +
        "no longer the only thing standing between a bad code and a silent gap.",
      code: "apps/api/src/ingest/ons/carga-api.ts",
    };

    it(
      `SE is still answered with a silent empty array (${SILENT.note})`,
      measuring("the ONS carga API — /cargaverificada?cod_areacarga=SE", async () => {
        // Deliberately built by hand: `SE` is not a `LoadAreaCode`, and the type
        // refusing it is the point of the claim being defended here.
        const url =
          `${CARGA_API_BASE}${SERIES_PATH.VERIFIED}` +
          `?dat_inicio=${day}&dat_fim=${day}&cod_areacarga=SE`;
        const response = await fetch(url);
        const body = await response.text();
        let rows: unknown;
        try {
          rows = JSON.parse(body);
        } catch {
          rows = null;
        }
        assertClaim(
          SILENT,
          response.status === 200,
          `GET ${url} answered HTTP ${response.status}, not the documented 200. ` +
            "An error status would be an improvement, but it is a different " +
            "contract from the one the adapter was written against.",
        );
        assertClaim(
          SILENT,
          Array.isArray(rows) && rows.length === 0,
          `GET ${url} answered HTTP 200 with ${
            Array.isArray(rows)
              ? `${rows.length} rows`
              : `a non-array body: ${body.slice(0, 200)}`
          }. If SE now returns data, the SECO mapping is no longer required — but ` +
            "check which series it is before removing it, because the two codes " +
            "answering differently would be worse than one of them being empty.",
        );
      }),
      TIMEOUT_MS,
    );
  });

  describe("the registry identifier padding asymmetry", () => {
    const SIGA_COLUMNS: Claim = {
      note: "docs/research/plant-registry.md",
      section: "Schema — the SIGA extract",
      claim:
        "The SIGA daily CSV is `;`-delimited with a UTF-8 BOM and a 23-column " +
        "header, carrying CodCEG, IdeNucleoCEG, DatGeracaoConjuntoDados, " +
        "DscFaseUsina, MdaPotenciaFiscalizadaKw, the two coordinate columns and " +
        "DscMuninicpios — ANEEL's own misspelling, which is the column name.",
      breaks:
        "SIGA is where every plant's latitude and longitude comes from. A renamed " +
        "or dropped column stops the whole registry join, not one field of it.",
      code: "apps/api/src/ingest/aneel/siga.ts",
    };

    const ONS_REGISTRY_COLUMNS: Claim = {
      note: "docs/research/plant-registry.md",
      section: "SIGA is needed only for coordinates",
      claim:
        "capacidade-geracao parses into a wind/solar plant registry keyed on the " +
        "version-stripped ceg, with the out-of-scope hydro and thermal rows " +
        "filtered rather than rejected.",
      breaks:
        "This is the platform's plant registry. If it stops parsing there is no " +
        "fleet to attribute curtailment to.",
      code: "apps/api/src/ingest/ons/plant-registry.ts",
    };

    const PADDING: Claim = {
      note: "docs/research/plant-registry.md",
      section: "Match rates — why A is zero",
      claim:
        "ANEEL writes the CEG version segment unpadded (`…-D.1`) and ONS writes it " +
        "zero-padded to two digits (`…-D.01`), so a verbatim CodCEG↔ceg join " +
        "matches 0 of 1,614 plants while the version-stripped core matches 100%. " +
        "Nothing in either data dictionary mentions the discrepancy.",
      breaks:
        "This is the platform's single most dangerous silent failure: the naive " +
        "join throws nothing, malforms nothing, and leaves every plant without " +
        "coordinates — which is only noticed months later when a weather sample " +
        "is asked for. Both halves matter: if the verbatim rate ever leaves zero, " +
        "ANEEL or ONS changed its rendering and the stripping rule needs " +
        "re-deriving; if the core rate falls, the join is decaying.",
      code: "apps/api/src/ingest/aneel/match-rate.ts, apps/api/src/ingest/aneel/siga.ts",
    };

    it(
      `verbatim CEG still matches nothing and the stripped core still matches (${PADDING.note})`,
      measuring("ONS capacidade-geracao and the ANEEL SIGA daily CSV", async () => {
        const onsResources = await fetchPackage(CAPACITY_DATASET_SLUG);
        const onsCsv = await (
          await get(selectSingleResource(onsResources, ["CSV"]).url)
        ).text();
        const registry = parsing(ONS_REGISTRY_COLUMNS, () =>
          parseCapacityRegistryCsv(onsCsv),
        );

        const sigaResources = await fetchAneelPackage(SIGA_DATASET_SLUG);
        const sigaCsv = await (
          await get(selectDailySigaResource(sigaResources).url)
        ).text();
        const siga = parsing(SIGA_COLUMNS, () => parseSigaCsv(sigaCsv));

        const plants = registry.plants;
        const match = measureMatchRate(
          plants.map((plant) => ({ cegCore: plant.cegCore, cegRaw: plant.cegRaw })),
          siga.rows,
        );
        const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

        assertClaim(
          PADDING,
          match.verbatimMatched === 0,
          `${match.verbatimMatched} of ${match.registryPlants} registry plants ` +
            `(${pct(match.verbatimRate)}) now match SIGA on the raw identifier. ` +
            "One of the two agencies changed how it renders the version segment. " +
            "That is good news for anyone writing a new join and bad news for the " +
            "stripping rule, which was derived from the two renderings differing.",
        );
        assertClaim(
          PADDING,
          match.rate >= 0.99,
          `the version-stripped core now matches ${match.matched} of ` +
            `${match.registryPlants} (${pct(match.rate)}), below the 99% floor the ` +
            `ingest asserts. Unmatched include ${match.unmatched.slice(0, 5).join(", ")}.`,
        );

        const versions = (values: string[]): string[] => [
          ...new Set(values.map((value) => value.split(".").at(-1) ?? "")),
        ];
        const onsVersions = versions(plants.map((plant) => plant.cegRaw)).sort();
        const sigaVersions = versions(siga.rows.map((row) => row.cegRaw)).sort();
        assertClaim(
          PADDING,
          onsVersions.every((version) => version.length === 2) &&
            sigaVersions.every((version) => version.length === 1),
          `ONS now renders version segments as [${onsVersions.join(", ")}] and ANEEL ` +
            `as [${sigaVersions.join(", ")}]. The research measured ONS zero-padded ` +
            "to two digits (00, 01, 02, 03) and ANEEL unpadded (1, 2, 3, 4); the " +
            "asymmetry is the reason the join key is version-stripped at all.",
        );
      }),
      TIMEOUT_MS,
    );
  });

  describe("the pinned weather model still serves every required variable", () => {
    const VARIABLES: Claim = {
      note: "docs/research/weather-lead-time.md",
      section: "5b. Single Runs API — variable parity",
      claim:
        `The Single Runs API, pinned to models=${WEATHER_MODEL}, serves all twelve ` +
        "variables WattSteer trains and serves on, from a named D-1 run. An " +
        "unsupported variable is not an error on this API — it is HTTP 200, an " +
        'all-null array and units "undefined".',
      breaks:
        "Train/serve parity is the whole reason this endpoint was chosen over the " +
        "stitched archive. A variable that quietly turns null becomes a NULL column " +
        "indistinguishable from weather that genuinely was not forecast, and the " +
        "model is scored on a feature it was never trained on.",
      code: "apps/api/src/ingest/weather/single-runs.ts",
    };

    /** Two days back: settled, and inside the archive at either run cycle. */
    const runInit = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    runInit.setUTCHours(12, 0, 0, 0);

    it(
      `all twelve variables, one centroid, ${WEATHER_MODEL} (${VARIABLES.note})`,
      measuring("the Open-Meteo Single Runs API", async () => {
        const centroid = CENTROIDS[0];
        if (!centroid) {
          throw new Error("The centroid set is empty; there is nothing to query.");
        }
        const response = await fetchModelRun({
          runInit,
          points: [{ latitude: centroid.latitude, longitude: centroid.longitude }],
          forecastDays: 2,
        });
        const location = response.locations[0];
        if (!location) {
          assertClaim(
            VARIABLES,
            false,
            `run=${runParam(runInit)} returned no location object at all.`,
          );
          return;
        }

        const undefinedUnits: string[] = [];
        const allNull: string[] = [];
        for (const variable of WEATHER_VARIABLES) {
          const values = location.hourly[variable];
          const units = location.hourly_units[variable];
          if (units === undefined || units === "undefined") {
            undefinedUnits.push(`${variable} (units=${String(units)})`);
          }
          const series = Array.isArray(values) ? values : [];
          if (!series.some((value) => value !== null && value !== undefined)) {
            allNull.push(variable);
          }
        }

        assertClaim(
          VARIABLES,
          undefinedUnits.length === 0 && allNull.length === 0,
          `run=${runParam(runInit)} at ${centroid.id} (${centroid.latitude}, ` +
            `${centroid.longitude}) returned ` +
            (undefinedUnits.length > 0
              ? `units "undefined" for ${undefinedUnits.join(", ")}; `
              : "") +
            (allNull.length > 0 ? `an all-null series for ${allNull.join(", ")}; ` : "") +
            `for model ${WEATHER_MODEL}. This is exactly the shape the research ` +
            "measured for temperature_120m, which is why that variable is excluded.",
        );
      }),
      TIMEOUT_MS,
    );

    const EXCLUDED: Claim = {
      note: "docs/research/weather-lead-time.md",
      section: "5b. Single Runs API — temperature_120m is null on all three endpoints",
      claim:
        `temperature_120m is null under models=${WEATHER_MODEL} on every Open-Meteo ` +
        "endpoint, which is why it is named in single-runs.ts as a variable that " +
        "must not be specified.",
      breaks:
        "Nothing, immediately — but the exclusion is documented as a measured fact, " +
        "and a fact that stops being true should be re-decided rather than left " +
        "standing. If this fails, Open-Meteo started serving hub-height " +
        "temperature and the twelve-variable set is worth revisiting.",
      code: "apps/api/src/ingest/weather/single-runs.ts",
    };

    it(
      `temperature_120m is still not served (${EXCLUDED.note})`,
      measuring("the Open-Meteo Single Runs API", async () => {
        const centroid = CENTROIDS[0];
        if (!centroid) {
          throw new Error("The centroid set is empty; there is nothing to query.");
        }
        // Requested by hand rather than through `fetchModelRun`, because
        // `temperature_120m` is deliberately not a member of `WeatherVariable`
        // — the type refusing it is the decision this case re-examines.
        const url =
          `${SINGLE_RUNS_HOST}${SINGLE_RUNS_PATH}` +
          `?latitude=${centroid.latitude}&longitude=${centroid.longitude}` +
          `&hourly=temperature_120m&run=${encodeURIComponent(runParam(runInit))}` +
          `&forecast_days=1&timezone=GMT&models=${WEATHER_MODEL}`;
        const [location] = locationsOf(await (await get(url)).json());
        const series = Array.isArray(location?.hourly.temperature_120m)
          ? (location.hourly.temperature_120m as unknown[])
          : [];
        const served = series.filter(
          (value) => value !== null && value !== undefined,
        ).length;
        assertClaim(
          EXCLUDED,
          served === 0,
          `run=${runParam(runInit)} now returns ${served} non-null temperature_120m ` +
            `values with units ${String(location?.hourly_units.temperature_120m)}. ` +
            "This is a capability gain, not a breakage: the variable is available " +
            "and the exclusion note in single-runs.ts is out of date.",
        );
      }),
      TIMEOUT_MS,
    );
  });

  describe("the SIGA daily resource is still fresher than the monthly one", () => {
    const FRESHNESS: Claim = {
      note: "docs/research/plant-registry.md",
      section: "Resources — the daily cut",
      claim:
        "ANEEL publishes siga-empreendimentos-geracao.csv monthly and " +
        "siga-empreendimentos-geracao-diario.csv daily, with an identical " +
        "23-column header, and the daily resource is the fresher cut. WattSteer " +
        "ingests the daily one and refuses to substitute the monthly one.",
      breaks:
        "The monthly cut leaves a newly-operating plant sitting at DscFaseUsina " +
        "= Construção while ONS is already curtailing it — twelve plants on the " +
        "day the research was measured. If the daily resource stops moving, " +
        "coordinates for new entrants go stale silently and the selector's " +
        "refusal to fall back is the only thing that will say so.",
      code: "apps/api/src/ingest/aneel/catalogue.ts",
    };

    it(
      `the daily cut is present and newer than the monthly (${FRESHNESS.note})`,
      measuring("the ANEEL CKAN catalogue — SIGA package_show", async () => {
        const resources = await fetchAneelPackage(SIGA_DATASET_SLUG);
        const daily = selectDailySigaResource(resources);
        const monthly = resources.find(
          (resource) =>
            resource.format === "CSV" &&
            resource.url.toLowerCase().endsWith("siga-empreendimentos-geracao.csv"),
        );
        assertClaim(
          FRESHNESS,
          monthly !== undefined,
          "the SIGA package no longer publishes a monthly CSV at all. The daily " +
            "cut is what WattSteer reads, so this is not an outage — but the " +
            "package changed shape and the note describes five resources.",
        );
        if (!monthly) {
          return;
        }
        const dailyStamp = daily.lastModified;
        const monthlyStamp = monthly.lastModified;
        assertClaim(
          FRESHNESS,
          dailyStamp !== null && monthlyStamp !== null,
          `CKAN reports last_modified as daily=${String(dailyStamp)} and ` +
            `monthly=${String(monthlyStamp)}. Without both stamps the freshness ` +
            "claim cannot be measured at all, which is itself a change: the " +
            "research read both from package_show.",
        );
        if (!(dailyStamp && monthlyStamp)) {
          return;
        }
        assertClaim(
          FRESHNESS,
          dailyStamp.getTime() > monthlyStamp.getTime(),
          `the daily resource was last modified ${dailyStamp.toISOString()} and the ` +
            `monthly one ${monthlyStamp.toISOString()} — the daily cut is no longer ` +
            "the fresher of the two. Either the daily job stopped, or ANEEL " +
            "re-published the monthly file over the top of it.",
        );

        const dayAge = (Date.now() - dailyStamp.getTime()) / (24 * 60 * 60 * 1000);
        assertClaim(
          FRESHNESS,
          dayAge <= 7,
          `the daily resource has not moved for ${dayAge.toFixed(1)} days ` +
            `(last_modified ${dailyStamp.toISOString()}). ANEEL documents this ` +
            'dataset as "Mensal e diária"; a week-old "daily" cut is the monthly ' +
            "cadence wearing the daily filename.",
        );
      }),
      TIMEOUT_MS,
    );
  });
});
