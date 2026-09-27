/**
 * The voice session, held above the `Stack`.
 *
 * **This is the one structural requirement in `docs/plans/voice-copilot.md`
 * that cannot be compromised** (§2.2), and it is worth restating where the code
 * is rather than only where the plan is:
 *
 * > The session **must** outlive a screen change […] navigating is the agent's
 * > *primary action*. A dock mounted per screen would tear down its WebSocket,
 * > drop the mic, and cut the sentence in half **every time a tool call
 * > succeeded** — the feature would break precisely when it worked.
 *
 * So this provider wraps the `Stack` in `app/app/_layout.tsx`, inside
 * `ServingProvider` — inside, because the agent has to know whether a model is
 * promoted, and reading that from the same provider the screens read is what
 * stops the dock and the chrome badge disagreeing about it. Two sources for
 * "is there a model" is exactly the defect `ServingProvider`'s own comment was
 * written to prevent.
 *
 * ## What it owns, and what it refuses to own
 *
 * It owns the socket, the microphone, the transcript, the level, the size, the
 * last intent and the credential's expiry. It owns **no rules**: which URL a
 * tool call means is `execute.ts`, what the model is told about the screen is
 * `context.ts`, what it is allowed to say is `instructions.ts`, and how an
 * intent is performed is `use-voice-agent.ts`. This file is wiring, and the
 * wiring is the part that cannot be unit-tested — which is precisely why none
 * of the rules live in it.
 *
 * ## Mic permission is session state
 *
 * Asked once and held here, because a copilot that re-prompts for the
 * microphone every time it opens a screen is unusable — and that is the default
 * outcome if this state lives anywhere below the `Stack`. A denial is not an
 * error: it switches the dock to the typed fallback, which is a working
 * product with a keyboard in it.
 *
 * ## No key means no dock
 *
 * The first mint is attempted when the reader asks for voice, and a
 * `VOICE_NOT_CONFIGURED` from the gateway latches `availability` to `absent`
 * for the life of the page. §2.1 non-negotiable 4: *"A deploy without the key
 * must look like a product without voice, not a broken one."* An instance with
 * no key therefore shows a trigger once, at most, and never again — and
 * `apps/api` answers that code before it has made any external call, so the
 * cost of finding out is one local request.
 */

import type { SubsystemCode } from "@wattsteer/core";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { parseAppParams } from "@/components/app/params";
import { defaultScenario, readScenario, SCENARIO_PARAM } from "@/components/app/scenario";
import { requestSection } from "@/components/app/section-request";
import { useReplayDays } from "@/components/app/use-replay-days";
import { useServing } from "@/components/app/use-serving";
import type { BriefingRequest } from "@/components/voice/use-voice-agent";
import { useI18n } from "@/i18n";
import type { ReplayCandidateDay } from "@/lib/fixtures";
import { useLatest } from "@/lib/use-latest";
import { contextSentence, screenFor } from "@/lib/voice/context";
import { executeTool, SCREEN_PATHS, type ToolCall } from "@/lib/voice/execute";
import { voiceInstructions } from "@/lib/voice/instructions";
import { voiceTools } from "@/lib/voice/tools";

/**
 * The agent's paths that are sections of `/app` rather than documents.
 *
 * Keyed by the path the agent names, so adding a section is one entry and
 * nothing in `execute.ts` or `instructions.ts` has to know.
 */
/**
 * No calendar, as one stable array.
 *
 * A fresh `[]` per render would give `useMemo` a new dependency every time and
 * rebuild the tool list — which is cheap, but it also means `toolsRef` would
 * change identity under an open session for no reason at all.
 */
const EMPTY_DAYS: readonly ReplayCandidateDay[] = [];

const SECTION_OF: Record<string, string | undefined> = {
  [SCREEN_PATHS.explain]: "explain",
  [SCREEN_PATHS.mitigate]: "mitigate",
};

import {
  dockSizeFor,
  performIntent,
  type VoiceAction,
  VoiceAgentProvider,
  type VoiceAgentState,
  type VoiceNavigator,
} from "./use-voice-agent";
import { useVoiceSession } from "./use-voice-session";

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const serving = useServing();
  const pathname = usePathname();
  // Global, not local: this provider sits *above* the `Stack`, so the local
  // search params here are the layout's and not the focused screen's. The
  // agent must act on what the reader is actually looking at.
  const rawParams = useGlobalSearchParams();

  const [action, setAction] = useState<VoiceAction | null>(null);
  const [highlighted, setHighlighted] = useState<SubsystemCode | null>(null);
  /**
   * The briefing the agent asked for, or `null`.
   *
   * The *question*, not a plan: composing needs the screen's own reads, and
   * holding the question rather than the scenes means a briefing can never be
   * staler than the state it is drawn from.
   */
  const [briefing, setBriefing] = useState<BriefingRequest | null>(null);
  const [expandedByReader, setExpandedByReader] = useState(false);

  const params = useMemo(() => parseAppParams(rawParams), [rawParams]);
  const screen = screenFor(pathname);

  /**
   * The days this deployment can replay, which the agent is offered and the
   * executor checks against.
   *
   * **Read here rather than named in `tools.ts`.** The `episode` enum was four
   * hand-written dates while the picker read `GET /v1/replay/days`, so the
   * model was offered days the screen could not open: measured in production
   * on 2026-09-27, "abra a máquina do tempo" landed on a refusal about a day
   * nobody had asked for. One source or none — the same rule `/v1/meta` and
   * the lane name are under.
   *
   * `probing` is an empty list on purpose, not a fallback to the fixtures. The
   * `replay` tool then carries no `episode` property at all and the executor
   * refuses rather than guessing, which is what an absence is owed here. The
   * read is one request per subsystem, ETag-cached by the gateway and skipped
   * entirely until `/v1/meta` has named a lane.
   */
  const replayDays = useReplayDays(params.subsystem);
  const days = replayDays.status === "known" ? replayDays.viewable : EMPTY_DAYS;
  const tools = useMemo(() => voiceTools(days), [days]);

  /**
   * The current selection and scenario, in a ref.
   *
   * A ref and not a closure: the socket's message handler is installed once,
   * when the session starts, and a tool call arriving three navigations later
   * must be executed against the URL the reader is on *now*. Closing over
   * `params` would execute it against the URL the session was opened on, which
   * is the same "the feature breaks when it works" failure §2.2 is about — one
   * layer down, and invisible, because every intent would still be a valid URL.
   */
  const liveSelection = useMemo(
    () => ({ params, screen, locale, serving, days }),
    [params, screen, locale, serving, days],
  );
  const liveRef = useLatest(liveSelection);

  /**
   * The prompt the model is holding right now: the standing rules with this
   * turn's context block under them.
   *
   * Computed on every render rather than memoised, and that is deliberate.
   * `contextSentence` and `voiceInstructions` are both pure string builders over
   * state that is already in hand — §3.4 requires it: *"a pure function of
   * already-fetched state — it must not issue a request of its own, or the
   * agent's context and the screen's numbers could disagree."* A memo keyed on
   * the six fields it reads would be a second, weaker statement of when the
   * block changes, and the strong one is available for free: compare the string.
   */
  const context = voiceInstructions(
    locale,
    contextSentence({ locale, screen, params, serving }),
  );

  const scenarioRaw = firstValue(rawParams[SCENARIO_PARAM]);
  const scenarioReadout = useMemo(
    () => readScenario(scenarioRaw, defaultScenario(params.subsystem, params.date)),
    [scenarioRaw, params.subsystem, params.date],
  );
  const scenarioRef = useLatest(scenarioReadout);

  const navigator: VoiceNavigator = useMemo(
    () => ({
      navigate: (pathname_, next) => {
        /*
          **Two of the four destinations are no longer elsewhere.**

          Explicar and Mitigar are sections of `/app` now. The agent still names
          their paths — `SCREEN_PATHS` is the vocabulary it was taught and
          `context.ts` reads the same constants — but performing `explain` as a
          navigation would throw away the map the reader is looking at to reach
          content six hundred pixels below it. `SectionBlock` was given anchors
          for exactly this and nothing was using them.

          So the intent is unchanged and its performance is not: set the
          selection, then scroll. This is the file whose whole job is "how an
          intent is performed", which is why the two sections' paths are decided
          here rather than in `execute.ts`, where what the agent *means* lives.
        */
        const section = SECTION_OF[pathname_];
        if (section !== undefined) {
          router.setParams({ ...next });
          requestSection(section);
          // The highlight survives, unlike below: the map is still on this page,
          // a few thousand pixels up, and the region the agent lit is still the
          // region it is talking about.
          return;
        }
        // `push`, so browser Back reverses what the agent did. §0: *"undoable —
        // browser Back reverses it"* is one of the four properties that make
        // this shippable rather than a demo, and it is a property of `push`.
        router.push({ pathname: pathname_ as never, params: { ...next } });
        // A navigation ends a highlight. The emphasis was an answer about the
        // screen the reader was on, and carrying it onto the next screen would
        // leave a region lit for a reason nobody can see any more.
        setHighlighted(null);
      },
      setParams: (next) => {
        router.setParams({ ...next });
      },
      brief: (questionKind, subsystem) => {
        // Held, not performed. The provider owns the plan because the stage
        // overlays whatever screen the reader is on, and composing it needs the
        // network and explain state this component already holds.
        setBriefing({ questionKind, subsystem });
      },
      highlight: (subsystem) => {
        setHighlighted(subsystem);
      },
      refuse: () => {
        // A refusal changes nothing on screen by design — the dock renders it
        // from the action card and the model says it out loud. The reader must
        // not be moved anywhere on the strength of an argument we rejected.
      },
    }),
    [],
  );

  const onToolCall = useCallback(
    (call: ToolCall) => {
      const live = liveRef.current;
      const scenario = scenarioRef.current;
      const intent = executeTool(
        call,
        live.params,
        // The calendar the reader's screen has, not the one the session opened
        // with: a tool call three navigations later must be checked against
        // what the deployment can answer *now*, which is why it rides in the
        // same ref as the params rather than in this callback's closure.
        live.days,
        scenario.ok === true ? scenario.scenario : undefined,
      );
      performIntent(intent, navigator);
      setAction({ intent, at: Date.now() });
      // The intent goes back to `useVoiceSession`, which answers the model with
      // it and puts the status back after a refusal. Both are things done *to
      // the session*, and this callback is the part that is about the app: what
      // the call means, where it sends the reader, and what the card says.
      return intent;
    },
    // `liveRef` and `scenarioRef` are read inside, deliberately: the handler
    // is installed once and a tool call arriving three navigations later must
    // execute against the URL the reader is on now. Listing them would rebuild
    // the handler on every navigation, which is the closure bug inverted.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
    [navigator],
  );

  /**
   * The live session — a credential, a socket and the state it produces.
   *
   * One string and one callback in; the session's state and three actions out.
   * `use-voice-session.ts` carries the argument for the split: everything about
   * the WebSocket is behind this line, and everything this component does with
   * the result — the action card, the map highlight, the dock's size — is in
   * front of it.
   */
  const session = useVoiceSession({ context, tools, onToolCall });
  const { availability, status, transcript, level, mic, error, say, narrationClock } =
    session;

  /**
   * `stop` is the session's; `close` is the screen's.
   *
   * Closing the dock also clears the map highlight and collapses the panel —
   * both things about what the *reader* sees, neither of which a socket has an
   * opinion about. Composing them here rather than passing two setters into the
   * hook is what keeps its interface one callback wide.
   */
  const open = useCallback(() => session.open(), [session]);
  const close = useCallback(() => {
    session.stop();
    setHighlighted(null);
    // A briefing outlives nothing. Left standing it would run on a wall clock
    // over a dead session, narrating a turn that has been torn down.
    setBriefing(null);
    setExpandedByReader(false);
  }, [session]);

  // Stable identities: the expanded panel installs a `keydown` listener keyed
  // on `collapse`, and a new function per render would tear the listener down
  // and rebuild it on every audio level frame.
  const dismissBriefing = useCallback(() => setBriefing(null), []);
  /*
    Re-perform the last action, through the same `performIntent` the tool call
    went through. Not a second code path: a repeat that navigated by its own
    route would be a place for the two to disagree about what the agent did.
  */
  const repeatAction = useCallback(() => {
    if (action !== null) {
      performIntent(action.intent, navigator);
    }
  }, [action, navigator]);
  const expand = useCallback(() => setExpandedByReader(true), []);
  const collapse = useCallback(() => setExpandedByReader(false), []);

  const value: VoiceAgentState = useMemo(
    () => ({
      availability,
      status,
      size: dockSizeFor(status, expandedByReader),
      transcript,
      level,
      mic,
      action,
      repeatAction,
      briefing,
      dismissBriefing,
      narrationClock,
      highlighted,
      error,
      open,
      close,
      expand,
      collapse,
      say,
    }),
    [
      availability,
      status,
      expandedByReader,
      transcript,
      level,
      mic,
      action,
      repeatAction,
      briefing,
      dismissBriefing,
      narrationClock,
      highlighted,
      error,
      open,
      close,
      expand,
      collapse,
      say,
    ],
  );

  return <VoiceAgentProvider value={value}>{children}</VoiceAgentProvider>;
}

/** `useGlobalSearchParams` types every value as `string | string[]`. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
