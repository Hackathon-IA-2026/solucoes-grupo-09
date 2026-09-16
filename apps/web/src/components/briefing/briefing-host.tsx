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

import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (briefing === null) {
      return;
    }
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
  // Both zero means nothing is playing — which is also exactly what a blocked
  // autoplay policy looks like. The sequence falls back to a wall clock so the
  // briefing still advances, and says so on screen.
  const silent = clock.bufferedMs === 0;
  const elapsed = silent ? tick * TICK_MS : clock.elapsedMs;

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
