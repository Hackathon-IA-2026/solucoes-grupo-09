/**
 * The one briefing, mounted beside the dock.
 *
 * It sits in `app/app/_layout.tsx` for the same reason `VoiceDock` does: a
 * reader can ask for a briefing from any of the four screens, and a stage that
 * lived on one of them would answer only there. The first cut of this feature
 * mounted it on Visão da rede alone, so the agent reported "briefing opened" on
 * Explicar and nothing opened — a tool that silently does nothing, which is the
 * failure the exhaustive `switch` in `use-voice-agent` exists to prevent, and
 * which had simply reappeared one layer further out.
 *
 * What it draws comes from the screen, through `BriefingSubjectProvider`. What
 * it *says* comes from the transcript the session already keeps. Neither is
 * fetched here.
 */

import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { BriefingStage } from "@/components/briefing/briefing-stage";
import { useBriefingSubject } from "@/components/briefing/briefing-subject";
import { useVoiceAgent } from "@/components/voice/use-voice-agent";
import { cursorFor } from "@/lib/voice/briefing/clock";
import { composeBriefing } from "@/lib/voice/briefing/compose";

/**
 * How often the cursor is recomputed while a briefing runs.
 *
 * The tick only *samples* the audio clock — it does not advance anything — so a
 * slow tick shows a scene late and a fast one costs renders. 120 ms is below
 * where a late scene change is noticeable against speech, and well above one
 * render per frame.
 */
const TICK_MS = 120;

export function BriefingHost() {
  const { briefing, dismissBriefing, narrationClock, transcript } = useVoiceAgent();
  const { context, data, counterfactual } = useBriefingSubject();
  const [tick, setTick] = useState(0);
  /**
   * The last elapsed the *audio* reported, held across a barge-in.
   *
   * When the reader speaks over the agent the session cancels the turn and
   * `endNarration` drops the clock, so the backend goes back to reporting
   * zeros. Without this the stage would fall through to the wall clock —
   * which has been running the whole time — and snap to the last scene at the
   * exact moment the reader interrupted. Plan §4.1 says hold, and this is how.
   */
  const heldMs = useRef(0);

  useEffect(() => {
    if (briefing === null) {
      return;
    }
    // **Reset, not just start.** `tick` is component state and a second
    // briefing in the same visit would otherwise inherit the first one's
    // count and open already finished.
    setTick(0);
    heldMs.current = 0;
    const id = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(id);
  }, [briefing]);

  // Mounted on every app screen, so the common case is no briefing at all and
  // it must cost nothing: no compose, no clock read, no interval.
  if (briefing === null) {
    return null;
  }

  // A briefing asked for on a screen that has published nothing still composes
  // — into a single refusal scene, which is the honest answer to "brief me"
  // where nothing has been read.
  const plan =
    context === null
      ? null
      : composeBriefing({
          context,
          kind: briefing.questionKind,
          counterfactual,
          hasComparison: data.comparison !== null && data.comparison.length > 0,
        });
  if (plan === null) {
    return null;
  }

  const clock = narrationClock();
  /*
    Which clock, and why it is three cases rather than two.

    - **Audio is playing.** Lock to it. A scene has to change on the sentence
      it illustrates.
    - **Audio played and has stopped** — the turn ended, or the reader barged in
      and the session cancelled it. Hold where the audio left off rather than
      falling through to the wall clock, which has been running since the
      briefing opened and would jump the stage to its last scene.
    - **Audio never played.** A blocked autoplay policy buffers frames that
      never sound: `bufferedMs` grows while `currentTime` does not move, so
      "queued" and "playing" are indistinguishable without `running`. The wall
      clock drives the sequence and the stage says it is silent.
  */
  const audible = clock.bufferedMs > 0 && clock.running;
  if (audible) {
    heldMs.current = clock.elapsedMs;
  }
  const started = heldMs.current > 0;
  const silent = !(audible || started);
  const elapsed = audible ? clock.elapsedMs : started ? heldMs.current : tick * TICK_MS;

  return (
    <BriefingStage
      plan={plan}
      cursor={cursorFor(plan, elapsed, clock.bufferedMs)}
      // The narration is what the agent actually said, read off the transcript
      // the session already keeps. Never a second copy generated for display:
      // two texts for one utterance is two things to drift.
      narration={lastSpoken(transcript)}
      silent={silent}
      data={data}
      onDismiss={dismissBriefing}
      // Replay restarts this host's clocks rather than re-asking the model: the
      // plan and the narration are already here, and a second turn would answer
      // a question the reader did not ask twice.
      onReplay={() => {
        heldMs.current = 0;
        setTick(0);
      }}
      // Escape closes it on web, which is what a reader expects of anything
      // that covers the screen. `Platform` rather than a bare `document` guard
      // so the native build never reaches for a DOM listener.
      escapeToDismiss={Platform.OS === "web"}
    />
  );
}

/** The most recent thing the agent said, or nothing yet. */
function lastSpoken(
  transcript: readonly { readonly role: "user" | "assistant"; readonly text: string }[],
): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role === "assistant") {
      return entry.text;
    }
  }
  return "";
}
