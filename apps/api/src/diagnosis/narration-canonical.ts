import type { JsonValue } from "@wattsteer/core/scenario";
import { canonicalJson } from "@wattsteer/core/scenario";
import { sha256Hex } from "@wattsteer/core/sha256";
import { NarrationPayloadError } from "./narration-payload.js";

/**
 * The canonical form of the narration document, built once.
 *
 * `docs/specs/diagnosis.md` keys three separate things on this one form — the
 * Redis cache key, the output validator's numeric whitelist and the snapshot
 * test — so it is derived here and nowhere else. Three canonicalisers that
 * agree today is the same failure mode as two regexes for one banned lexicon,
 * one layer along.
 *
 * ### Two rules, and why each one is not the obvious thing
 *
 * **Sorted keys** come from `packages/core`'s `canonicalJson`, which is RFC
 * 8785 (JCS) and is already the scenario hash's serialiser, already mirrored in
 * `apps/ml`'s `canonicalize_scenario`, and already pinned by shared golden
 * vectors. Writing a second sorter here would be writing a second definition of
 * "the same document".
 *
 * **Rounding before hashing** is the rule that is easy to get backwards. The
 * cache is keyed on content so that a retrain, a promotion or a superseding
 * weather run invalidates it by construction and nothing else does. But a `phi`
 * recomputed on a different machine can differ in the sixteenth decimal, and a
 * hash over raw doubles would call that a different day and pay for a second
 * language-model call that produces a byte-identical paragraph — because the
 * paragraph only ever quotes the number at its *display* precision. So every
 * float is rounded to the precision the product would print it at, and only
 * then hashed: a change the reader could see misses the cache, and a change
 * nobody could see hits it. `docs/specs/diagnosis.md` seam 12 is that
 * behaviour, stated as a test.
 *
 * ### The precision table is keyed by field name, and fails closed
 *
 * By **name**, not by path, for a reason the numeric whitelist depends on: the
 * same quantity appears in more than one place — `sum_abs_attributed_mwh` sits
 * both on the attribution and inside `attribution_is_noise`'s facts — and if
 * the two were rounded differently the document would offer the renderer two
 * spellings of one number and the validator would have to accept both.
 *
 * A numeric field with no entry in the table is a **failure**, not a default.
 * A new field arriving without a precision decision is exactly the accidental
 * addition that would silently invalidate every cached narration, and the honest
 * moment to notice is the one where somebody has to write down how it is
 * printed.
 */

/**
 * How precisely each number in the document is written down.
 *
 * The values follow the product's own formatters:
 * energy and power are printed to one decimal, a probability or a share is
 * printed as a whole percentage — two decimals of the fraction — and a feature
 * reading gets two, because a ratio near 1 says nothing at one.
 */
export const NARRATION_DISPLAY_PRECISION: Readonly<Record<string, number>> = {
  // The parameter that makes an hour curtailed at all.
  threshold_mw: 1,
  // Risk.
  day_occurrence_probability: 2,
  hours_p50_nonzero: 0,
  lowest_risk_bin_edge: 2,
  // Magnitude: energy and power, in the product's own unit.
  day_expected_mwh: 1,
  baseline_expected_mwh: 1,
  day_energy_p10_mwh: 1,
  day_energy_p50_mwh: 1,
  day_energy_p90_mwh: 1,
  peak_power_p50_mw: 1,
  peak_hour_local: 0,
  // The attribution itself.
  total_attributed_mwh: 1,
  sum_abs_attributed_mwh: 1,
  stderr_mwh: 1,
  attribution_stderr_mwh: 1,
  top_two_share: 2,
  phi_mwh: 1,
  share: 2,
  hour_disagreement: 1,
  // A group's headline reading, whose unit varies and whose interesting
  // movement is often in the second decimal.
  observed: 2,
  typical: 2,
  // Facts a rule fired on, and the settled reason mix.
  weather_run_age_hours: 1,
  weather_centroid_coverage: 2,
  top_reason_share: 2,
};

/** The cache key's namespace and version. Bumping it invalidates everything. */
const CACHE_NAMESPACE = "narration:v1";

/**
 * The canonical text of one narration document.
 *
 * Takes the `snake_case` document `narration-payload.ts` produced — already
 * closed and already checked for prose — because canonicalising an unvalidated
 * object would produce stable bytes for a document that must not exist.
 */
export function canonicalNarrationJson(document: Record<string, unknown>): string {
  return canonicalJson(round(document, "") as JsonValue);
}

/**
 * `sha256` over the canonical text, as bare hex.
 *
 * Bare rather than `sha256:`-prefixed because it is a component of a cache key
 * rather than a published identity; `ScenarioHash` is the prefixed one and the
 * two are not interchangeable.
 */
export function narrationPayloadDigest(document: Record<string, unknown>): string {
  return sha256Hex(new TextEncoder().encode(canonicalNarrationJson(document)));
}

/** Everything the key varies on, and nothing that it does not. */
export interface NarrationCacheKeyParts {
  promptVersion: string;
  modelId: string;
  locale: string;
  /** {@link narrationPayloadDigest} of the document this narration renders. */
  digest: string;
}

/**
 * `narration:v1:{prompt_version}:{model_id}:{locale}:{sha256(canonical(input))}`.
 *
 * Verbatim from the spec. The document already carries
 * `forecast_origin.run_label`, so a retrain, a promotion, a superseding 12Z run
 * and a changed `driver_group_version` all invalidate this key **by
 * construction** — there is no manual invalidation path to forget to call.
 * `prompt_version` and `model_id` are in the key because a prompt edit or a
 * model change produces different prose from identical facts.
 */
export function narrationCacheKey(parts: NarrationCacheKeyParts): string {
  return [
    CACHE_NAMESPACE,
    parts.promptVersion,
    parts.modelId,
    parts.locale,
    parts.digest,
  ].join(":");
}

/**
 * Every float at its display precision, everything else untouched.
 *
 * `path` carries the *field name* the value arrived under — an array index does
 * not change what a value is, so a list's members are rounded under the list's
 * own name.
 */
function round(value: unknown, name: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => round(item, name));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key] = round(member, key);
    }
    return out;
  }
  if (typeof value !== "number") {
    return value;
  }
  if (!Number.isFinite(value)) {
    throw new NarrationPayloadError(
      `${name} is ${String(value)}; a document a paragraph is written from carries finite numbers only`,
    );
  }
  const decimals = NARRATION_DISPLAY_PRECISION[name];
  if (decimals === undefined) {
    throw new NarrationPayloadError(
      `${name} has no display precision; a number with no decided precision cannot be canonicalised, and a field added without one silently invalidates every cached narration`,
    );
  }
  const rounded = Number(value.toFixed(decimals));
  // `-0` and `0` are the same number and JCS writes both as `0`; normalising
  // here keeps the rounded document equal to itself under `toEqual` too.
  return Object.is(rounded, -0) ? 0 : rounded;
}
