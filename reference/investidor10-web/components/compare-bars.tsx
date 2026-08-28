import { usePalette } from "@negotiatio/ui";
import { useEffect, useState } from "react";
import { Animated, Text, View } from "react-native";

/**
 * Horizontal comparison bars (this offer vs category average vs overall
 * average) — the bars grow in on mount. Values are % a.a.
 */
export function CompareBars({
  rows,
}: {
  rows: { label: string; value: number; highlight?: boolean }[];
}) {
  const colors = usePalette();
  const max = Math.max(...rows.map((r) => r.value), 0.01);
  // Lazy useState (not useRef) so the Animated.Value is created exactly once
  // without a ref initializer running on every render.
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 650,
      delay: 150,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [progress]);

  return (
    <View style={{ gap: 14 }}>
      {rows.map((row) => {
        const target = Math.max(0.04, row.value / max);
        return (
          <View key={row.label} style={{ gap: 6 }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: row.highlight ? "700" : "500",
                  color: row.highlight ? colors.ink : colors.inkMuted,
                }}
              >
                {row.label}
              </Text>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "700",
                  fontVariant: ["tabular-nums"],
                  color: row.highlight ? colors.accent : colors.ink,
                }}
              >
                {row.value.toFixed(2).replace(".", ",")}%
              </Text>
            </View>
            <View
              style={{
                height: 10,
                borderRadius: 5,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
              }}
            >
              <Animated.View
                style={{
                  height: "100%",
                  borderRadius: 5,
                  backgroundColor: row.highlight ? colors.accent : colors.violet,
                  width: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["0%", `${target * 100}%`],
                  }),
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
