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
 * How a number is written down, once the digits are decided.
 *
 * Three notations, because the client's formatters have three and the
 * validator's numeric whitelist has to spell a payload value the way a reader
 * would actually see it:
 *
 *  - `plain` — the digits, grouped, with the field's own unit appended.
 *  - `percent` — a fraction in `[0, 1]` written as a percentage. `decimals`
 *    stays the precision of the **fraction**, so a whole percentage is two
 *    decimals and a tenth of a percentage point is three. The `×100` is a
 *    notation, not a different precision, and keeping the table in one unit is
 *    what lets a single number be compared against the client's formatter.
 *  - `hour` — a wall-clock hour on the grid's day, written `13:00`. Zero
 *    decimals by construction; an hour index is a whole number of hours.
 */
export type NarrationDisplayStyle = "plain" | "percent" | "hour";

/** One field's display decision: how many digits, and in which notation. */
export interface NarrationFieldDisplay {
  /** Fraction digits, always of the value **as the document carries it**. */
  decimals: number;
  /** The notation the product prints those digits in. */
  style: NarrationDisplayStyle;
}

/**
 * How precisely — and in what notation — each number in the document is
 * written down.
 *
 * The values follow the product's own formatters:
 * energy and power are printed to one decimal, a probability or a share is
 * printed as a whole percentage — two decimals of the fraction — and a feature
 * reading gets two, because a ratio near 1 says nothing at one.
 *
 * ### This table is tied to the client's, on decimals rather than membership
 *
 * `apps/web/src/i18n/narration.ts` holds the formatter each of these fields is
 * printed through, and the two tables were originally matched by hand. Neither
 * is a subset of the other and neither should be — this one prices
 * `day_energy_p10_mwh`, which no clause carries, and the client formats
 * `target_date`, which is a string this one is right not to round. So the
 * relation that actually has to hold is **decimals**: for a field in both
 * tables, the digits the client displays are the precision this table hashed
 * at. `test/narration-precision-tie.test.ts` asserts it by invoking each
 * client formatter and counting the fraction digits it emitted, which is why
 * `style` is here: a percent formatter multiplies by a hundred and would
 * otherwise look like two fewer decimals than it is.
 *
 * The failure that tie catches is a quiet one. A rename or a decimals change on
 * one side leaves this table rounding a field nobody displays while a displayed
 * one goes unrounded, and the narration cache then misses forever at a cost
 * nobody attributes to a table entry.
 */
export const NARRATION_DISPLAY: Readonly<Record<string, NarrationFieldDisplay>> = {
  // The parameter that makes an hour curtailed at all. A whole number of MW by
  // decision — `docs/domain-model.md` §5 commits to 5 MW at subsystem grain and
  // 1 MW at reporting-entity grain, and the sweep it defers tries 1 / 5 / 10 —
  // so it is displayed and hashed as one. It was priced at one decimal here
  // while the client printed it at zero, which is exactly the disagreement the
  // tie test now refuses.
  threshold_mw: { decimals: 0, style: "plain" },
  // Risk.
  day_occurrence_probability: { decimals: 2, style: "percent" },
  hours_p50_nonzero: { decimals: 0, style: "plain" },
  lowest_risk_bin_edge: { decimals: 2, style: "percent" },
  // Magnitude: energy and power, in the product's own unit.
  day_expected_mwh: { decimals: 1, style: "plain" },
  baseline_expected_mwh: { decimals: 1, style: "plain" },
  day_energy_p10_mwh: { decimals: 1, style: "plain" },
  day_energy_p50_mwh: { decimals: 1, style: "plain" },
  day_energy_p90_mwh: { decimals: 1, style: "plain" },
  peak_power_p50_mw: { decimals: 1, style: "plain" },
  peak_hour_local: { decimals: 0, style: "hour" },
  // The attribution itself.
  total_attributed_mwh: { decimals: 1, style: "plain" },
  sum_abs_attributed_mwh: { decimals: 1, style: "plain" },
  stderr_mwh: { decimals: 1, style: "plain" },
  attribution_stderr_mwh: { decimals: 1, style: "plain" },
  top_two_share: { decimals: 2, style: "percent" },
  phi_mwh: { decimals: 1, style: "plain" },
  share: { decimals: 2, style: "percent" },
  hour_disagreement: { decimals: 1, style: "plain" },
  // A group's headline reading, whose unit varies and whose interesting
  // movement is often in the second decimal. The one pair whose *client*
  // decimals vary — by `unit`, which is a property of the row rather than of
  // the field — so the tie test asserts a bound and enumerates the units.
  observed: { decimals: 2, style: "plain" },
  typical: { decimals: 2, style: "plain" },
  // Facts a rule fired on, and the settled reason mix.
  weather_run_age_hours: { decimals: 1, style: "plain" },
  weather_centroid_coverage: { decimals: 2, style: "percent" },
  top_reason_share: { decimals: 2, style: "percent" },
};

/**
 * The same table, decimals only — what the rounder and the snapshot test read.
 *
 * Derived rather than restated: a second literal that agreed today is the
 * failure this module's own header objects to, one layer smaller.
 */
export const NARRATION_DISPLAY_PRECISION: Readonly<Record<string, number>> =
  Object.fromEntries(
    Object.entries(NARRATION_DISPLAY).map(([name, display]) => [name, display.decimals]),
  );

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
