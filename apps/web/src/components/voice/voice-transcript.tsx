/**
 * The transcript, in the EXPANDED panel only.
 *
 * **It is not a chat log, and the difference is not cosmetic.**
 * `docs/plans/voice-copilot.md` §9 refuses chat history, threads and a model
 * picker outright: *"Voice here is stateless across sessions by design — the
 * state is the URL."* So this renders **this session's turns and nothing
 * else**, it is not persisted, it is cleared when the dock opens, and there is
 * no way to scroll into a previous conversation because there is no previous
 * conversation to scroll into.
 *
 * What it is for is narrower and worth naming: a spoken sentence is gone the
 * moment it is said, and a reader who was looking at the map while the agent
 * named a driver has no way back to it. The transcript is the *replay of the
 * last thing said*, which is why it is only in the expanded size — at the pill
 * sizes there is nowhere to put it and the reader has not asked for it.
 *
 * The assistant's line streams in: `session.ts` emits a growing string under
 * one id per turn, and the list updates that entry rather than appending a word
 * at a time. A list that appended would grow to fifty entries a sentence and
 * would scroll under the reader's eye while they were reading it.
 */

import { radius, space, type, usePalette } from "@wattsteer/ui";
import { ScrollView, Text, View } from "react-native";
import { useCopy } from "@/i18n";
import type { TranscriptEntry } from "@/lib/voice/session";

/**
 * How tall the transcript is allowed to get.
 *
 * A fixed maximum rather than "as tall as it needs": the dock is fixed to the
 * viewport, and a panel that grows with the conversation eventually covers the
 * screen it exists to annotate. 200 px holds about four turns at this type
 * size, which is more than a spoken exchange usually has in it, and the rest
 * scrolls.
 */
const MAX_HEIGHT = 200;

export function VoiceTranscript({ entries }: { entries: readonly TranscriptEntry[] }) {
  const colors = usePalette();
  const copy = useCopy();

  if (entries.length === 0) {
    return (
      <Text
        testID="voice-transcript-empty"
        style={{ ...type.bodySmall, color: colors.inkFaint }}
      >
        {copy.app.voice.transcript.empty}
      </Text>
    );
  }

  return (
    <ScrollView
      testID="voice-transcript"
      // A live region, so a screen reader hears the agent's answer without the
      // reader having to go looking for it. The whole point of a voice
      // interface is that the answer arrives; announcing it is the same
      // promise kept for someone who cannot hear it.
      accessibilityLiveRegion="polite"
      aria-live="polite"
      style={{ maxHeight: MAX_HEIGHT }}
      contentContainerStyle={{ gap: space.sm }}
    >
      {/*
        **A `ScrollView` and a `map`, on a list that is bounded to twenty.**

        The rule this suppresses is about a mapped list building every row at
        once, which is a real cost on a list that can grow without limit. This
        one cannot: `voice-provider.tsx` trims the transcript to
        `TRANSCRIPT_TURNS` on every append, for the reason stated there — the
        provider outlives every screen, so its state is the visit's and the
        transcript was the one piece of it that only grew.

        Twenty short rows is not a virtualisation problem, and a `FlatList`
        here would cost the two things this panel is built on: the live region
        that announces the agent's answer to a screen reader, and `maxHeight`
        letting the panel size itself to its content below the cap. Bounding the
        data was the fix; the container was never the defect.
      */}
      {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list */}
      {entries.map((entry) => (
        <View key={entry.id} style={{ gap: 2 }}>
          <Text
            style={{
              ...type.caption,
              // The speaker's name carries the distinction, not a bubble.
              // Bubbles are a chat idiom and this is not a chat — and at 400 px
              // two alignments halve the width available to the longer of the
              // two lines, which is always the agent's.
              color: entry.role === "user" ? colors.inkFaint : colors.onAccentSoft,
            }}
          >
            {entry.role === "user"
              ? copy.app.voice.transcript.you
              : copy.app.voice.transcript.agent}
          </Text>
          <Text
            style={{
              ...type.bodySmall,
              color: entry.role === "user" ? colors.inkMuted : colors.ink,
              borderLeftWidth: entry.role === "assistant" ? 2 : 0,
              borderLeftColor: colors.accent,
              paddingLeft: entry.role === "assistant" ? space.sm : 0,
              borderRadius: radius.sm,
            }}
          >
            {entry.text}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}
