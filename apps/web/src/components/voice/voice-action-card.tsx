/**
 * "↗ Abri Explicar para você" — the load-bearing element, and the plan says so
 * in as many words:
 *
 * > The action card is the load-bearing element. It is what makes an automatic
 * > navigation feel like **the assistant did something for you** rather than
 * > the app jumping. It states what changed and stays there after the speech
 * > ends, so a reader who looked away can see what happened. Tapping it
 * > re-navigates; it is also the undo affordance's anchor.
 *
 * Three things follow from that paragraph and each is a decision here.
 *
 * **It states the selection, not just the screen.** "I opened Explain" is a
 * claim about a route; "Explain · NE · Wind · 12Z" is a claim about a *state*,
 * and the state is what the agent actually changed. A reader who looked up
 * mid-navigation needs the second one to know whether it answered their
 * question.
 *
 * **It renders a refusal with the same weight as a success.** A refused tool
 * call is a thing that happened, and hiding it would leave the reader with a
 * screen that did not change and a voice that said something they may not have
 * caught. The card names the rule that refused — from `copy`, keyed on the
 * refusal code, so a refusal is never prose assembled at a call site. The
 * refusal table in `execute.ts` separates its codes by *what the reader should
 * hear*, and this is where that separation is spent.
 *
 * **Tapping it re-navigates.** The same intent, performed again. It is not an
 * undo: browser Back is the undo, and it already works because the agent
 * navigates with `push`. This is the other direction — a reader who navigated
 * away manually and wants to get back to what the agent showed them.
 */

import {
  ArrowUpRightIcon,
  focusRing,
  radius,
  space,
  type,
  usePalette,
} from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { useCopy } from "@/i18n";
import type { NavigationIntent } from "@/lib/voice/execute";
import { intentLines } from "./use-voice-agent";

export function VoiceActionCard({
  intent,
  onPress,
}: {
  intent: NavigationIntent;
  onPress?: () => void;
}) {
  const colors = usePalette();
  const copy = useCopy();

  const refused = intent.kind === "refused";
  const { headline, detail } = intentLines(intent, copy);

  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.md,
        borderWidth: 1,
        // A refusal is warned, not errored: the agent declining to guess is
        // the agent working, and the red of `danger` is reserved for things
        // that broke.
        borderColor: refused ? colors.warning : colors.accent,
        backgroundColor: refused ? colors.warningSoft : colors.accentSoft,
      }}
    >
      {refused ? null : (
        <ArrowUpRightIcon size={14} color={colors.onAccentSoft} strokeWidth={2} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            ...type.label,
            color: refused ? colors.onWarningSoft : colors.onAccentSoft,
          }}
        >
          {headline}
        </Text>
        {detail === "" ? null : (
          <Text style={{ ...type.caption, color: colors.inkMuted }}>{detail}</Text>
        )}
      </View>
    </View>
  );

  /**
   * What a screen reader announces: the two visible lines, joined.
   *
   * Assembled from two dictionary strings and one separator rather than from a
   * third copy key, because the separator is punctuation and a locale has no
   * opinion about it. Hoisted out of the JSX so the repo's hardcoded-copy guard
   * sees a variable rather than a template — a check keyed on the prop name
   * cannot tell a joined pair of translated clauses from an English literal, and
   * teaching it to would weaken it for every other component.
   */
  const spoken = detail === "" ? headline : `${headline}. ${detail}`;

  if (onPress === undefined || refused) {
    // A refusal is not re-performable: pressing it would re-run a call we
    // already rejected, which is either nothing happening or the same refusal
    // again. Neither is worth a control.
    return <View testID="voice-action-card">{body}</View>;
  }

  return (
    <Pressable
      testID="voice-action-card"
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={onPress}
      style={(state) => {
        const { focused = false } = state as { focused?: boolean };
        return {
          borderRadius: radius.md,
          ...focusRing(focused, colors.focus, 2),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      {body}
    </Pressable>
  );
}
