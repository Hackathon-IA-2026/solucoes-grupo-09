import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  type ViewStyle,
} from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { focusRing, webTransition } from "@/lib/focus-ring";
import { layout, motion, radius, space } from "@/theme/tokens";

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  /** Grow to fill the row (mobile-first default is full-width). */
  fluid?: boolean;
  accessibilityHint?: string;
  testID?: string;
  icon?: ReactNode;
}

/**
 * The one button. Large hit area (≥44pt — Fitts), visible focus ring, hover +
 * pressed states, and a loading state that keeps its width so the layout
 * never jumps mid-submit.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  fluid = false,
  accessibilityHint,
  testID,
  icon,
}: ButtonProps) {
  const colors = usePalette();
  const blocked = disabled || loading;

  const fills: Record<string, { bg: string; text: string; border: string }> = {
    primary: { bg: colors.accent, text: colors.onAccent, border: colors.accent },
    secondary: { bg: colors.surface, text: colors.ink, border: colors.borderStrong },
    ghost: { bg: "transparent", text: colors.inkMuted, border: "transparent" },
    danger: { bg: "transparent", text: colors.danger, border: colors.borderStrong },
  };
  const fill = fills[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: blocked, busy: loading }}
      aria-busy={loading}
      testID={testID}
      onPress={blocked ? undefined : onPress}
      disabled={blocked}
      style={(state): ViewStyle => {
        const { pressed } = state;
        // RN Web extends the pressable state with hover/focus; native ignores.
        const { hovered = false, focused = false } = state as {
          hovered?: boolean;
          focused?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.sm,
          minHeight: layout.touch + 8,
          paddingHorizontal: space.xl,
          paddingVertical: space.md,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: fill.border,
          backgroundColor:
            variant === "primary" && (pressed || hovered) ? colors.accentStrong : fill.bg,
          opacity: blocked && !loading ? 0.45 : pressed ? 0.92 : 1,
          alignSelf: fluid ? "stretch" : "auto",
          ...focusRing(focused, colors.focus),
          ...webTransition("background-color, opacity, box-shadow", motion.fast),
          ...(Platform.OS === "web"
            ? ({ cursor: blocked ? "default" : "pointer" } as object)
            : null),
        };
      }}
    >
      {loading ? <ActivityIndicator size="small" color={fill.text} /> : (icon ?? null)}
      <Text
        style={{
          color: fill.text,
          fontSize: 16,
          fontWeight: "700",
          letterSpacing: 0.1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
