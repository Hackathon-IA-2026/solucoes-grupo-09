import { sql } from "drizzle-orm";
import { withAxes } from "../contract/scope.js";
import type { Database } from "../database/connection.js";
import type { ForecastGateProfile } from "../forecast/publication.js";
import type { SubsystemCode } from "../ingest/normalise.js";

/**
 * The most recent settled day's reported reason shares, per subsystem.
 *
 * **The read `unmodelled_outage_regime` was waiting for.** `diagnosis` ticket 07
 * shipped the rule, its predicate and its facts, complete and tested against a
 * supplied `ReasonMix`, and left the read unbuilt — so the rule could not fire.
 * `.scratch/api-surface/issues/10-forecast-publication.md` inherited it and said
 * why it belongs here rather than under `diagnosis/`: it is a *new canonical
 * read*, and the publication job is what has to perform it.
 *
 * ## What the rule needs, and why reading it is not a causal claim
 *
 * `RestrictionCause` is **ONS's own reported reason**, and `REL` is external
 * unavailability. When yesterday's curtailment in a subsystem was mostly `REL`,
 * the model is explaining a mechanism it structurally cannot see —
 * `docs/specs/forecaster.md` ruled the reason-code model out on the ground that
 * no ingested dataset carries transmission availability — and the screen should
 * say so next to the bars. Reading a reported reason and displaying it as
 * evidence makes no causal claim and none is permitted downstream
 * (`docs/domain-model.md` §10).
 *
 * ## The three decisions in this file
 *
 * 1. **The subsystem comes from `reporting_entity`, not from a changed view.**
 *    The ticket recorded the blocker as "`curtailment-by-reporting-entity` is
 *    not filterable by subsystem", and that is true of the *canonical view* —
 *    it projects `reporting_entity_kind` and not `subsystem`. The dimension
 *    underneath it has carried `subsystem NOT NULL` since it was created, out
 *    of the constrained-off files themselves. So this is a join to a dimension
 *    rather than a change to a published read: no column of
 *    `canonical_curtailment_by_reporting_entity` moves, nothing in
 *    `contract/manifest.ts` changes, and no consumer of that read is affected.
 *
 * 2. **It is cut at `actuals_cutoff`, not at the gate.** `recent_reasons` is an
 *    an *observation* — `rule_context.FIELD_PROVENANCE` says so — and every
 *    observation-sourced input in this product is filtered on
 *    `actuals_cutoff(target_date, gate_profile, dataset)`, which is the gate
 *    minus the dataset's configured publication lag. Reading it at the gate
 *    instead would hand the rule ONS rows that had not been published when the
 *    forecast was made, which is a leak of exactly the kind
 *    `drizzle/0021_lagged_actuals_behind_the_cutoff.sql` exists to prevent — and
 *    it would put a *causally impossible* annotation on the screen beside an
 *    attribution that was computed honestly. `restricao-coff` carries a 40 h
 *    lag, so `gate_late` for tomorrow sees curtailment up to D−2 03:00 BRT.
 *
 * 3. **A whole civil day or nothing.** The shares are of one settled
 *    `(subsystem, date)`, and a partial day's shares are a different quantity
 *    that looks exactly like a complete one — the evening's reason mix is not
 *    the day's. So a day qualifies only when its *last* hour is at or before
 *    the cutoff.
 *
 * ## And an absence stays an absence
 *
 * `null` is returned when there is no settled day with restricted energy in
 * range, and `RuleContext.recent_reasons` is `null` in that case — which the
 * rule reads as "not available" and never fires on. Nothing here returns a day
 * of zero shares: a zero standing in for an absence is the defect the whole
 * spec is against, and here it would make "nothing was restricted" and "we
 * cannot see yet" the same input to a rule that annotates the screen.
 */

/** ONS's reported restriction reasons — `reason_code`, the closed set of four. */
export const REASON_CODES = ["REL", "CNF", "ENE", "PAR"] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * The ONS dataset whose publication lag cuts this read.
 *
 * `feature_publication_lag.dataset`, spelled as that table spells it. A name
 * this function invented would raise `22023` out of `actuals_cutoff`, which is
 * that function's posture on purpose: an unconfigured lag is an unmeasured leak
 * and is refused rather than defaulted to zero.
 */
export const REASON_MIX_DATASET = "restricao-coff";

/** One settled day's reported reason mix, as shares of constrained-off MWh. */
export interface ReasonMix {
  /** The Brasília civil day the shares are of. */
  settledDate: string;
  /** Constrained-off MWh over that day, by reason. Restricted rows only. */
  shares: Partial<Record<ReasonCode, number>>;
  /** The denominator, in MWh, so a mix over a trivial day is recognisable. */
  totalMwh: number;
}

export interface ReasonMixQuery {
  subsystem: SubsystemCode;
  /** The day being explained — the gate is derived from it, never passed. */
  targetDate: string;
  gateProfile: ForecastGateProfile;
  /** The vintage cut. The canonical view reads it off the session. */
  asOf: Date;
}

interface MixRow {
  [column: string]: unknown;
  settled_date: string;
  reason: string;
  mwh: string | number;
}

/**
 * Read one subsystem's most recent settled reason mix, or `null`.
 *
 * The whole read is one statement so that "the most recent qualifying day" and
 * "that day's shares" cannot be answered from two different snapshots. The
 * `distinct on`/`order by` pair picks the greatest civil date that has any
 * restricted energy at all; a day whose restricted total is zero is not a day
 * with a reason mix and is skipped rather than returned as eight zeros.
 */
export async function readRecentReasonMix(
  db: Database,
  query: ReasonMixQuery,
): Promise<ReasonMix | null> {
  const rows = await withAxes(db, { asOf: query.asOf }, async (tx) =>
    tx.execute<MixRow>(sql`
      with cutoff as (
        select actuals_cutoff(
          ${query.targetDate}::date,
          ${query.gateProfile},
          ${REASON_MIX_DATASET}
        ) as at
      ),
      restricted as (
        select
          (c.valid_time at time zone 'America/Sao_Paulo')::date as settled_date,
          c.restriction_reason as reason,
          c.constrained_off_mwh as mwh
        from canonical_curtailment_by_reporting_entity c
        join reporting_entity e on e.ons_code = c.reporting_entity_code
        cross join cutoff
        where e.subsystem = ${query.subsystem}::subsystem_code
          and c.restriction_reason is not null
          and c.constrained_off_mwh > 0
          -- The whole civil day is behind the cutoff, not merely its first
          -- hour: 23:00 Brasília is the last hour a Brasília day starts.
          and (
            ((c.valid_time at time zone 'America/Sao_Paulo')::date::timestamp
              + interval '23 hours') at time zone 'America/Sao_Paulo'
          ) <= cutoff.at
      ),
      latest as (
        select settled_date from restricted
        order by settled_date desc
        limit 1
      )
      select
        r.settled_date::text as settled_date,
        r.reason::text as reason,
        sum(r.mwh) as mwh
      from restricted r
      join latest l on l.settled_date = r.settled_date
      group by r.settled_date, r.reason
      order by r.reason
    `),
  );

  const found = [...rows];
  if (found.length === 0) {
    return null;
  }
  const settledDate = String(found[0]?.settled_date);
  const byReason = new Map<ReasonCode, number>();
  let totalMwh = 0;
  for (const row of found) {
    const reason = String(row.reason);
    if (!(REASON_CODES as readonly string[]).includes(reason)) {
      // Unreachable while the column is `reason_code`. Thrown rather than
      // dropped, because silently omitting a reason would change the
      // denominator and therefore every share.
      throw new RangeError(
        `${reason} is not a reason code; the reported reasons are ` +
          `${REASON_CODES.join(", ")}`,
      );
    }
    const mwh = Number(row.mwh);
    byReason.set(reason as ReasonCode, mwh);
    totalMwh += mwh;
  }
  if (!(totalMwh > 0)) {
    // Defensive: `constrained_off_mwh > 0` above already excludes it. A total
    // of zero has no shares, and dividing by it would produce NaNs that look
    // like numbers.
    return null;
  }
  const shares: Partial<Record<ReasonCode, number>> = {};
  for (const [reason, mwh] of byReason) {
    shares[reason] = mwh / totalMwh;
  }
  return { settledDate, shares, totalMwh };
}

/**
 * The mix on the wire, as `apps/ml`'s `ReasonMix` reads it.
 *
 * Shares and a date, never the MWh: the rule compares shares, and a payload
 * carrying the energies would invite a second producer of the same ratio.
 */
export function reasonMixPayload(mix: ReasonMix): {
  settled_date: string;
  shares: Record<string, number>;
} {
  return { settled_date: mix.settledDate, shares: { ...mix.shares } };
}
