import { describe, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPACITY_DATASET_SLUG,
  CARGA_API_BASE,
  type CatalogueResource,
  DESSEM_DETAIL_DATASET_SLUG,
  DATASET_SLUG as ENERGY_BALANCE_DATASET_SLUG,
  fetchLoadRange,
  fetchPackage,
  findRenewableDeactivations,
  headResource,
  INTERCHANGE_DATASET_SLUG,
  ONS_TIME_ZONE,
  parseCapacityRegistryCsv,
  parseConstrainedOffCsv,
  parseDessemBalanceCsv,
  parseEnergyBalanceCsv,
  parseInterchangeCsv,
  parseProgrammedLoad,
  parseVerifiedLoad,
  SERIES_PATH,
  SOLAR_DATASET_SLUG,
  selectResourceForDay,
  selectResourceForMonth,
  selectResourceForYear,
  WIND_DATASET_SLUG,
  WIND_DETAIL_DATASET_SLUG,
  zonedWallClockToUtc,
} from "../src/ingest/index.js";
import { selectSingleResource } from "../src/ingest/ons/catalogue.js";
import {
  PROGRAMME_PUBLICATION_HOUR_BRT,
  programmePublishedAt,
} from "../src/ingest/ons/load.js";
import { parseWallClock, zonedWallClock } from "../src/ingest/time.js";
import {
  AssumptionExpiredError,
  assertClaim,
  type Claim,
  get,
  measuring,
  parsing,
  publish,
} from "./support/conformance.js";

/**
 * Seam 6 — **publication-lag conformance**, the feature layer's scheduled
 * measurement of the guesses it is built on.
 *
 * `docs/specs/feature-engineering.md` is honest about what its constants are:
 * every conservative default in it is a guess standing in for a measurement,
 * and the guesses are load-bearing **in both directions**. A configured lag
 * that is too tight is a leak served quietly; one that is too loose throws away
 * a day of usable actuals and several dropped features with it. The day-ahead
 * programme's decided publication instant is the same object one layer up:
 * `PROGRAMME_PUBLICATION_HOUR_BRT` is an *upper bound* inferred from DESSEM's
 * file creation time, not an observation of ONS publishing, and the whole
 * viability of `gate_early` turns on whether the real instant is earlier.
 *
 * So this suite measures, and the measurement is the product. It follows the
 * data platform's `test/live-conformance.test.ts` in every respect — the same
 * `Claim` vocabulary out of `test/support/conformance.ts`, the same refusal to
 * report a bare value diff, the same separation of "the source did not answer"
 * from "a documented assumption expired" — and adds one thing that suite does
 * not need: it **publishes numbers on a passing run** (`publish`). An alarm
 * that only speaks when it fires cannot tell an operator that a 40-hour default
 * has been running with three hours of headroom for a year.
 *
 * **What it measures against.** `apps/api/drizzle/0021_lagged_actuals_behind_
 * the_cutoff.sql` seeds `feature_publication_lag` with six datasets, and
 * `0016_the_feature_gate.sql` fixes the two gate hours. Nothing writes either
 * at runtime, deliberately: loosening a lag moves `actuals_cutoff`, which moves
 * every lag and trailing window behind it, which changes the feature
 * distribution the model was fitted on. That is a **retrain trigger, not a
 * config tweak**, so it lands as a migration next to a new feature-set version.
 * This suite therefore reads the migrations' own text rather than a copy of
 * their numbers — a constant restated here would be a second place to change,
 * and the second place is the one that gets forgotten.
 *
 * **Gating.** `WATTSTEER_PUBLICATION_LAG_CONFORMANCE`, the same
 * `describe.skip`-on-env-var shape as `WATTSTEER_LIVE_CONFORMANCE` and the
 * `database-*.test.ts` suites. The default `bun test test` discovers this file
 * and skips every case in it, so the default path stays offline. Run it
 * deliberately:
 *
 *     bun run --cwd apps/api test:lag
 *
 * and on a schedule from `.github/workflows/publication-lag-conformance.yml`,
 * never on a commit. **The schedule is 11:00 UTC = 08:00 BRT, and that hour is
 * load-bearing**: the only way to observe whether the day-ahead programme is
 * available at `gate_early` (D−1 09:00 BRT) is to ask before 09:00 BRT. A run
 * at any other hour can tighten the upper bound and cannot settle the question.
 */
const ENABLED = process.env.WATTSTEER_PUBLICATION_LAG_CONFORMANCE;
const suite = ENABLED ? describe : describe.skip;

/**
 * Generous: two of these cases pull a whole month of constrained-off CSV
 * (~29 MB) out of ONS S3, which is the price of counting reason codes over a
 * real month rather than over its last few kilobytes.
 */
const TIMEOUT_MS = 600_000;

const MS_PER_HOUR = 3_600_000;

const MIGRATIONS = join(import.meta.dir, "../drizzle");

/** Hours between two instants, signed, `to − from`. */
const hoursBetween = (from: Date, to: Date): number =>
  (to.getTime() - from.getTime()) / MS_PER_HOUR;

const round = (value: number, places = 2): string => value.toFixed(places);

/** An instant, rendered in both UTC and the zone ONS actually publishes in. */
function bothClocks(instant: Date): string {
  const local = zonedWallClock(instant, ONS_TIME_ZONE);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${instant.toISOString()} (${local.year}-${pad(local.month)}-${pad(local.day)} ` +
    `${pad(local.hour)}:${pad(local.minute)} BRT)`
  );
}

/** Run an async producer at most once per process. */
function once<T>(produce: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= produce();
    return pending;
  };
}

/**
 * The seeded lags, read out of the migration that seeds them.
 *
 * Not a copy of the six numbers. The migration is the authority — the ticket's
 * whole point is that loosening one has to be a diff in `drizzle/` — and a
 * suite that measured against its own transcription of the seed would keep
 * passing after somebody changed the seed and forgot the test, which is the one
 * failure mode this file exists to make impossible.
 */
interface ConfiguredLag {
  dataset: string;
  canonicalRead: string;
  hours: number;
  rationale: string;
}

const SEED_ROW = /\('([a-z-]+)',\s*'([a-z-]+)',\s*(\d+),\s*'([^']*)'\)/g;

function configuredLags(): Map<string, ConfiguredLag> {
  const sql = readFileSync(
    join(MIGRATIONS, "0021_lagged_actuals_behind_the_cutoff.sql"),
    "utf8",
  );
  const start = sql.indexOf("INSERT INTO feature_publication_lag");
  const end = sql.indexOf("ON CONFLICT (dataset) DO NOTHING", start);
  if (start < 0 || end < 0) {
    throw new Error(
      "0021_lagged_actuals_behind_the_cutoff.sql no longer seeds " +
        "feature_publication_lag in a form this suite can read. The seed is what " +
        "this suite measures against; re-point it before trusting a green run.",
    );
  }
  const lags = new Map<string, ConfiguredLag>();
  for (const match of sql.slice(start, end).matchAll(SEED_ROW)) {
    lags.set(match[1] as string, {
      dataset: match[1] as string,
      canonicalRead: match[2] as string,
      hours: Number(match[3]),
      rationale: match[4] as string,
    });
  }
  if (lags.size === 0) {
    throw new Error(
      "no publication lags parsed from 0021_lagged_actuals_behind_the_cutoff.sql",
    );
  }
  return lags;
}

const CONFIGURED = configuredLags();

/** The configured lag for a dataset, or a loud failure if the row went away. */
function lagFor(dataset: string): ConfiguredLag {
  const lag = CONFIGURED.get(dataset);
  if (!lag) {
    throw new Error(
      `feature_publication_lag no longer seeds a row for '${dataset}'. ` +
        "actuals_cutoff raises 22023 for an unconfigured dataset, so this is not " +
        "a test-only problem: the feature build for that series is now broken.",
    );
  }
  return lag;
}

/**
 * The two gate hours, read out of `0016_the_feature_gate.sql` for the same
 * reason the lags are read out of `0021`.
 */
function gateHours(): { early: number; late: number } {
  const sql = readFileSync(join(MIGRATIONS, "0016_the_feature_gate.sql"), "utf8");
  const early = /WHEN 'gate_early' THEN (\d+)/.exec(sql);
  const late = /WHEN 'gate_late' THEN (\d+)/.exec(sql);
  if (!(early && late)) {
    throw new Error(
      "0016_the_feature_gate.sql no longer spells the two gate hours in a form " +
        "this suite can read. The gate hours decide what 'available' means here.",
    );
  }
  return { early: Number(early[1]), late: Number(late[1]) };
}

const GATE = gateHours();

// ---------------------------------------------------------------------------
// Freshness probes — "what is the newest hour this source has published, and
// when did it say it published it?"
// ---------------------------------------------------------------------------

/**
 * One source's freshness, measured now.
 *
 * `newestValidTime` is the quantity the cutoff is about. `actuals_cutoff(gate,
 * dataset) = gate − lag` promises that **every** hour at or before the cutoff
 * is published by the time the gate falls; read at this instant, that promise
 * is exactly `now − newestValidTime <= lag`.
 *
 * Two honest limits, stated here rather than discovered later:
 *
 * 1. The newest published hour does not prove there is no *hole* behind it.
 *    The seam-2 ablation test is what catches a hole; this catches lateness.
 * 2. `now − newestValidTime` **over**states the real publication lag, because
 *    the file may have been published hours ago and nothing newer has happened
 *    since. That is the right direction to be wrong in for an alarm — it is the
 *    operational quantity, "how stale is the freshest actual available to a
 *    gate falling right now" — and `sourceStamp` is reported beside it so the
 *    tighter number, lag at publication, is in the log too.
 */
interface Freshness {
  newestValidTime: Date;
  /** The source's own publication stamp, where it publishes one. */
  sourceStamp: Date | null;
  /** How the two above were obtained, in prose, for the published record. */
  method: string;
  /** What was actually read — a filename, a row count. */
  detail: string;
}

/** The newest `valid_time` in a whole published file, via the platform's parser. */
async function fileFreshness(
  claim: Claim,
  resource: CatalogueResource,
  newest: (text: string) => Date | null,
): Promise<Freshness> {
  const response = await get(resource.url);
  const stamp = response.headers.get("last-modified");
  const text = await response.text();
  const validTime = parsing(claim, () => newest(text));
  if (!validTime) {
    assertClaim(
      claim,
      false,
      `${resource.url.split("/").pop()} parsed without error but yielded no usable ` +
        "row at all, so the newest published hour could not be established.",
    );
    throw new AssumptionExpiredError("unreachable");
  }
  return {
    newestValidTime: validTime,
    sourceStamp: stamp ? new Date(stamp) : null,
    method:
      "whole published file downloaded and parsed with the platform's own " +
      "adapter; newest valid_time over every row",
    detail: `${resource.url.split("/").pop()} (${text.length} bytes)`,
  };
}

/**
 * The newest `valid_time` in the **tail** of a published CSV.
 *
 * For the `_detail` files only, and only because they are 171 MB as CSV against
 * a question about their last line — the same trade `live-conformance.test.ts`
 * makes with a `Range` request for a header. Two limits come with it and are
 * reported in the measurement rather than hidden: the tail holds the rows of
 * whichever reporting entity the file groups last, so the instant read here is
 * that entity's newest half hour and not provably the file's maximum; and the read
 * asserts the tail is time-ordered rather than assuming it, because an
 * unordered tail would make the number meaningless instead of merely partial.
 */
async function tailFreshness(
  claim: Claim,
  resource: CatalogueResource,
): Promise<Freshness> {
  const head = await get(resource.url, { headers: { Range: "bytes=0-8191" } });
  const columns = (await head.text())
    .replace(/^﻿/, "")
    .split(/\r?\n/)[0]
    ?.split(";")
    .map((column) => column.trim().replace(/^"|"$/g, ""));
  const index = columns?.indexOf("din_instante") ?? -1;
  assertClaim(
    claim,
    index >= 0,
    `the file's header is [${(columns ?? []).join(", ")}] and carries no ` +
      "din_instante, so it publishes no valid time this suite can read.",
  );

  const tail = await get(resource.url, { headers: { Range: "bytes=-65536" } });
  const stamp = tail.headers.get("last-modified");
  // The first line of a byte range starts mid-row; drop it.
  const lines = (await tail.text()).split(/\r?\n/).slice(1).filter(Boolean);
  const stamps = lines
    .map((line) => line.split(";")[index] ?? "")
    .filter((value) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value));
  assertClaim(
    claim,
    stamps.length > 0,
    `the last 64 kB of ${resource.url.split("/").pop()} yielded no parsable ` +
      `din_instante in column ${index}.`,
  );
  const ordered = stamps.every(
    (value, position) => position === 0 || value >= (stamps[position - 1] as string),
  );
  assertClaim(
    claim,
    ordered,
    "the tail of this file is no longer ordered by din_instante, so its last " +
      "rows are not its newest ones and this measurement cannot be made from a " +
      "range request any more. Read the Parquet rendition instead.",
  );
  const newest = stamps[stamps.length - 1] as string;
  return {
    // ONS bulk timestamps are Brasília wall clock; the offset is applied by the
    // same helper every adapter uses rather than by a fixed −3.
    newestValidTime: brtWallClockToInstant(claim, newest),
    sourceStamp: stamp ? new Date(stamp) : null,
    method:
      "last 64 kB of the published CSV read with a Range request; newest " +
      "din_instante among the final reporting entity's rows",
    detail: `${resource.url.split("/").pop()} — ${stamps.length} rows in the tail, newest ${newest} BRT`,
  };
}

/**
 * ONS's `YYYY-MM-DD HH:MM:SS` wall clock → the instant it names.
 *
 * Through the platform's own zone helpers rather than a fixed −3, and through
 * the same pair every adapter uses, so this suite cannot disagree with the
 * ingest about what an ONS timestamp means. A wall clock that names no instant
 * is reported as an expired claim rather than replaced by a plausible one.
 */
function brtWallClockToInstant(claim: Claim, wall: string): Date {
  const parsed = parseWallClock(wall);
  assertClaim(claim, parsed !== null, `'${wall}' is not an ONS wall clock.`);
  const zoned = zonedWallClockToUtc(parsed as NonNullable<typeof parsed>, ONS_TIME_ZONE);
  assertClaim(
    claim,
    zoned.kind !== "gap",
    `'${wall}' BRT names no instant in ${ONS_TIME_ZONE} — a DST transition swallowed ` +
      "it. Brazil abolished DST in 2019, so this is a statement about the source's " +
      "timestamps, not about the calendar.",
  );
  // Fall-back hours happened twice. The earlier reading makes the row look
  // older, which is the direction an alarm should err in.
  return zoned.kind === "ok"
    ? zoned.instant
    : (zoned as { instants: [Date, Date] }).instants[0];
}

/**
 * The datasets the seed configures, and how each one's freshness is measured.
 *
 * The list is keyed by the **seed's** dataset names, not by CKAN slugs, because
 * the seed is the thing being measured against. Two of the six are not bulk
 * ONS files at all and are measured differently, which is stated per row rather
 * than smoothed over: a REST API with a row-level stamp and a registry snapshot
 * with no valid time of its own are genuinely different questions.
 */
interface LagCase {
  dataset: string;
  label: string;
  claim: Claim;
  probe: () => Promise<Freshness>;
}

/** The current-month resource of a monthly-split dataset, else last month's. */
async function currentMonthResource(
  slug: string,
  formats: readonly ("CSV" | "PARQUET")[] = ["CSV"],
): Promise<CatalogueResource> {
  const resources = await fetchPackage(slug);
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const candidates = [
    { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 },
    { year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1 },
  ];
  for (const candidate of candidates) {
    try {
      return selectResourceForMonth(resources, candidate.year, candidate.month, formats);
    } catch {
      // ONS creates a month's file on its first days; falling back to the
      // previous month is not a fudge here — that file genuinely is the newest
      // one published, and measuring its staleness is the honest answer.
    }
  }
  throw new AssumptionExpiredError(
    `\n\nSOURCE MOVED — ${slug} publishes neither the current nor the previous\n` +
      "  month as a readable resource. The monthly split is the assumption that\n" +
      "  expired; see docs/research/ons-datasets.md § 1-4.\n",
  );
}

const CURTAILMENT_CLAIM: Claim = {
  note: "docs/research/publication-lag.md",
  section: "restricao-coff — measured lag",
  claim:
    "The entity-grain constrained-off files are republished on the ONS 12h/19h " +
    "cycle carrying data through the end of the previous civil day, which is a " +
    "real lag of roughly 20 h at publication and at most ~37 h of staleness just " +
    "before a cycle — inside the 40 h the seed configures.",
  breaks:
    "This series is the label. Every observed_constrained_off_* feature and the " +
    "mandatory baseline are cut at gate − 40 h on it; if the real lag exceeds 40 h " +
    "the platform is serving features built from rows that will not exist at the " +
    "gate, which is the leak the whole cutoff exists to prevent.",
  code: "apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql (seed) and apps/api/src/ingest/ons/constrained-off.ts",
};

/** The current month of entity-grain wind curtailment, parsed once per run. */
const windCurtailment = once(async () => {
  const resource = await currentMonthResource(WIND_DATASET_SLUG);
  const response = await get(resource.url);
  const text = await response.text();
  return {
    resource,
    lastModified: response.headers.get("last-modified"),
    parse: parsing(CURTAILMENT_CLAIM, () => parseConstrainedOffCsv(text, "WIND")),
    bytes: text.length,
  };
});

/** The same for solar, which the same adapter reads. */
const solarCurtailment = once(async () => {
  const resource = await currentMonthResource(SOLAR_DATASET_SLUG);
  const response = await get(resource.url);
  const text = await response.text();
  return {
    resource,
    parse: parsing(CURTAILMENT_CLAIM, () => parseConstrainedOffCsv(text, "SOLAR")),
    bytes: text.length,
  };
});

const BALANCE_CLAIM: Claim = {
  note: "docs/research/publication-lag.md",
  section: "balanco-energia-subsistema — measured lag",
  claim:
    "The yearly balance file is rewritten on the ONS 12h/19h cycle and carries " +
    "hours through the end of the civil day before the publication that advanced " +
    "it — about 20 h of lag at publication, and never more than the 40 h the seed " +
    "configures. Measured 2026-08-29, only the 19h cycle advanced its coverage, " +
    "so staleness sawtooths from ~20 h to ~44 h across a day.",
  breaks:
    "system-context is the load, generation-by-technology and net-exchange " +
    "series behind observed_load_lag_168h, the two capacity factors and every " +
    "trailing window over actuals. A real lag past 40 h means those features " +
    "are built from rows a live gate will not have.",
  code: "apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql (seed) and apps/api/src/ingest/ons/energy-balance.ts",
};

const INTERCHANGE_CLAIM: Claim = {
  note: "docs/research/publication-lag.md",
  section: "intercambio-nacional — measured lag",
  claim:
    "Interchange shares the balance file's release: same yearly split, same " +
    "12h/19h cycle, republished within minutes of it. It does not share its " +
    "coverage — measured 2026-08-29, interchange gained a day on the 12h cycle " +
    "and the balance file did not — which is why both are probed rather than one " +
    "standing in for the other.",
  breaks:
    "system-exchange is behind observed_net_exchange_* and the two corridor " +
    "flows — the features that explain a curtailment in one subsystem by what " +
    "the neighbouring one was doing.",
  code: "apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql (seed) and apps/api/src/ingest/ons/interchange.ts",
};

const DETAIL_CLAIM: Claim = {
  note: "docs/research/publication-lag.md",
  section: "restricao-coff-detalhe — measured lag",
  claim:
    "The plant-grain _detail files are published in the same release as the " +
    "entity-grain ones and are no staler than they are.",
  breaks:
    "curtailment-by-plant is the plant-level view behind the diagnosis surface " +
    "and the measured wind speed; it is cut on the same 40 h.",
  code: "apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql (seed) and apps/api/src/ingest/ons/constrained-off-detail.ts",
};

const VERIFIED_LOAD_CLAIM: Claim = {
  note: "docs/research/publication-lag.md",
  section: "carga-verificada — measured lag",
  claim:
    "The carga API publishes verified load within about an hour of the half " +
    "hour it describes, and it is the one ONS source whose latency is observed " +
    "rather than assumed — every row carries din_atualizacao. It also pre-fills " +
    "the rest of the current day with val_cargaglobal = 0, so the newest " +
    "*published* half hour is the newest non-zero one, not the newest row.",
  breaks:
    "No canonical read is built on this series yet; the row is configuration " +
    "ahead of a reader. It is measured anyway because 6 h is the tightest lag " +
    "in the table, so it is the one that will fail first if ONS slows down.",
  code: "apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql (seed) and apps/api/src/ingest/ons/load.ts",
};

const CAPACITY_CLAIM: Claim = {
  note: "docs/research/publication-lag.md",
  section: "capacidade-geracao — measured lag",
  claim:
    "The registry is a single file overwritten twice a day and carries no " +
    "valid time of its own: its content is 'the fleet as ONS records it now', " +
    "so the only measurable staleness is the age of the file itself, and it " +
    "stays inside the 24 h the seed configures.",
  breaks:
    "installed-capacity is the denominator of both realised capacity factors " +
    "and the fleet the weather features are weighted by. A snapshot older than " +
    "24 h at the gate means the fleet used for the target date is older than " +
    "the cutoff claims.",
  code: "apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql (seed) and apps/api/src/ingest/ons/plant-registry.ts",
};

const LAG_CASES: LagCase[] = [
  {
    dataset: "balanco-energia-subsistema",
    label: "hourly subsystem balance",
    claim: BALANCE_CLAIM,
    probe: async () => {
      const claim = BALANCE_CLAIM;
      const resources = await fetchPackage(ENERGY_BALANCE_DATASET_SLUG);
      const resource = selectResourceForYear(resources, new Date().getUTCFullYear(), [
        "CSV",
      ]);
      return fileFreshness(claim, resource, (text) => {
        const rows = parseEnergyBalanceCsv(text).rows;
        return newestOf(rows.map((row) => row.validTime));
      });
    },
  },
  {
    dataset: "intercambio-nacional",
    label: "hourly directed interchange",
    claim: INTERCHANGE_CLAIM,
    probe: async () => {
      const claim = INTERCHANGE_CLAIM;
      const resources = await fetchPackage(INTERCHANGE_DATASET_SLUG);
      const resource = selectResourceForYear(resources, new Date().getUTCFullYear(), [
        "CSV",
      ]);
      return fileFreshness(claim, resource, (text) => {
        const rows = parseInterchangeCsv(text).rows;
        return newestOf(rows.map((row) => row.validTime));
      });
    },
  },
  {
    dataset: "restricao-coff",
    label: "constrained-off, reporting-entity grain (the label's own series)",
    claim: CURTAILMENT_CLAIM,
    probe: async () => {
      const { resource, lastModified, parse, bytes } = await windCurtailment();
      const newest = newestOf(parse.rows.map((row) => row.validTime));
      if (!newest) {
        assertClaim(
          CURTAILMENT_CLAIM,
          false,
          `${resource.url.split("/").pop()} parsed to zero usable rows.`,
        );
        throw new AssumptionExpiredError("unreachable");
      }
      return {
        newestValidTime: newest,
        sourceStamp: lastModified ? new Date(lastModified) : null,
        method:
          "whole published month downloaded and parsed with the platform's own " +
          "adapter; newest valid_time over every reporting entity",
        detail: `${resource.url.split("/").pop()} (${bytes} bytes, ${parse.rows.length} entity-hours)`,
      };
    },
  },
  {
    dataset: "restricao-coff-detalhe",
    label: "constrained-off, plant grain (_detail)",
    claim: DETAIL_CLAIM,
    probe: async () => {
      const resource = await currentMonthResource(WIND_DETAIL_DATASET_SLUG);
      return tailFreshness(DETAIL_CLAIM, resource);
    },
  },
  {
    dataset: "carga-verificada",
    label: "verified load (REST, row-level vintage)",
    claim: VERIFIED_LOAD_CLAIM,
    probe: async () => {
      const claim = VERIFIED_LOAD_CLAIM;
      const today = brtDate(new Date());
      const yesterday = brtDate(new Date(Date.now() - 24 * MS_PER_HOUR));
      const response = await fetchLoadRange({
        series: "VERIFIED",
        areaCode: "SECO",
        range: { from: yesterday, to: today },
      });
      const parsed = parsing(claim, () => parseVerifiedLoad(response.rows));
      // Zero is not "no load"; it is this endpoint's placeholder for a half hour
      // it has not observed yet. Treating it as published would report the whole
      // of the current day as available and understate the lag to nothing.
      const observed = parsed.rows.filter((row) => row.loadMwh > 0);
      const newest = newestOf(observed.map((row) => row.validTime));
      if (!newest) {
        assertClaim(
          claim,
          false,
          `${response.url} returned ${parsed.rows.length} rows for ${yesterday}..${today} ` +
            "and not one of them carries a non-zero val_cargaglobal.",
        );
        throw new AssumptionExpiredError("unreachable");
      }
      const stamps = observed
        .map((row) => row.publishedAt)
        .filter((stamp): stamp is Date => stamp !== null);
      return {
        newestValidTime: newest,
        sourceStamp: newestOf(stamps),
        method:
          "two civil days of /cargaverificada for SECO, parsed with the platform's " +
          "adapter; newest valid_time carrying a non-zero val_cargaglobal, and the " +
          "newest row-level din_atualizacao beside it",
        detail: `${parsed.rows.length} half-hours, ${observed.length} of them observed`,
      };
    },
  },
  {
    dataset: "capacidade-geracao",
    label: "installed-capacity snapshot",
    claim: CAPACITY_CLAIM,
    probe: async () => {
      const claim = CAPACITY_CLAIM;
      const resources = await fetchPackage(CAPACITY_DATASET_SLUG);
      const resource = selectSingleResource(resources, ["CSV"]);
      const fingerprint = await headResource(resource.url);
      if (!fingerprint.lastModified) {
        assertClaim(
          claim,
          false,
          `HEAD ${resource.url} answered without a Last-Modified header, so the ` +
            "age of the snapshot — the only staleness this dataset has — cannot be " +
            "measured at all.",
        );
        throw new AssumptionExpiredError("unreachable");
      }
      return {
        // The snapshot's valid time *is* its publication: it asserts the fleet as
        // of the moment it was written, and there is no earlier hour in it.
        newestValidTime: fingerprint.lastModified,
        sourceStamp: fingerprint.lastModified,
        method:
          "HEAD on the single overwritten CSV; the file's own Last-Modified is " +
          "both its publication instant and the instant its content is valid at",
        detail: `${resource.url.split("/").pop()} (${fingerprint.contentLength ?? "?"} bytes)`,
      };
    },
  },
];

/** The latest of a list of instants, or null when it is empty. */
function newestOf(instants: readonly Date[]): Date | null {
  let newest: Date | null = null;
  for (const instant of instants) {
    if (!newest || instant.getTime() > newest.getTime()) {
      newest = instant;
    }
  }
  return newest;
}

/** `YYYY-MM-DD` of an instant in Brasília civil time. */
function brtDate(instant: Date): string {
  const local = zonedWallClock(instant, ONS_TIME_ZONE);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

/**
 * Closed months of the entity-grain wind file, pinned at their last observed
 * republication, and the window they cover.
 *
 * Measured 2026-08-29. The window opens where the platform's own modelling
 * window opens (`WINDOW_OPENS_ON`, 2024-04) and closes two months back, because
 * the current and previous months are rewritten on essentially every
 * publication cycle by design and pinning them would fire every day.
 *
 * `docs/research/ons-datasets.md` § "Coverage, cadence and revision behaviour"
 * records what these stamps are for: ONS runs **bulk re-publication campaigns**
 * that rewrite years of closed history at once — the whole of 2025 on
 * 2026-04-30/05-04, 2021–2022 in May 2024. Such a campaign is not guaranteed to
 * be a correction. One that changed the *definition* of the curtailment
 * quantity would teach the model a methodology break as a change in the grid,
 * and it would arrive as a silent re-ingest of rows that already exist.
 */
const PINNED_RESTATEMENTS: readonly (readonly [string, string])[] = [
  ["2024-04", "2025-02-13T18:26:47.018073"],
  ["2024-05", "2025-02-13T18:30:44.776171"],
  ["2024-06", "2025-02-24T17:59:12.671810"],
  ["2024-07", "2025-02-24T18:02:28.006105"],
  ["2024-08", "2025-02-13T18:40:41.737237"],
  ["2024-09", "2025-02-13T18:44:14.795705"],
  ["2024-10", "2025-02-13T18:48:27.781726"],
  ["2024-11", "2025-02-13T18:51:57.953394"],
  ["2024-12", "2025-02-13T18:55:46.672103"],
  ["2025-01", "2026-05-04T15:15:50.571172"],
  ["2025-02", "2026-05-04T15:20:05.718395"],
  ["2025-03", "2026-05-04T12:52:44.570333"],
  ["2025-04", "2026-05-04T12:55:44.211768"],
  ["2025-05", "2026-05-04T12:59:46.543445"],
  ["2025-06", "2026-05-04T13:03:25.292898"],
  ["2025-07", "2026-04-30T22:48:53.481714"],
  ["2025-08", "2026-04-30T22:51:18.368305"],
  ["2025-09", "2026-04-30T22:54:55.968510"],
  ["2025-10", "2026-04-30T22:11:12.754797"],
  ["2025-11", "2026-04-30T22:15:05.831278"],
  ["2025-12", "2026-04-30T22:18:50.336814"],
  ["2026-01", "2026-04-30T17:24:43.336903"],
  ["2026-02", "2026-04-30T17:28:59.884552"],
  ["2026-03", "2026-04-30T22:47:10.217331"],
  ["2026-04", "2026-05-31T22:41:30.732413"],
  ["2026-05", "2026-06-30T22:11:44.161265"],
  ["2026-06", "2026-07-31T22:10:27.511542"],
];

/** CKAN writes its stamps without a zone and means UTC. */
const ckanInstant = (raw: string): number => new Date(`${raw}Z`).getTime();

/** `YYYY-MM` of a monthly resource, from the filename CKAN gave us. */
function resourceMonth(resource: CatalogueResource): string | null {
  const match = /_(\d{4})_(\d{2})\.(csv|parquet)$/.exec(
    (resource.url.split("/").pop() ?? "").toLowerCase(),
  );
  return match ? `${match[1]}-${match[2]}` : null;
}

suite("publication-lag conformance — the spec's guesses, measured", () => {
  describe("every configured lag still covers the real one", () => {
    for (const source of LAG_CASES) {
      it(
        `${source.dataset} — ${source.label}`,
        measuring(`ONS — ${source.dataset}`, async () => {
          const configured = lagFor(source.dataset);
          const freshness = await source.probe();
          const now = new Date();
          const staleness = hoursBetween(freshness.newestValidTime, now);
          const atPublication = freshness.sourceStamp
            ? hoursBetween(freshness.newestValidTime, freshness.sourceStamp)
            : null;

          publish(`${source.dataset} — publication lag`, [
            `configured        : ${configured.hours} h  (canonical read '${configured.canonicalRead}')`,
            `newest valid_time : ${bothClocks(freshness.newestValidTime)}`,
            `source stamp      : ${
              freshness.sourceStamp ? bothClocks(freshness.sourceStamp) : "none published"
            }`,
            `lag at publication: ${
              atPublication === null ? "not measurable" : `${round(atPublication)} h`
            }`,
            `staleness now     : ${round(staleness)} h`,
            `headroom          : ${round(configured.hours - staleness)} h`,
            `method            : ${freshness.method}`,
            `read              : ${freshness.detail}`,
          ]);

          assertClaim(
            source.claim,
            staleness <= configured.hours,
            `the newest published valid_time is ${bothClocks(freshness.newestValidTime)}, ` +
              `which is ${round(staleness)} h old — past the ${configured.hours} h ` +
              `configured for '${source.dataset}'. A gate falling now would compute ` +
              `actuals_cutoff at gate − ${configured.hours} h and read rows that ONS ` +
              "has not published, so the feature values would differ between train " +
              "and serve. THE FIX IS A MIGRATION, NOT AN EDIT HERE: raise " +
              "publication_lag_hours for this dataset in a new migration, beside a " +
              "new feature-set version, and RETRAIN — loosening a lag moves the " +
              "cutoff, which moves every lag and trailing window behind it, which " +
              "changes the feature distribution the current model was fitted on. " +
              `Measured with: ${freshness.method}.`,
          );
        }),
        TIMEOUT_MS,
      );
    }
  });

  describe("the day-ahead programme — the open question this suite owns", () => {
    const EXISTS: Claim = {
      note: "docs/research/ons-datasets.md",
      section: "6 & 7. Carga de energia — verificada and programada",
      claim:
        "The carga API serves the programme for day D addressed as cod_areacarga=" +
        "SECO, in 48 half-hourly rows, and it is there on D−1. SE — the code every " +
        "other ONS dataset uses for the same subsystem — is not a member of this " +
        "API's enum and answers HTTP 200 with an empty array.",
      breaks:
        "programmed_load_mwh is the DESSEM-free set's spine and the base of the " +
        "whole proxy_* residual-load family. If the programme stops answering, or " +
        "starts answering for a different code, dessem_free_v1 has no spine and the " +
        "A/B has one arm.",
      code: "apps/api/src/ingest/ons/carga-api.ts and apps/api/src/ingest/ons/load.ts",
    };

    it(
      "still returns a full day of rows for the subsystem code the adapter uses",
      measuring("the ONS carga API — /cargaprogramada?cod_areacarga=SECO", async () => {
        const today = brtDate(new Date());
        const response = await fetchLoadRange({
          series: "PROGRAMMED",
          areaCode: "SECO",
          range: { from: today, to: today },
        });
        const parsed = parsing(EXISTS, () => parseProgrammedLoad(response.rows));
        assertClaim(
          EXISTS,
          parsed.rows.length > 0,
          `GET ${response.url} returned HTTP 200 with no usable row for ${today}, a ` +
            "day whose programme was published yesterday.",
        );
        // 48 half hours on a DST-free day; Brazil abolished DST in 2019 and the
        // window carries no transition, so a short day is a finding, not a case.
        assertClaim(
          EXISTS,
          parsed.rows.length === 48,
          `${today} came back as ${parsed.rows.length} half-hourly rows rather than 48.`,
        );
        const subsystems = new Set(parsed.rows.map((row) => row.subsystem));
        assertClaim(
          EXISTS,
          subsystems.size === 1 && subsystems.has("SE"),
          `SECO now resolves to [${[...subsystems].join(", ")}] rather than the single ` +
            "subsystem SE.",
        );

        // The silent-empty hazard, asked of the programme series specifically:
        // `SE` is not a LoadAreaCode, which is why this URL is built by hand.
        const url =
          `${CARGA_API_BASE}${SERIES_PATH.PROGRAMMED}` +
          `?dat_inicio=${today}&dat_fim=${today}&cod_areacarga=SE`;
        const raw = await (await get(url)).text();
        let rows: unknown;
        try {
          rows = JSON.parse(raw);
        } catch {
          rows = null;
        }
        assertClaim(
          EXISTS,
          Array.isArray(rows) && rows.length === 0,
          `cod_areacarga=SE now answers ${raw.slice(0, 120)}. If it started returning ` +
            "rows, two codes address the same subsystem and a double count is one " +
            "careless call away; if it started returning an error, the platform's " +
            "silent-empty detector is no longer the only guard.",
        );

        publish("day-ahead programme — rows for the addressed subsystem", [
          `reference day     : ${today} (BRT)`,
          `SECO              : ${parsed.rows.length} half-hours, subsystem ${[...subsystems].join(", ")}`,
          "SE                : HTTP 200, empty array (the documented silent hazard)",
          `derived published : ${bothClocks(programmePublishedAt(parsed.rows[0]?.validTime as Date) as Date)}`,
        ]);
      }),
      TIMEOUT_MS,
    );

    /**
     * The measurement this whole ticket exists for.
     *
     * `PROGRAMME_PUBLICATION_HOUR_BRT` is 15:00 BRT on D−1, and it is an
     * an inference: ONS's DESSEM file for day D is created on the evening of
     * D−1, DESSEM demand agrees with the programme to 0.03%, and a run cannot
     * consume a programme that does not exist — so the programme was published
     * by 14:48 BRT, rounded conservatively to 15:00. Nobody has ever watched
     * ONS publish it.
     *
     * The consequence of that inference is the largest open decision in the
     * spec: 15:00 is six hours after `gate_early` (D−1 09:00 BRT), so at the
     * early gate `programmed_load_mwh` is NULL, and with it every `proxy_*`
     * column — `dessem_free_v1` has no spine and no residual load at that gate
     * at all.
     *
     * The only instrument that settles it is **asking before 09:00 BRT**. A
     * run at any other hour tightens the upper bound and proves nothing about
     * the early gate, and this case says which of the two happened rather than
     * implying an answer it did not measure.
     */
    const TIMING: Claim = {
      note: "docs/research/publication-lag.md",
      section: "The day-ahead programme's publication instant",
      claim:
        "The programme for day D is published no later than D−1 15:00 BRT — the " +
        "constant PROGRAMME_PUBLICATION_HOUR_BRT, an upper bound inferred from " +
        "DESSEM's creation time rather than observed. It therefore clears gate_late " +
        "(D−1 19:00 BRT) and does not clear gate_early (D−1 09:00 BRT).",
      breaks:
        "The instant is written into published_at on every programmed row at ingest, " +
        "and every forecast-sourced feature is cut on published_at <= gate. Too late " +
        "and the DESSEM-free set is denied a spine it could have had at gate_early; " +
        "too early and the same features are a leak — rows entering a gate before " +
        "ONS published them.",
      code: "apps/api/src/ingest/ons/load.ts — PROGRAMME_PUBLICATION_HOUR_BRT",
    };

    it(
      "publishes when the programme for tomorrow actually became available",
      measuring("the ONS carga API — /cargaprogramada, one day ahead", async () => {
        const now = new Date();
        const local = zonedWallClock(now, ONS_TIME_ZONE);
        const nowHourBrt = local.hour + local.minute / 60;
        // The target date is tomorrow, so its gates fall today: gate_early at
        // 09:00 BRT and gate_late at 19:00 BRT of the current civil day.
        const target = brtDate(new Date(now.getTime() + 24 * MS_PER_HOUR));
        const response = await fetchLoadRange({
          series: "PROGRAMMED",
          areaCode: "SECO",
          range: { from: target, to: target },
        });
        const parsed = parsing(TIMING, () => parseProgrammedLoad(response.rows));
        const published = parsed.rows.length > 0;

        const clearsEarly = published && nowHourBrt <= GATE.early;
        const clearsLate = published && nowHourBrt <= GATE.late;
        const verdict = published
          ? clearsEarly
            ? `PUBLISHED BY ${round(nowHourBrt)} BRT — EARLIER THAN gate_early (${GATE.early}:00). gate_early IS VIABLE.`
            : `PUBLISHED BY ${round(nowHourBrt)} BRT. Upper bound tightened; gate_early (${GATE.early}:00) NOT SETTLED by this run — it ran too late in the day to ask the question.`
          : `NOT YET PUBLISHED AT ${round(nowHourBrt)} BRT. The programme for ${target} does not exist yet.`;

        publish("day-ahead programme — publication instant", [
          `target date        : ${target} (its gates fall today)`,
          `run instant        : ${bothClocks(now)}`,
          `configured instant : D−1 ${PROGRAMME_PUBLICATION_HOUR_BRT}:00 BRT (an inferred upper bound, not an observation)`,
          `gate_early         : D−1 ${GATE.early}:00 BRT`,
          `gate_late          : D−1 ${GATE.late}:00 BRT`,
          `programme present  : ${published ? `yes, ${parsed.rows.length} half-hours` : "no"}`,
          `clears gate_early  : ${published ? (clearsEarly ? "PROVEN" : "not proven by this run") : "no"}`,
          `clears gate_late   : ${published ? (clearsLate ? "PROVEN" : "not proven by this run") : "no"}`,
          `verdict            : ${verdict}`,
          "",
          "A run before 09:00 BRT is the only instrument that settles gate_early:",
          "the API carries no publication stamp, so presence at an instant is the",
          "whole of the evidence. The scheduled workflow runs at 11:00 UTC.",
        ]);

        // Direction 1 — the constant is too EARLY, which is a leak. If the
        // configured instant has passed and the programme is still not there,
        // then rows are being stamped as published before ONS published them.
        assertClaim(
          TIMING,
          published || nowHourBrt < PROGRAMME_PUBLICATION_HOUR_BRT,
          `it is ${round(nowHourBrt)}:00 BRT — past the configured ${PROGRAMME_PUBLICATION_HOUR_BRT}:00 — ` +
            `and /cargaprogramada still has nothing for ${target}. Every programmed row ` +
            `for ${target} will nonetheless be stamped published at ${PROGRAMME_PUBLICATION_HOUR_BRT}:00 BRT on ` +
            "D−1, so a feature cut on published_at <= gate_late would admit a " +
            "programme that did not exist at the gate. That is a leak, and it is the " +
            "expensive direction: re-measure the real instant, move " +
            "PROGRAMME_PUBLICATION_HOUR_BRT later, RE-INGEST the series (the instant " +
            "is written into the fact, not applied at read time) and retrain.",
        );

        // Direction 2 — the constant is too LATE, which costs the early gate.
        // Observing the programme at or before gate_early proves the bound is
        // wrong by at least six hours *and* that dessem_free_v1 can have its
        // spine at gate_early. It is good news, and it fails the run because it
        // is exactly as actionable as the bad news.
        assertClaim(
          TIMING,
          !clearsEarly,
          `the programme for ${target} was already served at ${round(nowHourBrt)}:00 BRT — ` +
            `at or before gate_early (${GATE.early}:00 BRT). The configured instant of ` +
            `${PROGRAMME_PUBLICATION_HOUR_BRT}:00 is provably at least ` +
            `${round(PROGRAMME_PUBLICATION_HOUR_BRT - nowHourBrt)} h too late, and the ` +
            "consequence is not a rounding error: programmed_load_mwh and the entire " +
            "proxy_* residual-load family are NULL at gate_early only because of it, " +
            "so the DESSEM-free set currently has no spine at the early gate and the " +
            "A/B's early arm is weather and lags alone. THIS IS THE FINDING THE " +
            "TICKET WAS OPENED FOR. Move PROGRAMME_PUBLICATION_HOUR_BRT to the hour " +
            "measured here, re-ingest carga-energia-programada so the new instant is " +
            "written into published_at, rebuild both feature sets and retrain — the " +
            "early-gate feature distribution changes from all-NULL to a real column.",
        );
      }),
      TIMEOUT_MS,
    );

    const AGREEMENT: Claim = {
      note: "docs/research/ons-datasets.md",
      section: "10 & 11. DESSEM — balanço de energia",
      claim:
        "DESSEM val_demanda and the carga API's programmed load are the same " +
        "quantity for the same subsystem-day, agreeing to 0.03% — which is what " +
        "makes num_patamar k the half hour ending k×30 min BRT, and what makes the " +
        "programme a usable stand-in for DESSEM demand over the long window.",
      breaks:
        "The DESSEM-free set's spine rests on these two being the same statement. " +
        "A divergence is evidence that one of them changed meaning, and the " +
        "patamar↔wall-clock mapping — an empirical inference from a single day — " +
        "is the first thing it would falsify.",
      code: "apps/api/src/ingest/ons/dessem-balance.ts and apps/api/src/ingest/ons/load.ts",
    };

    it(
      "still agrees with DESSEM demand for the same subsystem-day",
      measuring("ONS — balanco_dessem_detalhe against /cargaprogramada", async () => {
        // Yesterday: recent enough to be the live regime, settled enough that
        // both artefacts exist for the whole day.
        const day = brtDate(new Date(Date.now() - 24 * MS_PER_HOUR));
        const [year, month, date] = day.split("-").map(Number) as [
          number,
          number,
          number,
        ];
        const resources = await fetchPackage(DESSEM_DETAIL_DATASET_SLUG);
        const resource = selectResourceForDay(resources, year, month, date, ["CSV"]);
        const text = await (await get(resource.url)).text();
        const dessem = parsing(AGREEMENT, () => parseDessemBalanceCsv(text));

        const response = await fetchLoadRange({
          series: "PROGRAMMED",
          areaCode: "SECO",
          range: { from: day, to: day },
        });
        const programme = parsing(AGREEMENT, () => parseProgrammedLoad(response.rows));

        // DESSEM publishes MW; the programme adapter converts MWmed over a half
        // hour to MWh, so it doubles back to MW. Comparing the two without this
        // would report a 100% divergence and blame the wrong thing.
        const programmed = new Map(
          programme.rows.map((row) => [
            row.validTime.getTime(),
            row.programmedLoadMwh * 2,
          ]),
        );
        const deviations: number[] = [];
        let worst = { at: "", deviation: 0, dessem: 0, programme: 0 };
        for (const row of dessem.rows) {
          if (row.subsystem !== "SE") {
            continue;
          }
          const mirror = programmed.get(row.validTime.getTime());
          if (mirror === undefined || mirror === 0) {
            continue;
          }
          const deviation = Math.abs(row.demandMw - mirror) / mirror;
          deviations.push(deviation);
          if (deviation > worst.deviation) {
            worst = {
              at: row.validTime.toISOString(),
              deviation,
              dessem: row.demandMw,
              programme: mirror,
            };
          }
        }

        assertClaim(
          AGREEMENT,
          deviations.length >= 40,
          `only ${deviations.length} of the day's half hours could be matched between ` +
            `${resource.url.split("/").pop()} and /cargaprogramada for ${day}. The two ` +
            "no longer describe the same 48 half hours, which falsifies the patamar " +
            "mapping before it says anything about the values.",
        );
        const mean =
          deviations.reduce((sum, value) => sum + value, 0) / deviations.length;

        publish("DESSEM demand against programmed load", [
          `subsystem-day     : SE / SECO, ${day}`,
          `half hours matched: ${deviations.length}`,
          `mean deviation    : ${round(mean * 100, 4)} %`,
          `worst deviation   : ${round(worst.deviation * 100, 4)} % at ${worst.at} ` +
            `(DESSEM ${round(worst.dessem)} MW vs programme ${round(worst.programme)} MW)`,
          "research recorded : 0.03 %",
        ]);

        // An order of magnitude above the recorded agreement, and still well
        // below anything a revision or a rounding change would produce. A
        // divergence at this scale is a change of meaning, not of value.
        assertClaim(
          AGREEMENT,
          mean <= 0.005,
          `the two series now differ by ${round(mean * 100, 4)}% on average over ${day} ` +
            `(worst ${round(worst.deviation * 100, 4)}% at ${worst.at}), against the ` +
            "0.03% the research measured. One of them changed meaning: either DESSEM's " +
            "val_demanda is no longer the same demand the programme states, or the " +
            "patamar↔wall-clock mapping — inferred from a single day and never " +
            "documented by ONS — has moved.",
        );
      }),
      TIMEOUT_MS,
    );
  });

  describe("the things that are asserted rather than modelled", () => {
    const RESTATEMENT: Claim = {
      note: "docs/research/ons-datasets.md",
      section: "Coverage, cadence and revision behaviour (all four)",
      claim:
        "Closed months of the constrained-off files stay closed between bulk " +
        "re-publication campaigns. The months pinned in this suite carry the " +
        "last_modified they carried when they were pinned.",
      breaks:
        "The labels. A campaign rewrites months the platform has already ingested " +
        "and trained on; the bitemporal store absorbs it as a new version without " +
        "comment, which is correct storage and silent modelling. If the campaign " +
        "changed the definition of the curtailment quantity rather than correcting " +
        "values, the model learns a methodology break as a change in the grid.",
      code: "apps/api/src/ingest/ons/constrained-off.ts and apps/api/src/ingest/versioned-write.ts",
    };

    it(
      "surfaces a bulk restatement of closed months rather than absorbing it",
      measuring(`ONS CKAN — ${WIND_DATASET_SLUG}`, async () => {
        const resources = await fetchPackage(WIND_DATASET_SLUG);
        const published = new Map<string, CatalogueResource>();
        for (const resource of resources) {
          const month = resourceMonth(resource);
          if (month && resource.format === "CSV") {
            published.set(month, resource);
          }
        }

        const moved: string[] = [];
        const gone: string[] = [];
        for (const [month, pinned] of PINNED_RESTATEMENTS) {
          const resource = published.get(month);
          if (!resource?.lastModified) {
            gone.push(month);
            continue;
          }
          if (resource.lastModified.getTime() !== ckanInstant(pinned)) {
            moved.push(
              `${month}: pinned ${pinned}Z, now ${resource.lastModified.toISOString()}`,
            );
          }
        }
        // Months that closed since the pins were taken are not a failure — they
        // are the next re-pin. Naming them keeps the coverage of this check
        // visible instead of letting it decay quietly.
        const unpinned = [...published.keys()]
          .filter((month) => month >= "2024-04")
          .filter((month) => !PINNED_RESTATEMENTS.some(([pinned]) => pinned === month))
          .toSorted();

        publish("closed-month restatements", [
          `months pinned     : ${PINNED_RESTATEMENTS.length} (2024-04 .. 2026-06, the modelling window)`,
          `months restated   : ${moved.length}`,
          `months absent     : ${gone.length}`,
          `not yet pinned    : ${unpinned.join(", ") || "none"} — the current and previous months are rewritten every cycle by design`,
        ]);

        assertClaim(
          RESTATEMENT,
          gone.length === 0,
          `${gone.join(", ")} no longer exist as CSV resources in the package. A month ` +
            "the platform has ingested has been withdrawn.",
        );
        assertClaim(
          RESTATEMENT,
          moved.length === 0,
          `ONS has republished ${moved.length} closed month(s) of curtailment: ` +
            `${moved.join("; ")}. Re-ingest them and compare the values before ` +
            "trusting the model that was trained on the old ones — a campaign that " +
            "corrected values is a retrain, and one that changed the definition of " +
            "the quantity is a relabelling. Then re-pin PINNED_RESTATEMENTS in this " +
            "file with the new stamps, in the same commit as the note that says which " +
            "of the two it was.",
        );
      }),
      TIMEOUT_MS,
    );

    const PAR: Claim = {
      note: "docs/research/ons-datasets.md",
      section: "Restriction reason codes — confirmed",
      claim:
        "PAR — restriction stated in the access opinion — is a documented member of " +
        "cod_razaorestricao added on 2024-04-11 and has been observed zero times in " +
        "any month scanned. It is a monitoring signal, not a class.",
      breaks:
        "The three reason-share features are ENE, CNF and REL. PAR has no share " +
        "column and stays in the denominator, so the day it first appears the three " +
        "shares stop summing to one — silently, in a live feature, with nothing in " +
        "the row saying why.",
      code: "apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql — observed_reason_share_*",
    };

    it(
      "raises the first appearance of the PAR reason code",
      measuring(
        "ONS — the current month of constrained-off, both technologies",
        async () => {
          const [wind, solar] = await Promise.all([
            windCurtailment(),
            solarCurtailment(),
          ]);
          const counts = new Map<string, number>();
          let withCause = 0;
          for (const parse of [wind.parse, solar.parse]) {
            for (const row of parse.rows) {
              if (!row.cause) {
                continue;
              }
              withCause += 1;
              counts.set(row.cause.reason, (counts.get(row.cause.reason) ?? 0) + 1);
            }
          }
          const par = counts.get("PAR") ?? 0;

          publish("restriction reason codes, current month", [
            `wind file         : ${wind.resource.url.split("/").pop()}`,
            `solar file        : ${solar.resource.url.split("/").pop()}`,
            `entity-hours with a cause: ${withCause}`,
            `ENE / CNF / REL / PAR    : ${counts.get("ENE") ?? 0} / ${counts.get("CNF") ?? 0} / ${counts.get("REL") ?? 0} / ${par}`,
          ]);

          assertClaim(
            PAR,
            par === 0,
            `PAR appears ${par} time(s) this month, for the first time in any month ` +
              "WattSteer has scanned. Decide what it is before the next retrain: a " +
              "fourth share column, a fold into an existing one, or a deliberate " +
              "exclusion — and note that until that decision lands, " +
              "observed_reason_share_ene_7d + _cnf_7d + _rel_7d no longer sum to one " +
              "for the affected subsystem-days.",
          );
        },
      ),
      TIMEOUT_MS,
    );

    const DEACTIVATION: Claim = {
      note: "docs/research/plant-registry.md",
      section:
        "5. Snapshot, not history — (b) Decommissioning invisibility, empirically zero for VRE in this window",
      claim:
        "ONS records exactly three VRE deactivations in capacidade-geracao — three " +
        "units of BELMONTE 1-1, stamped 2023-05-03 — and none on or after the " +
        "modelling window opens on 2024-04-01. Capacity weighting therefore treats " +
        "deactivation as impossible inside the window.",
      breaks:
        "The capacity denominator behind both realised capacity factors and the " +
        "weather features' capacity weights. A within-window deactivation makes the " +
        "weighting silently wrong for every hour after it, and the ingest refuses " +
        "the file rather than writing it — so this fires before an operator meets it " +
        "as a failed daily refresh.",
      code: "apps/api/src/ingest/ons/plant-registry.ts — findRenewableDeactivations",
    };

    it(
      "raises a deactivation date becoming non-null for any VRE unit",
      measuring(`ONS — ${CAPACITY_DATASET_SLUG}`, async () => {
        const resources = await fetchPackage(CAPACITY_DATASET_SLUG);
        const resource = selectSingleResource(resources, ["CSV"]);
        const text = await (await get(resource.url)).text();
        // The parser throws on a within-window deactivation by design; this
        // suite wants to *report* it, so the escape hatch is taken and the
        // check is run explicitly.
        const registry = parsing(DEACTIVATION, () =>
          parseCapacityRegistryCsv(text, { allowRenewableDeactivations: true }),
        );
        const deactivations = findRenewableDeactivations(registry.units);
        const everDeactivated = registry.units.filter((unit) => unit.decommissionedOn);

        publish("VRE deactivations in the registry", [
          `file              : ${resource.url.split("/").pop()}`,
          `VRE units         : ${registry.units.length} across ${registry.plants.length} plants`,
          `with any deactivation date : ${everDeactivated.length}`,
          `inside the modelling window: ${deactivations.length}`,
        ]);

        assertClaim(
          DEACTIVATION,
          deactivations.length === 0,
          `capacidade-geracao now records ${deactivations.length} VRE deactivation(s) ` +
            "on or after the window opens: " +
            deactivations
              .slice(0, 5)
              .map(
                (unit) =>
                  `${unit.plantCegCore}/${unit.equipmentCode} on ` +
                  `${unit.decommissionedOn.toISOString().slice(0, 10)} (${unit.ratedPowerMw} MW)`,
              )
              .join("; ") +
            ". The daily registry refresh is already refusing this file. Capacity " +
            "weighting has to model decommissioning, or the assertion has to be " +
            "narrowed deliberately, before the fleet denominator can be trusted again.",
        );
      }),
      TIMEOUT_MS,
    );
  });
});
