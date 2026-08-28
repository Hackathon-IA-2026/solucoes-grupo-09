import { useEffect, useState } from "react";
import { Animated, Platform, Pressable } from "react-native";
import { usePalette } from "../hooks/use-palette";
import { useReducedMotion } from "../hooks/use-reduced-motion";
import { focusRing } from "../lib/focus-ring";

/**
 * Animated switch. The knob slides and the track cross-fades from sunken to
 * lime on the RN Animated driver (no reanimated dependency in the design
 * system). Honors prefers-reduced-motion by snapping.
 */
export function Toggle({
  value,
  onValueChange,
  label,
  testID,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
  testID?: string;
}) {
  const colors = usePalette();
  const reduced = useReducedMotion();
  // Lazy useState (not useRef) so the Animated.Value is created exactly once
  // without a ref initializer running on every render.
  const [progress] = useState(() => new Animated.Value(value ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      progress.setValue(value ? 1 : 0);
      return;
    }
    const anim = Animated.spring(progress, {
      toValue: value ? 1 : 0,
      useNativeDriver: false,
      friction: 8,
      tension: 90,
    });
    anim.start();
    return () => anim.stop();
  }, [value, reduced, progress]);

  const trackColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.surfaceSunken, colors.accent],
  });
  const knobX = progress.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });

  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      aria-checked={value}
      accessibilityLabel={label}
      onPress={() => onValueChange(!value)}
      hitSlop={8}
      style={(state) => {
        const { focused = false } = state as { focused?: boolean };
        return {
          borderRadius: 999,
          ...focusRing(focused, colors.focus, 3),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      <Animated.View
        style={{
          width: 44,
          height: 24,
          borderRadius: 999,
          backgroundColor: trackColor,
          justifyContent: "center",
        }}
      >
        <Animated.View
          style={{
            width: 20,
            height: 20,
            borderRadius: 999,
            backgroundColor: value ? colors.onAccent : colors.ink,
            transform: [{ translateX: knobX }],
          }}
        />
      </Animated.View>
    </Pressable>
  );
}
