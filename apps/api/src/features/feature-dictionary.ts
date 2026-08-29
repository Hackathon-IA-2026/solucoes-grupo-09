import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import type { FeatureSet, GateProfile } from "./feature-rows.js";

/**
 * The feature dictionary — the caller, and deliberately nothing more.
 *
 * `feature_dictionary()` lives in the migration tree
 * (`drizzle/0033_both_feature_sets_and_the_dictionary.sql`) for the reason
 * `feature_rows` does: the API owns the schema, and there must be exactly one
 * description of a feature set. This module binds no arguments and computes
 * nothing — it returns what came back.
 *
 * **The rows are not renamed**, on the same terms as `feature-rows.ts`. A
 * column's name is its identity: `docs/specs/forecaster.md` hashes the ordered
 * attribute names into a lane's `feature_hash`, the dictionary reads that same
 * ordered list from the same catalogue, and a second spelling on the way out
 * would be a third list to keep in step by hand.
 *
 * ## Why the dictionary is not a constant in this file
 *
 * Because a constant here would be the fourth place the feature set is written
 * down, after the composite type, `ordered_features.yaml` and
 * `DAY_GRAIN_COLUMNS`. The dictionary is *derived* from `pg_attribute` on
 * `feature_row` — that is the whole design — so reading it requires a database,
 * and that cost is the point rather than an inconvenience. What can be answered
 * without one is answered without one: `isFeatureColumn` and `featureGrain` in
 * `feature-rows.ts` stay where they are, and `database-features.test.ts` binds
 * them to the dictionary the way `capacity-weights.ts` is bound to
 * `canonical_capacity_weight` — two implementations, compared, rather than one
 * trusted.
 */

/** What a column *is*, before what it is made of. */
export type FeatureRole = "identity" | "stamp" | "feature" | "label";

/**
 * The spec's classes, minus `✗`.
 *
 * `D` from the DESSEM balance, `W` from the pinned weather run, `P` from ONS
 * day-ahead programming, `K` a lagged actual behind `actuals_cutoff`, `T`
 * deterministic. A dropped feature has no column, so `✗` is not here — it is
 * `readDroppedFeatures` below.
 */
export type FeatureClass = "D" | "W" | "P" | "K" | "T";

/** Hourly, or one value broadcast across the 24 hours of the target date. */
export type FeatureColumnGrain = "hour" | "day";

/** One row of the dictionary: one attribute of `feature_row`. */
export interface FeatureDictionaryEntry {
  /** The attribute's position in the composite type — the tree's history. */
  ordinal: number;
  column_name: string;
  /** As `format_type` renders it, e.g. `double precision`. */
  sql_type: string;
  role: FeatureRole;
  classes: FeatureClass[];
  /** `W+T`, `D+K`, `P+W+T` — the spec's own notation, or the role when empty. */
  class_label: string;
  source: string;
  /** NULL for `identity` and `stamp`, where the question is not asked. */
  grain: FeatureColumnGrain | null;
  in_dessem_free_v1: boolean;
  in_dessem_augmented_v1: boolean;
  augmented_only: boolean;
  /**
   * False for every `dessem_*`, `programmed_*` and `proxy_*` column.
   *
   * The DESSEM family is absent structurally; the other two are absent because
   * the programme for day D is stamped D−1 15:00 BRT, six hours after the early
   * gate. Nobody repaired the second one, deliberately.
   */
  available_at_gate_early: boolean;
  /** An estimate of a quantity WattSteer cannot observe, named as one. */
  is_proxy: boolean;
  /** One of the four augmented-only columns that would justify the trade. */
  justifies_dessem_trade: boolean;
  /** Offered to the estimator: every feature, plus `subsystem`. */
  model_input: boolean;
  /** `col_description` — the prose, which lives once, at the column. */
  description: string;
}

/**
 * The whole dictionary, in attribute order.
 *
 * Raises rather than answering when an attribute has no entry, an entry has no
 * attribute, or an attribute has no catalogue comment. That severity is
 * deliberate: a dictionary with one unclassified column in it still reads like
 * a dictionary, and that column is exactly the one a reader will assume
 * somebody classified.
 */
export async function readFeatureDictionary(
  db: Database,
): Promise<FeatureDictionaryEntry[]> {
  const rows = await db.execute<FeatureDictionaryEntry & Record<string, unknown>>(
    sql`select * from feature_dictionary()`,
  );
  return [...rows];
}

/** One ordered model input of a feature set. */
export interface FeatureSetModelInput {
  /** 1-based position within this set, in the composite type's own order. */
  input_index: number;
  column_name: string;
  class_label: string;
  grain: FeatureColumnGrain;
  available_at_gate_early: boolean;
}

/**
 * The ordered model inputs of one feature set — what an artifact is bound to.
 *
 * This is the list `apps/ml`'s `ordered_features.yaml` transcribes by hand, and
 * that file's own header says the transcription goes away once the builder
 * lands and the names can come from the artifact instead. They can now come
 * from here.
 */
export async function readFeatureSetModelInputs(
  db: Database,
  featureSet: FeatureSet,
): Promise<FeatureSetModelInput[]> {
  const rows = await db.execute<FeatureSetModelInput & Record<string, unknown>>(
    sql`select * from feature_set_model_inputs(${featureSet})`,
  );
  return [...rows];
}

/** An IDEA.md feature that cannot be served at D−1, and what replaces it. */
export interface DroppedFeature {
  idea_feature: string;
  reason: string;
  replacement: string;
  /** Checked against `feature_row`'s attributes by the function itself. */
  replacement_columns: string[];
}

/** The `✗` class. Every replacement is a column that exists, or the call raises. */
export async function readDroppedFeatures(db: Database): Promise<DroppedFeature[]> {
  const rows = await db.execute<DroppedFeature & Record<string, unknown>>(
    sql`select * from feature_dropped_features()`,
  );
  return [...rows];
}

/** One of the A/B's three trainings, as arguments to `feature_rows`. */
export interface AbConfiguration {
  /** `A-full`, `A-common`, `B-common`. */
  run: string;
  feature_set: FeatureSet;
  /** `YYYY-MM-DD`, never before the set's own window. */
  window_from: string;
  gate_profile: GateProfile;
  isolates: string;
}

/**
 * The three trainings the A/B needs.
 *
 * Three and not two: comparing set A over 880 days against set B over 460
 * confounds feature content with window length, so the DESSEM-free set is
 * trained over both its own window and the common one. Every row is a legal
 * argument tuple for `feature_rows`, and the function refuses one that is not.
 */
export async function readAbConfigurations(db: Database): Promise<AbConfiguration[]> {
  const rows = await db.execute<AbConfiguration & Record<string, unknown>>(
    sql`select * from feature_ab_configurations()`,
  );
  return [...rows];
}

/**
 * How many rows a full-window build of one set produces, up to a date.
 *
 * Subsystems × local hours × days, counted through `feature_local_day_hours`
 * rather than multiplied by a literal 24 — so it cannot agree with a calendar
 * that lost an hour, which is the failure the 24-local-hours canary exists for.
 */
export async function readExpectedRowCount(
  db: Database,
  featureSet: FeatureSet,
  targetTo: string,
): Promise<number> {
  const rows = await db.execute<{ rows: string | number }>(sql`
    select feature_set_expected_rows(${featureSet}, ${targetTo}::date) as rows
  `);
  return Number([...rows][0]?.rows ?? 0);
}
