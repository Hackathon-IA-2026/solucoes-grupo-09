/**
 * The live session: a credential, a socket, and the state it produces.
 *
 * Split from `VoiceProvider`, which was over the size threshold by holding two
 * jobs at once. The provider is a **coordinator** — it decides what the agent
 * is told about the screen, what a tool call does to the URL, and how big the
 * dock is. None of that is about a WebSocket, and this is all of what is.
 *
 * **A deep module by the interface it offers.** One string and one callback in;
 * five pieces of state and three actions out. Everything between — minting an
 * ephemeral credential, wiring six handlers, the re-mint timer, the trim on the
 * transcript, and the rule that a context block is pushed once per *value*
 * rather than once per render — is behind it.
 *
 * What deliberately stays outside: the action card, the map highlight and the
 * dock's expanded flag. Those are what the reader sees *about* a session rather
 * than the session itself, and a hook that owned them would be back to two
 * jobs.
 */

import { ApiError } from "@wattsteer/core/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useLatest } from "@/lib/use-latest";
import type { NavigationIntent, ToolCall } from "@/lib/voice/execute";
import {
  type MintedSession,
  type TranscriptEntry,
  VoiceSessionCore,
  type VoiceStatus,
} from "@/lib/voice/session";
import { VOICE_TOOLS } from "@/lib/voice/tools";
import { WebAudioBackend } from "@/lib/voice/web-audio-backend";
import {
  remintDelayMs,
  toolResult,
  type VoiceAvailability,
  type VoiceMicState,
} from "./use-voice-agent";

/**
 * How many turns the transcript keeps.
 *
 * **A bound, because this provider outlives every screen.** It sits above the
 * `Stack` — §2.2's whole argument — so its state lives for the visit, not for a
 * route, and `transcript` was the one piece of it that only ever grew. A long
 * session accumulated an entry per turn for as long as the tab stayed open, and
 * every one of them was rendered: `voice-transcript.tsx` maps the array into a
 * `ScrollView`, which virtualises nothing. Bounded height, unbounded list.
 *
 * Twenty is chosen against what the panel is *for*, which its own header says:
 * "the replay of the last thing said". `MAX_HEIGHT` shows about four turns
 * and the rest scrolls, so twenty is five screenfuls of scrollback behind a
 * question nobody asks more than a turn or two later. Trimming below that would
 * be losing something a reader might reach for; keeping more is keeping it for
 * nobody.
 *
 * Dropping from the front, so what survives is the *recent* end. And only on
 * append — a streaming update rewrites an entry in place and must not shift the
 * window under a reader mid-sentence.
 */
const TRANSCRIPT_TURNS = 20;

function trimTranscript(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  return entries.length <= TRANSCRIPT_TURNS
    ? entries
    : entries.slice(entries.length - TRANSCRIPT_TURNS);
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

/** What a live session is, and the three things a caller can do to it. */
export interface VoiceSession {
  readonly status: VoiceStatus;
  /**
   * Whether this deployment can mint a session at all. `unknown` until the
   * first attempt; a provider with no key latches `unavailable` so the trigger
   * can stop offering a control that cannot work.
   */
  readonly availability: VoiceAvailability;
  readonly level: number;
  readonly mic: VoiceMicState;
  readonly transcript: readonly TranscriptEntry[];
  readonly error: string | null;
  /** Mint, connect and open the microphone. Safe to call while already open. */
  readonly open: () => void;
  /** Close the socket and the microphone. Safe to call when already closed. */
  readonly stop: () => void;
  /** A typed line, for a reader with no microphone. See the note on `say`. */
  readonly say: (text: string) => void;
}

export function useVoiceSession({
  context,
  onToolCall,
}: {
  /**
   * What the reader is looking at, as the sentence the model is told. Pushed
   * between turns, deduplicated by value — see the effect below.
   */
  context: string;
  /**
   * What a tool call means to the app — where it sends the reader, and what
   * the action card says. Returns the intent, which this hook then answers the
   * model with: replying to the conversation and resetting the status after a
   * refusal are things done *to the session*, and keeping them here is what
   * keeps this interface one callback wide.
   */
  onToolCall: (call: ToolCall) => NavigationIntent;
}): VoiceSession {
  const [availability, setAvailability] = useState<VoiceAvailability>("unknown");
  /**
   * The prompt the model is holding right now, readable from a callback that
   * outlived the render it was installed in.
   *
   * `open` and `say` both need the *current* block and both must keep a stable
   * identity — `open` because it is handed to the dock's press handler, `say`
   * because the expanded panel keys a listener on it and a new function per
   * render would tear that down under a half-typed line. Depending on `context`
   * would rebuild both on every selection change; closing over it would hand
   * the model the screen the dock was first rendered on.
   */
  const contextRef = useLatest(context);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [level, setLevel] = useState(0);
  const [mic, setMic] = useState<VoiceMicState>("unasked");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<VoiceSessionCore | null>(null);
  const remintRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const levelAtRef = useRef(0);
  /** The last block the session was actually told. See the effect below. */
  const sentContextRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (remintRef.current !== null) {
      clearTimeout(remintRef.current);
      remintRef.current = null;
    }
    sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus("idle");
    setLevel(0);
    // The map highlight is *not* cleared here. It belongs to the screen, not to
    // the socket, and `VoiceProvider` clears it alongside this call — which is
    // what keeps this hook's interface one callback and one string wide.
    // Teardown only. Nothing read here changes what unmount has to do.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
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
              return trimTranscript([...current, entry]);
            }
            const next = [...current];
            next[at] = entry;
            return next;
          }),
        onToolCall: (call) => {
          const intent = onToolCall(call);
          if (call.callId !== undefined) {
            // Answer the model, always — including for a refusal. A tool call
            // the conversation never answers leaves the next turn built on a
            // gap, and the gap is where a model invents the figure it was
            // refused.
            session.respondToTool(call.callId, toolResult(intent));
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
        onLevel: (frameLevel) => {
          const now = Date.now();
          if (now - levelAtRef.current < LEVEL_FRAME_MS) {
            return;
          }
          levelAtRef.current = now;
          setLevel(frameLevel);
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
    // `contextRef` is read at session start, on purpose — the prompt the model
    // is handed is whatever the screen says at the moment it connects. Adding
    // it would tear down and re-mint the session on every selection change.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [mint, onToolCall]);

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
    setTranscript((current) =>
      trimTranscript([
        ...current,
        { id: `typed-${current.length}`, role: "user", text: trimmed },
      ]),
    );
    sessionRef.current?.updateContext(
      `${contextRef.current}\nThe reader typed, rather than said: ${trimmed}`,
    );
    // `contextRef` is read at the moment the reader presses send, which is the
    // whole reason it is a ref: a `say` rebuilt on every context change would
    // be a new function identity on every selection, and the dock's panel would
    // tear down its handler under a half-typed line.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, []);

  return { status, availability, level, mic, transcript, error, open, stop, say };
}
