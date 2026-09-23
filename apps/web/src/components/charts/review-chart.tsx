/**
 * The replayed day, hour by hour: the D−1 band as a fan and the settled record
 * as bars, on one axis.
 *
 * The two vocabularies share an axis and never a mark. The forecast is a
 * filled P10–P90 band with its two edges and its P50 drawn as lines; the
 * settled day is one bar per hour, in ink, because a settled hour is one
 * measured number and a bar is the mark for one number. The legend names each
 * and says which is ONS's.
 *
 * The shaded span is the likely window — the longest run of hours with an even
 * chance or better of clearing the threshold, off the hours' own occurrence
 * probabilities. It is labelled as that, and not as a "critical" window: the
 * product states how likely an hour was, not how much it mattered.
 *
 * Nothing on the time axis is an issue time. The gates that published this
 * forecast happened the day before and are on the timeline beside this chart,
 * because putting an issue instant on a valid-time axis draws a 19:00 BRT
 * publication on the D−1 as though it were an hour of D.
 */

import { useContainerWidth, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import Svg, { G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { CHART_H, FONT, GRID, PAD } from "@/components/charts/fan-geometry";
import { reviewGeometry } from "@/components/charts/review-geometry";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type { CurtailmentHourForecast, CurtailmentHourObservation } from "@/lib/fixtures";

const W = 640;
const H = 260;
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

export function ReviewChart({
  hours,
  settled,
  thresholdMw,
  window,
}: {
  hours: CurtailmentHourForecast[];
  settled: CurtailmentHourObservation[] | undefined;
  thresholdMw: number;
  window: { fromHour: number; toHour: number } | null;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const text = copy.app.timeMachine.chart;
  const f = useFormat();
  const [containerWidth, onLayout] = useContainerWidth();

  if (hours.length === 0) {
    return null;
  }
  const geometry = reviewGeometry(hours, settled, thresholdMw, window);
  const scale = containerWidth > 0 ? containerWidth / W : 0;

  const legend: {
    key: string;
    label: string;
    swatch: "band" | "line" | "dashed" | "bar" | "span";
  }[] = [
    { key: "band", label: text.legendBand, swatch: "band" },
    { key: "p50", label: text.legendP50, swatch: "line" },
    { key: "edges", label: text.legendEdges, swatch: "dashed" },
    { key: "settled", label: text.legendSettled, swatch: "bar" },
    ...(window === null
      ? []
      : [{ key: "window", label: text.legendWindow, swatch: "span" as const }]),
  ];

  return (
    <View onLayout={onLayout} style={{ gap: 10 }}>
      <Svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={scale > 0 ? scale * H : H}
        accessibilityLabel={text.figure}
      >
        {geometry.window === null ? null : (
          <Rect
            x={geometry.window.x}
            y={PAD.top}
            width={geometry.window.width}
            height={CHART_H}
            fill={colors.warning}
            opacity={0.12}
          />
        )}

        {GRID.map((g) => {
          const gy = PAD.top + CHART_H * (1 - g);
          return (
            <G key={g}>
              <Line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={gy}
                y2={gy}
                stroke={colors.border}
                strokeDasharray="2 6"
              />
              <SvgText
                x={PAD.left - 8}
                y={gy + 3}
                textAnchor="end"
                fontSize={10}
                fontFamily={FONT}
                fill={colors.inkMuted}
              >
                {f.number(geometry.max * g)}
              </SvgText>
            </G>
          );
        })}

        <Path d={geometry.bandPath} fill={colors.violet} opacity={0.18} />
        <Path
          d={geometry.p90Path}
          stroke={colors.violet}
          strokeWidth={1.5}
          strokeDasharray="5 4"
          fill="none"
        />
        <Path
          d={geometry.p10Path}
          stroke={colors.violet}
          strokeWidth={1.5}
          strokeDasharray="5 4"
          fill="none"
        />
        {/* Settled on top of the band: the measurement is the mark a reader
            reads first, and a band drawn over it would tint it violet. */}
        {geometry.bars.map((bar) => (
          <Rect
            key={`bar-${bar.hourLocal}`}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={2}
            fill={colors.ink}
            opacity={0.72}
          />
        ))}
        <Path
          d={geometry.medianPath}
          stroke={colors.accent}
          strokeWidth={2.5}
          fill="none"
          strokeLinejoin="round"
        />

        <Line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={geometry.y(thresholdMw)}
          y2={geometry.y(thresholdMw)}
          stroke={colors.inkFaint}
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        <SvgText
          x={W - PAD.right}
          y={geometry.y(thresholdMw) - 5}
          textAnchor="end"
          fontSize={9}
          fontFamily={FONT}
          fill={colors.inkFaint}
        >
          {fill(copy.app.fan.thresholdMark, { mw: f.number(thresholdMw) })}
        </SvgText>

        {TICKS.map((hour) => (
          <SvgText
            key={`tick-${hour}`}
            x={geometry.x(hour)}
            y={H - 10}
            textAnchor="middle"
            fontSize={10}
            fontFamily={FONT}
            fill={colors.inkMuted}
          >
            {f.hour(hour)}
          </SvgText>
        ))}
      </Svg>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        {legend.map((item) => (
          <View
            key={item.key}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}
          >
            <View
              style={{
                width: 16,
                height:
                  item.swatch === "bar" ||
                  item.swatch === "band" ||
                  item.swatch === "span"
                    ? 10
                    : 0,
                borderTopWidth:
                  item.swatch === "line" || item.swatch === "dashed" ? 2 : 0,
                borderStyle: item.swatch === "dashed" ? "dashed" : "solid",
                borderColor: item.swatch === "line" ? colors.accent : colors.violet,
                backgroundColor:
                  item.swatch === "bar"
                    ? colors.ink
                    : item.swatch === "band"
                      ? colors.violet
                      : item.swatch === "span"
                        ? colors.warning
                        : "transparent",
                opacity: item.swatch === "band" || item.swatch === "span" ? 0.3 : 1,
                borderRadius: 2,
              }}
            />
            <Text style={{ fontSize: 12, color: colors.inkMuted, flexShrink: 1 }}>
              {item.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
