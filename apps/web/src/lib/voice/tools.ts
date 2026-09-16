/**
 * The six tools the voice copilot is given, and nothing else.
 *
 * `docs/plans/voice-copilot.md` §3.1 fixes the set at six: *"not thirty — a
 * small, sharp set the model can hold in its head, each mapping onto state the
 * app already has."* That is not an aesthetic preference. The entire
 * user-visible state of `/app` is six query parameters and a route —
 * `params.ts` says so and says why — so a seventh tool would necessarily be a
 * tool with nothing behind it, and the model would learn that calling tools
 * sometimes does nothing.
 *
 * **This module is a value, not a behaviour.** It holds the schema that goes
 * out in `session.update` and the names `execute.ts` dispatches on; it does not
 * know what a tool *does*. The split matters because the schema is the thing
 * the model reads and the executor is the thing the URL reads, and they fail
 * differently: a bad schema makes the model call the wrong tool, a bad executor
 * sends a reader to the wrong region. Keeping them apart means the tests for
 * each assert the right thing.
 *
 * **No React, no audio, no network, no expo-router.** Same rule as `params.ts`
 * and `scenario.ts`, for the same reason and one more: the plan calls this
 * “the single most important structural decision in this document”, because
 * it makes the agent's whole behaviour assertable as arithmetic.
 * `voice-tools.test.ts` walks the runtime import graph of this file and the
 * other three and fails if any of the three names appears in it.
 *
 * **The enums are read, never re-typed.** `SUBSYSTEM_DISPLAY_ORDER`,
 * `RUN_LABELS`, `DRIVER_CODES` and `REPLAY_DAYS` are the same lists the screens
 * and the gateway use. A hand-written `["N", "NE", "SE", "S"]` here would be a
 * second opinion about the grid, and the first time the two disagreed the model
 * would be offered a subsystem the executor refuses — which is the worst kind
 * of defect in this layer, because it looks like the model hallucinating.
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import { ASSET_LIMITS, REPLAY_DAYS, RUN_LABELS } from "@/lib/fixtures";
import { QUESTION_KINDS } from "@/lib/voice/briefing/types";

/** The six. Order is the order they are offered to the model. */
export const TOOL_NAMES = [
  "show_grid",
  "explain",
  "mitigate",
  "replay",
  "focus",
  "highlight",
  "brief",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Narrowing guard — the only sanctioned way to trust a name off the wire. */
export function isToolName(value: unknown): value is ToolName {
  return TOOL_NAMES.includes(value as ToolName);
}

/**
 * The eight driver groups `explain` may be pointed at.
 *
 * Spelled out rather than imported as a value because `DriverCode` is a *type*
 * in `@wattsteer/core` — there is no runtime list of it — and a JSON schema
 * needs one. The list is kept honest by a compile-time check rather than by
 * care: `DRIVER_CODES` is typed `readonly DriverCode[]` and
 * `voice-tools.test.ts` asserts it has the same eight members the diagnosis
 * contract publishes, so a ninth driver is a failing test and not a silently
 * unofferable row. `other` is deliberately absent — `domain.ts` says it is the
 * client's merged remainder and never travels.
 */
export const DRIVER_CODES = [
  "renewable_resource",
  "demand_level",
  "net_surplus",
  "export_stress",
  "ramp_shape",
  "calendar_season",
  "recent_history",
  "data_conditions",
] as const;

export type VoiceDriverCode = (typeof DRIVER_CODES)[number];

/** The URL spellings of `Technology`, which is what a tool argument carries. */
export const TECHNOLOGY_VALUES = ["wind", "solar"] as const;

/**
 * How far back `replay`'s `relative_day` may reach.
 *
 * Ten years, which is not a product limit but an arithmetic one: it is the
 * range beyond which a day is not a day anyone is asking about, and a bound
 * stops a hallucinated `-99999999` becoming an `Invalid Date` two functions
 * later. The real narrowing is done by the replay catalogue — see
 * `execute.ts` — which has four days in it.
 */
export const RELATIVE_DAY_FLOOR = -3650;

/**
 * A realtime function tool, in the shape `session.update` takes.
 *
 * Deliberately a local type rather than one imported from a vendored SDK: this
 * file is the boundary at which our vocabulary becomes the provider's, and
 * `grok-voice-core.ts` (phase 2) is free to adapt it. The shape is the
 * OpenAI/xAI realtime one — `{ type, name, description, parameters }` — because
 * that is what the socket accepts.
 */
export interface VoiceTool {
  readonly type: "function";
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

/** The subset of JSON Schema a realtime tool's parameters may use. */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required: readonly string[];
  /**
   * Always false. A model that invents a property is a model whose call the
   * executor refuses (`unexpected_argument`), and saying so in the schema turns
   * that refusal into a thing the model can avoid rather than discover.
   */
  readonly additionalProperties: false;
}

export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "integer";
  readonly description: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

/**
 * The tool descriptions are **English and machine-facing**, and that is not an
 * i18n leak.
 *
 * `docs/specs/i18n.md`'s rule is about what a *reader* sees; nothing here
 * reaches a text node. The reader-facing half of the contract lives in
 * `instructions.ts`, which is authored in both locales, and the model is told
 * there to answer in the reader's language whatever language it was briefed in.
 * Writing these six paragraphs twice would double the surface on which the two
 * locales could describe different tools — a far worse failure than an English
 * string the reader never sees.
 */
export const VOICE_TOOLS: readonly VoiceTool[] = [
  {
    type: "function",
    name: "show_grid",
    description:
      "Open the Grid Overview: all four subsystems, the map and the risk rows. " +
      "Use it when the reader asks to go back, to see everything, or to compare " +
      "regions. Takes no arguments — the current selection is carried over.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "explain",
    description:
      "Open Explain for a subsystem: the risk class, the band and the ranked " +
      "drivers behind it. Use it for any 'why' question.",
    parameters: {
      type: "object",
      properties: {
        subsystem: {
          type: "string",
          enum: SUBSYSTEM_DISPLAY_ORDER,
          description:
            "The ONS subsystem code. Omit to keep the one the reader is already on. " +
            "Never guess: if you did not hear one of these four codes, omit it.",
        },
        driver: {
          type: "string",
          enum: DRIVER_CODES,
          description:
            "The driver group to emphasise, when the reader named one. Omit otherwise.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mitigate",
    description:
      "Open Mitigate and, optionally, resize the fleet in the scenario. The " +
      "optimizer re-solves on the server from the URL, so a size given here " +
      "produces a real plan. Omit every size to open the screen unchanged.",
    parameters: {
      type: "object",
      properties: {
        subsystem: {
          type: "string",
          enum: SUBSYSTEM_DISPLAY_ORDER,
          description: "The ONS subsystem code. Omit to keep the current one.",
        },
        battery_mwh: {
          type: "number",
          minimum: ASSET_LIMITS.batteryEnergyMwh.min,
          maximum: ASSET_LIMITS.batteryEnergyMwh.max,
          description: "Battery energy capacity in MWh.",
        },
        battery_mw: {
          type: "number",
          minimum: ASSET_LIMITS.batteryPowerMw.min,
          maximum: ASSET_LIMITS.batteryPowerMw.max,
          description: "Battery maximum power in MW.",
        },
        load_mwh: {
          type: "number",
          minimum: ASSET_LIMITS.loadDailyEnergyMwh.min,
          maximum: ASSET_LIMITS.loadDailyEnergyMwh.max,
          description: "Daily energy of the shiftable load, in MWh.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "replay",
    description:
      "Open the Time Machine on a past day that WattSteer can score. Give " +
      "either an episode id or a relative day, never both.",
    parameters: {
      type: "object",
      properties: {
        episode: {
          type: "string",
          enum: REPLAY_DAYS.map((day) => day.id),
          description: "The id of a replayable day.",
        },
        relative_day: {
          type: "integer",
          minimum: RELATIVE_DAY_FLOOR,
          maximum: -1,
          description:
            "Days before today, negative. -7 is 'last week'. The nearest " +
            "replayable day at or before that date is opened.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus",
    description:
      "Change the selection without changing screen: subsystem, fleet or " +
      "weather run. Use it when the reader wants the same view of something " +
      "else. At least one argument is required.",
    parameters: {
      type: "object",
      properties: {
        subsystem: {
          type: "string",
          enum: SUBSYSTEM_DISPLAY_ORDER,
          description: "The ONS subsystem code.",
        },
        technology: {
          type: "string",
          enum: TECHNOLOGY_VALUES,
          description: "Which fleet to emphasise.",
        },
        run: {
          type: "string",
          enum: RUN_LABELS,
          description: "Which D−1 weather run's gate to read.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "highlight",
    description:
      "Light a subsystem on the map and its row, WITHOUT navigating. This is " +
      "the right tool when you are about to talk about one region while the " +
      "reader is looking at all four — do not open a screen to answer a " +
      "question you can answer where they are.",
    parameters: {
      type: "object",
      properties: {
        subsystem: {
          type: "string",
          enum: SUBSYSTEM_DISPLAY_ORDER,
          description: "The ONS subsystem code to light.",
        },
      },
      required: ["subsystem"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "brief",
    description:
      "Present the answer instead of only saying it: a short narrated sequence " +
      "over this product's own panels. The right tool when the question is " +
      "'why', 'what happens tomorrow', 'what happened' or 'what if' — the " +
      "questions whose answer is a sequence rather than a sentence. For a " +
      "question with a one-line answer, speak it and use `highlight` or " +
      "`focus` instead; a briefing for 'which subsystem is selected' would be " +
      "theatre. You choose THAT a briefing is owed and what it is about. You " +
      "do not choose what is in it: the scenes are composed from what the " +
      "screen has actually read, and a briefing will silently contain less " +
      "when less is available.",
    parameters: {
      type: "object",
      properties: {
        question_kind: {
          type: "string",
          enum: [...QUESTION_KINDS],
          description:
            "Which shape of question this is. `why` and `what_happened` earn " +
            "the driver attribution; `tomorrow` earns the day's magnitude; " +
            "`what_if` earns the counterfactual, but only where a plan has " +
            "actually been solved.",
        },
        subsystem: {
          type: "string",
          enum: SUBSYSTEM_DISPLAY_ORDER,
          description:
            "The ONS subsystem the briefing is about. Omit to brief on the " +
            "one already selected.",
        },
      },
      required: ["question_kind"],
      additionalProperties: false,
    },
  },
];

/** The tool of a name, or `undefined`. Used by the tests and by the dock. */
export function toolNamed(name: string): VoiceTool | undefined {
  return VOICE_TOOLS.find((tool) => tool.name === name);
}
