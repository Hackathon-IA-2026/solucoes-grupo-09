import { Elysia, t } from "elysia";
import {
  CANONICAL_BASE_PATH,
  CANONICAL_READS,
  canonicalReadPath,
  readConjuntoMembership,
  readCurtailment,
  readDayAheadBalance,
  readInstalledCapacity,
  readPlantMeasurements,
  readSystemContext,
  readSystemExchange,
  readTrainingWindow,
  readWeatherForecast,
} from "../contract/index.js";
import { toWire } from "../contract/wire.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { BadInputError, BusyError } from "../errors.js";

/**
 * `GET /v1/canonical/*` — the canonical read contract, over HTTP.
 *
 * This is the surface the modelling side consumes, and the reason it exists in
 * front of `src/contract/` rather than being left as an in-process module: the
 * modelling side is Python, and a TypeScript function is not a contract it can
 * hold. Everything the routes do is shape and vintage — the reads themselves
 * live in `src/contract/reads.ts` and compose the repositories, so no query is
 * written twice.
 *
 * Three properties are worth stating because they are the ticket's acceptance
 * criteria and they are enforced here rather than documented:
 *
 * - **Every response carries its `vintage` receipt**, with the
 *   `vintage_fidelity` inside it. There is no shape of this API that returns
 *   rows without one, so a consumer cannot accidentally treat a
 *   revision-optimistic window as point-in-time.
 * - **`as_of` is required on every read.** Not defaulted to `now`: a default
 *   would let a caller who never thought about vintage get an answer that looks
 *   authoritative, which is the failure mode `AsOf` exists to prevent.
 * - **Nothing here writes.** The reads run inside a `READ ONLY` transaction and
 *   the router exposes no verb but `GET`, so the modelling side holds no
 *   migration rights and no write path, by construction rather than by policy.
 */

/** Parse an instant, refusing anything that is not one rather than defaulting. */
function instant(label: string, raw: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadInputError(`${label} must be an ISO-8601 instant, got "${raw}"`);
  }
  return parsed;
}

/** Parse the optional form. `undefined` stays `undefined`; junk still throws. */
function optionalInstant(label: string, raw?: string): Date | undefined {
  return raw === undefined ? undefined : instant(label, raw);
}

/** The window, validated once so every read gets the same treatment. */
function factWindow(query: { as_of: string; from: string; to: string }): {
  asOf: Date;
  from: Date;
  to: Date;
} {
  const from = instant("from", query.from);
  const to = instant("to", query.to);
  if (to.getTime() <= from.getTime()) {
    // `[from, to)` is half-open, so an empty or inverted window is a caller
    // error rather than an empty result — an empty result would read as "there
    // was no curtailment", which is a different and much worse statement.
    throw new BadInputError(
      "`to` must be strictly after `from` — the window is [from, to)",
    );
  }
  return { asOf: instant("as_of", query.as_of), from, to };
}

const requireDatabase = (): Database => {
  if (!database) {
    throw new BusyError("Persistence is not configured");
  }
  return database.db;
};

/**
 * Run one canonical read and hand back its wire form.
 *
 * The argument order is load-bearing: the caller builds `args` — which is where
 * `factWindow` parses and rejects — **before** this function asks for a
 * database. Passing the handle in as the first argument instead would evaluate
 * it first, and a request with a malformed `as_of` would come back as
 * "persistence is not configured" rather than as the 400 it is.
 */
async function serve<TArgs, TResult>(
  read: (db: Database, args: TArgs) => Promise<TResult>,
  args: TArgs,
): Promise<unknown> {
  return toWire(await read(requireDatabase(), args));
}

const FACT_QUERY = {
  as_of: t.String({
    description: "Vintage cut: what WattSteer had learned by this instant (ISO-8601).",
  }),
  from: t.String({ description: "Valid-time window start, inclusive (ISO-8601)." }),
  to: t.String({ description: "Valid-time window end, exclusive (ISO-8601)." }),
};

const REGISTRY_QUERY = {
  as_of: t.String({
    description: "Vintage cut: what WattSteer had learned by this instant (ISO-8601).",
  }),
  on: t.String({ description: "Fleet date the question is asked about (ISO-8601)." }),
};

const SUBSYSTEM = t.Optional(
  t.Union([t.Literal("N"), t.Literal("NE"), t.Literal("S"), t.Literal("SE")]),
);
const TECHNOLOGY = t.Optional(t.Union([t.Literal("WIND"), t.Literal("SOLAR")]));

/** Comma-separated ids, because a repeated query key is not portable. */
const idList = (raw?: string): string[] | undefined =>
  raw === undefined
    ? undefined
    : raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

export const canonicalReads = new Elysia({ name: "canonical-reads" })
  .get(
    CANONICAL_BASE_PATH,
    () => ({
      base_path: CANONICAL_BASE_PATH,
      reads: CANONICAL_READS.map((spec) => ({
        ...(toWire(spec) as Record<string, unknown>),
        path: canonicalReadPath(spec.name),
      })),
    }),
    {
      detail: {
        summary: "The canonical read manifest",
        description:
          "Every read the contract exposes, with its grain, business key, " +
          "whether it is an observation or a forecast, and whether a " +
          "restriction cause is reachable from it. A consumer that has this " +
          "never needs a table name.",
      },
    },
  )
  .get(
    canonicalReadPath("curtailment-by-reporting-entity"),
    async ({ query }) =>
      serve(readCurtailment, {
        ...factWindow(query),
        technology: query.technology,
        reportingEntityCode: query.reporting_entity_code,
      }),
    {
      query: t.Object({
        ...FACT_QUERY,
        technology: TECHNOLOGY,
        reporting_entity_code: t.Optional(t.String()),
      }),
      detail: {
        summary: "Constrained-off at reporting-entity grain",
        description:
          "The grain ONS settles curtailment at, and therefore the only read " +
          "whose rows carry a restriction cause.",
      },
    },
  )
  .get(
    canonicalReadPath("curtailment-by-plant"),
    async ({ query }) =>
      serve(readPlantMeasurements, {
        ...factWindow(query),
        technology: query.technology,
        plantOnsCode: query.plant_ons_code,
      }),
    {
      query: t.Object({
        ...FACT_QUERY,
        technology: TECHNOLOGY,
        plant_ons_code: t.Optional(t.String()),
      }),
      detail: {
        summary: "Per-plant generation and measured resource",
        description:
          "No restriction cause and no reference generation exist at this " +
          "grain, so neither is offered and no parameter can request one.",
      },
    },
  )
  .get(
    canonicalReadPath("system-context"),
    async ({ query }) =>
      serve(readSystemContext, {
        ...factWindow(query),
        subsystem: query.subsystem,
      }),
    {
      query: t.Object({ ...FACT_QUERY, subsystem: SUBSYSTEM }),
      detail: { summary: "Load and generation by technology, per subsystem-hour" },
    },
  )
  .get(
    canonicalReadPath("system-exchange"),
    async ({ query }) =>
      serve(readSystemExchange, {
        ...factWindow(query),
        subsystem: query.subsystem,
      }),
    {
      query: t.Object({ ...FACT_QUERY, subsystem: SUBSYSTEM }),
      detail: { summary: "Interchange per directed subsystem link" },
    },
  )
  .get(
    canonicalReadPath("day-ahead-balance"),
    async ({ query }) =>
      serve(readDayAheadBalance, {
        ...factWindow(query),
        subsystem: query.subsystem,
        publishedAtOrBefore: optionalInstant(
          "published_at_or_before",
          query.published_at_or_before,
        ),
      }),
    {
      query: t.Object({
        ...FACT_QUERY,
        subsystem: SUBSYSTEM,
        published_at_or_before: t.Optional(
          t.String({
            description:
              "The gate. Cuts on publication rather than ingestion, which is " +
              "what reproduces what was knowable over backfilled history.",
          }),
        ),
      }),
      detail: {
        summary: "The operational day-ahead balance (forecast)",
        description:
          "A forecast, in its own read, never merged with actuals. Every row " +
          "carries the origin of the run that produced it.",
      },
    },
  )
  .get(
    canonicalReadPath("weather-forecast"),
    async ({ query }) =>
      serve(readWeatherForecast, {
        ...factWindow(query),
        centroidIds: idList(query.centroid_ids),
        runCycle: query.run_cycle,
      }),
    {
      query: t.Object({
        ...FACT_QUERY,
        centroid_ids: t.Optional(
          t.String({ description: "Comma-separated centroid ids." }),
        ),
        run_cycle: t.Optional(t.Union([t.Literal("00Z"), t.Literal("12Z")])),
      }),
      detail: {
        summary: "Weather at cluster centroids from a named run (forecast)",
        description:
          "Omit run_cycle for the normal read: the later run wins as a newer " +
          "vintage of the same hours, with no supersession rule of its own.",
      },
    },
  )
  .get(
    canonicalReadPath("installed-capacity"),
    async ({ query }) =>
      serve(readInstalledCapacity, {
        asOf: instant("as_of", query.as_of),
        on: instant("on", query.on),
        subsystem: query.subsystem,
        technology: query.technology,
      }),
    {
      query: t.Object({
        ...REGISTRY_QUERY,
        subsystem: SUBSYSTEM,
        technology: TECHNOLOGY,
      }),
      detail: {
        summary: "Installed capacity as of a fleet date",
        description:
          "Summed over the generating units live on the fleet date. Never a " +
          "stored scalar: capacity is a function of time.",
      },
    },
  )
  .get(
    canonicalReadPath("conjunto-membership"),
    async ({ query }) =>
      serve(readConjuntoMembership, {
        asOf: instant("as_of", query.as_of),
        on: instant("on", query.on),
        conjuntoCode: query.conjunto_code,
        plantOnsCode: query.plant_ons_code,
      }),
    {
      query: t.Object({
        ...REGISTRY_QUERY,
        conjunto_code: t.Optional(t.String()),
        plant_ons_code: t.Optional(t.String()),
      }),
      detail: {
        summary: "Which conjunto a plant belonged to on a date",
        description:
          "The only path between the plant and reporting-entity grains, and " +
          "it is time-resolved: every traversal takes a date.",
      },
    },
  )
  .get(
    `${CANONICAL_BASE_PATH}/training-window`,
    async ({ query }) =>
      serve(readTrainingWindow, {
        ...factWindow(query),
        subsystem: query.subsystem,
        technology: query.technology,
        centroidIds: idList(query.centroid_ids),
        publishedAtOrBefore: optionalInstant(
          "published_at_or_before",
          query.published_at_or_before,
        ),
        fleetDate: optionalInstant("fleet_date", query.fleet_date),
      }),
    {
      query: t.Object({
        ...FACT_QUERY,
        subsystem: SUBSYSTEM,
        technology: TECHNOLOGY,
        centroid_ids: t.Optional(t.String()),
        published_at_or_before: t.Optional(t.String()),
        fleet_date: t.Optional(
          t.String({ description: "Defaults to the window start." }),
        ),
      }),
      detail: {
        summary: "Every family for one window, under one as-of",
        description:
          "Curtailment, system context, the day-ahead balance, weather and " +
          "as-of capacity in one snapshot, with a single vintage receipt that " +
          "is point_in_time only when every contributing source is.",
      },
    },
  );
