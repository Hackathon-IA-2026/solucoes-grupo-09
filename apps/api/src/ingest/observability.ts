import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import type { PayloadArchive } from "./archive.js";
import { type CustodySummary, readCustodySummary } from "./custody.js";
import { CAMPAIGN_MIN_RESOURCES, CAMPAIGN_MIN_SETTLED_DAYS } from "./refresh.js";
import type { IngestionSource } from "./tasks.js";

/**
 * The per-source view — freshness, volume, last successful run, and the joins.
 *
 * **The failure mode this exists for is silence.** A source that quietly stops
 * updating does not throw: the sweep keeps running, every `HEAD` keeps saying
 * "unchanged", every run is recorded successful, and the data ages. So
 * freshness is measured against the *facts* — the newest thing the source has
 * said — and not against whether the job ran. A green run log over a stale
 * table is exactly the state that must be visible, and it is the one a run log
 * alone cannot show.
 *
 * **The registry joins are in here for the same reason.** `ons_plant_code` is
 * recovered from a bridge file, and the SIGA join is on a CEG whose version
 * segment has to be stripped for it to match at all. If a rename upstream drops
 * the match rate from 98% to 12%, nothing errors — capacity weights simply
 * start covering a twelfth of the fleet. A rate on a dashboard is the only
 * place that shows up.
 */

/** How a source's freshness is judged. */
type FreshnessBasis =
  /** The newest fact time — right for an observation series. */
  | "valid_time"
  /**
   * The newest ingest time — right for a forecast, whose `valid_time` is in the
   * future by construction, and for the registry, whose valid time is a
   * commissioning date rather than a publication clock.
   */
  | "ingested_at"
  /**
   * The last time the source was **read successfully**, from `ingestion_run`.
   *
   * For a source with no period whose content is usually identical. ONS
   * rewrites `capacidade-geracao` and `usina_conjunto` daily and ANEEL rewrites
   * the SIGA extract daily, but the fleet itself changes rarely — and
   * `versioned-write.ts` writes nothing for a key whose digest is unchanged,
   * which is right: a bitemporal record must not store a second vintage of
   * identical values. So `max(ingested_at)` on those tables is *when the fleet
   * last changed*, not *when we last looked*, and judging freshness by it makes
   * a healthy source read as stale forever. Measured on 2026-09-22:
   * `/ingest/health` answered 503 with `lagHours: 139.8` for `plant_registry`
   * while the job had run 27 minutes earlier, reported `ok`, and both upstream
   * objects had been rewritten that afternoon.
   *
   * It answers a different question from the other two, and the row keeps all
   * three: `latestValidTime` and `latestIngestedAt` stay on it, so "has the
   * content moved" is still there to be asked. What this basis says is only
   * that the fetch is working — and `republications30d` beside it is what would
   * show an upstream that went quiet while we went on reading the same bytes.
   */
  | "last_read";

interface SourceHealthSpec {
  source: IngestionSource;
  table: string;
  /** Extra predicate where one table serves two sources. */
  where?: string;
  basis: FreshnessBasis;
  /**
   * The column holding the fact's valid time. Named per table because the
   * registry's is `commissioned_on` — the day the unit exists from, which is
   * what `valid_time` means for a table whose grain is a fleet snapshot.
   */
  validTimeColumn?: string;
  /**
   * How far behind `now` the basis may fall before the source is stale.
   * Derived from the published cadence plus slack: ONS updates the bulk files
   * twice daily, so two days of silence is a real signal rather than a late
   * afternoon.
   */
  toleranceHours: number;
}

/**
 * Every ingested source, and what "fresh" means for each.
 *
 * The count is not in this sentence on purpose. It used to be — a spelled-out
 * number four short of the table it sat over — while the worker's boot banner
 * claimed a third figure. Three places carrying one number, two of them wrong,
 * and nothing that could notice. `TRACKED_SOURCES` below is the count,
 * derived; prose that wants to state it reads it from there, and
 * `test/repo-hygiene.test.ts` holds both halves of that rule.
 */
const SOURCES: SourceHealthSpec[] = [
  {
    source: "energy_balance",
    table: "subsystem_energy_balance_hour",
    basis: "valid_time",
    toleranceHours: 48,
  },
  {
    source: "constrained_off_wind",
    table: "curtailment_report_hour",
    where: "technology = 'WIND'",
    basis: "valid_time",
    toleranceHours: 72,
  },
  {
    source: "constrained_off_solar",
    table: "curtailment_report_hour",
    where: "technology = 'SOLAR'",
    basis: "valid_time",
    toleranceHours: 72,
  },
  {
    // The plant grain of the same two datasets, and a separate freshness
    // question: the `_detail` files can stop while the entity-grain files keep
    // publishing, and this is the row that would say so. Same tolerance,
    // because it is the same publication cadence.
    source: "constrained_off_wind_detail",
    table: "plant_detail_hour",
    where: "technology = 'WIND'",
    basis: "valid_time",
    toleranceHours: 72,
  },
  {
    source: "constrained_off_solar_detail",
    table: "plant_detail_hour",
    where: "technology = 'SOLAR'",
    basis: "valid_time",
    toleranceHours: 72,
  },
  {
    source: "interchange",
    table: "subsystem_exchange_hour",
    basis: "valid_time",
    toleranceHours: 48,
  },
  {
    source: "daily_load",
    table: "subsystem_load_day",
    basis: "valid_time",
    toleranceHours: 72,
  },
  {
    source: "dessem_balance",
    table: "dessem_balance_half_hour",
    basis: "ingested_at",
    toleranceHours: 36,
  },
  {
    source: "dessem_general",
    table: "dessem_general_half_hour",
    basis: "ingested_at",
    toleranceHours: 36,
  },
  {
    // The three day-ahead programme datasets: forecasts, so freshness is judged
    // on the ingest clock, at the DESSEM tolerance for the same reason — one
    // file a day, published the evening before.
    source: "programmed_generation",
    table: "programmed_generation_half_hour",
    basis: "ingested_at",
    toleranceHours: 36,
  },
  {
    source: "programmed_vs_forecast",
    table: "programmed_vs_forecast_half_hour",
    basis: "ingested_at",
    toleranceHours: 36,
  },
  {
    source: "controlled_flow",
    table: "controlled_flow_half_hour",
    basis: "ingested_at",
    toleranceHours: 36,
  },
  {
    source: "verified_load",
    table: "verified_load_half_hour",
    basis: "valid_time",
    toleranceHours: 48,
  },
  {
    source: "programmed_load",
    table: "programmed_load_half_hour",
    basis: "ingested_at",
    toleranceHours: 36,
  },
  {
    source: "plant_registry",
    table: "generating_unit",
    validTimeColumn: "commissioned_on",
    // See `last_read`: this table's `ingested_at` moves when the *fleet*
    // changes, and the fleet is stable for weeks at a time.
    basis: "last_read",
    toleranceHours: 48,
  },
  {
    source: "siga",
    table: "plant_geo",
    // `observed_on` is the snapshot a *belief began* in and deliberately does
    // not move when a later extract restates the same location, so it is the
    // wrong clock to judge freshness by — a fleet whose coordinates are stable
    // would read as years stale.
    //
    // `ingested_at` was the answer to that and has the same defect one step
    // along: an unchanged key writes no row, so it is also a clock that stops
    // when the fleet does. The honest one is when the read last succeeded.
    validTimeColumn: "observed_on",
    basis: "last_read",
    toleranceHours: 48,
  },
  {
    source: "weather",
    table: "weather_forecast_hour",
    // A forecast's `valid_time` is in the future by construction, so freshness
    // is the ingest clock here for the same reason it is for DESSEM. Twenty-six
    // hours is two run cycles plus publication slack: one missed run is a late
    // afternoon, two consecutive misses is the source having gone quiet.
    basis: "ingested_at",
    toleranceHours: 26,
  },
];

/**
 * One source's freshness, and nothing about the runs behind it.
 *
 * Split out of `SourceHealth` because `/v1/meta` needs exactly these five
 * fields and none of the rest: the run log, the custody summary and the join
 * rates are `GET /ingest/health`'s business, and a meta endpoint that computed
 * them would be doing four extra table scans to answer a question nobody asked
 * it. Splitting the *type* is what let the read be split without the source
 * table being written down twice.
 */
export interface SourceFreshness {
  source: IngestionSource;
  /**
   * Fact rows stored, all versions — the volume an operator recognises.
   *
   * `null` when the caller did not ask for it. Counting is an exact `count(*)`
   * per source and no index answers one, so it is a full scan of every fact
   * table — and after a forced history sweep those tables are tens of millions
   * of rows. `/v1/meta` was paying for seventeen of those scans in series and
   * publishing none of them: `toFreshness` carries the source, the two instants
   * and the lag, and never this. Measured on production 2026-09-24, that made
   * `/v1/meta` take 38.9 s against `/v1/grid/now`'s 1.2 s — and `/v1/meta` is
   * the read every screen waits for before it can name a lane, so the Time
   * Machine sat on its default day for as long as the scan ran.
   */
  rows: number | null;
  /** Newest fact time. Ahead of `now` for a forecast, by design. */
  latestValidTime: Date | null;
  /** When the newest row was learned. */
  latestIngestedAt: Date | null;
  /** Hours behind `now` on the basis this source is judged by. */
  lagHours: number | null;
  toleranceHours: number;
  /**
   * True when the source has gone quiet — the lag exceeds tolerance, or nothing
   * has ever been ingested. This is the flag that turns silence into an alert.
   */
  stale: boolean;
}

/** One source's line in the view. */
export interface SourceHealth extends SourceFreshness {
  lastRunAt: Date | null;
  lastRunStatus: "running" | "ok" | "failed" | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  /** Failed runs in the last 24 hours. */
  failedRuns24h: number;
  /** Re-publications of this source's files in the last 30 days. */
  republications30d: number;
}

/** How well the registry's identifiers actually join. */
export interface RegistryJoinRates {
  /** Plants that acquired an ONS code from the conjunto bridge. */
  plantOnsCode: { matched: number; total: number; rate: number | null };
  /** Bridge memberships whose plant resolves to a registry plant by CEG. */
  membershipPlant: { matched: number; total: number; rate: number | null };
  /** Settlement entities that resolve to a conjunto or a plant. */
  reportingEntity: { matched: number; total: number; rate: number | null };
}

/** Re-publication activity, summarised. */
export interface RepublicationHealth {
  last30d: number;
  /** Of those, ones that had stood settled long enough to matter. */
  settledLast30d: number;
  latestAt: Date | null;
  /** True when the settled count alone would constitute a campaign. */
  campaignSuspected: boolean;
}

export interface IngestionHealth {
  generatedAt: Date;
  sources: SourceHealth[];
  archive: CustodySummary;
  republications: RepublicationHealth;
  registryJoins: RegistryJoinRates;
}

const MS_PER_HOUR = 3_600_000;

function rate(matched: number, total: number): number | null {
  return total === 0 ? null : Number((matched / total).toFixed(4));
}

function toDate(value: unknown): Date | null {
  return value ? new Date(String(value)) : null;
}

/**
 * How many sources are tracked, and the one place that knows.
 *
 * Exported for the worker's boot banner, which an operator reads to confirm
 * what the process came up with. A literal there drifted by ten without
 * anything failing: nothing renders it, no route returns it, and a number in a
 * `console.log` is invisible to every guard in this repository.
 */
export const TRACKED_SOURCES = SOURCES.length;

/**
 * The sources ONS publishes, which is all of them but the weather feed.
 *
 * Named separately because the banner says "ONS ingestion" and the weather
 * source is not ONS's — a count that swept it in would be a small false claim
 * in the one line an operator reads to check the deployment.
 */
export const ONS_SOURCES = SOURCES.filter((spec) => spec.source !== "weather").length;

/**
 * Per-source freshness, and nothing else.
 *
 * The read behind `/v1/meta`'s `data.freshness` block, and the first half of
 * `GET /ingest/health`'s. One function rather than two because the
 * sources and what "fresh" means for each are a single table — `SOURCES` above
 * — and a second copy of it in the meta route is exactly how the two surfaces
 * would come to disagree about whether the weather feed is late.
 */
export async function readSourceFreshness(
  db: Database,
  options: {
    now?: Date;
    /**
     * Whether to count the rows. `/ingest/health` wants the number — it is the
     * volume an operator recognises — and `/v1/meta` does not publish it, so it
     * asks for the instants alone. See {@link SourceFreshness.rows}.
     */
    countRows?: boolean;
  } = {},
): Promise<SourceFreshness[]> {
  const now = options.now ?? new Date();
  const countRows = options.countRows ?? true;
  /*
    The last successful read per source, for the `last_read` basis — one query
    for the whole table rather than one per source, and only when some spec
    asks for it, so a deployment whose specs are all content-based pays nothing.
  */
  const lastRead = new Map<string, Date | null>();
  if (SOURCES.some((spec) => spec.basis === "last_read")) {
    const reads = await db.execute<{
      source: string;
      last_success_at: string | null;
    }>(sql`
      select source, max(started_at) as last_success_at
      from ingestion_run
      where status = 'ok'
      group by source
    `);
    for (const row of reads) {
      lastRead.set(row.source, toDate(row.last_success_at));
    }
  }
  const freshness: SourceFreshness[] = [];
  for (const spec of SOURCES) {
    /*
      The count is its own column rather than its own query because when it is
      wanted the scan happens anyway; what matters is that it is *absent* when
      it is not, since `max()` reads an index and `count(*)` cannot.
    */
    const [facts] = await db.execute<{
      rows: number | null;
      latest_valid: string | null;
      latest_ingested: string | null;
    }>(sql`
      select
        ${countRows ? sql`count(*)::int` : sql`null::int`} as rows,
        max(${sql.identifier(spec.validTimeColumn ?? "valid_time")}) as latest_valid,
        max(ingested_at) as latest_ingested
      from ${sql.identifier(spec.table)}
      ${spec.where ? sql`where ${sql.raw(spec.where)}` : sql``}
    `);

    const latestValidTime = toDate(facts?.latest_valid);
    const latestIngestedAt = toDate(facts?.latest_ingested);
    const basis =
      spec.basis === "valid_time"
        ? latestValidTime
        : spec.basis === "last_read"
          ? (lastRead.get(spec.source) ?? null)
          : latestIngestedAt;
    const lagHours =
      basis === null
        ? null
        : Math.round(((now.getTime() - basis.getTime()) / MS_PER_HOUR) * 10) / 10;

    freshness.push({
      source: spec.source,
      rows: countRows ? Number(facts?.rows ?? 0) : null,
      latestValidTime,
      latestIngestedAt,
      lagHours,
      toleranceHours: spec.toleranceHours,
      // Never ingested is stale, not unknown: a source that has produced
      // nothing is exactly as useless as one that stopped.
      stale: lagHours === null || lagHours > spec.toleranceHours,
    });
  }
  return freshness;
}

/**
 * Read the whole view in one call.
 *
 * Deliberately a handful of aggregates rather than a materialised view: it is
 * read by a human or a monitor a few times an hour, the counts are index-only
 * or sequential over tables the platform already scans, and a stale
 * materialisation of a freshness view would be a joke told at the operator's
 * expense.
 */
export async function readIngestionHealth(
  db: Database,
  archive: PayloadArchive | undefined,
  options: { now?: Date } = {},
): Promise<IngestionHealth> {
  const now = options.now ?? new Date();

  const runs = await db.execute<{
    source: IngestionSource;
    last_run_at: string | null;
    last_run_status: "running" | "ok" | "failed";
    last_success_at: string | null;
    last_error: string | null;
    failed_24h: number;
    republications_30d: number;
  }>(sql`
    select distinct on (source)
      source,
      started_at as last_run_at,
      status as last_run_status,
      max(started_at) filter (where status = 'ok') over (partition by source)
        as last_success_at,
      error_message as last_error,
      count(*) filter (where status = 'failed' and started_at > ${new Date(
        now.getTime() - 24 * MS_PER_HOUR,
      ).toISOString()}::timestamptz) over (partition by source)::int as failed_24h,
      coalesce(sum(republications) filter (where started_at > ${new Date(
        now.getTime() - 30 * 24 * MS_PER_HOUR,
      ).toISOString()}::timestamptz) over (partition by source), 0)::int
        as republications_30d
    from ingestion_run
    order by source, started_at desc
  `);
  const runBySource = new Map(runs.map((row) => [row.source, row]));

  const sources: SourceHealth[] = [];
  for (const freshness of await readSourceFreshness(db, { now })) {
    const run = runBySource.get(freshness.source);

    sources.push({
      ...freshness,
      lastRunAt: toDate(run?.last_run_at),
      lastRunStatus: run?.last_run_status ?? null,
      lastSuccessAt: toDate(run?.last_success_at),
      lastError: run?.last_error ?? null,
      failedRuns24h: Number(run?.failed_24h ?? 0),
      republications30d: Number(run?.republications_30d ?? 0),
    });
  }

  const [republications] = await db.execute<{
    last_30d: number;
    settled_30d: number;
    latest_at: string | null;
  }>(sql`
    select
      count(*)::int as last_30d,
      count(*) filter (where settled_days >= ${CAMPAIGN_MIN_SETTLED_DAYS})::int
        as settled_30d,
      max(detected_at) as latest_at
    from resource_republication
    where detected_at > ${new Date(
      now.getTime() - 30 * 24 * MS_PER_HOUR,
    ).toISOString()}::timestamptz
  `);

  const [joins] = await db.execute<{
    plants: number;
    plants_with_code: number;
    memberships: number;
    memberships_matched: number;
    entities: number;
    entities_matched: number;
  }>(sql`
    select
      (select count(*) from plant)::int as plants,
      (select count(*) from plant where ons_plant_code is not null)::int
        as plants_with_code,
      (select count(distinct (plant_ons_code, conjunto_code, member_from))
         from conjunto_membership)::int as memberships,
      (select count(distinct (m.plant_ons_code, m.conjunto_code, m.member_from))
         from conjunto_membership m
         join plant p on p.ceg_core = m.plant_ceg_core)::int as memberships_matched,
      (select count(*) from reporting_entity)::int as entities,
      (select count(*) from reporting_entity e
         where (e.kind = 'CONJUNTO'
                and exists (select 1 from conjunto c where c.ons_conjunto_code = e.ons_code))
            or (e.kind = 'PLANT'
                and exists (select 1 from plant p where p.ceg_core = e.ceg_core)))::int
        as entities_matched
  `);

  const plants = Number(joins?.plants ?? 0);
  const memberships = Number(joins?.memberships ?? 0);
  const entities = Number(joins?.entities ?? 0);
  const plantsWithCode = Number(joins?.plants_with_code ?? 0);
  const membershipsMatched = Number(joins?.memberships_matched ?? 0);
  const entitiesMatched = Number(joins?.entities_matched ?? 0);

  return {
    generatedAt: now,
    sources,
    archive: await readCustodySummary(db, archive),
    republications: {
      last30d: Number(republications?.last_30d ?? 0),
      settledLast30d: Number(republications?.settled_30d ?? 0),
      latestAt: toDate(republications?.latest_at),
      campaignSuspected:
        Number(republications?.settled_30d ?? 0) >= CAMPAIGN_MIN_RESOURCES,
    },
    registryJoins: {
      plantOnsCode: {
        matched: plantsWithCode,
        total: plants,
        rate: rate(plantsWithCode, plants),
      },
      membershipPlant: {
        matched: membershipsMatched,
        total: memberships,
        rate: rate(membershipsMatched, memberships),
      },
      reportingEntity: {
        matched: entitiesMatched,
        total: entities,
        rate: rate(entitiesMatched, entities),
      },
    },
  };
}
