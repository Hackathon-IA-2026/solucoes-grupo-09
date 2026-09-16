/**
 * The React binding for the voice agent — the context, and the pure decisions
 * the provider makes on every turn.
 *
 * **This file holds the context and `voice-provider.tsx` holds the socket**,
 * which is the opposite of the obvious arrangement and is deliberate. The
 * provider imports `expo-router`, `react-native`, an `AudioContext` and a
 * `WebSocket`; none of that can be loaded in a `bun test`. The decisions worth
 * asserting — *how an intent is performed*, *what the model is told happened*,
 * “when a credential is re-minted”, “which of the three sizes is showing” — are
 * arithmetic, and keeping them in a module that imports only `react` is what
 * lets `voice-provider.test.ts` call them rather than grep for them.
 *
 * `docs/plans/voice-copilot.md` §2.2 draws the same line one level up:
 *
 * > The provider is the only thing holding a socket, a microphone or a router.
 * > It calls `executeTool(call, params)`, gets an intent back, and performs it.
 *
 * `performIntent` below is that "performs it", written against a four-method
 * port instead of `router`. The provider supplies the implementation that calls
 * `router.push` / `router.setParams`; a test supplies one that records. The
 * router is a dependency of the provider, not of the rule.
 */

import type { SubsystemCode } from "@wattsteer/core";
import { createContext, useContext } from "react";
import type { Copy } from "@/i18n/copy.en";
import { fill } from "@/i18n/format";
import type { QuestionKind } from "@/lib/voice/briefing/types";
import type { NavigationIntent, ToolRefusalCode } from "@/lib/voice/execute";
import { SCREEN_PATHS } from "@/lib/voice/execute";
import type { TranscriptEntry, VoiceStatus } from "@/lib/voice/session";

/**
 * The three sizes of §5, as a type.
 *
 * `idle` is the pill that invites; `active` is the pill that is listening or
 * speaking; `expanded` is the ~400 px panel with the transcript and the action
 * card. They are a size and not a status: a reader can expand a dock that is
 * idle, and a dock that is speaking stays expanded if they expanded it.
 */
export type VoiceDockSize = "idle" | "active" | "expanded";

/**
 * Whether this deployment has voice at all.
 *
 * Three values, and the middle one is the whole reason `VOICE_NOT_CONFIGURED`
 * is a separate code from `VOICE_UNAVAILABLE` — `packages/core/src/errors.ts`
 * says so in as many words:
 *
 * > An instance deployed without a key must look like **a product without
 * > voice** — no dock, no microphone prompt, no session minted — and never like
 * > a product whose voice is broken.
 *
 * `absent` renders nothing at all. `unknown` also renders nothing, because the
 * only honest thing to do before the first mint is attempted is to say nothing:
 * a trigger that appears and then vanishes is worse than one that appears a
 * moment late. `present` renders the dock.
 */
export type VoiceAvailability = "unknown" | "absent" | "present";

/**
 * Why the microphone is not running, when it is not.
 *
 * `denied` is its own value rather than an `error` with a message, because the
 * dock's answer to it is not an error at all — §8 calls for "an explicit state
 * in the dock with the ⌨ typed fallback, not an error toast". A denied
 * microphone is a reader who said no, and a product that scolds them for it has
 * misread the interaction.
 */
export type VoiceMicState = "unasked" | "granted" | "denied";

/** What the last tool call did, kept so the action card can say so. */
export interface VoiceAction {
  readonly intent: NavigationIntent;
  /** Monotonic, so an identical repeat still re-renders the card. */
  readonly at: number;
}

export interface VoiceAgentState {
  readonly availability: VoiceAvailability;
  readonly status: VoiceStatus;
  readonly size: VoiceDockSize;
  readonly transcript: readonly TranscriptEntry[];
  /** 0..1, from `levelFromFloat` — the reader's own voice, then the agent's. */
  readonly level: number;
  readonly mic: VoiceMicState;
  readonly action: VoiceAction | null;
  /**
   * Do the last action again.
   *
   * The action card has always been able to take a press —
   * `voice-action-card.tsx` implements it, and refuses it for a refusal — and
   * nothing ever passed one, so a documented affordance shipped inert. A reader
   * who navigates away from where the agent put them needs a way back that is
   * not "ask again".
   */
  readonly repeatAction: () => void;
  /** The subsystem the agent asked to light, if any. `highlight` never navigates. */
  readonly highlighted: SubsystemCode | null;
  readonly error: string | null;
  /** Start a session, asking for the microphone if it has not been asked for. */
  readonly open: () => void;
  /** Stop the session and return to the idle pill. */
  readonly close: () => void;
  readonly expand: () => void;
  readonly collapse: () => void;
  /**
   * The briefing the agent asked for, as a *question* rather than a plan.
   *
   * The screens compose and render it, not this provider: a briefing draws what
   * the screen has already read, and lifting that state up here would mean the
   * briefing and the screen under it could disagree about the same day.
   */
  readonly briefing: BriefingRequest | null;
  /** Close the briefing and leave the reader on the screen it overlaid. */
  readonly dismissBriefing: () => void;
  /**
   * How far the narration has played, and how much is queued, in milliseconds.
   *
   * A function, not a value: it moves continuously while audio plays, and
   * publishing it as state would re-render every consumer of this context on
   * every audio frame to carry a number only the briefing reads.
   */
  readonly narrationClock: () => {
    elapsedMs: number;
    bufferedMs: number;
    running: boolean;
  };
  /** The typed fallback — a turn with no microphone in it. */
  readonly say: (text: string) => void;
}

/** What the agent asked to be briefed about. */
export interface BriefingRequest {
  readonly questionKind: QuestionKind;
  readonly subsystem: SubsystemCode | null;
}

/**
 * The state a component gets outside a provider: voice is absent and every
 * control is a no-op.
 *
 * Not `unknown`: a component mounted with no provider above it is not waiting
 * for an answer, it is in a tree where voice was never installed — the landing
 * page, `/pitch`, a legal page. `absent` is the honest reading and it renders
 * nothing, which is exactly what §2.2 asks for outside `/app`.
 */
export const VOICE_ABSENT: VoiceAgentState = {
  availability: "absent",
  status: "idle",
  size: "idle",
  transcript: [],
  level: 0,
  mic: "unasked",
  action: null,
  repeatAction: () => {},
  highlighted: null,
  briefing: null,
  dismissBriefing: () => {},
  narrationClock: () => ({ elapsedMs: 0, bufferedMs: 0, running: false }),
  error: null,
  open: () => {},
  close: () => {},
  expand: () => {},
  collapse: () => {},
  say: () => {},
};

const VoiceAgentContext = createContext<VoiceAgentState>(VOICE_ABSENT);

export const VoiceAgentProvider = VoiceAgentContext.Provider;

/** The dock, the trigger and the map read the agent through this and nothing else. */
export function useVoiceAgent(): VoiceAgentState {
  return useContext(VoiceAgentContext);
}

/**
 * The subsystem the agent is speaking about, for the map to light.
 *
 * Its own hook rather than a field read off `useVoiceAgent()` at the call site,
 * so the Overview's map does not acquire a dependency on the dock's transcript
 * and re-render every time a word arrives. §3.1: *"That is a one-line change to
 * who can call `setHovered`, and no new highlight mechanism at all."*
 */
export function useVoiceHighlight(): SubsystemCode | null {
  return useContext(VoiceAgentContext).highlighted;
}

/**
 * The port `performIntent` acts through.
 *
 * Four methods, one per `NavigationIntent` kind, and the shape is what carries
 * the rule: `highlight` has nowhere to navigate *to*, so a `highlight` intent
 * cannot become a navigation by accident. That is §6 step 1 — the step that
 * proves the thesis — expressed in a type rather than in a comment.
 */
export interface VoiceNavigator {
  navigate: (pathname: string, params: Readonly<Record<string, string>>) => void;
  setParams: (params: Readonly<Record<string, string>>) => void;
  highlight: (subsystem: SubsystemCode | null) => void;
  refuse: (code: ToolRefusalCode) => void;
  /**
   * Open a briefing about one region.
   *
   * Takes the *question*, not a plan: the scenes are composed from what the
   * screen has read, so an agent cannot widen a briefing by asking for more.
   */
  brief: (questionKind: QuestionKind, subsystem: SubsystemCode | null) => void;
}

/**
 * Perform an intent. The one place a tool call becomes a thing that happened.
 *
 * Exhaustive by `switch` over a discriminated union, so a fifth intent kind is
 * a compile error here rather than a call that silently does nothing — which,
 * for an agent whose whole job is to act, is the failure that looks most like
 * the product working.
 */
export function performIntent(intent: NavigationIntent, nav: VoiceNavigator): void {
  switch (intent.kind) {
    case "navigate":
      nav.navigate(intent.pathname, intent.params);
      return;
    case "params":
      nav.setParams(intent.params);
      return;
    case "highlight":
      // **No navigation here, and never one.** The reader asked which region to
      // worry about; the answer is the region lighting up on the screen they
      // are already looking at, not a screen change they did not ask for.
      nav.highlight(intent.subsystem);
      return;
    case "brief":
      // Also no navigation. A briefing overlays the screen the reader is on and
      // dismisses back onto it, for the same reason `highlight` stays put.
      nav.brief(intent.questionKind, intent.subsystem);
      return;
    case "refused":
      nav.refuse(intent.reason.code);
      return;
    default:
      // Unreachable: the five cases above exhaust the union, and `unreachable`
      // is what makes that a *compile* error rather than a comment. A fifth
      // intent kind added without a branch here would otherwise be a tool call
      // that silently does nothing — for an agent whose whole job is to act,
      // the failure that looks most like the product working.
      unreachable(intent);
      return;
  }
}

/**
 * Typed proof that a switch is exhaustive.
 *
 * Never called at runtime: reaching it means a member of the union has no
 * branch, which TypeScript refuses to compile because `never` accepts nothing.
 * The runtime body exists only so the `default` clause is a statement.
 */
function unreachable(_value: never): void {}

/**
 * What the model is told the tool did.
 *
 * Deliberately terse, and `session.ts` says why: *"the screen is the real
 * output, and a paragraph here would invite the model to narrate what the
 * reader can already see."* It is still sent for every intent including a
 * refusal — a tool call the conversation never answers leaves the model
 * building its next turn on a gap, and the gap is where it invents a figure.
 *
 * English, and machine-facing, like the context block: `instructions.ts` tells
 * the model the screen names in the reader's language, so a result that spelled
 * them in Portuguese would be a second table that could drift from the first.
 */
export function toolResult(intent: NavigationIntent): string {
  switch (intent.kind) {
    case "navigate":
      return `ok: opened ${intent.pathname} with ${describeParams(intent.params)}`;
    case "params":
      return `ok: selection now ${describeParams(intent.params)}, same screen`;
    case "highlight":
      return intent.subsystem === null
        ? "ok: highlight cleared, no screen change"
        : `ok: highlighted ${intent.subsystem} on the current screen, no screen change`;
    case "brief":
      return (
        `ok: briefing opened about ${intent.subsystem ?? "the selected subsystem"} ` +
        `(${intent.questionKind}), no screen change. Its scenes were composed from ` +
        "what this screen has actually read, so it may contain fewer than you " +
        "expect — narrate what is there, not what you asked for."
      );
    case "refused":
      return `refused: ${intent.reason.code}${
        intent.reason.value === undefined
          ? ""
          : ` (${intent.reason.field ?? "value"}=${intent.reason.value})`
      }`;
    default:
      // Exhaustive for the same reason as `performIntent` — a new intent kind
      // must break the build rather than answer the model with `undefined`
      // mid-turn, which is a gap in the conversation the model will fill.
      unreachable(intent);
      return "";
  }
}

function describeParams(params: Readonly<Record<string, string>>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return "no parameters";
  }
  return entries
    .map(([key, value]) =>
      // The scenario blob is a base64 document and can be hundreds of
      // characters. Naming it without spelling it keeps the tool result a
      // sentence rather than a payload the model might try to read back.
      value.length > 24 ? `${key}=<${value.length} chars>` : `${key}=${value}`,
    )
    .join(", ");
}

/**
 * How long to wait before re-minting, in milliseconds.
 *
 * §2.1 non-negotiable 3: *"Expiry is echoed, not assumed. The client shows a
 * session's remaining life and re-mints before it lapses rather than dying
 * mid-sentence."* The margin is the whole point — re-minting *at* expiry is
 * re-minting after it, because the round trip to the gateway and on to xAI
 * takes seconds and the socket dies during it.
 *
 * Clamped at zero rather than returning a negative: a credential that is
 * already stale should be replaced now, and a `setTimeout` with a negative
 * delay fires immediately anyway — saying so here is cheaper than relying on it.
 * An unparseable or empty `expiresAt` also returns 0, because a credential
 * whose life we cannot read is one we cannot trust to outlive this turn.
 */
export const REMINT_MARGIN_MS = 30_000;

export function remintDelayMs(expiresAt: string, now: number): number {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) {
    return 0;
  }
  return Math.max(0, at - now - REMINT_MARGIN_MS);
}

/**
 * Which size the dock shows, given what the reader asked for and what the
 * session is doing.
 *
 * The reader's choice wins wherever they have made one: a dock they expanded
 * stays expanded through every status, and a dock they collapsed is not
 * re-expanded by the agent starting to talk. What the status decides is only
 * the *unexpanded* case, and there it decides exactly one thing — a live
 * session is the ACTIVE pill and a dead one is the IDLE pill.
 *
 * `error` reads as idle rather than as a fourth size. The dock still renders
 * its message, but at the size that invites a retry: an error is not a state
 * to sit in, and a panel that stays open around one is a panel that has to be
 * dismissed.
 */
export function dockSizeFor(
  status: VoiceStatus,
  expandedByReader: boolean,
): VoiceDockSize {
  if (expandedByReader) {
    return "expanded";
  }
  return status === "idle" || status === "error" ? "idle" : "active";
}

/**
 * Whether the orb should be animating at all.
 *
 * `connecting` is in the list on purpose: it is the one live status with no
 * audio behind it, and an orb frozen at zero while a socket opens is the
 * "dead at the moment the reader is waiting hardest" failure that `thinking`
 * was added to the status union to prevent — one status earlier.
 */
export function isLive(status: VoiceStatus): boolean {
  return (
    status === "connecting" ||
    status === "listening" ||
    status === "thinking" ||
    status === "speaking" ||
    status === "acting"
  );
}

/* ------------------------------------------------------------------------- *
 * What the dock renders, computed rather than laid out.
 *
 * These four live here rather than beside their components for the same reason
 * `performIntent` does: the components import `react-native`, and a `bun test`
 * cannot load it. A property worth asserting — *these two statuses read the
 * microphone*, *this card names only the fields the intent carried* — should be
 * asserted by calling the function, not by grepping the JSX that calls it.
 * ------------------------------------------------------------------------- */

/**
 * How far a full-volume frame pushes the orb's outer ring.
 *
 * 0.34 and not 1.0: the rings sit inside a pill with 12 px of padding around
 * them, and a ring that scales past the pill's edge is clipped rather than
 * expressive. Measured against speech at conversational volume, `levelFromFloat`
 * spends most of its time between 0.05 and 0.4, so the visible travel is what
 * this constant buys at *those* values, not at 1.
 */
export const RING_TRAVEL = 0.34;

/**
 * Whether the orb's rings are driven by a real signal in this status.
 *
 * §5.1's one visual idea: the microphone while the reader talks, the playback
 * buffer while the agent does. A `thinking` orb that read a level would be
 * claiming a signal it does not have, and the honest motion for "no audio yet"
 * is the sweep instead.
 */
export function readsLevel(status: VoiceStatus): boolean {
  return status === "listening" || status === "speaking";
}

/**
 * The orb's ring scale, from a status and a level.
 *
 * Clamped, because a rogue frame must not blow the pill apart, and flattened to
 * rest under `useReducedMotion` — a ring that pulses with a voice is still
 * motion, and a reader who asked for none did not mean "none except the
 * interesting one".
 */
export function ringScale(status: VoiceStatus, level: number, reduced: boolean): number {
  if (reduced || !readsLevel(status)) {
    return 1;
  }
  return 1 + Math.min(1, Math.max(0, level)) * RING_TRAVEL;
}

/**
 * The dock's status line.
 *
 * Seven statuses, seven sentences — including `idle`, which is the IDLE pill's
 * invitation rather than a status report. A status with no sentence is a pill
 * that renders blank, in one locale, at the moment the reader is watching
 * hardest; `voice-dock.test.ts` asserts the two tables have the same members.
 */
export function statusLabel(status: VoiceStatus, copy: Copy): string {
  return copy.app.voice.status[status];
}

/** The route the agent opened, as a key into the screen names copy already has. */
export function screenKeyFor(pathname: string): keyof Copy["app"]["shell"]["screens"] {
  switch (pathname) {
    case SCREEN_PATHS.explain:
      return "explain";
    case SCREEN_PATHS.mitigate:
      return "mitigate";
    case SCREEN_PATHS.replay:
      return "replay";
    default:
      return "overview";
  }
}

/**
 * The action card's second line: what the selection is now.
 *
 * Built from the params the intent carries, in the order the selection bar
 * shows them, and **only from the ones that are there** — a `focus` that
 * changed the technology and nothing else says "Solar", not "NE · Solar · 12Z"
 * with two values it did not touch. Claiming to have set three things when one
 * was set is the small dishonesty that makes a reader stop trusting the card.
 *
 * The scenario blob is named rather than spelled: it is a base64 document, and
 * a card that printed 300 characters of it would be unreadable and would push
 * the panel past its 400 px.
 */
export function selectionLine(
  params: Readonly<Record<string, string>>,
  copy: Copy,
): string {
  const parts: string[] = [];
  if (params.subsystem !== undefined) {
    parts.push(params.subsystem);
  }
  if (params.technology !== undefined) {
    parts.push(
      params.technology === "solar"
        ? copy.app.technology.SOLAR
        : copy.app.technology.WIND,
    );
  }
  if (params.run !== undefined) {
    parts.push(params.run);
  }
  if (params.episode !== undefined) {
    parts.push(params.episode);
  }
  if (params.s !== undefined) {
    parts.push(copy.app.voice.action.scenarioChanged);
  }
  return parts.join(" · ");
}

/** The EXPANDED panel's width — §5's "EXPANDED — 400px", minus its own margin. */
export const DOCK_WIDTH = 380;

/**
 * Below this the panel gives up its fixed width rather than overflow.
 *
 * A fixed 380 on a 400 px viewport is an overflow, and the symptom is not a
 * scrollbar — `app-shell.tsx`'s header comment records what it actually is: a
 * truncated word at the viewport edge, with the page not scrolling sideways.
 */
export const DOCK_NARROW_BREAKPOINT = 460;

/**
 * The two lines an intent reads as: what happened, and what it did.
 *
 * **One dispatch over `intent.kind`, not two.** These were a pair of nested
 * ternary chains, four levels deep each, computing the headline and the detail
 * separately from the same discriminant — and the failure that shape invites is
 * not a crash. A fifth `NavigationIntent` arm added to one chain and not the
 * other yields a card whose two lines describe different things, which reads as
 * a working card saying something false. react-doctor measured the component at
 * cognitive complexity 22 and nesting depth 4; almost all of it was here.
 *
 * A `switch` also makes exhaustiveness the compiler's problem: the `never` in
 * the default arm fails to typecheck the moment `NavigationIntent` grows an arm
 * nothing here handles, which is the check the ternaries could not express —
 * their final `else` silently absorbed anything new as a refusal.
 *
 * Extracted rather than inlined so it can be read, and tested, without a
 * renderer: it is two strings out of a discriminated union and a dictionary.
 */
export function intentLines(
  intent: NavigationIntent,
  copy: Copy,
): { headline: string; detail: string } {
  const voice = copy.app.voice;
  switch (intent.kind) {
    case "navigate":
      return {
        headline: fill(voice.action.navigate, {
          screen: copy.app.shell.screens[screenKeyFor(intent.pathname)],
        }),
        detail: selectionLine(intent.params, copy),
      };
    case "params":
      return {
        headline: voice.action.focused,
        detail: selectionLine(intent.params, copy),
      };
    case "highlight":
      return {
        headline:
          intent.subsystem === null
            ? voice.action.highlightCleared
            : fill(voice.action.highlighted, { subsystem: intent.subsystem }),
        // The line that makes the demo's first step legible: the agent
        // answered and the reader did not move.
        detail: voice.action.noScreenChange,
      };
    case "brief":
      return {
        headline: voice.action.briefing,
        detail: voice.action.noScreenChange,
      };
    case "refused":
      return {
        headline: voice.action.refused,
        detail: voice.refusal[intent.reason.code],
      };
    default:
      // The same `unreachable` the intent *performer* above uses, for the same
      // reason: a fifth `NavigationIntent` arm has to be a compile error rather
      // than a card rendering two lines about nothing. It is also the check the
      // nested ternaries this replaced could not express — their final `else`
      // absorbed anything new as a refusal. Reusing the helper keeps one
      // statement of what exhaustive means in this file.
      unreachable(intent);
      return { headline: "", detail: "" };
  }
}
