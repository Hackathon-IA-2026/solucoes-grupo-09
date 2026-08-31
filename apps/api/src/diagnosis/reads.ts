import { sql } from "drizzle-orm";
import { readOnly } from "../contract/read-only.js";
import { applyAxes } from "../contract/scope.js";
import type { VintageFidelity } from "../contract/vintage.js";
import {
  canonicalDiagnosisAttribution,
  canonicalDiagnosisDriver,
} from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { ForecastGateProfile } from "../forecast/publication.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import type { AttributionGrain, FiredRule, RuleAction } from "./publication.js";

/**
 * Reading back what was said — the query `/v1/diagnosis/day-ahead` is.
 *
 * **A row read, not an inference.** This is the boundary decision the
 * api-surface spec rests on: the attribution half of the diagnosis response is
 * a stored row, so answering "what did we say at D−1" never loads a model
 * artifact, never draws a background, and never re-runs a Shapley game. There
 * is no arithmetic in this file, which is what makes the round trip exact
 * rather than approximately exact.
 *
 * **All eight groups come back, ranked.** The `share ≥ 0.03` cut, the six-row
 * cap and the merge into one `other` row are the client's; applying them here
 * would put the `other` row's `"mixed"` direction in two places the first time
 * a second client appears, and would publish shares whose denominator no longer
 * exists.
 *
 * **`withhold` never reaches these rows.** A withheld narration is a 200
 * carrying the drivers untouched and a template paragraph in place of the
 * model's. So this read has no branch on `governing_rule_action`: it returns
 * the flags and the action beside a complete ranking, and what the narration
 * layer does with them is that layer's decision.
 *
 * **The grouping is returned, not silently applied.** `driver_group_hash` and
 * `driver_group_version` come back on every answer, and
 * `groupingHasChanged(read, currentHash)` is the one-line comparison a caller
 * makes before rendering a stored attribution under today's map. A row whose
 * grouping has since moved is still the truth about what was said; it is simply
 * not a row today's labels describe.
 */

/** One group's contribution, read back exactly as it was written. */
export interface AttributionDriverRow {
  code: string;
  labelCode: string;
  rank: number;
  phiMwh: number;
  /** A share of all eight groups, never of the displayed rows. */
  share: number;
  direction: "raises" | "lowers";
  /** Day rows only; `null` on the peak hour's. */
  hourDisagreement: number | null;
  headlineFeature: string;
  observed: number;
  typical: number;
  unit: string;
  demoted: boolean;
}

/** One published attribution, read back. */
export interface PublishedAttributionRow {
  subsystem: SubsystemCode;
  targetDate: string;
  gateProfile: ForecastGateProfile;
  thresholdMw: number;
  /** `ForecastOrigin.run_label` — the artifact that produced the numbers. */
  artifactId: string;
  featureSet: string;
  /** Which regime composed the expectation these bars decompose. */
  correctionRegime: string;
  publishedAt: Date;
  ingestedAt: Date;
  dataVersion: number;
  /** `expected_mwh_day`, and the disclaimer code beside it. */
  target: string;
  explains: string;
  hoursAttributed: number;
  baselineExpectedMwh: number;
  dayExpectedMwh: number;
  totalAttributedMwh: number;
  sumAbsAttributedMwh: number;
  localAccuracyResidualMwh: number;
  /** Pre-computed, because the renderer may not add. */
  topTwoShare: number;
  attributionStderrMwh: number;
  baselineStderrMwh: number;
  stderrResamples: number;
  stderrSeed: number;
  peakHourLocal: number;
  peakHourExpectedMwh: number;
  peakHourBaselineExpectedMwh: number;
  /** The vocabulary these bars were ranked under. See the module note. */
  driverGroupVersion: string;
  driverGroupHash: string;
  /** Which matched background defined "typical", and how it was drawn. */
  backgroundSource: string;
  backgroundSeed: number;
  backgroundRows: number;
  coalitions: number;
  ruleFlags: FiredRule[];
  governingRuleAction: RuleAction | null;
  /** All eight, ranked by `|share|`. */
  drivers: AttributionDriverRow[];
  /** The peak hour's own eight, beside the day's and never instead of them. */
  peakHourDrivers: AttributionDriverRow[];
  /**
   * A `served` attribution is a record of a real publication, so its fidelity
   * is `point_in_time` by construction — derived from the origin kind rather
   * than stored as a column nobody could write a second value into.
   */
  vintageFidelity: VintageFidelity;
}

export interface AttributionQuery {
  subsystem: SubsystemCode;
  /** The civil day in `America/Sao_Paulo`, `YYYY-MM-DD`. */
  targetDate: string;
  gateProfile: ForecastGateProfile;
  /** The vintage cut. The route defaults it to the request instant. */
  asOf: Date;
}

interface AttributionRecord {
  [column: string]: unknown;
  gate_profile: string;
  threshold_mw: number;
  run_label: string;
  feature_set: string;
  correction_regime: string;
  published_at: string;
  ingested_at: string;
  data_version: number;
  target: string;
  explains: string;
  hours_attributed: number;
  baseline_expected_mwh: number;
  day_expected_mwh: number;
  total_attributed_mwh: number;
  sum_abs_attributed_mwh: number;
  local_accuracy_residual_mwh: number;
  top_two_share: number;
  attribution_stderr_mwh: number;
  baseline_stderr_mwh: number;
  stderr_resamples: number;
  stderr_seed: number;
  peak_hour_local: number;
  peak_hour_expected_mwh: number;
  peak_hour_baseline_expected_mwh: number;
  driver_group_version: string;
  driver_group_hash: string;
  background_source: string;
  background_seed: number;
  background_rows: number;
  coalitions: number;
  rule_flags: unknown;
  governing_rule_action: string | null;
}

interface DriverRecord {
  [column: string]: unknown;
  grain: string;
  driver_group: string;
  label_code: string;
  rank: number;
  phi_mwh: number;
  share: number;
  direction: string;
  hour_disagreement: number | null;
  headline_feature: string;
  observed: number;
  typical: number;
  unit: string;
  demoted: boolean;
}

const asNumber = (value: unknown): number => Number(value);

/** The one origin kind the day-ahead diagnosis may return. A constant. */
export const SERVED: "served" = "served";

/**
 * The attribution for one subsystem-day at one gate, or `null` if none exists.
 *
 * `null` is an absence and the route answers it as one — never an empty
 * ranking, never eight zero bars. A day nobody explained is not a day whose
 * drivers were all zero.
 */
export async function readAttributionDayAhead(
  db: Database,
  query: AttributionQuery,
): Promise<PublishedAttributionRow | null> {
  return readOnly(db, async (tx) => {
    // The vintage axis on the transaction, never in the predicate: the views
    // read `canonical_as_of()` and raise when it is unset.
    await applyAxes(tx, { asOf: query.asOf });

    const rows = await tx.execute<AttributionRecord>(sql`
      select *
      from ${canonicalDiagnosisAttribution}
      where subsystem = ${query.subsystem}::subsystem_code
        and target_date = ${query.targetDate}::date
        and gate_profile = ${query.gateProfile}::forecast_gate_profile
        and origin_kind = 'served'::forecast_origin_kind
    `);
    const [row] = [...rows];
    if (row === undefined) {
      return null;
    }

    const driverRows = await tx.execute<DriverRecord>(sql`
      select *
      from ${canonicalDiagnosisDriver}
      where subsystem = ${query.subsystem}::subsystem_code
        and target_date = ${query.targetDate}::date
        and gate_profile = ${query.gateProfile}::forecast_gate_profile
        and origin_kind = 'served'::forecast_origin_kind
      order by grain, rank
    `);
    const drivers = { day: [], peak_hour: [] } as Record<
      AttributionGrain,
      AttributionDriverRow[]
    >;
    for (const driver of driverRows) {
      const grain = driver.grain as AttributionGrain;
      drivers[grain].push({
        code: driver.driver_group,
        labelCode: driver.label_code,
        rank: asNumber(driver.rank),
        phiMwh: asNumber(driver.phi_mwh),
        share: asNumber(driver.share),
        direction: driver.direction as "raises" | "lowers",
        hourDisagreement:
          driver.hour_disagreement === null ? null : asNumber(driver.hour_disagreement),
        headlineFeature: driver.headline_feature,
        observed: asNumber(driver.observed),
        typical: asNumber(driver.typical),
        unit: driver.unit,
        demoted: driver.demoted === true,
      });
    }

    return {
      subsystem: query.subsystem,
      targetDate: query.targetDate,
      gateProfile: row.gate_profile as ForecastGateProfile,
      thresholdMw: asNumber(row.threshold_mw),
      artifactId: row.run_label,
      featureSet: row.feature_set,
      correctionRegime: row.correction_regime,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
      dataVersion: asNumber(row.data_version),
      target: row.target,
      explains: row.explains,
      hoursAttributed: asNumber(row.hours_attributed),
      baselineExpectedMwh: asNumber(row.baseline_expected_mwh),
      dayExpectedMwh: asNumber(row.day_expected_mwh),
      totalAttributedMwh: asNumber(row.total_attributed_mwh),
      sumAbsAttributedMwh: asNumber(row.sum_abs_attributed_mwh),
      localAccuracyResidualMwh: asNumber(row.local_accuracy_residual_mwh),
      topTwoShare: asNumber(row.top_two_share),
      attributionStderrMwh: asNumber(row.attribution_stderr_mwh),
      baselineStderrMwh: asNumber(row.baseline_stderr_mwh),
      stderrResamples: asNumber(row.stderr_resamples),
      stderrSeed: asNumber(row.stderr_seed),
      peakHourLocal: asNumber(row.peak_hour_local),
      peakHourExpectedMwh: asNumber(row.peak_hour_expected_mwh),
      peakHourBaselineExpectedMwh: asNumber(row.peak_hour_baseline_expected_mwh),
      driverGroupVersion: row.driver_group_version,
      driverGroupHash: row.driver_group_hash,
      backgroundSource: row.background_source,
      backgroundSeed: asNumber(row.background_seed),
      backgroundRows: asNumber(row.background_rows),
      coalitions: asNumber(row.coalitions),
      ruleFlags: (Array.isArray(row.rule_flags) ? row.rule_flags : []) as FiredRule[],
      governingRuleAction: (row.governing_rule_action ?? null) as RuleAction | null,
      drivers: drivers.day,
      peakHourDrivers: drivers.peak_hour,
      vintageFidelity: "point_in_time",
    };
  });
}

/**
 * Whether a stored attribution was ranked under a grouping that has since moved.
 *
 * The reason `driver_group_hash` is a column. The hash covers the
 * feature-to-group pairing and deliberately not a label or a unit edit, so a
 * `true` here means the *membership* changed: some feature moved group, arrived
 * or left, which is exactly the change that re-ranks the screen. Re-rendering
 * such a row under today's map would show old numbers under new labels, which
 * is the one failure mode a stored explanation exists to prevent.
 */
export function groupingHasChanged(
  attribution: Pick<PublishedAttributionRow, "driverGroupHash">,
  currentHash: string,
): boolean {
  return attribution.driverGroupHash !== currentHash;
}
