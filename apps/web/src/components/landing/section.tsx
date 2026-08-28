import { layout, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";

/** Named scroll targets. The nav and the CTAs address sections by these. */
export type SectionId = "forecast" | "engines" | "showcase" | "provenance";

/**
 * Page-width section wrapper. `onLayout` reports the section's y within the
 * scroll content so the nav can scroll to it — measured rather than
 * hard-coded, and identical on web and native (an anchor-hash approach would
 * only work on one of the two).
 */
export function Section({
  id,
  onSectionLayout,
  children,
  paddingTop = space.huge,
  paddingBottom = space.huge,
  testID,
}: {
  id: SectionId;
  onSectionLayout?: (id: SectionId, y: number) => void;
  children: ReactNode;
  paddingTop?: number;
  paddingBottom?: number;
  testID?: string;
}) {
  const handleLayout = (event: LayoutChangeEvent): void => {
    onSectionLayout?.(id, event.nativeEvent.layout.y);
  };
  return (
    <View
      testID={testID}
      onLayout={handleLayout}
      style={{
        width: "100%",
        maxWidth: layout.page + 128,
        alignSelf: "center",
        paddingHorizontal: space.lg,
        paddingTop,
        paddingBottom,
        gap: space.xl,
      }}
    >
      {children}
    </View>
  );
}

/** Centred section heading: title (with an optional accent clause) + lede. */
export function SectionHeading({
  title,
  accent,
  sub,
  wide,
}: {
  title: string;
  accent?: string;
  sub: string;
  wide: boolean;
}) {
  const colors = usePalette();
  return (
    <View style={{ alignItems: "center", gap: space.lg }}>
      <Text
        accessibilityRole="header"
        aria-level={2}
        style={{
          textAlign: "center",
          fontSize: wide ? 38 : 28,
          lineHeight: wide ? 44 : 34,
          fontWeight: "600",
          letterSpacing: -1,
          color: colors.ink,
        }}
      >
        {title}
        {accent === undefined ? null : (
          <Text style={{ color: colors.accent }}>{` ${accent}`}</Text>
        )}
      </Text>
      <Text
        style={{
          textAlign: "center",
          fontSize: 15,
          lineHeight: 23,
          color: colors.inkMuted,
          maxWidth: 620,
        }}
      >
        {sub}
      </Text>
    </View>
  );
}

/** Small muted footnote under a panel — the honesty lines live in these. */
export function Footnote({ children }: { children: ReactNode }) {
  const colors = usePalette();
  return (
    <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
      {children}
    </Text>
  );
}
