import type {
  Narration,
  NarrationClause,
  NarrationFromTemplate,
  UnitCode,
} from "@wattsteer/core/api";
import type { Copy } from "./copy.en";
import { type Formatters, fill, formatTag } from "./format";

/**
 * The deterministic narration, said in the reader's language and notation.
 *
 * `docs/specs/diagnosis.md` gives the Explain panel two narration surfaces. The
 * language model's arrives as prose, generated in the requested locale — the
 * single settled exception to "codes on the wire, the client renders the
 * words". The template's arrives as **a plan**: an ordered list of `t()` keys
 * and the values their placeholders take, assembled by
 * `apps/api/src/diagnosis/narration-template.ts` from the same closed document
 * the model would have been given.
 *
 * This module is the other half of that. It looks each key up in the active
 * catalogue and formats each value through `Intl`, which is the whole reason
 * the split exists: `412,0` and `412.0` are the same number and different
 * strings, and which one a reader sees is a property of the reader. A server
 * that had already joined the digits to a decimal separator would have decided
 * it, in one locale, for everyone.
 *
 * Three rules it keeps, all of them the catalogue's own:
 *
 * 1. **A placeholder is a value, never a sentence.** Every one is filled by a
 *    formatter, by a date, or by a label this catalogue owns for a code the
 *    server sent. No clause is interpolated into another clause.
 * 2. **Units and notation are not translated.** `MW`, `MWh`, `m/s`, `%` and
 *    `h` read the same in both locales, so they are appended here rather than
 *    stored in the dictionaries.
 * 3. **A value with no formatter is a failure.** Silently falling back to
 *    `String(value)` would print `412.0` inside a Portuguese paragraph, which
 *    is exactly the bug the plan exists to prevent, and it would do it quietly.
 */

/**
 * How each value in a clause is written, keyed by the **document field name**
 * it was read under.
 *
 * By name rather than by position, and the names are the payload's own, so a
 * catalogue string names the field it quotes and this table can be read beside
 * `apps/api/src/diagnosis/narration-canonical.ts`'s precision table — which is
 * keyed the same way, for the same reason.
 */
type Formatter = (value: string | number | unknown[], context: Context) => string;

interface Context {
  copy: Copy;
  f: Formatters;
  /** The clause's own values: `observed` cannot be written without `unit`. */
  clause: NarrationClause;
}

/** Energy and power, at the precision the product prints them. */
function mwh(value: number, f: Formatters): string {
  return `${f.number(value, 1)} MWh`;
}

/** A group's headline reading, whose unit varies and whose movement is small. */
function reading(value: number, unit: UnitCode, f: Formatters): string {
  switch (unit) {
    case "mwh":
      return `${f.number(value, 2)} MWh`;
    case "mw":
      return `${f.number(value, 2)} MW`;
    case "pct":
      return f.percentPoints(value, 1);
    case "hours":
      return `${f.number(value, 2)} h`;
    case "brl":
      return f.brl(value, 2);
    case "count":
      return f.number(value, 0);
    case "m_s":
      return `${f.number(value, 2)} m/s`;
    default:
      return f.number(value, 2);
  }
}

function asNumber(value: string | number | unknown[]): number {
  if (typeof value !== "number") {
    throw new Error(`narration clause value is not a number: ${JSON.stringify(value)}`);
  }
  return value;
}

function asText(value: string | number | unknown[]): string {
  if (typeof value !== "string") {
    throw new Error(`narration clause value is not a code: ${JSON.stringify(value)}`);
  }
  return value;
}

function unitOf(clause: NarrationClause): UnitCode {
  const unit = clause.values.unit;
  if (typeof unit !== "string") {
    throw new Error(`narration clause ${clause.key} quotes a reading with no unit`);
  }
  return unit as UnitCode;
}

const percent: Formatter = (value, { f }) => f.percent(asNumber(value));
const energy: Formatter = (value, { f }) => mwh(asNumber(value), f);
const headline: Formatter = (value, context) =>
  reading(asNumber(value), unitOf(context.clause), context.f);

const FORMATTERS: Readonly<Record<string, Formatter>> = {
  // ONS's own proper noun, and the two dates. Untranslated by decision.
  subsystem_display_name: (value) => asText(value),
  target_date: (value, { f }) => f.date(asText(value)),
  date: (value, { f }) => f.date(asText(value)),
  top_reason: (value) => asText(value),
  // The parameter that makes an hour curtailed at all.
  threshold_mw: (value, { f }) => `${f.number(asNumber(value))} MW`,
  // Risk.
  day_occurrence_probability: percent,
  lowest_risk_bin_edge: percent,
  hours_p50_nonzero: (value, { f }) => f.number(asNumber(value)),
  // Magnitude.
  day_expected_mwh: energy,
  baseline_expected_mwh: energy,
  total_attributed_mwh: energy,
  peak_power_p50_mw: (value, { f }) => `${f.number(asNumber(value), 1)} MW`,
  peak_hour_local: (value, { f }) => f.hour(asNumber(value)),
  // The attribution itself.
  code: (value, { copy }) => copy.app.drivers.groups[asText(value) as GroupCode],
  share: percent,
  top_two_share: percent,
  phi_mwh: energy,
  hour_disagreement: (value, { f }) => f.number(asNumber(value), 1),
  observed: headline,
  typical: headline,
  // Consumed by `observed` and `typical`; it is notation, not a sentence, and
  // it never appears as a placeholder of its own.
  unit: (value) => asText(value),
  // The facts the rules fired on.
  sum_abs_attributed_mwh: energy,
  attribution_stderr_mwh: energy,
  weather_run_age_hours: (value, { f }) => `${f.number(asNumber(value), 1)} h`,
  weather_centroid_coverage: percent,
  top_reason_share: percent,
  null_headline_features: (value, { f }) => {
    if (!Array.isArray(value)) {
      throw new Error("null_headline_features is not a list");
    }
    return new Intl.ListFormat(formatTag(f.locale), {
      style: "long",
      type: "conjunction",
    }).format(value.map((one) => String(one)));
  },
};

type GroupCode = keyof Copy["app"]["drivers"]["groups"];

/** Every value name this module knows how to write. A test reads it. */
export const NARRATION_VALUE_NAMES: readonly string[] = Object.keys(FORMATTERS);

/**
 * One clause, as a sentence.
 *
 * Exported because the clause is the unit worth testing: a paragraph assertion
 * that fails tells you a sentence changed, and not which one.
 */
export function renderNarrationClause(
  clause: NarrationClause,
  copy: Copy,
  f: Formatters,
): string {
  const context: Context = { copy, f, clause };
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(clause.values)) {
    const formatter = FORMATTERS[name];
    if (formatter === undefined) {
      throw new Error(
        `narration clause ${clause.key} carries ${name}, which has no formatter; a value written without one would print the server's decimal separator`,
      );
    }
    values[name] = formatter(value, context);
  }
  return fill(copy.app.narration[clause.key], values);
}

/** The whole deterministic paragraph, one clause per sentence. */
export function renderNarrationTemplate(
  narration: NarrationFromTemplate,
  copy: Copy,
  f: Formatters,
): string {
  return narration.clauses
    .map((clause) => renderNarrationClause(clause, copy, f))
    .join(" ");
}

/**
 * The paragraph, whichever surface produced it.
 *
 * The model's is already prose in the requested locale and is returned as it
 * arrived; nothing here reformats it, because every number in it has already
 * been through the output validator's numeric whitelist at the precision the
 * document carries.
 */
export function renderNarration(narration: Narration, copy: Copy, f: Formatters): string {
  return narration.source === "model"
    ? narration.text
    : renderNarrationTemplate(narration, copy, f);
}
