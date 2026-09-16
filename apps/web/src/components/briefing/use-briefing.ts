/**
 * The screen's half of a briefing.
 *
 * `VoiceProvider` holds the *question* the agent asked; this turns it into a
 * plan and a cursor against the screen's own state. It lives on the screen for
 * one reason and it is the same reason `briefing-data.ts` gives: a briefing
 * draws what the screen has already read, and lifting that state into the
 * provider would let a briefing and the screen under it disagree about the same
 * day.
 *
 * The hook owns no timer. It reads the clock the audio backend keeps and
 * derives everything else, so a briefing cannot drift from the sentence being
 * spoken over it.
 */

import { useEffect, useState } from "react";
import { useVoiceAgent } from "@/components/voice/use-voice-agent";
import type { BriefingCursor } from "@/lib/voice/briefing/clock";
import { cursorFor } from "@/lib/voice/briefing/clock";
import { composeBriefing } from "@/lib/voice/briefing/compose";
import type { BriefingPlan } from "@/lib/voice/briefing/types";
import type { VoiceContextInput } from "@/lib/voice/context";

/**
 * How often the cursor is recomputed while a briefing runs.
 *
 * A frame budget rather than a scene budget: the tick only *samples* the audio
 * clock, so a slow tick shows a scene late while a fast one costs renders. 120
 * ms is under the threshold where a late scene change is noticeable against
 * speech and well above a render per frame.
 */
const TICK_MS = 120;

export interface BriefingView {
  readonly plan: BriefingPlan;
  readonly cursor: BriefingCursor;
  readonly silent: boolean;
  readonly dismiss: () => void;
}

export function useBriefing(
  context: VoiceContextInput,
  /**
   * How much narration has played and how much is queued, from
   * `WebAudioBackend.narrationClock()`. Both zero means no audio — blocked
   * autoplay looks exactly like silence — and the sequence falls back to a wall
   * clock so the briefing still advances.
   */
  clock: { elapsedMs: number; bufferedMs: number },
): BriefingView | null {
  const { briefing, dismissBriefing } = useVoiceAgent();
  const [wallMs, setWallMs] = useState(0);

  /*
    Composed every render rather than memoised on the question.

    Memoising would pin the plan to the state at the moment the question was
    asked, and the state that matters here is whether a forecast exists. If it
    disappears mid-briefing — a re-read refuses, the model is withdrawn — a
    pinned plan would carry on animating a forecast the product no longer has,
    which is the one failure this whole design is built to prevent. Composing is
    pure and builds a handful of small objects; correctness is worth more than
    the allocation.
  */
  const plan =
    briefing === null ? null : composeBriefing({ context, kind: briefing.questionKind });

  const silent = clock.bufferedMs === 0;

  // Keyed on the *question*, not the plan: the plan is a new object every
  // render, and restarting the interval on each one would keep resetting the
  // briefing's own start time to now.
  useEffect(() => {
    if (briefing === null) {
      setWallMs(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setWallMs(Date.now() - started), TICK_MS);
    return () => clearInterval(id);
  }, [briefing]);

  if (plan === null || briefing === null) {
    return null;
  }

  // The audio clock when there is audio, the wall clock when there is not. The
  // module that decides which scene is showing does not know the difference,
  // which is what keeps the silent path from being a second implementation.
  const elapsed = silent ? wallMs : clock.elapsedMs;
  return {
    plan,
    cursor: cursorFor(plan, elapsed, clock.bufferedMs),
    silent,
    dismiss: dismissBriefing,
  };
}
