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
import type { CurtailmentHourForecast, CurtailmentHourObservation } from "@/lib/fixtures";
import { formatMwhCompact } from "./band-figure";

const W = 640;
const H = 260;
const PAD = { top: 18, right: 14, bottom: 30, left: 46 };
const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const GRID = [1, 0.75, 0.5, 0.25, 0];

function niceMax(value: number): number {
  if (value <= 0) {
    return 10;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
  for (const step of steps) {
    if (step * magnitude >= value) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

export function FanChart({
  hours,
  observed,
  thresholdMw,
  observedLabel = "Observed",
  height = H,
}: {
  hours: CurtailmentHourForecast[];
  observed?: CurtailmentHourObservation[];
  thresholdMw: number;
  observedLabel?: string;
  height?: number;
}) {
  const colors = usePalette();
  const [containerWidth, onLayout] = useContainerWidth();
  const [activeSel, setActive] = useState<number | null>(null);

  if (hours.length === 0) {
    return null;
  }

  const observedPeak =
    observed === undefined ? 0 : Math.max(...observed.map((o) => o.constrainedOffMwh));
  const max = niceMax(
    Math.max(observedPeak, ...hours.map((h) => h.constrainedOff.p90), thresholdMw * 2),
  );
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const slot = chartW / hours.length;
  const scale = containerWidth > 0 ? containerWidth / W : 0;

  const x = (i: number) => PAD.left + i * slot + slot / 2;
  const y = (v: number) => PAD.top + chartH - (v / max) * chartH;

  const upper = hours.map(
    (h, i) => `${x(i).toFixed(1)},${y(h.constrainedOff.p90).toFixed(1)}`,
  );
  const lower = hours
    .map((h, i) => `${x(i).toFixed(1)},${y(h.constrainedOff.p10).toFixed(1)}`)
    .reverse();
  const bandPath = `M${upper.join(" L")} L${lower.join(" L")} Z`;
  const medianPath = `M${hours
    .map((h, i) => `${x(i).toFixed(1)},${y(h.constrainedOff.p50).toFixed(1)}`)
    .join(" L")}`;
  const observedPath =
    observed === undefined
      ? null
      : `M${observed
          .map((o, i) => `${x(i).toFixed(1)},${y(o.constrainedOffMwh).toFixed(1)}`)
          .join(" L")}`;

  const active = activeSel === null ? null : Math.min(activeSel, hours.length - 1);
  const activeHour = active === null ? null : hours[active];

  return (
    <View onLayout={onLayout} style={{ position: "relative" }}>
      <Svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={scale > 0 ? scale * height : height}
        accessibilityLabel="Day-ahead curtailment profile, P10 to P90 band around the median"
      >
        <Defs>
          <LinearGradient id="fan-band" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.violet} stopOpacity={0.42} />
            <Stop offset="1" stopColor={colors.violet} stopOpacity={0.1} />
          </LinearGradient>
        </Defs>

        {GRID.map((g) => {
          const gy = PAD.top + chartH * (1 - g);
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
                {Math.round(max * g)}
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
            y2={PAD.top + chartH}
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
          {`threshold ${thresholdMw} MW`}
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
              y2={PAD.top + chartH}
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
            width: chartW * scale,
            height: chartH * scale,
            flexDirection: "row",
          }}
        >
          {hours.map((h, i) => (
            <Pressable
              key={`hit-${h.validTime}`}
              accessibilityRole="button"
              accessibilityLabel={`Hour ${h.hourLocal}: P50 ${formatMwhCompact(
                h.constrainedOff.p50,
              )} MWh, P10 to P90 ${formatMwhCompact(h.constrainedOff.p10)} to ${formatMwhCompact(
                h.constrainedOff.p90,
              )}`}
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
          observedLabel={observedLabel}
        />
      ) : (
        <Legend hasObserved={observed !== undefined} observedLabel={observedLabel} />
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
      <Swatch color={colors.violet} label="P50 forecast" />
      <Swatch color={colors.violet} label="P10–P90 band" faded={true} />
      {hasObserved ? <Swatch color={colors.accent} label={observedLabel} /> : null}
      <RnText style={{ fontSize: 11, color: colors.inkFaint }}>
        Tap an hour to read its interval
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
      <Readout label="Hour" value={`${String(hour.hourLocal).padStart(2, "0")}:00`} />
      <Readout label="P10" value={formatMwhCompact(hour.constrainedOff.p10)} />
      <Readout
        label="P50"
        value={formatMwhCompact(hour.constrainedOff.p50)}
        strong={true}
      />
      <Readout label="P90" value={formatMwhCompact(hour.constrainedOff.p90)} />
      <Readout
        label="P(above threshold)"
        value={`${Math.round(hour.occurrenceProbability * 100)}%`}
      />
      {observedMwh === undefined ? null : (
        <Readout label={observedLabel} value={formatMwhCompact(observedMwh)} />
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
