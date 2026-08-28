/**
 * The normalisation rules every ONS adapter applies at its boundary.
 *
 * Each rule here defends a finding from `docs/research/ons-datasets.md` that is
 * invisible in the code that would otherwise be written. They are collected in
 * one module so the fixture tests have a single thing to pin, and so no adapter
 * can quietly implement its own dialect of "canonical".
 */

/** WattSteer's canonical subsystem vocabulary. `SIN` is not a member. */
export type SubsystemCode = "N" | "NE" | "S" | "SE";

const SUBSYSTEM_CODES = new Set<string>(["N", "NE", "S", "SE"]);

/** ONS's national aggregate row. Never a subsystem — filtered at the boundary. */
export const AGGREGATE_SUBSYSTEM_CODE = "SIN";

/** What a raw `id_subsistema` turned out to be. */
export type SubsystemResolution =
  | { kind: "subsystem"; code: SubsystemCode }
  | { kind: "aggregate" }
  | { kind: "unknown"; raw: string };

/**
 * Trim unconditionally.
 *
 * Padding and stray whitespace appear unpredictably and inconsistently across
 * ONS files — `id_subsistema` is right-padded to three characters in the 2026
 * balanço file and unpadded in the 2000 one — so nothing is ever trimmed
 * conditionally or "where needed".
 */
export function trimmed(value: string): string {
  return value.trim();
}

/**
 * Canonicalise a raw `id_subsistema`.
 *
 * Padded (`"SE "`) and unpadded (`"SE"`) forms both resolve; `SIN` resolves to
 * the aggregate rather than to a fifth subsystem; anything else is unknown and
 * is rejected rather than defaulted.
 */
export function resolveSubsystem(raw: string): SubsystemResolution {
  const code = trimmed(raw).toUpperCase();
  if (code === AGGREGATE_SUBSYSTEM_CODE) {
    return { kind: "aggregate" };
  }
  if (SUBSYSTEM_CODES.has(code)) {
    return { kind: "subsystem", code: code as SubsystemCode };
  }
  return { kind: "unknown", raw };
}

/**
 * Parse an ONS decimal. `null` means the column was present but empty, which is
 * a distinct outcome from the column being absent and is never read as zero —
 * older balanço files write `0E-8` for a real zero, so an empty string means
 * "no value", not "nothing happened".
 */
export function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = trimmed(value);
  if (text === "") {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Convert an average-power value to energy using the source interval length.
 *
 * ONS publishes `val_*` in MWmed — mean power over the labelled interval — and
 * WattSteer stores MWh. At the hourly balanço grain the two are numerically
 * identical, which is precisely why this is a named function rather than an
 * omission: the half-hourly sources are not, and a later adapter that copies
 * this one must inherit the conversion rather than the coincidence.
 */
export function mwmedToMwh(mwmed: number, intervalMinutes: number): number {
  return mwmed * (intervalMinutes / 60);
}
