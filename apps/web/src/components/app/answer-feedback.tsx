/**
 * Two thumbs under an answer, and a box that opens under the one that means
 * "no".
 *
 * ## What this control promises, and what it does not
 *
 * It promises that the verdict was **filed**. It does not promise that anything
 * on the screen will change, because nothing will: the figure above it is what
 * the model or the corpus said, and a reader's opinion does not restate it. The
 * sentence after a press says exactly that, which is the same rule the rest of
 * these screens follow — an absence, or here an action, is stated in words a
 * reader can act on rather than implied by a glow.
 *
 * ## Why the reason box only opens on "no"
 *
 * A thumbs-up with a paragraph attached is welcome and rare; a thumbs-down
 * without one is the common case and has to stay cheap to leave, because the
 * point of this control is that a busy person uses it. So "yes" files on the
 * press, and "no" files on the press *and* offers the box — the verdict is
 * already recorded when the reader decides whether to write.
 *
 * The 400-character limit is refused here, while the reader is still looking at
 * the box, rather than after a round trip that tells them what they typed was
 * too long.
 */

import type { FeedbackSubject, FeedbackSurface } from "@wattsteer/core/api";
import { radius, space, type as type$, usePalette } from "@wattsteer/ui";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { MAX_REASON_CHARS, useFeedback } from "@/components/app/use-feedback";
import { useCopy } from "@/i18n";

export function AnswerFeedback({
  surface,
  subject,
  testID,
}: {
  surface: FeedbackSurface;
  /** What was on screen: the keys a later retrain groups by. */
  subject: FeedbackSubject;
  testID?: string;
}) {
  const colors = usePalette();
  const copy = useCopy().app.feedback;
  const { state, file } = useFeedback(surface, subject);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);

  const said =
    state.status === "filed"
      ? copy.filed
      : state.status === "failed"
        ? state.tooLong
          ? copy.tooLong
          : copy.failed
        : null;

  const thumb = (label: string, onPress: () => void, active: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      // The selection is a colour and a border, which a screen reader cannot
      // see: without this, both thumbs keep reading the same after a press.
      accessibilityState={{ selected: active, disabled: state.status === "sending" }}
      disabled={state.status === "sending"}
      onPress={onPress}
      style={{
        paddingVertical: 4,
        paddingHorizontal: space.sm,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.surfaceSunken : "transparent",
      }}
    >
      <Text style={{ ...type$.bodySmall, color: active ? colors.ink : colors.inkMuted }}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    /*
      `flexShrink: 1` and `minWidth: 0`, because this lands in a flex row on
      three screens and react-native-web defaults the shrink to 0 (ADR-0001):
      without them the block sizes to its max-content — 343px beside the Explain
      heading, in a 280px box at 320px width — and wrapping the row inside it
      changes nothing, since the parent never asks for less.
    */
    <View
      testID={testID ?? "answer-feedback"}
      style={{ gap: space.sm, flexShrink: 1, minWidth: 0 }}
    >
      {/*
        Wraps, and the question shrinks with it. The row is a sentence and two
        pills — 343px of it in a 280px box at 320px width, where it clipped the
        second thumb and was the page's only horizontal overflow
        (`no-horizontal-overflow.spec.ts` names the element). react-native-web
        defaults `flexShrink` to 0 (ADR-0001), so the row sized to its content
        and never gave any back; wrapping alone is not enough, because the
        question is one long inline that has to be allowed to break first.
      */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space.sm,
        }}
      >
        <Text style={{ ...type$.bodySmall, color: colors.inkMuted, flexShrink: 1 }}>
          {copy.question}
        </Text>
        {thumb(
          copy.up,
          () => {
            setAsking(false);
            void file("up");
          },
          state.status === "filed" && state.verdict === "up",
        )}
        {thumb(
          copy.down,
          () => {
            setAsking(true);
            void file("down");
          },
          state.status === "filed" && state.verdict === "down",
        )}
        {state.status === "sending" ? (
          <Text style={{ ...type$.bodySmall, color: colors.inkFaint }}>
            {copy.sending}
          </Text>
        ) : null}
      </View>

      {asking ? (
        <View style={{ gap: space.xs }}>
          <Text style={{ ...type$.bodySmall, color: colors.inkMuted }}>
            {copy.reasonLabel}
          </Text>
          <TextInput
            testID="answer-feedback-reason"
            value={reason}
            onChangeText={setReason}
            placeholder={copy.reasonPlaceholder}
            placeholderTextColor={colors.inkFaint}
            accessibilityLabel={copy.reasonLabel}
            multiline
            maxLength={MAX_REASON_CHARS}
            style={{
              minHeight: 56,
              padding: space.sm,
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surfaceSunken,
              color: colors.ink,
              ...type$.bodySmall,
            }}
          />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {thumb(
              copy.send,
              () => {
                /*
                  The verdict is already filed, so this row exists only to carry
                  the sentence. Pressing Send with an empty box used to file a
                  second, reasonless "down" — two rows for one press, and a
                  retrain counting verdicts would have read the thumb twice.
                */
                if (reason.trim() !== "") {
                  void file("down", reason);
                }
                setAsking(false);
                setReason("");
              },
              false,
            )}
            {thumb(
              copy.cancel,
              () => {
                setAsking(false);
                setReason("");
              },
              false,
            )}
          </View>
        </View>
      ) : null}

      {said === null ? null : (
        <Text
          testID="answer-feedback-said"
          // Announced, because it appears after the request rather than with
          // the press: a reader whose focus is still on the thumb is otherwise
          // never told whether their verdict was filed or refused.
          accessibilityLiveRegion="polite"
          role="status"
          style={{
            ...type$.bodySmall,
            color: state.status === "failed" ? colors.warning : colors.inkMuted,
          }}
        >
          {said}
        </Text>
      )}
    </View>
  );
}
