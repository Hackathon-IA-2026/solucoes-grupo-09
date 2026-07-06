import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { usePalette } from "../hooks/use-palette";
import { focusRing } from "../lib/focus-ring";
import { radius } from "../tokens";

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
  accessibilityRole?: "button" | "radio" | "tab";
  testID?: string;
}) {
  const colors = usePalette();
  const padV = size === "md" ? 10 : 6;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityState={
        accessibilityRole === "button" ? undefined : { selected: active }
      }
      accessibilityLabel={label}
      onPress={onPress}
      disabled={!onPress}
      style={(state) => {
        const { pressed } = state;
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
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
                transitionProperty: "background-color, opacity",
                transitionDuration: "150ms",
              } as object)
            : null),
        };
      }}
    >
      {icon}
      <Text
        style={{
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

/** Solid or outlined action pill with an icon (export buttons, New scrape). */
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
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={(state) => {
        const { pressed } = state;
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: primary ? colors.accent : colors.border,
          backgroundColor: primary
            ? colors.accent
            : hovered
              ? colors.surfaceSunken
              : colors.surface,
          paddingHorizontal: 16,
          paddingVertical: 10,
          transform: [{ scale: pressed ? 0.95 : 1 }],
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web"
            ? ({
                cursor: "pointer",
                transitionProperty: "transform, background-color",
                transitionDuration: "150ms",
              } as object)
            : null),
        };
      }}
    >
      {icon}
      <Text
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
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={!onPress}
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
          transform: [{ scale: pressed ? 0.92 : 1 }],
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web" && onPress
            ? ({
                cursor: "pointer",
                transitionProperty: "transform, background-color",
                transitionDuration: "150ms",
              } as object)
            : null),
        };
      }}
    >
      {children}
    </Pressable>
  );
}
