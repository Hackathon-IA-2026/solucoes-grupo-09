import { Platform, Pressable, Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { focusRing, webTransition } from "@/lib/focus-ring";
import { motion, radius, space } from "@/theme/tokens";

interface SegControlProps<T extends string | number> {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/**
 * A segmented control (radio group semantics). Few, large, adjacent targets —
 * Hick's and Fitts's laws over a dropdown for ≤5 known options.
 */
export function SegControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SegControlProps<T>) {
  const colors = usePalette();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ gap: space.sm }}
    >
      <Text style={{ color: colors.inkMuted, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: "row",
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.sm + 2,
          borderCurve: "continuous",
          padding: 3,
          gap: 2,
          borderWidth: 1,
          borderColor: colors.border,
          alignSelf: "flex-start",
          flexWrap: "wrap",
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              accessibilityLabel={option.label}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              style={(state) => {
                const { focused = false } = state as { focused?: boolean };
                return {
                  minHeight: 36,
                  minWidth: 56,
                  paddingHorizontal: space.md,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.sm,
                  borderCurve: "continuous",
                  backgroundColor: selected ? colors.surface : "transparent",
                  opacity: disabled ? 0.5 : 1,
                  boxShadow: selected ? "0 1px 3px rgba(0,0,0,0.12)" : undefined,
                  ...focusRing(focused, colors.focus, 1),
                  ...webTransition("background-color", motion.fast),
                  ...(Platform.OS === "web"
                    ? ({ cursor: disabled ? "default" : "pointer" } as object)
                    : null),
                };
              }}
            >
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: selected ? "700" : "500",
                  color: selected ? colors.ink : colors.inkMuted,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
