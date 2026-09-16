/**
 * The 24-hour profile with its P10–P90 band.
 *
 * Ported from the template `timeline-chart.tsx` restored under `reference/` — the
 * viewBox + `useContainerWidth` scale trick, the gridline/axis furniture, the
 * RN `Pressable` hit strip overlaid on the SVG (SVG-level press handlers leak
 * responder props into the DOM on web), and the glass tooltip are all that
 * file's. What did *not* survive is the mark itself: capsule bars encode one
 * number per slot and there is no honest way to draw an interval as a capsule.
 * The bars become a filled P10–P90 area under a P50 line — a fan chart.
 *
 * The occurrence probability rides along as the *opacity* of the hour's
 * shading, so hours the hurdle model is unsure about read as visibly thinner
 * even where their P50 is large.
 */

import { radius, useContainerWidth, usePalette } from "@wattsteer/ui";
import { useState } from "react";
import { Platform, Pressable, Text as RnText, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import {
  CHART_H,
  CHART_W,
  FONT,
  fanGeometry,
  GRID,
  PAD,
} from "@/components/charts/fan-geometry";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type { CurtailmentHourForecast, CurtailmentHourObservation } from "@/lib/fixtures";

/** The viewBox the geometry module lays out inside. */
const W = 640;
const H = 260;

export function FanChart({
  hours,
  observed,
  thresholdMw,
  observedLabel,
  height = H,
}: {
  hours: CurtailmentHourForecast[];
  observed?: CurtailmentHourObservation[];
  thresholdMw: number;
  /** Overrides the generic "Observed" — Replay calls it the settled actual. */
  observedLabel?: string;
  height?: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const observedText = observedLabel ?? copy.app.fan.observedDefault;
  const [containerWidth, onLayout] = useContainerWidth();
  const [activeSel, setActive] = useState<number | null>(null);

  if (hours.length === 0) {
    return null;
  }

  const { max, slot, x, y, bandPath, medianPath, observedPath } = fanGeometry(
    hours,
    observed,
    thresholdMw,
  );
  const scale = containerWidth > 0 ? containerWidth / W : 0;

  const active = activeSel === null ? null : Math.min(activeSel, hours.length - 1);
  const activeHour = active === null ? null : hours[active];

  return (
    <View onLayout={onLayout} style={{ position: "relative" }}>
      <Svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={scale > 0 ? scale * height : height}
        accessibilityLabel={copy.app.fan.figure}
      >
        <Defs>
          <LinearGradient id="fan-band" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.violet} stopOpacity={0.42} />
            <Stop offset="1" stopColor={colors.violet} stopOpacity={0.1} />
          </LinearGradient>
        </Defs>

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
                {f.number(max * g)}
              </SvgText>
            </G>
          );
        })}

        {/* Per-hour occurrence shading: the hurdle model's confidence. */}
        {hours.map((h, i) => (
          <Line
            key={`occ-${h.validTime}`}
            x1={x(i)}
            x2={x(i)}
            y1={PAD.top}
            y2={PAD.top + CHART_H}
            stroke={colors.violet}
            strokeWidth={slot}
            opacity={0.05 + 0.1 * h.occurrenceProbability}
          />
        ))}

        <Path d={bandPath} fill="url(#fan-band)" />
        <Path
          d={medianPath}
          stroke={colors.violet}
          strokeWidth={2.5}
          fill="none"
          strokeLinejoin="round"
        />
        {observedPath === null ? null : (
          <Path
            d={observedPath}
            stroke={colors.accent}
            strokeWidth={2.5}
            fill="none"
            strokeLinejoin="round"
          />
        )}

        {/* The threshold that produced every episode figure on the screen. */}
        <Line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(thresholdMw)}
          y2={y(thresholdMw)}
          stroke={colors.inkFaint}
          strokeWidth={1}
          strokeDasharray="5 4"
        />
        <SvgText
          x={W - PAD.right}
          y={y(thresholdMw) - 5}
          textAnchor="end"
          fontSize={9}
          fontFamily={FONT}
          fill={colors.inkFaint}
        >
          {fill(copy.app.fan.thresholdMark, { mw: f.number(thresholdMw) })}
        </SvgText>

        {hours.map((h, i) =>
          h.hourLocal % 3 === 0 ? (
            <SvgText
              key={`tick-${h.validTime}`}
              x={x(i)}
              y={H - 10}
              textAnchor="middle"
              fontSize={10}
              fontFamily={FONT}
              fill={colors.inkMuted}
            >
              {String(h.hourLocal).padStart(2, "0")}
            </SvgText>
          ) : null,
        )}

        {active === null || activeHour === null ? null : (
          <G>
            <Line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={PAD.top + CHART_H}
              stroke={colors.ink}
              strokeWidth={1}
              opacity={0.5}
            />
            <Line
              x1={x(active)}
              x2={x(active)}
              y1={y(activeHour.constrainedOff.p10)}
              y2={y(activeHour.constrainedOff.p90)}
              stroke={colors.ink}
              strokeWidth={3}
              strokeLinecap="round"
              opacity={0.9}
            />
            <Circle
              cx={x(active)}
              cy={y(activeHour.constrainedOff.p50)}
              r={5}
              fill={colors.ink}
              stroke={colors.violet}
              strokeWidth={3}
            />
          </G>
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
          {hours.map((h, i) => (
            <Pressable
              key={`hit-${h.validTime}`}
              accessibilityRole="button"
              accessibilityLabel={fill(copy.app.fan.hourFigure, {
                hour: f.hour(h.hourLocal),
                p50: f.compact(h.constrainedOff.p50),
                p10: f.compact(h.constrainedOff.p10),
                p90: f.compact(h.constrainedOff.p90),
              })}
              onPress={() => setActive(activeSel === i ? null : i)}
              style={
                Platform.OS === "web"
                  ? ({ flex: 1, cursor: "pointer" } as object)
                  : { flex: 1 }
              }
            />
          ))}
        </View>
      ) : null}

      {active !== null && activeHour !== null && scale > 0 ? (
        <HourReadout
          hour={activeHour}
          observedMwh={observed?.[active]?.constrainedOffMwh}
          observedLabel={observedText}
        />
      ) : (
        <Legend hasObserved={observed !== undefined} observedLabel={observedText} />
      )}
    </View>
  );
}

function Legend({
  hasObserved,
  observedLabel,
}: {
  hasObserved: boolean;
  observedLabel: string;
}) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 16,
        marginTop: 10,
      }}
    >
      <Swatch color={colors.violet} label={copy.app.fan.medianLegend} />
      <Swatch color={colors.violet} label={copy.app.fan.bandLegend} faded={true} />
      {hasObserved ? <Swatch color={colors.accent} label={observedLabel} /> : null}
      <RnText style={{ fontSize: 11, color: colors.inkFaint }}>
        {copy.app.fan.hint}
      </RnText>
    </View>
  );
}

function Swatch({
  color,
  label,
  faded = false,
}: {
  color: string;
  label: string;
  faded?: boolean;
}) {
  const colors = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 14,
          height: faded ? 10 : 3,
          borderRadius: 2,
          backgroundColor: color,
          opacity: faded ? 0.35 : 1,
        }}
      />
      <RnText style={{ fontSize: 11, color: colors.inkMuted }}>{label}</RnText>
    </View>
  );
}

function HourReadout({
  hour,
  observedMwh,
  observedLabel,
}: {
  hour: CurtailmentHourForecast;
  observedMwh?: number;
  observedLabel: string;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View
      style={{
        marginTop: 10,
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 16,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surfaceSunken,
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      <Readout label={copy.app.fan.hourLabel} value={f.hour(hour.hourLocal)} />
      <Readout label="P10" value={f.compact(hour.constrainedOff.p10)} />
      <Readout label="P50" value={f.compact(hour.constrainedOff.p50)} strong={true} />
      <Readout label="P90" value={f.compact(hour.constrainedOff.p90)} />
      {/*
        The expectation sits *beside* P10/P50/P90, never between them. At this
        grain the difference is visible rather than argued: in a shoulder hour
        the median is 0 and E[Y] is not, because the hour is more likely than
        not to stay under the threshold and considerably above it when it does.
      */}
      <Readout label={copy.app.fan.expected} value={f.compact(hour.expectedMwh)} />
      <Readout
        label={copy.app.fan.exceedance}
        value={f.percent(hour.occurrenceProbability)}
      />
      {/*
        The split, at the hour grain: two scalars, no fourth quantile — and
        omitted entirely where the payload carries none. A replayed day's
        forecast hours have no technology division on the contract, and filling
        the row with a ratio this chart invented would publish a number no model
        produced.
      */}
      {hour.split === undefined ? null : (
        <Readout
          label={copy.app.split.title}
          value={fill(copy.app.fan.splitReadout, {
            wind: f.compact(hour.split.windMwh),
            solar: f.compact(hour.split.solarMwh),
          })}
        />
      )}
      {observedMwh === undefined ? null : (
        <Readout label={observedLabel} value={f.compact(observedMwh)} />
      )}
    </View>
  );
}

function Readout({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  const colors = usePalette();
  return (
    <View>
      <RnText style={{ fontSize: 10, color: colors.inkFaint }}>{label}</RnText>
      <RnText
        style={{
          fontSize: 14,
          fontWeight: strong ? "700" : "500",
          fontVariant: ["tabular-nums"],
          color: strong ? colors.ink : colors.inkMuted,
        }}
      >
        {value}
      </RnText>
    </View>
  );
}
