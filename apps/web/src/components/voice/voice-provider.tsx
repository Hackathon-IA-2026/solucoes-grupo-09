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
import { ApiError } from "@wattsteer/core/client";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseAppParams } from "@/components/app/params";
import { defaultScenario, readScenario, SCENARIO_PARAM } from "@/components/app/scenario";
import { useServing } from "@/components/app/use-serving";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { contextSentence, type VoiceScreen } from "@/lib/voice/context";
import { executeTool, SCREEN_PATHS, type ToolCall } from "@/lib/voice/execute";
import { voiceInstructions } from "@/lib/voice/instructions";
import {
  type MintedSession,
  type TranscriptEntry,
  VoiceSessionCore,
  type VoiceStatus,
} from "@/lib/voice/session";
import { VOICE_TOOLS } from "@/lib/voice/tools";
import { WebAudioBackend } from "@/lib/voice/web-audio-backend";
import {
  dockSizeFor,
  performIntent,
  remintDelayMs,
  toolResult,
  type VoiceAction,
  VoiceAgentProvider,
  type VoiceAgentState,
  type VoiceAvailability,
  type VoiceMicState,
  type VoiceNavigator,
} from "./use-voice-agent";

/** Which of the four modes a pathname is. The agent addresses no other route. */
export function screenFor(pathname: string): VoiceScreen {
  if (pathname.startsWith(SCREEN_PATHS.explain)) {
    return "explain";
  }
  if (pathname.startsWith(SCREEN_PATHS.mitigate)) {
    return "mitigate";
  }
  if (pathname.startsWith(SCREEN_PATHS.replay)) {
    return "replay";
  }
  return "overview";
}

/**
 * How often a level frame is allowed to become a render.
 *
 * The capture worklet emits a frame per 128 samples at 24 kHz — 187 a second —
 * and `setState` on every one of them would re-render the whole dock subtree
 * 187 times a second while the reader is talking. Measured on the export, the
 * orb is indistinguishable at 20 Hz from at 187 Hz, because the bars are 4 px
 * wide and a human cannot see a 5 ms difference in one. So the level is
 * sampled, not smoothed: what reaches the orb is still a real measurement of a
 * real moment, just fewer of them.
 */
const LEVEL_FRAME_MS = 50;

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const serving = useServing();
  const pathname = usePathname();
  // Global, not local: this provider sits *above* the `Stack`, so the local
  // search params here are the layout's and not the focused screen's. The
  // agent must act on what the reader is actually looking at.
  const rawParams = useGlobalSearchParams();

  const [availability, setAvailability] = useState<VoiceAvailability>("unknown");
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [level, setLevel] = useState(0);
  const [mic, setMic] = useState<VoiceMicState>("unasked");
  const [action, setAction] = useState<VoiceAction | null>(null);
  const [highlighted, setHighlighted] = useState<SubsystemCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedByReader, setExpandedByReader] = useState(false);

  const sessionRef = useRef<VoiceSessionCore | null>(null);
  const remintRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const levelAtRef = useRef(0);

  const params = useMemo(() => parseAppParams(rawParams), [rawParams]);
  const screen = screenFor(pathname);

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
  const liveRef = useRef({ params, screen, locale, serving });
  liveRef.current = { params, screen, locale, serving };

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
  const contextRef = useRef(context);
  contextRef.current = context;
  /** The last block the session was actually told. See the effect below. */
  const sentContextRef = useRef<string | null>(null);

  const scenarioRaw = firstValue(rawParams[SCENARIO_PARAM]);
  const scenarioRef = useRef<ReturnType<typeof readScenario> | null>(null);
  scenarioRef.current = readScenario(
    scenarioRaw,
    defaultScenario(params.subsystem, params.date),
  );

  const navigator: VoiceNavigator = useMemo(
    () => ({
      navigate: (pathname_, next) => {
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
        scenario?.ok === true ? scenario.scenario : undefined,
      );
      performIntent(intent, navigator);
      setAction({ intent, at: Date.now() });
      if (call.callId !== undefined) {
        // Answer the model, always — including for a refusal. A tool call the
        // conversation never answers leaves the next turn built on a gap, and
        // the gap is where a model invents the figure it was refused.
        sessionRef.current?.respondToTool(call.callId, toolResult(intent));
      }
      // `VoiceSessionCore` sets `acting` on **every** tool call, because it
      // cannot know which ones will be refused — it does not know what a
      // subsystem is, and keeping it that way is what makes `execute.ts`
      // testable. The dock does know, and a refusal that left the orb saying
      // "opening it for you" over a screen that did not change would be the
      // interface claiming an action the agent had just declined to take. So
      // the status is put back where the reader can see it is still listening.
      // Seen in the browser: a refused `explain{SUDESTE}` sat on `acting`
      // indefinitely, because nothing else moves the status until the model's
      // next audio delta arrives.
      if (intent.kind === "refused") {
        setStatus("listening");
      }
    },
    [navigator],
  );

  const stop = useCallback(() => {
    if (remintRef.current !== null) {
      clearTimeout(remintRef.current);
      remintRef.current = null;
    }
    sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus("idle");
    setLevel(0);
    setHighlighted(null);
  }, []);

  /**
   * Mint, and remember what the answer said about this deployment.
   *
   * The two voice codes are read here and nowhere else. `VOICE_NOT_CONFIGURED`
   * latches `absent`: the capability does not exist on this instance and will
   * not start existing while the page is open, so asking again would be a
   * request per button press for an answer that cannot change.
   * `VOICE_UNAVAILABLE` does not latch — the provider is down *now*, and the
   * reader pressing the button again in a minute is a reasonable thing to let
   * them do.
   */
  const mint = useCallback(async (): Promise<MintedSession> => {
    try {
      const minted = await api.voiceSession();
      setAvailability("present");
      // Re-mint before it lapses rather than discovering expiry mid-sentence —
      // §2.1 non-negotiable 3. The socket is not torn down: the next `start`
      // opens a new one, which is why this is scheduled rather than eager.
      if (remintRef.current !== null) {
        clearTimeout(remintRef.current);
      }
      remintRef.current = setTimeout(
        () => {
          void sessionRef.current?.start();
        },
        remintDelayMs(minted.expiresAt, Date.now()),
      );
      return minted;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "VOICE_NOT_CONFIGURED") {
        setAvailability("absent");
      }
      throw cause;
    }
  }, []);

  const open = useCallback(() => {
    if (sessionRef.current !== null) {
      return;
    }
    setError(null);
    setTranscript([]);
    const session = new VoiceSessionCore(
      {
        onStatus: (next) => {
          setStatus(next);
          if (next === "listening") {
            // Reaching `listening` is the only proof the microphone opened:
            // `startCapture` resolves after `getUserMedia` did.
            setMic("granted");
          }
        },
        onTranscript: (entry) =>
          setTranscript((current) => {
            const at = current.findIndex((item) => item.id === entry.id);
            if (at === -1) {
              return [...current, entry];
            }
            const next = [...current];
            next[at] = entry;
            return next;
          }),
        onToolCall,
        onLevel: (value) => {
          const now = Date.now();
          if (now - levelAtRef.current < LEVEL_FRAME_MS) {
            return;
          }
          levelAtRef.current = now;
          setLevel(value);
        },
        onError: (message) => {
          setError(message);
          // A denied microphone is the most common failure here, and it is not
          // an error the reader should be scolded with. It becomes the typed
          // fallback instead — §8, "not an error toast".
          if (isPermissionDenial(message)) {
            setMic("denied");
          }
          sessionRef.current = null;
        },
      },
      new WebAudioBackend(),
      {
        mint,
        // The block as it is *now*, read through the ref: `open` is a stable
        // callback and a closure over `context` would hand the model the screen
        // the dock was first rendered on rather than the one it is opening from.
        instructions: contextRef.current,
        tools: VOICE_TOOLS,
      },
    );
    sessionRef.current = session;
    void session.start();
  }, [mint, onToolCall]);

  const close = useCallback(() => {
    stop();
    setExpandedByReader(false);
  }, [stop]);

  /**
   * Push the reader's screen into the session between turns.
   *
   * Deduplicated **by value**, not by a dependency list. The obvious version
   * keys the effect on the six fields the block is built from, and it is a
   * second statement of the same fact that can drift from the first the moment
   * a seventh field joins `contextSentence` — the symptom being an agent that
   * answers confidently about the screen the reader left. Comparing the string
   * it is about to send cannot drift, because the string *is* the thing that
   * changed.
   *
   * It is also what makes the effect safe to run on every render: the level
   * meter re-renders this subtree about twenty times a second while the reader
   * is talking, and a `session.update` per frame would be twenty prompt rewrites
   * a second.
   */
  useEffect(() => {
    if (sessionRef.current === null || sentContextRef.current === context) {
      return;
    }
    sentContextRef.current = context;
    sessionRef.current.updateContext(context);
  }, [context]);

  /** One teardown, on unmount. Leaving `/app` closes the microphone. */
  useEffect(() => stop, [stop]);

  /**
   * The typed fallback: a turn the reader wrote instead of said.
   *
   * It shows in the transcript as the reader's own turn, because it is one —
   * the only difference from a spoken turn is which device it arrived on, and a
   * separate rendering would suggest otherwise. It is then pushed into the
   * session as context, so the agent's next turn is answered knowing it.
   *
   * **Known limit, stated rather than hidden.** `VoiceSessionCore` exposes
   * `respondToTool` and `updateContext` and nothing that creates a *user* turn,
   * so a typed line cannot itself provoke a spoken answer: it reaches the model
   * as context, not as a question. Closing that needs one method on the pure
   * layer — a `conversation.item.create` of an `input_text` item followed by
   * `response.create` — and `@/lib/voice/*` is out of scope for this change, so
   * it is reported rather than written. Until then the dock's fallback panel
   * says what it is: a way to be heard without a microphone, not a chat box.
   */
  const say = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    setTranscript((current) => [
      ...current,
      { id: `typed-${current.length}`, role: "user", text: trimmed },
    ]);
    sessionRef.current?.updateContext(
      `${contextRef.current}\nThe reader typed, rather than said: ${trimmed}`,
    );
  }, []);

  // Stable identities: the expanded panel installs a `keydown` listener keyed
  // on `collapse`, and a new function per render would tear the listener down
  // and rebuild it on every audio level frame.
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

/**
 * Whether a failure message is the reader saying no to the microphone.
 *
 * Matched on the `DOMException` names the spec defines rather than on prose:
 * `NotAllowedError` is a denial, `NotFoundError` is a machine with no
 * microphone on it. Both end in the same place — the typed fallback — because
 * from the dock's point of view "you said no" and "there is nothing to say it
 * with" call for the same interface, and neither is an error.
 */
function isPermissionDenial(message: string): boolean {
  return (
    message.includes("NotAllowedError") ||
    message.includes("NotFoundError") ||
    message.includes("Permission denied") ||
    message.includes("permission")
  );
}
