/**
 * The normalisation rules every ONS adapter applies at its boundary.
 *
 * Each rule here defends a finding from `docs/research/ons-datasets.md` that is
 * invisible in the code that would otherwise be written. They are collected in
 * one module so the fixture tests have a single thing to pin, and so no adapter
 * can quietly implement its own dialect of "canonical".
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import type { SubsystemCode } from "@wattsteer/core/domain";

/**
 * WattSteer's canonical subsystem vocabulary. `SIN` is not a member.
 *
 * Re-exported from `@wattsteer/core/domain` rather than restated: this module
 * is where every ONS adapter learns what a subsystem is, and a second literal
 * union here is how the ingest side would come to hold an opinion the gateway
 * and the web app do not share. The name stays exported from here so the
 * adapters and repositories that already import it keep reading the vocabulary
 * from the module that also holds the normalisation rules — they now get the
 * published definition through it.
 */
export type { SubsystemCode } from "@wattsteer/core/domain";

/**
 * The membership test, derived from the published list rather than typed out.
 * A fifth entry in `SUBSYSTEMS` would be accepted here without this file being
 * edited, which is the point: the enum is closed in one place.
 */
const SUBSYSTEM_MEMBERS = new Set<string>(SUBSYSTEM_DISPLAY_ORDER);

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
  if (SUBSYSTEM_MEMBERS.has(code)) {
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

/**
 * Parse a plain calendar date from an ONS registry file.
 *
 * The registry datasets (`capacidade-geracao`, `usina_conjunto`) write dates as
 * bare `YYYY-MM-DD` with no time and no zone — unlike `din_instante`, which is
 * a Brasília wall clock and needs the full IANA treatment in `time.ts`. A
 * commissioning date is a calendar day, not an instant in Brasília, so it is
 * anchored at UTC midnight: that is the reading under which
 * `commissioned_on <= t` means "on or after that day" in every timezone the
 * question is ever asked from.
 *
 * `null` means the column was present but empty — which is meaningful data in
 * both files (`dat_desativacao` empty = still running; `dat_fimrelacionamento`
 * empty = still a member). `NaN`-carrying dates are impossible to express, so
 * an unparsable value is reported as `invalid` rather than coerced.
 */
export function parseSourceDate(
  value: string | null | undefined,
): { date: Date | null } | { invalid: string } {
  if (value === null || value === undefined) {
    return { date: null };
  }
  const text = trimmed(value);
  if (text === "") {
    return { date: null };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { invalid: text };
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? { invalid: text } : { date };
}

/** Truncate an instant to the UTC midnight of the calendar day it falls in. */
export function toUtcDay(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}
