import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { usePalette } from "../hooks/use-palette";
import { usePressScale } from "../hooks/use-press-scale";
import { focusRing, webTransition } from "../lib/focus-ring";
import { motion, radius } from "../tokens";

/**
 * Pill primitives — the reference's recurring control language:
 * active pill = solid lime with olive text; inactive = card/secondary with
 * muted text; icon buttons are 40-44px circles with hairline borders.
 */

export function Pill({
  label,
  active = false,
  onPress,
  icon,
  trailing,
  size = "md",
  ariaCurrent,
  tone = "card",
  accessibilityRole = "button",
  testID,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  icon?: ReactNode;
  trailing?: ReactNode;
  /** md = nav/filter pills (py 10), sm = compact toggles (py 6). */
  size?: "md" | "sm";
  /** Inactive background: raised card or sunken secondary. */
  tone?: "card" | "secondary";
  accessibilityRole?: "button" | "radio" | "tab" | "link";
  /**
   * `page` when this pill is the document the reader is on.
   *
   * A nav pill is a link, and a link says "you are here" with `aria-current`,
   * not with `aria-selected` — that one belongs to a tab, and a tab promises a
   * panel it controls in the same document. The app's row has neither.
   */
  ariaCurrent?: "page";
  testID?: string;
}) {
  const colors = usePalette();
  const padV = size === "md" ? 10 : 6;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      // Direct aria props: radios require aria-checked, tabs use
      // aria-selected (RN maps these to native state; accessibilityState is
      // not rendered by the static-web pass).
      aria-checked={accessibilityRole === "radio" ? active : undefined}
      aria-selected={accessibilityRole === "tab" ? active : undefined}
      aria-current={ariaCurrent}
      accessibilityLabel={label}
      onPress={onPress}
      disabled={!onPress}
      // Fitts's Law / WCAG 2.5.5: compact pills render below 44px; expand the
      // touch area without changing the visual size.
      hitSlop={8}
      style={(state) => {
        const { pressed } = state;
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
          // A pill with a long label — the mitigate reset spells out the whole
          // reference fleet — is 301px wide against a 280px panel at 320px.
          // Shrinking beats clipping: the label wraps inside the pill.
          flexShrink: 1,
          gap: 8,
          borderRadius: radius.pill,
          paddingHorizontal: 16,
          paddingVertical: padV,
          backgroundColor: active
            ? colors.accent
            : hovered
              ? colors.surfaceSunken
              : tone === "card"
                ? colors.surface
                : colors.surfaceSunken,
          opacity: pressed ? 0.85 : 1,
          ...focusRing(focused, colors.focus, 1),
          ...(Platform.OS === "web" && onPress
            ? ({
                cursor: "pointer",
                // Colour and opacity only, so `ease` rather than the ease-out
                // default: there is no movement here to carry momentum.
                ...webTransition(
                  "background-color, opacity",
                  motion.fast,
                  motion.ease.color,
                ),
              } as object)
            : null),
        };
      }}
    >
      {icon}
      <Text
        style={{
          flexShrink: 1,
          fontSize: 14,
          fontWeight: active ? "600" : "500",
          color: active ? colors.onAccent : colors.inkMuted,
        }}
      >
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

/** Solid or outlined action pill with an icon (primary and secondary actions). */
export function PillButton({
  label,
  icon,
  onPress,
  primary = false,
  testID,
}: {
  label: string;
  icon?: ReactNode;
  onPress: () => void;
  primary?: boolean;
  testID?: string;
}) {
  const colors = usePalette();
  const pressScale = usePressScale();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={(state) => {
        const { pressed } = state;
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          // A pill hugs its label. As a flex child in a wrapping row it would
          // otherwise shrink below its content and break the label onto a
          // second line *inside* the rounded shape.
          flexShrink: 0,
          borderRadius: radius.pill,
          borderWidth: 1,
          // `borderStrong` (12%), not `border` (8%): 8% is the hairline used to
          // separate *surfaces*, and on a near-black canvas it leaves an
          // outlined button barely distinguishable from the page — next to a
          // solid lime primary the pair reads as one button and one label.
          // Interactive controls get the input-strength border.
          borderColor: primary ? colors.accent : colors.borderStrong,
          backgroundColor: primary
            ? colors.accent
            : hovered
              ? colors.surfaceSunken
              : colors.surface,
          paddingHorizontal: 16,
          paddingVertical: 10,
          transform: [{ scale: pressed ? pressScale : 1 }],
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web"
            ? ({
                cursor: "pointer",
                // Carries a `scale` on press, so this takes the ease-out
                // default — the press has to register at the instant it lands.
                ...webTransition("transform, background-color", motion.fast),
              } as object)
            : null),
        };
      }}
    >
      {icon}
      <Text
        numberOfLines={1}
        style={{
          fontSize: 14,
          fontWeight: primary ? "600" : "500",
          color: primary ? colors.onAccent : colors.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Outlined icon circle — the panel-header glyph (h-10 w-10, hairline ring). */
export function IconCircle({
  children,
  size = 40,
  tone = "outline",
}: {
  children: ReactNode;
  size?: number;
  /** outline = hairline ring; onAccent = lime-foreground/10 (lime cards). */
  tone?: "outline" | "onAccent";
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        ...(tone === "onAccent"
          ? { backgroundColor: "rgba(30, 43, 16, 0.1)" }
          : { borderWidth: 1, borderColor: colors.border }),
      }}
    >
      {children}
    </View>
  );
}

/** Circular icon button (search, bell, filter, more…). */
export function IconCircleButton({
  children,
  onPress,
  label,
  size = 44,
  tone = "card",
  backgroundColor,
  testID,
}: {
  children: ReactNode;
  onPress?: () => void;
  label: string;
  size?: number;
  /** card = filled; outline = hairline ring; inverse = foreground on background. */
  tone?: "card" | "outline" | "inverse";
  /** Explicit fill override (e.g. olive on the lime stat card). */
  backgroundColor?: string;
  testID?: string;
}) {
  const colors = usePalette();
  const pressScale = usePressScale();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={!onPress}
      hitSlop={8}
      style={(state) => {
        const { pressed } = state;
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor:
            backgroundColor ??
            (tone === "inverse"
              ? colors.ink
              : hovered
                ? colors.surfaceSunken
                : tone === "card"
                  ? colors.surface
                  : "transparent"),
          borderWidth: tone === "outline" ? 1 : 0,
          borderColor: colors.border,
          transform: [{ scale: pressed ? pressScale : hovered && onPress ? 1.05 : 1 }],
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web" && onPress
            ? ({
                cursor: "pointer",
                // Carries a `scale` on press, so this takes the ease-out
                // default — the press has to register at the instant it lands.
                ...webTransition("transform, background-color", motion.fast),
              } as object)
            : null),
        };
      }}
    >
      {children}
    </Pressable>
  );
}
