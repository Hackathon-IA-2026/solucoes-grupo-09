import type { FeatureSetModelInput } from "./feature-dictionary.js";
import type { FeatureSet } from "./feature-rows.js";

/**
 * The ordered model inputs, rendered as a generated artifact `apps/ml` can read
 * without a database.
 *
 * ## Why this exists at all
 *
 * `apps/ml`'s driver-group map is checked for *totality*: every model input is
 * in exactly one of the eight groups and every group member is a model input
 * (`diagnosis/driver_groups.py`, `assert_total_partition`). That check needs the
 * list of names, and the Python side has no database in its default test path —
 * no fixture, no container, no connection of any kind.
 *
 * Ticket 02 answered that by *transcribing* the spec's feature table into
 * `ordered_features.yaml` by hand. Ticket 14 retires it, and the reason is
 * worth stating precisely, because it is not the reason a second list is
 * usually retired. The transcription did not drift from
 * `feature_set_model_inputs()`; it matched it exactly — 77 names and 99 — while
 * both of them were one name short of `docs/specs/feature-engineering.md`,
 * whose class-`K` table has carried
 * `observed_constrained_off_same_hour_exceedance_7d` since ticket 05's merge.
 * A hand-transcribed list agreeing with the implementation it claims to check
 * is worse than one disagreeing with it: the disagreement is the only thing a
 * second list is for.
 *
 * ## The shape, and why this one
 *
 * A **generated artifact, checked in**, with the live check in the gated suite.
 *
 * The alternative the ticket names — a snapshot plus a staleness test — is the
 * same artifact with a weaker promise, because a snapshot nobody generates from
 * anything is a transcription with better manners. What makes this file
 * different from `ordered_features.yaml` is exactly one property: **no human
 * types a feature name into it.** It is `feature_set_model_inputs(set)`,
 * serialised, and `feature_set_model_inputs` is itself derived from
 * `pg_attribute` on `feature_row` and refuses to answer when the catalogue and
 * the type disagree. So the names in the artifact are the names in the type, at
 * one remove, and the only way a wrong name reaches `apps/ml` is by being wrong
 * in the composite type — where `feature_hash` is taken over it and the
 * dictionary raises about it.
 *
 * The staleness test is still needed, and it is
 * `database-features.test.ts` §"the generated model-input artifact": it renders
 * this artifact from the live database and compares it to the checked-in bytes.
 * It runs where a database exists and nowhere else, which is the right place
 * for the one assertion that cannot be made without one.
 *
 * ## Rendered rather than `JSON.stringify`-ed at the call site
 *
 * Because the test compares *bytes*. Two callers that agree on the content and
 * disagree on the trailing newline would produce a staleness failure that is
 * about formatting, and a failure nobody believes is a failure nobody acts on.
 */

/**
 * Where the artifact lives, relative to the repository root.
 *
 * Inside the Python package rather than beside this module: it is imported by
 * `wattsteer_ml.diagnosis.driver_groups` at load time, so it has to ship in the
 * wheel the way `driver_groups.yaml` beside it does.
 */
export const MODEL_INPUTS_ARTIFACT_PATH =
  "apps/ml/src/wattsteer_ml/diagnosis/model_inputs.json";

/** How the artifact says it was made — checked by the Python reader. */
export const MODEL_INPUTS_GENERATOR = "apps/api/src/features/model-inputs-artifact.ts";

/** The function the names come from. Also checked by the Python reader. */
export const MODEL_INPUTS_SOURCE = "feature_set_model_inputs(feature_set)";

/** One model input, as the artifact records it. */
export interface ModelInputArtifactEntry {
  /** 1-based position within the set, in the composite type's own order. */
  input_index: number;
  column_name: string;
  /** `K`, `W+T`, `P+W+T` — the spec's notation, straight from the dictionary. */
  class_label: string;
  /** `null` for `subsystem`, which is an input and not a measurement. */
  grain: "hour" | "day" | null;
  available_at_gate_early: boolean;
}

/** The whole artifact. */
export interface ModelInputsArtifact {
  generated_by: string;
  source: string;
  /**
   * The prose that stops somebody editing it. Rendered into the file because a
   * JSON file has nowhere else to put a comment, and a generated file with no
   * statement that it is generated is a file somebody will fix by hand.
   */
  do_not_edit: string;
  /** Attribute count of `feature_row` — the number `feature_hash` moves with. */
  feature_row_attributes: number;
  sets: Record<FeatureSet, ModelInputArtifactEntry[]>;
}

const DO_NOT_EDIT =
  "Generated. Do not edit by hand. This file is feature_set_model_inputs(set) " +
  "serialised, and that function derives its names from pg_attribute on the " +
  "feature_row composite type. Regenerate with `bun run --cwd apps/api " +
  "features:snapshot` against a migrated database; " +
  "database-features.test.ts fails when it is stale. It replaces " +
  "ordered_features.yaml, which was transcribed by hand and agreed with the " +
  "implementation rather than with its stated authority.";

const entry = (input: FeatureSetModelInput): ModelInputArtifactEntry => ({
  input_index: input.input_index,
  column_name: input.column_name,
  class_label: input.class_label,
  grain: input.grain,
  available_at_gate_early: input.available_at_gate_early,
});

/**
 * The artifact, from what the database returned.
 *
 * `featureRowAttributes` is the length of `readFeatureDictionary`, not a count
 * of the inputs: the dictionary covers the identity, stamp and label columns
 * too, and it is the dictionary's length — the type's attribute count — that
 * `feature_hash` moves with.
 */
export const buildModelInputsArtifact = (
  inputs: Record<FeatureSet, FeatureSetModelInput[]>,
  featureRowAttributes: number,
): ModelInputsArtifact => ({
  generated_by: MODEL_INPUTS_GENERATOR,
  source: MODEL_INPUTS_SOURCE,
  do_not_edit: DO_NOT_EDIT,
  feature_row_attributes: featureRowAttributes,
  sets: {
    dessem_free_v1: inputs.dessem_free_v1.map(entry),
    dessem_augmented_v1: inputs.dessem_augmented_v1.map(entry),
  },
});

/** The artifact's bytes. Two spaces and one trailing newline, always. */
export const renderModelInputsArtifact = (artifact: ModelInputsArtifact): string =>
  `${JSON.stringify(artifact, null, 2)}\n`;
