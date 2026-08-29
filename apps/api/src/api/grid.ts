import type { GridNow } from "@wattsteer/core/api";
import { subsystemMeta } from "@wattsteer/core/constants";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import type { GridNowObservation } from "../contract/grid-now.js";
import { readGridNow } from "../contract/grid-now.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { BadInputError, CodedError } from "../errors.js";

/**
 * `GET /v1/grid/now` — the observed "right now".
 *
 * **The endpoint that needs no model**, which is exactly why it ships first. It
 * resolves entirely from Postgres, through the canonical curtailment view, and
 * touches nothing the modelling service owns: with `apps/ml` returning 503 for
 * everything and with no promoted artifact in any lane, this route still
 * answers 200 with real numbers. That is `docs/specs/api-surface.md`'s
 * degradation table, and for this route it is a property of the dependency
 * graph rather than a fallback path someone has to remember to write.
 *
 * Three shaping decisions live here and nowhere else:
 *
 * - **`ons_display_name` comes from `SUBSYSTEMS`**, the published constant, and
 *   never from a row. There is no `GET /v1/subsystems` on purpose — an endpoint
 *   would invite a fifth member of a four-member enum — so the display name is
 *   read from the same constant the web app and `apps/ml` read.
 * - **The wire form is produced by `@wattsteer/core`'s translator**, given the
 *   schema's shape name. Not by this file, and not by `contract/wire.ts`: that
 *   one derives `snake_case` from `camelCase` by rule, and the rule is lossy on
 *   exactly the field this payload leads with —
 *   `last24hConstrainedOffMwh` derives to `last24h_constrained_off_mwh`, and
 *   the contract says `last_24h_constrained_off_mwh`. The generated table gets
 *   it right because the schema, not a regular expression, is the authority.
 * - **The response is typed as the generated `GridNow`**, so a field renamed in
 *   `grid-now.schema.json` breaks this compile rather than a screen.
 *
 * The route is built by a factory over its database, as `ingest-health.ts` is,
 * so the whole path — axes, view, shaping, headers — can be asserted against a
 * real Postgres rather than only the read underneath it.
 */

/** Parse an instant, refusing anything that is not one rather than defaulting. */
function instant(label: string, raw: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadInputError(`${label} must be an ISO-8601 instant, got "${raw}"`);
  }
  return parsed;
}

/**
 * The wire body, built field by field against the generated interface.
 *
 * Field by field rather than by handing the whole observation to the encoder:
 * the encoder carries an unrecognised key through unrenamed by design, and the
 * schema is `additionalProperties: false`, so `window` and `latestIngestedAt` —
 * which are the read's business and not the readout's — would be a contract
 * violation discovered by a validator instead of by a compiler.
 */
function toGridNow(observation: GridNowObservation): GridNow {
  return {
    asOf: observation.asOf.toISOString(),
    latestSettledHour: observation.latestSettledHour.toISOString(),
    lagHours: observation.lagHours,
    vintageFidelity: observation.vintageFidelity,
    subsystems: observation.subsystems.map((entry) => ({
      subsystem: entry.subsystem,
      onsDisplayName: subsystemMeta(entry.subsystem).onsDisplayName,
      last24hConstrainedOffMwh: entry.last24hConstrainedOffMwh,
      latestHourConstrainedOffMwh: entry.latestHourConstrainedOffMwh,
      split: entry.split,
    })),
    national: observation.national,
  };
}

export function createGridRoutes(deps: { db: Database | undefined }) {
  return new Elysia({ name: "grid" }).get(
    "/v1/grid/now",
    async ({ query, set, request }) => {
      if (!deps.db) {
        throw new CodedError("DATA_UNAVAILABLE", "Persistence is not configured");
      }

      // `as_of` defaults to the request instant, which the canonical reads
      // refuse to do and this route must. `/v1/canonical/*` is the modelling
      // surface, where a forgotten axis silently turns a backtest into a
      // latest-version read; this is a landing page, which cannot be asked to
      // name a vintage cut before it may see a number. The honesty the default
      // would have cost is paid on the response instead: `as_of` is *on* the
      // payload, beside the lag, so what the reader is holding is stated
      // rather than assumed.
      const asOf = query.as_of === undefined ? new Date() : instant("as_of", query.as_of);
      const observation = await readGridNow(deps.db, { asOf });

      if (observation === null) {
        // No hour is settled in all four subsystems at this cut. An absence,
        // and answered as one: the alternative is four zeroes under an invented
        // hour, which reads as "no curtailment anywhere" — a different and much
        // worse statement than "we have not settled an hour yet".
        throw new CodedError(
          "DATA_UNAVAILABLE",
          "No hour is settled in all four subsystems at this as-of",
          { details: { as_of: asOf.toISOString() } },
        );
      }

      // `api-surface.md`'s caching rule: a cache key is a provenance, never a
      // duration. This response moves with ingestion, which is hourly at best,
      // so the validator is the freshest ingestion instant behind it and the
      // `max-age` is short enough that the clock is never what makes it right.
      const etag = `W/"${observation.latestIngestedAt.toISOString()}"`;
      set.headers["cache-control"] = "public, max-age=60";
      set.headers.etag = etag;
      if (request.headers.get("if-none-match") === etag) {
        set.status = 304;
        return null;
      }

      return encodeWire("GridNow", toGridNow(observation));
    },
    {
      query: t.Object({
        as_of: t.Optional(
          t.String({
            description:
              "Vintage cut (ISO-8601). Defaults to now — this is the observed " +
              "readout, and the cut it was read at is on the response.",
          }),
        ),
      }),
      detail: {
        summary: "The observed right-now readout",
        description:
          "Latest settled hour, the lag, the four subsystems' observed " +
          "constrained-off over the last 24 hours and in the latest hour with " +
          "their scalar technology splits, and the national total with its " +
          "derivation named. Observed, not forecast: it needs no model and is " +
          "served with the modelling service unreachable.",
      },
    },
  );
}

/** The wired route, over the process-wide handle. */
export const gridRoutes = createGridRoutes({ db: database?.db });
