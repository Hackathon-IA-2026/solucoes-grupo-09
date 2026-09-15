/**
 * What the reader is looking at, as a paragraph the model is given each turn.
 *
 * `docs/plans/voice-copilot.md` §3.4. The agent has no eyes: it cannot see the
 * map, and if it is not told that the Northeast is at high risk it will either
 * stay silent or make something up. So before each turn the provider pushes a
 * compact block through `session.update` describing the selection, the screen
 * and — the part that matters — **what is and is not available**.
 *
 * ## It is a pure function of data already fetched
 *
 * It issues no request. `use-network.ts`, `use-explain.ts` and `use-serving.ts`
 * hold the answers; this module takes their *states* and renders them. The
 * alternative — a context builder with its own `fetch` — would give the agent a
 * second read of the same question, and `use-serving.ts` has already written
 * down what that costs:
 *
 * > If those came from two requests they could be answered a second apart by a
 * > gateway mid-promotion, and the page would carry a badge saying "no model
 * > promoted" above a panel showing a forecast.
 *
 * Same defect, louder: the screen would show a refusal while the voice read out
 * a band. The states arrive as `import type` only, so nothing here pulls React
 * in — `voice-tools.test.ts` walks the runtime import graph and proves it.
 *
 * ## The absence is the load-bearing line
 *
 * As of 2026-09-15 nothing is promoted. Both lanes are `present_unpromoted`,
 * the hot-swap gate having refused the only artifact on each — the late lane on
 * `coverage_p10_in_band` at 0.8114 against [0.85, 0.97] — so
 * `/v1/forecast/day-ahead` and `/v1/grid/outlook` answer
 * `FORECAST_NOT_YET_PUBLISHED` / `FORECAST_UNAVAILABLE` and `/v1/model/card`
 * answers `MODEL_UNAVAILABLE`. `absence.ts` records the measurement.
 *
 * That is the normal state, not an outage, and the block says so in a sentence
 * of its own. §3.4: *"An agent that cheerfully invents a P50 during a demo is
 * worse than no agent."* The absence line and `instructions.ts`'s refusal
 * clause are the two halves of one guarantee, and neither works without the
 * other: an instruction not to invent figures is unenforceable if the model is
 * never told that there are none.
 *
 * ## Why this block is English in both locales
 *
 * It is machine-facing. Nothing in it reaches a text node, and
 * `i18n-hardcoded-copy.test.ts` scopes itself to `src/app` and `src/components`
 * for exactly that distinction. Writing it twice would double the surface on
 * which the two locales could describe *different grids* — a Portuguese reader
 * hearing about a different band than an English one — which is a worse failure
 * than machine-facing English. What is per-locale is the **instruction to
 * answer in the reader's language**, which is stated here as a line of the
 * block and stated again, in that language, in `instructions.ts`.
 */

import type { ErrorCode } from "@wattsteer/core";
import { type Band, spread } from "@wattsteer/core";
import type { AppParams } from "@/components/app/params";
import type { ExplainState } from "@/components/app/use-explain";
import type { NetworkState } from "@/components/app/use-network";
import type { ServingState } from "@/components/app/use-serving";
import { type Locale, languageTag } from "@/i18n/locale";

/** Which of the four modes the reader is on. Keys, not labels. */
export type VoiceScreen = "overview" | "explain" | "mitigate" | "replay";

/**
 * The screen names the model is allowed to say, in English.
 *
 * Machine-facing like the rest of the block, and the model translates: the
 * reader hears "Explicar" because `instructions.ts` tells it the Portuguese
 * names, not because this table was written twice.
 */
const SCREEN_NAMES: Record<VoiceScreen, string> = {
  overview: "Grid Overview",
  explain: "Explain",
  mitigate: "Mitigate",
  replay: "Time Machine",
};

/**
 * Everything the block is built from — and nothing that could be fetched.
 *
 * `network` and `explain` are optional because only one of them is ever loaded:
 * the reader is on one screen, and a context builder that demanded both would
 * force the provider to keep a hook mounted for a screen nobody is looking at.
 */
export interface VoiceContextInput {
  readonly locale: Locale;
  readonly screen: VoiceScreen;
  readonly params: AppParams;
  readonly serving: ServingState;
  readonly network?: NetworkState;
  readonly explain?: ExplainState;
}

/** A band, spoken as three numbers. Never a centre on its own. */
export function bandPhrase(band: Band, unit = "MWh"): string {
  return `P10 ${band.p10} ${unit} / P50 ${band.p50} ${unit} / P90 ${band.p90} ${unit} (spread ${spread(band).toFixed(2)})`;
}

/**
 * Whether a forecast is in the block at all.
 *
 * Exported because two callers need the same answer and must not compute it
 * twice: the block's absence line, and the dock, which does not offer the
 * "explain the forecast" affordance when there is no forecast to explain.
 */
export function hasForecast(input: VoiceContextInput): boolean {
  return input.network?.status === "read" || input.explain?.status === "explained";
}

/** The refusal code behind a missing forecast, when one was reported. */
export function forecastRefusal(input: VoiceContextInput): ErrorCode | undefined {
  if (input.explain !== undefined && input.explain.status !== "reading") {
    return input.explain.status === "explained" ? undefined : input.explain.code;
  }
  if (input.network !== undefined && input.network.status !== "reading") {
    return input.network.status === "read" ? undefined : input.network.code;
  }
  return undefined;
}

function servingLine(serving: ServingState): string {
  if (serving.status === "reading") {
    return "Whether a model is promoted is not known yet — do not claim either way.";
  }
  if (serving.status === "unknown") {
    return "The gateway did not answer /v1/meta, so nothing is known about the model. Say that rather than guessing.";
  }
  if (!serving.modelReachable) {
    return "The modelling service could not be reached, so no lane state is known and no forecast is available.";
  }
  if (serving.serving) {
    const promoted = serving.lanes.filter((lane) => lane.usable === true).length;
    return `${promoted} of ${serving.lanes.length} serving lanes is promoted.`;
  }
  const conditions = serving.lanes.map((lane) => lane.condition).join(", ");
  return serving.lanes.length === 0
    ? "No serving lanes are reported, so no model is promoted."
    : `No model is promoted: the ${serving.lanes.length} lanes report ${conditions}. The hot-swap gate refusing a candidate is the gate working.`;
}

/**
 * The sentence that carries the absence. Always emitted when there is no
 * forecast — never omitted, never softened.
 *
 * It names the clause that refused, because `FORECAST_NOT_YET_PUBLISHED` and
 * `FORECAST_UNAVAILABLE` are different facts a reader can act on differently
 * — the first will resolve at tonight's gate and the second will not — and
 * `absence.ts` makes the same distinction for the same reason.
 */
function absenceLine(input: VoiceContextInput): string {
  const code = forecastRefusal(input);
  const because = code === undefined ? "" : ` The gateway refused with ${code}.`;
  return `NO FORECAST IS AVAILABLE for this day.${because} You have no P10, no P50, no P90 and no risk class. Do not estimate, recall or approximate one — say that no forecast has been published and why.`;
}

function observedLine(input: VoiceContextInput): string | undefined {
  const network = input.network;
  if (
    network === undefined ||
    (network.status !== "read" && network.status !== "observedOnly")
  ) {
    return undefined;
  }
  const { hoursDate, hours, episodes } = network.observed;
  const total = hours.reduce((sum, hour) => sum + hour.constrainedOffMwh, 0);
  return `Observed and settled (no model involved): on ${hoursDate}, ${input.params.subsystem} was constrained off ${Math.round(total)} MWh across ${hours.length} hours, and ${episodes.episodes.length} episodes were recorded in the fortnight before it. These are facts and you may state them.`;
}

function forecastLine(input: VoiceContextInput): string | undefined {
  if (input.explain?.status === "explained") {
    const { forecast, diagnosis } = input.explain.day;
    const top = diagnosis.attribution.drivers[0];
    const driver = top === undefined ? "none ranked" : top.code;
    return `Forecast for ${input.params.date}: risk ${forecast.riskClass}. Day energy ${bandPhrase(forecast.dayEnergyMwh)}. Top driver: ${driver}. Every figure you speak must be one of these three quantiles, and you must speak all three.`;
  }
  if (input.network?.status === "read") {
    const { forecast } = input.network.forecast;
    return `Forecast for ${input.params.date}: risk ${forecast.riskClass}. Day energy ${bandPhrase(forecast.dayEnergyMwh)}. Every figure you speak must be one of these three quantiles, and you must speak all three.`;
  }
  return undefined;
}

/**
 * The block, as it goes out in `session.update`.
 *
 * Returned as a list of lines rather than one string so the tests can assert a
 * clause is present without matching whitespace, and so the provider can log
 * exactly what the model was told when a turn goes wrong.
 */
export function contextLines(input: VoiceContextInput): string[] {
  const { params, screen, locale } = input;
  const lines = [
    `The reader is on ${SCREEN_NAMES[screen]}, looking at ${params.subsystem} · ${params.technology} · run ${params.run} · target ${params.date}.`,
  ];
  if (screen === "replay") {
    lines.push(`The Time Machine is on episode ${params.episode}.`);
  }
  lines.push(servingLine(input.serving));

  const forecast = forecastLine(input);
  if (forecast === undefined) {
    lines.push(absenceLine(input));
  } else {
    lines.push(forecast);
  }

  const observed = observedLine(input);
  if (observed !== undefined) {
    lines.push(observed);
  }
  lines.push(`Answer in ${languageTag(locale)}.`);
  return lines;
}

/** The same block, as the one string the socket takes. */
export function contextSentence(input: VoiceContextInput): string {
  return contextLines(input).join("\n");
}
