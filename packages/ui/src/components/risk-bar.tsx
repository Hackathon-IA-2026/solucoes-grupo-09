import { useEffect, useState } from "react";
import { Animated, Platform, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { usePalette } from "../hooks/use-palette";
import { useReducedMotion } from "../hooks/use-reduced-motion";
import { webNoTransition } from "../lib/focus-ring";

/**
 * Risk indicator: a green→yellow→red gradient track with a marker positioned
 * by the score. `value` is 0..1 (0 = lowest risk, 1 = highest). The marker
 * eases in from the left on mount for a small reveal.
 *
 * Intended for curtailment risk per subsystem on the grid overview. Note it
 * shows a point estimate — where the underlying forecast carries a P10–P90
 * band, the band belongs somewhere the bar cannot express.
 */
export function RiskBar({ value, height = 6 }: { value: number; height?: number }) {
  const colors = usePalette();
  const reduced = useReducedMotion();
  const clamped = Math.max(0, Math.min(1, value));
  // Lazy useState (not useRef) so the Animated.Value is created exactly once
  // without a ref initializer running on every render.
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 600,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [reduced, progress]);

  const left = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", `${clamped * 100}%`],
  });

  return (
    <View style={{ height: height + 8, justifyContent: "center" }}>
      <Svg width="100%" height={height} style={{ borderRadius: 999 }}>
        <Defs>
          <LinearGradient id="riskGrad" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#4ADE80" />
            <Stop offset="0.5" stopColor="#EDD24F" />
            <Stop offset="1" stopColor="#EA4A3D" />
          </LinearGradient>
        </Defs>
        <Rect
          x={0}
          y={0}
          width="100%"
          height={height}
          rx={height / 2}
          fill="url(#riskGrad)"
        />
      </Svg>
      <Animated.View
        style={{
          position: "absolute",
          left,
          top: 0,
          bottom: 0,
          justifyContent: "center",
          transform: [{ translateX: -6 }],
          ...(Platform.OS === "web" ? (webNoTransition("left") as object) : null),
        }}
      >
        <View
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            backgroundColor: colors.ink,
            borderWidth: 2,
            borderColor: colors.canvas,
          }}
        />
      </Animated.View>
    </View>
  );
}
