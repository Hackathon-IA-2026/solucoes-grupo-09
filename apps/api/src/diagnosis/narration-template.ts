import type {
  DiagnosisNarrationInput,
  Driver,
  NarrationClause,
  NarrationClauseKey,
  NarrationFromTemplate,
  RuleFlag,
} from "@wattsteer/core/api";
import { UpstreamError } from "../errors.js";
import { notableNarrationGroups } from "./narration-payload.js";

/**
 * The narration that is always there, and that never needed a model.
 *
 * `docs/specs/diagnosis.md` gives the Explain panel two narration surfaces and
 * `./narration-gate.ts` decides between them by handing the model's as a thunk
 * it may decline to call. This is the other branch of that decision — not a
 * fallback bolted on underneath one. It renders when a rule withheld, when the
 * language model is down and when the daily cap is reached, and it ships ahead
 * of the model call so the endpoint is complete and useful with no
 * language-model dependency at all.
 *
 * Its input is the same closed document the model's is: `./narration-payload.ts`
 * assembled it, `assertCodesOnly` proved nothing in it is prose, and nothing
 * else is read here. No database, no cache, no network.
 *
 * ### It emits a plan, not a paragraph
 *
 * The one thing this module deliberately does **not** do is write a sentence.
 * It emits an ordered list of `t()` keys and the values their placeholders take;
 * the words live in `apps/web/src/i18n/copy.{pt,en}.ts` and the numbers are
 * formatted by `apps/web/src/i18n/narration.ts` through `Intl`, in the reader's
 * locale.
 *
 * Two rules make that necessary rather than stylistic:
 *
 * 1. **`412,0` and `412.0` are the same number and different strings.** Which
 *    one a reader sees is a property of the reader, and a server that had
 *    already joined the digits to a decimal separator would have decided it. So
 *    every number crosses the wire as a number, exactly as `observed` and
 *    `typical` do on the driver rows beside it.
 * 2. **A template is a fixed string catalogue**, which is what
 *    `docs/specs/i18n.md` says the API returns everywhere except generated
 *    prose. Assembling one here would put user-facing copy in a server module,
 *    which is the leak `test/i18n-hardcoded-copy.test.ts`'s server scope now
 *    exists to catch. There is no string in this file that a user could read.
 *
 * ### It says what the model would say, and stops where the model stops
 *
 * The clause list is the system prompt's required content, item for item: the
 * risk class, the day's expected MWh against the baseline, the top two
 * displayed groups with their directions and their `observed`/`typical` pair,
 * the pre-computed `top_two_share`, a both-directions clause for any displayed
 * group whose hours disagree, and **every** fired rule. No hedging the model
 * would not do, and no fact the model would not have.
 *
 * The `docs/domain-model.md` §10 boundary holds here for the same reason it
 * holds in the payload: the only word this module chooses about a group is
 * `raises` or `lowers`, which is a statement about the **model's output**, and
 * it chooses it by reading `direction` off the document rather than by deciding
 * anything. Everything else it emits is a number or a code.
 *
 * ### The display cut is shared, the merge is not
 *
 * Which groups may be named comes from `packages/core`'s one predicate through
 * {@link notableNarrationGroups} — `share >= 0.03`, top six — because the spec
 * requires a *displayed* group with `hour_disagreement >= 2.0` to be reported
 * as having acted in both directions, and a server that could not tell which
 * groups are displayed could not obey that. The merge into `other` and its
 * `direction: "mixed"` stay client-side and are not reachable from here.
 */

/** A payload no deterministic paragraph can be planned from, and why. */
export class NarrationTemplateError extends UpstreamError {
  constructor(message: string) {
    super(`narration template: ${message}`);
    this.name = "NarrationTemplateError";
  }
}

/**
 * When a group's hours disagree enough to be worth saying so.
 *
 * `docs/specs/diagnosis.md`'s system prompt makes this a requirement of the
 * model's own paragraph; the template says the same thing at the same threshold,
 * because two narration surfaces that disagree about whether a driver reversed
 * during the day are two products.
 */
const BOTH_DIRECTIONS_FROM = 2.0;

/** How many displayed groups the paragraph names. The spec's "top two". */
const NAMED_GROUPS = 2;

/**
 * The clause each fired rule is stated with.
 *
 * A map rather than a `switch` with a default, and consulted through
 * {@link flagClauses}, so that a rule shipped upstream without a sentence is a
 * loud failure here rather than a paragraph that quietly omits it. The spec
 * requires the narration to state **every** `rule_flags` entry, and the only
 * way to keep that true of a rule nobody has written copy for yet is to refuse
 * to render.
 *
 * `stale_inputs` is the one rule with more than one clause: it fires on three
 * independent degradations, reports a null for the ones that did not happen,
 * and a single sentence would have to either invent a reading for a null or
 * drop the degradation that actually fired.
 */
const FLAG_CLAUSES: Readonly<Record<string, (flag: RuleFlag) => NarrationClause[]>> = {
  nothing_to_explain: (flag) => [
    {
      key: "flag_nothing_to_explain",
      values: {
        day_occurrence_probability: numberFact(flag, "day_occurrence_probability"),
        lowest_risk_bin_edge: numberFact(flag, "lowest_risk_bin_edge"),
        hours_p50_nonzero: numberFact(flag, "hours_p50_nonzero"),
      },
    },
  ],
  attribution_is_noise: (flag) => [
    {
      key: "flag_attribution_is_noise",
      values: {
        sum_abs_attributed_mwh: numberFact(flag, "sum_abs_attributed_mwh"),
        attribution_stderr_mwh: numberFact(flag, "attribution_stderr_mwh"),
      },
    },
  ],
  stale_inputs: staleInputsClauses,
  unmodelled_outage_regime: (flag) => [
    {
      key: "flag_unmodelled_outage_regime",
      values: {
        date: stringFact(flag, "settled_date"),
        top_reason: stringFact(flag, "top_reason"),
        top_reason_share: numberFact(flag, "top_reason_share"),
      },
    },
  ],
};

/**
 * The whole deterministic narration, ready to be returned as `narration`.
 *
 * The locale and the prompt version are the payload's own: a template cached
 * under one prompt version must not be served under another, and the panel's
 * footnote states the locale the paragraph was produced in either way.
 *
 * @param payload the closed document, exactly as the model would have received.
 */
export function templateNarration(
  payload: DiagnosisNarrationInput,
): NarrationFromTemplate {
  return {
    source: "template",
    clauses: narrationClauses(payload),
    locale: payload.locale,
    promptVersion: payload.promptVersion,
  };
}

/**
 * The clauses, in reading order.
 *
 * Exported because the property worth testing is which sentences a document
 * produces, and a test that has to unwrap an envelope to see them asserts
 * something weaker.
 */
export function narrationClauses(payload: DiagnosisNarrationInput): NarrationClause[] {
  const named = notableNarrationGroups(payload);
  if (named.length === 0) {
    throw new NarrationTemplateError(
      "no group cleared the display cut; shares are normalised over all eight groups, so at least one of them always does, and a document where none did is a document whose shares do not sum",
    );
  }
  const top = named.slice(0, NAMED_GROUPS);
  return [
    riskClause(payload),
    magnitudeClause(payload),
    peakClause(payload),
    ...top.map((group) => driverClause(group)),
    ...(top.length === NAMED_GROUPS ? [topTwoShareClause(payload)] : []),
    ...named.filter(disagrees).map((group) => disagreementClause(group)),
    ...payload.ruleFlags.flatMap((flag) => flagClauses(flag)),
  ];
}

/** The risk class as its own key, so the class name is authored, not filled. */
function riskClause(payload: DiagnosisNarrationInput): NarrationClause {
  const key: NarrationClauseKey =
    payload.risk.riskClass === "high"
      ? "risk_high"
      : payload.risk.riskClass === "elevated"
        ? "risk_elevated"
        : "risk_low";
  return {
    key,
    values: {
      subsystem_display_name: payload.subsystemDisplayName,
      target_date: payload.targetDate,
      threshold_mw: payload.thresholdMw,
      day_occurrence_probability: payload.risk.dayOccurrenceProbability,
      hours_p50_nonzero: payload.risk.hoursP50Nonzero,
    },
  };
}

/**
 * The day against its baseline, and the difference between them.
 *
 * `total_attributed_mwh` is carried rather than subtracted here for the same
 * reason `top_two_share` is a field: a narration surface that performs correct
 * arithmetic is indistinguishable from one that performed incorrect arithmetic,
 * and the document already holds the answer.
 */
function magnitudeClause(payload: DiagnosisNarrationInput): NarrationClause {
  return {
    key: "magnitude",
    values: {
      day_expected_mwh: payload.magnitude.dayExpectedMwh,
      baseline_expected_mwh: payload.magnitude.baselineExpectedMwh,
      total_attributed_mwh: payload.attribution.totalAttributedMwh,
    },
  };
}

function peakClause(payload: DiagnosisNarrationInput): NarrationClause {
  return {
    key: "peak",
    values: {
      peak_power_p50_mw: payload.magnitude.peakPowerP50Mw,
      peak_hour_local: payload.magnitude.peakHourLocal,
    },
  };
}

/**
 * One named group: which way the model moved, and what it was reading.
 *
 * The direction picks the key rather than filling a placeholder, so `raises`
 * and `lowers` are authored into whole sentences in both locales instead of
 * being two words dropped into one. `code` and `unit` travel as codes: the
 * client holds the group's label and appends the unit's symbol, neither of
 * which a server may spell.
 */
function driverClause(group: Driver): NarrationClause {
  return {
    key: group.direction === "raises" ? "driver_raises" : "driver_lowers",
    values: {
      code: group.code,
      share: group.share,
      phi_mwh: group.phiMwh,
      observed: group.observed,
      typical: group.typical,
      unit: group.unit,
    },
  };
}

function topTwoShareClause(payload: DiagnosisNarrationInput): NarrationClause {
  return {
    key: "top_two_share",
    values: { top_two_share: payload.attribution.topTwoShare },
  };
}

function disagrees(group: Driver): boolean {
  return group.hourDisagreement >= BOTH_DIRECTIONS_FROM;
}

function disagreementClause(group: Driver): NarrationClause {
  return {
    key: "hour_disagreement",
    values: { code: group.code, hour_disagreement: group.hourDisagreement },
  };
}

/** Every fired rule gets stated, or nothing is rendered. */
function flagClauses(flag: RuleFlag): NarrationClause[] {
  const clauses = FLAG_CLAUSES[flag.code];
  if (clauses === undefined) {
    throw new NarrationTemplateError(
      `${flag.code} fired and has no clause; the narration is required to state every rule that fired, and a rule shipped without a sentence has to fail here rather than go unsaid`,
    );
  }
  return clauses(flag);
}

/**
 * `stale_inputs`, one clause per degradation that actually happened.
 *
 * The rule fires on any of three conditions and reports a null for the two
 * that did not, so the clauses are chosen by which facts are present. A firing
 * with no representable degradation is refused: it would render as silence
 * about a rule the spec requires to be stated.
 */
function staleInputsClauses(flag: RuleFlag): NarrationClause[] {
  const clauses: NarrationClause[] = [];
  const runAge = flag.facts.weather_run_age_hours;
  const coverage = flag.facts.weather_centroid_coverage;
  const headlines = flag.facts.null_headline_features;
  if (typeof runAge === "number") {
    clauses.push({
      key: "flag_stale_inputs_run_age",
      values: { weather_run_age_hours: runAge },
    });
  }
  if (typeof coverage === "number") {
    clauses.push({
      key: "flag_stale_inputs_coverage",
      values: { weather_centroid_coverage: coverage },
    });
  }
  if (Array.isArray(headlines) && headlines.length > 0) {
    clauses.push({
      key: "flag_stale_inputs_headline",
      values: { null_headline_features: headlines.map((one) => String(one)) },
    });
  }
  if (clauses.length === 0) {
    throw new NarrationTemplateError(
      "stale_inputs fired with none of the three degradations it fires on; a rule flag is the record of what a rule read, and one that records nothing cannot be stated",
    );
  }
  return clauses;
}

function numberFact(flag: RuleFlag, name: string): number {
  const value = flag.facts[name];
  if (typeof value !== "number") {
    throw new NarrationTemplateError(
      `${flag.code} fired without a numeric ${name}; the clause that states it quotes that number and cannot invent one`,
    );
  }
  return value;
}

function stringFact(flag: RuleFlag, name: string): string {
  const value = flag.facts[name];
  if (typeof value !== "string") {
    throw new NarrationTemplateError(
      `${flag.code} fired without ${name}; the clause that states it quotes that value and cannot invent one`,
    );
  }
  return value;
}
