/**
 * A tool call becomes an intent. Nothing here navigates.
 *
 * `docs/plans/voice-copilot.md` §3.3: *"No `router` import. No hooks. The hook
 * calls it and **then** performs the intent."* So the whole behaviour of the
 * agent — six tools, every argument shape, every refusal — is assertable
 * without a socket, a microphone or a renderer, and `voice-execute.test.ts`
 * asserts it as arithmetic.
 *
 * ## Validation refuses. It never coerces.
 *
 * This is the one rule in the file worth reading twice, because it deliberately
 * contradicts the module next door. `parseAppParams` falls back to `NE` on
 * anything it does not recognise, and its comment says why: *"a hand-edited URL
 * yields a default, never a crash and never an empty screen."* That is right
 * for a URL, where the alternative is a blank page and the reader can see the
 * address bar.
 *
 * It is wrong here. A model that emits `subsystem: "SUDESTE"` has not made a
 * typo, it has guessed — and a fallback would answer confidently about the
 * Northeast while the reader asked about the Southeast, with the screen, the
 * numbers and the spoken sentence all agreeing and all wrong. §8 names it *"the
 * single highest-stakes rule here."* Different caller, different rule: every
 * argument is checked against the same published enum the screens use, and a
 * value that is not in it produces `{ kind: "refused" }` and a spoken "I don't
 * know that subsystem".
 *
 * ## A refusal is a code, never a sentence
 *
 * The same posture `scenario.ts` takes toward `ErrorCode`: this module reports
 * a `ToolRefusalCode` and the dock renders it from the dictionaries, so there
 * is no path by which a refusal becomes prose anywhere but `copy.*.ts`. It also
 * means the model can be told, in `instructions.ts`, what each code means in
 * the reader's language rather than reading English out of a data layer.
 *
 * ## The scenario is never spelled here
 *
 * `withBattery` / `withLoad` / `withSubsystem` / `writeScenario` are the only
 * way a scenario changes, exactly as on the Mitigate screen. `scenario.ts`:
 * “a second spelling of either on this side would be a link the API rejects
 * and the screen accepts, which is the one failure a shareable URL cannot
 * survive.” An agent that assembled the blob itself would be that second
 * spelling, written by the component least able to notice it had drifted.
 *
 * ## `executeTool` is total
 *
 * Every shape reaching it — a name that is not a tool, arguments that are a
 * number, a JSON string that does not parse, `null` — returns a
 * `NavigationIntent`. It never throws, because the only caller is a socket
 * message handler mid-sentence, and an exception there would end the session
 * rather than the turn.
 */

import {
  decodeScenarioParam,
  type JsonValue,
  SCENARIO_PARAM,
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  validateScenarioWire,
} from "@wattsteer/core";
import type { Scenario } from "@wattsteer/core/api";
import { type AppParams, sharedParams, technologyParam } from "@/components/app/params";
import {
  defaultScenario,
  fixtureBattery,
  fixtureLoad,
  refusalCode,
  scenarioBattery,
  scenarioLoad,
  withBattery,
  withLoad,
  withSubsystem,
  withTargetDate,
  writeScenario,
} from "@/components/app/scenario";
import {
  ASSET_LIMITS,
  REPLAY_DAYS,
  RUN_LABELS,
  type RunLabel,
  type Technology,
} from "@/lib/fixtures";
import { isQuestionKind, type QuestionKind } from "@/lib/voice/briefing/types";
import {
  DRIVER_CODES,
  isToolName,
  RELATIVE_DAY_FLOOR,
  type ToolName,
  type VoiceDriverCode,
} from "./tools";

/** The routes the four modes live at. The agent addresses no other path. */
export const SCREEN_PATHS = {
  overview: "/app",
  explain: "/app/explain",
  mitigate: "/app/mitigate",
  replay: "/app/replay",
} as const;

/**
 * A call as it comes off the socket.
 *
 * `arguments` is `unknown` on purpose. The realtime protocol delivers it as a
 * **JSON string**, a well-behaved model delivers an object, and a badly behaved
 * one delivers neither; typing it as `Record<string, unknown>` would push the
 * parse to the caller, which is the React layer, which is the one place the
 * plan says this logic must not be.
 */
export interface ToolCall {
  readonly name: string;
  readonly arguments?: unknown;
  /** The provider's id for the call, echoed back in the tool result. */
  readonly callId?: string;
}

/**
 * Why a call was refused. Nine codes, each one a distinct thing to say.
 *
 * They are separated by *what the reader should hear*, not by which `if`
 * rejected: `unknown_subsystem` and `unknown_run` are both "that is not a value
 * I have", but one of them is answerable with "I know N, NE, SE and S" and the
 * other with "there are two runs, 00Z and 12Z", and a single
 * `invalid_argument` would have made the voice vague in exactly the moment it
 * needs to be specific.
 */
export const TOOL_REFUSAL_CODES = [
  /** The name is not one of the six. */
  "unknown_tool",
  /** Arguments were not an object, or were a string that is not JSON. */
  "malformed_arguments",
  /** A property the tool does not have — usually a call meant for another. */
  "unexpected_argument",
  /** The tool needs an argument and got none. */
  "missing_argument",
  "unknown_subsystem",
  "unknown_technology",
  "unknown_run",
  "unknown_driver",
  "unknown_episode",
  /** A question kind the composer does not branch on. */
  "unknown_question_kind",
  /** A number outside the range the editors themselves accept. */
  "value_out_of_range",
  /** `replay` was given both an episode and a relative day. */
  "ambiguous_replay",
  /** The day asked for is older than anything the replay catalogue holds. */
  "no_episode_for_relative_day",
  /**
   * The fleet the sizes describe is one the refusal table rejects.
   *
   * Found by a test rather than by reading: `load_mwh: 100` is inside the
   * stepper's own range and still trips `SHIFT_EXCEEDS_BASELINE`, because that
   * rule is about a *combination* — a shift larger than the baseline it is
   * shifted from is not a physical load, whatever each field's range says on
   * its own. A per-field check cannot see that, so the assembled scenario is
   * run through `validateScenarioWire` — the same eighteen-rule table the
   * gateway runs — before a link is written. The `ErrorCode` it refused with
   * travels in `reason.value`, so the voice can name the rule.
   */
  "scenario_refused",
] as const;

export type ToolRefusalCode = (typeof TOOL_REFUSAL_CODES)[number];

/**
 * The refusal, with the argument that caused it.
 *
 * `field` and `value` exist for the dock's action card and for the model's tool
 * result — "I don't know the subsystem SUDESTE" is a better sentence than "I
 * don't know that subsystem", and the value is already in hand. `value` is
 * stringified rather than carried raw: it is attacker-adjacent text on its way
 * to a template, and the same reasoning that keeps `Scenario.label` away from a
 * text node applies to a hallucinated enum member.
 */
export interface ToolRefusal {
  readonly code: ToolRefusalCode;
  readonly field?: string;
  readonly value?: string;
}

/**
 * What the provider should do. Four kinds, and the third is the interesting one.
 *
 * `highlight` does not navigate — §6 step 1, the step that proves the thesis:
 * “it is the step where the assistant does not navigate, and a lesser design
 * would have opened a chat panel with a paragraph in it.” Making that a member
 * of this union rather than a flag on `params` is what stops it decaying into a
 * navigation the first time someone adds a screen.
 */
export type NavigationIntent =
  | {
      readonly kind: "navigate";
      readonly pathname: string;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: "params"; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: "highlight"; readonly subsystem: SubsystemCode | null }
  | {
      /**
       * Present the answer rather than only speak it.
       *
       * Carries the *question*, never the plan. `compose.ts` builds the scenes
       * from what the screen has actually read, so the model cannot widen a
       * briefing by asking for more — which is the property that keeps a
       * briefing from showing a forecast the product does not have.
       */
      readonly kind: "brief";
      readonly questionKind: QuestionKind;
      readonly subsystem: SubsystemCode | null;
    }
  | { readonly kind: "refused"; readonly reason: ToolRefusal };

function refuse(
  code: ToolRefusalCode,
  field?: string,
  value?: unknown,
): NavigationIntent {
  return {
    kind: "refused",
    reason: {
      code,
      ...(field === undefined ? {} : { field }),
      ...(value === undefined ? {} : { value: describeValue(value) }),
    },
  };
}

/** A hallucinated argument, as a short string safe to put in a template. */
function describeValue(value: unknown): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * The selection that travels with a navigation.
 *
 * `sharedParams` decides *which* three fields travel — this is not a second
 * opinion about that. What it does not do is spell the technology the way the
 * URL does: it emits the domain's `WIND` / `SOLAR`, and `parseAppParams` reads
 * only `wind` / `solar`, so a `SOLAR` selection carried through a raw
 * `sharedParams` link parses back as wind. On a tab press that is a wrong pill;
 * from the agent it would be the voice saying "solar" while the screen shows
 * wind, which is the same class of defect as a coerced subsystem. So the field
 * set comes from `sharedParams` and the spelling from `technologyParam`, which
 * is the function `params.ts` exports for exactly this.
 */
function carriedParams(params: AppParams): Record<string, string> {
  return {
    ...sharedParams(params),
    technology: technologyParam(params.technology),
  };
}

/** The arguments as an object, or the refusal that says they were not one. */
function readArguments(raw: unknown): Record<string, unknown> | ToolRefusalCode {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") {
      // The realtime protocol sends `""` for a no-argument call, which is not
      // malformed — it is `show_grid` working.
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return "malformed_arguments";
    }
    return readArguments(parsed);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return "malformed_arguments";
  }
  return raw as Record<string, unknown>;
}

/**
 * Every property the tool does not declare is a refusal.
 *
 * The permissive reading — ignore what you do not recognise — is wrong for the
 * same reason coercion is. A `show_grid` carrying `{ subsystem: "S" }` is a
 * model that meant `focus` or `highlight`; silently opening the overview on the
 * reader’s **current** subsystem would answer a question nobody asked. The
 * schema says `additionalProperties: false`, so this is the executor agreeing
 * with what the model was told.
 */
function unexpected(
  args: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  // A `Set`, not `allowed.includes` inside the `find`. The allowed list is at
  // most four names and the args at most four, so this is nanoseconds either
  // way — it is here because the shape is the thing worth being right: a linear
  // scan nested in a linear scan is the pattern that becomes a problem when
  // somebody later gives a tool twenty arguments, and the `Set` costs nothing
  // to write now and nothing to notice then.
  const permitted = new Set(allowed);
  return Object.keys(args).find((key) => !permitted.has(key));
}

/** Present means "the model said something about it" — `null` is not absent. */
function given(args: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(args, key) && args[key] !== undefined;
}

type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly intent: NavigationIntent };

function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function checkSubsystem(
  args: Record<string, unknown>,
  key = "subsystem",
): Checked<SubsystemCode | undefined> {
  if (!given(args, key)) {
    return ok(undefined);
  }
  const raw = args[key];
  if (typeof raw === "string" && SUBSYSTEM_DISPLAY_ORDER.includes(raw as SubsystemCode)) {
    return ok(raw as SubsystemCode);
  }
  return { ok: false, intent: refuse("unknown_subsystem", key, raw) };
}

/**
 * `wind` / `solar` in, `WIND` / `SOLAR` out.
 *
 * The tool argument is the URL's spelling rather than the domain's, because
 * that is the spelling the model sees in the address bar of a shared link and
 * the one `parseAppParams` reads. The uppercase form is accepted too: it is the
 * same fleet, unambiguously, and refusing it would be pedantry rather than
 * safety — the rule is *never guess*, and there is nothing to guess here.
 */
function checkTechnology(args: Record<string, unknown>): Checked<Technology | undefined> {
  if (!given(args, "technology")) {
    return ok(undefined);
  }
  const raw = args.technology;
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower === "wind" || lower === "solar") {
      return ok(lower.toUpperCase() as Technology);
    }
  }
  return { ok: false, intent: refuse("unknown_technology", "technology", raw) };
}

function checkRun(args: Record<string, unknown>): Checked<RunLabel | undefined> {
  if (!given(args, "run")) {
    return ok(undefined);
  }
  const raw = args.run;
  if (typeof raw === "string" && RUN_LABELS.includes(raw as RunLabel)) {
    return ok(raw as RunLabel);
  }
  return { ok: false, intent: refuse("unknown_run", "run", raw) };
}

function checkDriver(
  args: Record<string, unknown>,
): Checked<VoiceDriverCode | undefined> {
  if (!given(args, "driver")) {
    return ok(undefined);
  }
  const raw = args.driver;
  if (typeof raw === "string" && DRIVER_CODES.includes(raw as VoiceDriverCode)) {
    return ok(raw as VoiceDriverCode);
  }
  return { ok: false, intent: refuse("unknown_driver", "driver", raw) };
}

/**
 * A size, against the range the on-screen stepper itself enforces.
 *
 * `ASSET_LIMITS` and not a looser bound of our own: the voice may not build a
 * fleet the mouse cannot, or a shared link would open on a screen whose
 * steppers immediately clamp it and the plan the reader heard would not be the
 * plan the reader sees. Non-finite is refused with the same code — `NaN` is
 * out of every range.
 */
function checkNumber(
  args: Record<string, unknown>,
  key: string,
  limits: { readonly min: number; readonly max: number },
): Checked<number | undefined> {
  if (!given(args, key)) {
    return ok(undefined);
  }
  const raw = args[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, intent: refuse("value_out_of_range", key, raw) };
  }
  if (raw < limits.min || raw > limits.max) {
    return { ok: false, intent: refuse("value_out_of_range", key, raw) };
  }
  return ok(raw);
}

const MS_PER_DAY = 86_400_000;

/** The `YYYY-MM-DD` `days` after `date`. Negative goes back. */
function daysFrom(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * "Last week" becomes a day the Time Machine can actually score.
 *
 * The catalogue has four days in it, chosen for what they prove about the
 * artifact families — `REPLAY_DAYS` says which. A reader asking about seven
 * days ago is not asking for that date, they are asking *what happened
 * recently*, so the nearest replayable day **at or before** the one named is
 * the honest answer and the voice states which day it opened. Rounding forward
 * would be worse: it would answer about a day the reader has not had yet.
 *
 * Nothing at or before it is a refusal, not a clamp to the oldest day. A reader
 * asking about 2019 is asking about something WattSteer has no opinion on, and
 * opening November 2024 instead would be answering a different question.
 */
function replayDayBefore(target: string): string | undefined {
  const candidates = REPLAY_DAYS.filter((day) => day.date <= target);
  if (candidates.length === 0) {
    return;
  }
  return candidates.reduce((latest, day) => (day.date > latest.date ? day : latest)).id;
}

/**
 * The scenario a `mitigate` call edits.
 *
 * The caller passes the one the Mitigate screen currently holds where there is
 * one — a scenario that arrived carrying an availability window or an explicit
 * efficiency pair keeps them, because `withBattery` spreads over it rather than
 * rebuilding from four fields. Where there is none, the screen's own opening
 * fleet: `defaultScenario`, which spends `REFERENCE_FLEET` rather than
 * re-typing it.
 */
function scenarioFor(current: AppParams, supplied: Scenario | undefined): Scenario {
  return supplied ?? defaultScenario(current.subsystem, current.date);
}

/**
 * The call, executed.
 *
 * `scenario` is optional and additive to the plan's two-argument signature: the
 * provider has one on Mitigate and has none anywhere else, and a `mitigate`
 * call from the Overview must still be able to resize a battery. Absent, the
 * screen's default fleet is edited — which is what the reader would have been
 * looking at had they navigated first.
 */
/**
 * `brief` — the seventh tool, and the only one whose outcome is not a change to
 * the URL.
 *
 * `subsystem` is optional and falls back to the selection, which is the same
 * courtesy `focus` extends: a reader who says "why?" while looking at the
 * Northeast means the Northeast.
 */
function runBrief(args: Record<string, unknown>, current: AppParams): NavigationIntent {
  const stray = unexpected(args, ["question_kind", "subsystem"]);
  if (stray !== undefined) {
    return refuse("unexpected_argument", stray, args[stray]);
  }
  const kind = args.question_kind;
  if (typeof kind !== "string" || !isQuestionKind(kind)) {
    return refuse("unknown_question_kind", "question_kind", kind);
  }
  if (args.subsystem === undefined || args.subsystem === null) {
    return { kind: "brief", questionKind: kind, subsystem: current.subsystem };
  }
  const subsystem = checkSubsystem(args);
  if (!subsystem.ok) {
    return subsystem.intent;
  }
  return {
    kind: "brief",
    questionKind: kind,
    subsystem: subsystem.value as SubsystemCode,
  };
}

export function executeTool(
  call: ToolCall,
  current: AppParams,
  scenario?: Scenario,
): NavigationIntent {
  if (!isToolName(call.name)) {
    return refuse("unknown_tool", "name", call.name);
  }
  const args = readArguments(call.arguments);
  if (typeof args === "string") {
    return refuse(args, "arguments");
  }
  const name: ToolName = call.name;
  switch (name) {
    case "show_grid":
      return runShowGrid(args, current);
    case "explain":
      return runExplain(args, current);
    case "mitigate":
      return runMitigate(args, current, scenario);
    case "replay":
      return runReplay(args, current);
    case "focus":
      return runFocus(args);
    case "highlight":
      return runHighlight(args);
    case "brief":
      return runBrief(args, current);
    default:
      // Unreachable through `isToolName`, which narrowed `name` to the six
      // above — and still written, because `executeTool` is total by contract
      // and a seventh member added to `TOOL_NAMES` without a branch here must
      // refuse rather than fall off the end returning `undefined`.
      return refuse("unknown_tool", "name", name);
  }
}

function runShowGrid(
  args: Record<string, unknown>,
  current: AppParams,
): NavigationIntent {
  const stray = unexpected(args, []);
  if (stray !== undefined) {
    return refuse("unexpected_argument", stray, args[stray]);
  }
  return {
    kind: "navigate",
    pathname: SCREEN_PATHS.overview,
    params: carriedParams(current),
  };
}

function runExplain(args: Record<string, unknown>, current: AppParams): NavigationIntent {
  const stray = unexpected(args, ["subsystem", "driver"]);
  if (stray !== undefined) {
    return refuse("unexpected_argument", stray, args[stray]);
  }
  const subsystem = checkSubsystem(args);
  if (!subsystem.ok) {
    return subsystem.intent;
  }
  const driver = checkDriver(args);
  if (!driver.ok) {
    return driver.intent;
  }
  const next: AppParams = { ...current, subsystem: subsystem.value ?? current.subsystem };
  return {
    kind: "navigate",
    pathname: SCREEN_PATHS.explain,
    params: {
      ...carriedParams(next),
      // Carried as a plain query parameter rather than a fragment: the Explain
      // screen reads the selection out of the URL and nothing else, and a
      // parameter `parseAppParams` ignores is inert until the row emphasis is
      // wired (plan phase 5). A fragment would not survive `router.push`.
      ...(driver.value === undefined ? {} : { driver: driver.value }),
    },
  };
}

function runMitigate(
  args: Record<string, unknown>,
  current: AppParams,
  supplied: Scenario | undefined,
): NavigationIntent {
  const stray = unexpected(args, ["subsystem", "battery_mwh", "battery_mw", "load_mwh"]);
  if (stray !== undefined) {
    return refuse("unexpected_argument", stray, args[stray]);
  }
  const subsystem = checkSubsystem(args);
  if (!subsystem.ok) {
    return subsystem.intent;
  }
  const energy = checkNumber(args, "battery_mwh", ASSET_LIMITS.batteryEnergyMwh);
  if (!energy.ok) {
    return energy.intent;
  }
  const power = checkNumber(args, "battery_mw", ASSET_LIMITS.batteryPowerMw);
  if (!power.ok) {
    return power.intent;
  }
  const load = checkNumber(args, "load_mwh", ASSET_LIMITS.loadDailyEnergyMwh);
  if (!load.ok) {
    return load.intent;
  }

  const next: AppParams = { ...current, subsystem: subsystem.value ?? current.subsystem };
  const params: Record<string, string> = carriedParams(next);

  const resized =
    energy.value !== undefined || power.value !== undefined || load.value !== undefined;
  const moved = subsystem.value !== undefined && subsystem.value !== current.subsystem;
  if (resized || (moved && supplied !== undefined)) {
    // The blob is only written when something in it changed. A bare
    // `mitigate{NE}` navigates with the selection and no `?s=`, so the screen
    // opens on its own default fleet — which is what a reader pressing the tab
    // would have got, and one fewer place for the agent to have an opinion.
    let edited = withTargetDate(scenarioFor(current, supplied), next.date);
    edited = withSubsystem(edited, next.subsystem);
    if (energy.value !== undefined || power.value !== undefined) {
      const battery = fixtureBattery(scenarioBattery(edited));
      edited = withBattery(edited, {
        ...battery,
        energyCapacityMwh: energy.value ?? battery.energyCapacityMwh,
        maxPowerMw: power.value ?? battery.maxPowerMw,
      });
    }
    if (load.value !== undefined) {
      const shiftable = fixtureLoad(scenarioLoad(edited));
      edited = withLoad(edited, { ...shiftable, dailyEnergyMwh: load.value });
    }
    let blob: string;
    try {
      blob = writeScenario(edited);
      // The gateway's own table, run before the link exists. The date clause is
      // skipped: `targetDate` is `params.date`, which `latestTargetDate`
      // produced, so it is the one field no tool argument can reach — and
      // running the planning rule here would make `executeTool` a function of
      // the wall clock, which is exactly what `parseAppParams` takes `now` as
      // an argument to avoid.
      validateScenarioWire(JSON.parse(decodeScenarioParam(blob).canonical) as JsonValue, {
        targetDate: () => {},
      });
    } catch (cause) {
      return refuse("scenario_refused", "scenario", refusalCode(cause));
    }
    params[SCENARIO_PARAM] = blob;
  }
  return { kind: "navigate", pathname: SCREEN_PATHS.mitigate, params };
}

function runReplay(args: Record<string, unknown>, current: AppParams): NavigationIntent {
  const stray = unexpected(args, ["episode", "relative_day"]);
  if (stray !== undefined) {
    return refuse("unexpected_argument", stray, args[stray]);
  }
  const hasEpisode = given(args, "episode");
  const hasRelative = given(args, "relative_day");
  if (hasEpisode && hasRelative) {
    // Two answers to "which day", and no rule for picking between them that is
    // not this module inventing one. The model is told to send one.
    return refuse("ambiguous_replay");
  }

  let episode: string;
  if (hasEpisode) {
    const raw = args.episode;
    if (typeof raw !== "string" || !REPLAY_DAYS.some((day) => day.id === raw)) {
      return refuse("unknown_episode", "episode", raw);
    }
    episode = raw;
  } else if (hasRelative) {
    const raw = args.relative_day;
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw > -1 ||
      raw < RELATIVE_DAY_FLOOR
    ) {
      return refuse("value_out_of_range", "relative_day", raw);
    }
    const resolved = replayDayBefore(daysFrom(current.date, raw));
    if (resolved === undefined) {
      return refuse("no_episode_for_relative_day", "relative_day", raw);
    }
    episode = resolved;
  } else {
    // Neither: the Time Machine has no "current day", so there is nothing to
    // carry and nothing to default to that would not be a guess.
    return refuse("missing_argument", "episode");
  }

  return {
    kind: "navigate",
    pathname: SCREEN_PATHS.replay,
    params: { ...carriedParams(current), episode },
  };
}

function runFocus(args: Record<string, unknown>): NavigationIntent {
  const stray = unexpected(args, ["subsystem", "technology", "run"]);
  if (stray !== undefined) {
    return refuse("unexpected_argument", stray, args[stray]);
  }
  const subsystem = checkSubsystem(args);
  if (!subsystem.ok) {
    return subsystem.intent;
  }
  const technology = checkTechnology(args);
  if (!technology.ok) {
    return technology.intent;
  }
  const run = checkRun(args);
  if (!run.ok) {
    return run.intent;
  }
  if (
    subsystem.value === undefined &&
    technology.value === undefined &&
    run.value === undefined
  ) {
    // An empty `focus` is a no-op that would still show an action card saying
    // something happened. Refusing it makes the dock honest.
    return refuse("missing_argument");
  }
  // Only what was named. `router.setParams` merges, and writing the other two
  // back would turn a "switch to solar" into a three-field assertion that would
  // silently undo a pill the reader pressed while the model was thinking.
  const params: Record<string, string> = {};
  if (subsystem.value !== undefined) {
    params.subsystem = subsystem.value;
  }
  if (technology.value !== undefined) {
    params.technology = technologyParam(technology.value);
  }
  if (run.value !== undefined) {
    params.run = run.value;
  }
  return { kind: "params", params };
}

function runHighlight(args: Record<string, unknown>): NavigationIntent {
  const stray = unexpected(args, ["subsystem"]);
  if (stray !== undefined) {
    return refuse("unexpected_argument", stray, args[stray]);
  }
  if (!Object.hasOwn(args, "subsystem") || args.subsystem === undefined) {
    return refuse("missing_argument", "subsystem");
  }
  if (args.subsystem === null) {
    // An explicit clear, which is the other end of the same affordance the map
    // already has: `setHovered(null)` is how a pointer leaving a region puts
    // the highlight out. The agent gets the same two moves, not a new mechanism.
    return { kind: "highlight", subsystem: null };
  }
  const subsystem = checkSubsystem(args);
  if (!subsystem.ok) {
    return subsystem.intent;
  }
  return { kind: "highlight", subsystem: subsystem.value as SubsystemCode };
}
