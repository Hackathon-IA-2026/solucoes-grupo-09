/**
 * Regenerate `apps/ml/src/wattsteer_ml/diagnosis/model_inputs.json`.
 *
 *     DATABASE_URL=... bun run --cwd apps/api features:snapshot
 *
 * Against a **migrated** database — the names come from
 * `feature_set_model_inputs`, which reads `pg_attribute` on `feature_row`, so a
 * database behind the migration tree produces a perfectly well-formed artifact
 * for the wrong tree. That is why the staleness assertion is a test against a
 * freshly migrated container rather than a check inside this script: this
 * script has no way to know which tree it is looking at, and the test does.
 *
 * An entry point in `src/` rather than a loose file in a `scripts/` directory,
 * so `tsc --noEmit` covers it. A generator that stops compiling is how a
 * generated artifact quietly becomes a hand-maintained one.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "../database/connection.js";
import {
  readFeatureDictionary,
  readFeatureSetModelInputs,
} from "./feature-dictionary.js";
import {
  buildModelInputsArtifact,
  MODEL_INPUTS_ARTIFACT_PATH,
  renderModelInputsArtifact,
} from "./model-inputs-artifact.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required: the names come from the database.");
  process.exit(1);
}

const handle = createDatabase(url, 5);
try {
  const artifact = buildModelInputsArtifact(
    {
      dessem_free_v1: await readFeatureSetModelInputs(handle.db, "dessem_free_v1"),
      dessem_augmented_v1: await readFeatureSetModelInputs(
        handle.db,
        "dessem_augmented_v1",
      ),
    },
    (await readFeatureDictionary(handle.db)).length,
  );
  // `src/features/` → the repository root is four levels up.
  writeFileSync(
    join(import.meta.dir, "../../../..", MODEL_INPUTS_ARTIFACT_PATH),
    renderModelInputsArtifact(artifact),
    "utf8",
  );
  console.log(
    `${MODEL_INPUTS_ARTIFACT_PATH}: ` +
      `${artifact.sets.dessem_free_v1.length} / ` +
      `${artifact.sets.dessem_augmented_v1.length} inputs over ` +
      `${artifact.feature_row_attributes} attributes`,
  );
} finally {
  await handle.close();
}
