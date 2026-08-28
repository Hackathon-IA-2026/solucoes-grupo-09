/**
 * The Time Machine comparison — IDEA.md §45 / §47.
 *
 * Ported from `reference/investidor10-web/components/compare-bars.tsx`: the
 * row structure, the shared `max` scale, the sunken track and the grow-in
 * `Animated` interpolation are that file's, essentially unchanged. The port
 * was clean; only the unit and the highlight rule changed.
 *
 * One addition the original could not express: a row may carry a `Band`
 * instead of a value. The forecast row does, because "what the model said at
 * D−1" was never a single number, and drawing it as one next to a measured
 * actual would be the exact dishonesty this screen exists to avoid. A band row
 * draws the P10–P90 extent lightly with the P50 solid on top.
 */

import { space, usePalette } from "@wattsteer/ui";
import { useEffect, useState } from "react";
import { Animated, Text, View } from "react-native";
import type { Band } from "@/lib/fixtures";
import { formatMwh } from "./band-figure";

export interface CompareRow {
  key: string;
  label: string;
  /** Exactly one of `value` / `band`. */
  value?: number;
  band?: Band;
  tone: "actual" | "forecast" | "recovered";
  note?: string;
}

export function CompareBars({
  rows,
  unit = "MWh",
}: {
  rows: CompareRow[];
  unit?: string;
}) {
  const colors = usePalette();
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 650,
      delay: 120,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [progress]);

  const max = Math.max(...rows.map((r) => r.band?.p90 ?? r.value ?? 0), 0.01);

  const toneColor = (tone: CompareRow["tone"]) =>
    tone === "recovered"
      ? colors.accent
      : tone === "forecast"
        ? colors.violet
        : colors.ink;

  return (
    <View style={{ gap: space.lg }}>
      {rows.map((row) => {
        const color = toneColor(row.tone);
        const headline = row.band === undefined ? (row.value ?? 0) : row.band.p50;
        const extentLeft = row.band === undefined ? 0 : row.band.p10 / max;
        const extentRight = row.band === undefined ? 0 : row.band.p90 / max;
        return (
          <View key={row.key} style={{ gap: 6 }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: 12,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: colors.inkMuted }}>
                {row.label}
              </Text>
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: "700",
                  fontVariant: ["tabular-nums"],
                  color,
                }}
              >
                {`${formatMwh(headline)} ${unit}`}
              </Text>
            </View>

            <View
              style={{
                height: 16,
                borderRadius: 8,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
                justifyContent: "center",
              }}
            >
              {row.band === undefined ? null : (
                <View
                  style={{
                    position: "absolute",
                    left: `${extentLeft * 100}%`,
                    width: `${Math.max(1, (extentRight - extentLeft) * 100)}%`,
                    top: 0,
                    bottom: 0,
                    backgroundColor: color,
                    opacity: 0.28,
                  }}
                />
              )}
              <Animated.View
                style={{
                  height: row.band === undefined ? "100%" : 8,
                  borderRadius: 8,
                  backgroundColor: color,
                  opacity: row.tone === "actual" ? 0.85 : 1,
                  width: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["0%", `${(headline / max) * 100}%`],
                  }),
                }}
              />
            </View>

            {row.note === undefined ? null : (
              <Text style={{ fontSize: 11, color: colors.inkFaint }}>{row.note}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
