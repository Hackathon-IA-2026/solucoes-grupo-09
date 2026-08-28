import { FadeIn, IconCircle, radius, usePalette } from "@negotiatio/ui";
import type { ReactNode } from "react";
import { Text } from "react-native";

/**
 * Uniform stat card — outlined icon circle top-left, muted label, huge
 * tabular value, and a bold-delta + muted-label footer. The first card of a
 * row is usually the lime highlight.
 */
export function StatCard({
  basis,
  icon,
  label,
  value,
  deltaValue,
  deltaPositive,
  deltaLabel,
  highlight = false,
  delay = 0,
}: {
  basis: `${number}%`;
  icon: ReactNode;
  label: string;
  value: string;
  deltaValue: string;
  deltaPositive: boolean;
  deltaLabel: string;
  highlight?: boolean;
  delay?: number;
}) {
  const colors = usePalette();
  return (
    <FadeIn
      duration={500}
      delay={delay}
      style={{
        flexBasis: basis,
        flexGrow: 1,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        padding: 20,
        ...(highlight
          ? { backgroundColor: colors.accent }
          : {
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            }),
      }}
    >
      <IconCircle tone={highlight ? "onAccent" : "outline"}>{icon}</IconCircle>

      <Text
        style={{
          marginTop: 20,
          fontSize: 14,
          fontWeight: "500",
          color: highlight ? "rgba(30, 43, 16, 0.7)" : colors.inkMuted,
        }}
      >
        {label}
      </Text>
      <Text
        selectable={true}
        style={{
          marginTop: 4,
          fontSize: 34,
          lineHeight: 40,
          fontWeight: "600",
          letterSpacing: -0.8,
          fontVariant: ["tabular-nums"],
          color: highlight ? colors.onAccent : colors.ink,
        }}
      >
        {value}
      </Text>

      <Text
        style={{
          marginTop: 12,
          fontSize: 12,
          color: highlight ? "rgba(30, 43, 16, 0.7)" : colors.inkMuted,
        }}
      >
        <Text
          style={{
            fontWeight: "700",
            color: highlight
              ? colors.onAccent
              : deltaPositive
                ? colors.accent
                : colors.danger,
          }}
        >
          {deltaValue}
        </Text>{" "}
        {deltaLabel}
      </Text>
    </FadeIn>
  );
}
