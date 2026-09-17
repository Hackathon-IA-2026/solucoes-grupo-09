/**
 * The five questions, as five cards.
 *
 * ## Why the headline of the first card is a risk class and not "Sim"
 *
 * The dashboard this is modelled on answers "Vai cortar?" with the word **Sim**.
 * That is exactly right at a day probability of 1.0 and a falsehood at 0.6, and
 * the card cannot tell which it is holding — so a yes/no headline would be true
 * on the days nobody needed it and wrong on the days somebody did.
 *
 * The product already has a word for this and uses it everywhere else: the risk
 * class, three bins with published boundaries, which the gateway returns rather
 * than the browser deciding. It reads as a verdict, it *is* a verdict, and the
 * probability sits under it so a reader can see which end of the bin they are
 * on. Nothing is lost except the false crispness.
 */

import type { ReactNode } from "react";
import { radius, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";

/**
 * One question card.
 *
 * `tone` colours the headline and the border, and is passed only by the risk
 * card. The other four are figures rather than judgements, and colouring them
 * would imply a scale they are not on.
 */
export function QuestionCard({
  icon,
  question,
  answer,
  unit,
  detail,
  footnote,
  tone,
}: {
  icon: ReactNode;
  question: string;
  answer: string;
  unit?: string;
  detail: string;
  footnote?: string;
  tone?: string;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        /*
          Exact fifths of the row, so the three columns underneath can line up
          with the card edges — the arithmetic is beside the three columns in
          `overview/overview-hero.tsx`. `flexBasis: 0` rather than a content width is what makes
          them exact; `minWidth` is what stops them becoming unreadable rather
          than merely narrow, and is the point at which the row wraps.

          The explicit `flexShrink` is not redundant: react-native-web defaults
          it to 0 where CSS defaults it to 1, so a basis alone is a floor rather
          than a preference (ADR-0001).
        */
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 188,
        gap: 6,
        padding: space.md,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: tone === undefined ? colors.border : tone,
        backgroundColor: colors.surface,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {icon}
        <Text
          style={{
            ...type.caption,
            color: colors.inkFaint,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
          numberOfLines={1}
        >
          {question}
        </Text>
      </View>

      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
        <Text
          style={{
            fontSize: 27,
            lineHeight: 32,
            fontWeight: "700",
            color: tone ?? colors.ink,
            fontVariant: ["tabular-nums"],
            letterSpacing: -0.8,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {answer}
        </Text>
        {unit === undefined ? null : (
          <Text style={{ ...type.label, color: colors.inkMuted }}>{unit}</Text>
        )}
      </View>

      <Text style={{ ...type.caption, color: colors.inkMuted }} numberOfLines={2}>
        {detail}
      </Text>
      {footnote === undefined ? null : (
        <Text
          style={{
            ...type.caption,
            color: colors.inkFaint,
            fontVariant: ["tabular-nums"],
          }}
          numberOfLines={1}
        >
          {footnote}
        </Text>
      )}
    </View>
  );
}
