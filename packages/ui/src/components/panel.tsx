import type { ReactNode } from "react";
import { Text, View, type ViewProps } from "react-native";
import { usePalette } from "../hooks/use-palette";
import { radius } from "../tokens";
import { FadeIn } from "./fade-in";
import { IconCircle } from "./pill";

/** Rounded-3xl card with hairline border — every dashboard block (rises in). */
export function Panel({
  children,
  style,
  delay = 0,
  ...rest
}: { children: ReactNode; delay?: number } & ViewProps) {
  const colors = usePalette();
  return (
    <FadeIn
      duration={500}
      delay={delay}
      {...rest}
      style={[
        {
          borderRadius: radius.xl,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          padding: 20,
        },
        style,
      ]}
    >
      {children}
    </FadeIn>
  );
}

/**
 * The reference's panel header: outlined icon circle + muted title over a
 * semibold subtitle, with an optional right-side control cluster.
 */
export function PanelHeader({
  icon,
  title,
  subtitle,
  right,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  right?: ReactNode;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      {/*
        **`flexShrink` here and `flex` on the column, both load-bearing at
        400px.** The outer row already wrapped, which made this look solved: the
        `right` slot dropped to a second line and the header stopped *pushing*.
        The title and subtitle still could not, because this inner row had
        nothing telling it to give up width and the text column had nothing
        telling it to take what was left — so the two `Text`s sized to their
        content and never wrapped.

        Measured at 400px on the exported build, before this: every
        `PanelHeader` on every app screen overflowed its panel — 630px of
        content in a 318px box on the widest, 340px on the narrowest — with the
        remainder *clipped* by an ancestor rather than scrolled. Clipped is the
        bad half: a reader on a phone loses the right-hand end of every panel
        subtitle and has no gesture that brings it back.

        `landing/hero.tsx` carries the same fix for one row of its own and calls
        the pair load-bearing in the same words. It was right about its row and
        the shared component had the defect.
      */}
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 12, flexShrink: 1 }}
      >
        <IconCircle>{icon}</IconCircle>
        <View style={{ flex: 1 }}>
          {/*
            A heading, at level 3 under the page (1) and its sections (2).

            These ~18 titles are the only outline inside a section, and before
            `/app` became one page there were no headings on it at all — a
            screen-reader user's way through 13 000px was 45 tab stops or
            linear reading. `aria-level` rather than an `<h3>` because
            react-native has no heading element; `legal.tsx` set this idiom.
          */}
          <Text
            accessibilityRole="header"
            aria-level={3}
            style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}
          >
            {title}
          </Text>
          <Text style={{ fontSize: 16, fontWeight: "600", color: colors.ink }}>
            {subtitle}
          </Text>
        </View>
      </View>
      {right}
    </View>
  );
}
