import { radius, space, useContainerWidth, usePalette } from "@wattsteer/ui";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Text as SvgText } from "react-native-svg";
import { formatMwhExact } from "./band";
import type { HourlyBand } from "./fixtures";

/**
 * Day-ahead profile as a **fan chart**: the P10–P90 interval is a filled area
 * and the P50 is a line through it.
 *
 * This is a rebuild, not a port. The template's `timeline-chart.tsx` (staged
 * in `reference/`) supplied the machinery — a fixed `viewBox` scaled by
 * `useContainerWidth`,
 * the dashed gridlines, the SVG axis labels, the RN `Pressable` hit-slots
 * overlaid on the plot (SVG press handlers leak responder props into the DOM
 * on web) and the pop-in tooltip. What could not survive is the mark itself:
 * capsule bars encode one value per slot, and a forecast hour has three. A
 * bar chart of P50 with the band in a tooltip would have been the quiet drop
 * this ticket exists to prevent — the uncertainty has to be the shape you see
 * before you interact, not a reward for hovering.
 *
 * The band is drawn *under* the median line, so the eye reads width first and
 * the middle second.
 */

const W = 560;
const H = 250;
const PAD = { top: 22, right: 14, bottom: 30, left: 46 };
const CHART_W = W - PAD.left - PAD.right;
const CHART_H = H - PAD.top - PAD.bottom;
const GRID = [1, 0.75, 0.5, 0.25, 0];
const HOUR_TICKS = new Set([0, 4, 8, 12, 16, 20]);
const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

const styles = StyleSheet.create({
  tooltip: {
    pointerEvents: "none",
    position: "absolute",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
    boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
  },
});

function xAt(index: number, count: number): number {
  return PAD.left + (count > 1 ? (index / (count - 1)) * CHART_W : CHART_W / 2);
}

function yAt(value: number, max: number): number {
  return PAD.top + CHART_H - (value / max) * CHART_H;
}

/** Closed polygon: forward along P90, back along P10. */
function areaPath(points: readonly HourlyBand[], max: number): string {
  const top = points.map(
    (p, i) => `${i === 0 ? "M" : "L"}${xAt(i, points.length)},${yAt(p.p90, max)}`,
  );
  const bottom = points
    .slice()
    .reverse()
    .map((p, i) => `L${xAt(points.length - 1 - i, points.length)},${yAt(p.p10, max)}`);
  return `${top.join("")}${bottom.join("")}Z`;
}

function linePath(points: readonly HourlyBand[], max: number): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i, points.length)},${yAt(p.p50, max)}`)
    .join("");
}

export function FanChart({
  points,
  unit,
  accessibilityLabel,
}: {
  points: readonly HourlyBand[];
  unit: string;
  accessibilityLabel: string;
}) {
  const colors = usePalette();
  const [containerWidth, onLayout] = useContainerWidth();
  // Default to the peak hour rather than hour 0: the interesting hour should
  // be selected before anyone touches anything.
  const [selected, setSelected] = useState<number | null>(null);

  if (points.length === 0) {
    return null;
  }

  const peak = points.reduce((best, p, i) => (p.p50 > points[best].p50 ? i : best), 0);
  const active = selected ?? peak;
  const max = Math.max(...points.map((p) => p.p90)) * 1.08;
  const scale = containerWidth > 0 ? containerWidth / W : 0;
  const cur = points[active];
  const activeX = xAt(active, points.length);
  const activeY = yAt(cur.p50, max);

  return (
    <View onLayout={onLayout} style={{ position: "relative" }}>
      <Svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={scale > 0 ? scale * H : H}
        accessibilityLabel={accessibilityLabel}
      >
        {GRID.map((g) => {
          const y = PAD.top + CHART_H * (1 - g);
          return (
            <G key={g}>
              <Line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                stroke={colors.border}
                strokeDasharray="2 6"
              />
              <SvgText
                x={PAD.left - 10}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fontFamily={FONT}
                fill={colors.inkMuted}
              >
                {g === 0 ? "0" : formatMwhExact(max * g)}
              </SvgText>
            </G>
          );
        })}

        {/* P10–P90 band, then the P50 line over it. */}
        <Path
          d={areaPath(points, max)}
          fill={colors.violet}
          fillOpacity={0.22}
          stroke={colors.violet}
          strokeOpacity={0.55}
          strokeWidth={1}
        />
        <Path
          d={linePath(points, max)}
          fill="none"
          stroke={colors.accent}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Active hour: a full-height rule plus a dot on the median. */}
        <Line
          x1={activeX}
          x2={activeX}
          y1={PAD.top}
          y2={PAD.top + CHART_H}
          stroke={colors.ink}
          strokeOpacity={0.35}
          strokeDasharray="3 4"
        />
        <Circle cx={activeX} cy={yAt(cur.p90, max)} r={3.5} fill={colors.violet} />
        <Circle cx={activeX} cy={yAt(cur.p10, max)} r={3.5} fill={colors.violet} />
        <Circle
          cx={activeX}
          cy={activeY}
          r={5.5}
          fill={colors.canvas}
          stroke={colors.accent}
          strokeWidth={3}
        />

        {points.map((p, i) =>
          HOUR_TICKS.has(p.hour) ? (
            <SvgText
              key={p.hour}
              x={xAt(i, points.length)}
              y={H - 8}
              textAnchor="middle"
              fontSize={11}
              fontFamily={FONT}
              fill={colors.inkMuted}
            >
              {`${String(p.hour).padStart(2, "0")}h`}
            </SvgText>
          ) : null,
        )}
      </Svg>

      {scale > 0 ? (
        <View
          style={{
            position: "absolute",
            left: PAD.left * scale,
            top: PAD.top * scale,
            width: CHART_W * scale,
            height: CHART_H * scale,
            flexDirection: "row",
          }}
        >
          {points.map((p, i) => (
            <Pressable
              key={p.hour}
              accessibilityRole="button"
              accessibilityLabel={`${String(p.hour).padStart(2, "0")}:00 — median ${formatMwhExact(p.p50)} ${unit}, P10 to P90 ${formatMwhExact(p.p10)} to ${formatMwhExact(p.p90)} ${unit}`}
              onPress={() => setSelected(i)}
              onHoverIn={() => setSelected(i)}
              style={
                Platform.OS === "web"
                  ? ({ flex: 1, cursor: "pointer" } as object)
                  : { flex: 1 }
              }
            />
          ))}
        </View>
      ) : null}

      {scale > 0 ? (
        <View
          style={[
            styles.tooltip,
            {
              // Flip to the left of the rule near the right edge so the
              // tooltip never leaves the panel.
              left:
                active > points.length * 0.6
                  ? activeX * scale - 148
                  : activeX * scale + 12,
              top: Math.max(0, (activeY - 10) * scale),
            },
            Platform.OS === "web"
              ? ({
                  backgroundColor: "rgba(247, 247, 247, 0.06)",
                  backdropFilter: "blur(12px)",
                } as object)
              : { backgroundColor: "rgba(38, 38, 43, 0.92)" },
          ]}
        >
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>
            {`${String(cur.hour).padStart(2, "0")}:00`}
          </Text>
          <Text
            style={{
              fontSize: 20,
              fontWeight: "600",
              color: colors.ink,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`${formatMwhExact(cur.p50)} ${unit}`}
          </Text>
          <Text
            style={{
              fontSize: 12,
              color: colors.onVioletSoft,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`${formatMwhExact(cur.p10)}–${formatMwhExact(cur.p90)}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Legend for the two marks, so the fan is readable without interaction. */
export function FanLegend({
  bandLabel,
  medianLabel,
}: {
  bandLabel: string;
  medianLabel: string;
}) {
  const colors = usePalette();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            width: 18,
            height: 10,
            borderRadius: 3,
            backgroundColor: colors.violetSoft,
            borderWidth: 1,
            borderColor: colors.violet,
          }}
        />
        <Text style={{ fontSize: 12, color: colors.inkMuted }}>{bandLabel}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            width: 18,
            height: 3,
            borderRadius: 2,
            backgroundColor: colors.accent,
          }}
        />
        <Text style={{ fontSize: 12, color: colors.inkMuted }}>{medianLabel}</Text>
      </View>
    </View>
  );
}
