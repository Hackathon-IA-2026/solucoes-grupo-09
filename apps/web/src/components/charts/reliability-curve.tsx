/**
 * Reliability (calibration) diagram — a genuinely new chart.
 *
 * Nothing in `reference/` is close: the template's charts are all magnitude
 * marks (bars, arcs, capsules) over a categorical or time axis. A reliability
 * diagram plots forecast probability against observed frequency with a 45°
 * identity line, and the *deviation from the diagonal* is the whole message.
 * `projection-chart.tsx` from `reference/investidor10-web` supplied the
 * pure-SVG line/area idiom and nothing else.
 *
 * The dot area is proportional to the number of hours in the bin, so a bin
 * that looks badly off but was computed over 400 hours does not shout as
 * loudly as one computed over 4,000.
 */

import { useContainerWidth, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Text as SvgText } from "react-native-svg";
import { useCopy, useFormat } from "@/i18n";
import type { ReliabilityPoint } from "@/lib/fixtures";

const S = 240;
const PAD = 30;
const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

export function ReliabilityCurve({
  points,
  maxSize = 460,
}: {
  points: ReliabilityPoint[];
  /** Upper bound on the square's side. It grows to the panel width below this. */
  maxSize?: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  // Measured rather than fixed: `width="100%"` on a square viewBox letterboxes
  // — the plot renders as a centred square with dead space either side of it.
  // A reliability diagram has to *stay* square, because the identity line only
  // reads as "perfectly calibrated" at 45°, so the fix is to grow the square to
  // the panel's width rather than to stretch the drawing to fill it.
  const [measured, onLayout] = useContainerWidth();
  const side = Math.max(180, Math.min(measured || S, maxSize));
  const plot = S - PAD * 2;
  const maxCount = Math.max(...points.map((p) => p.hourCount), 1);

  const x = (v: number) => PAD + v * plot;
  const y = (v: number) => PAD + (1 - v) * plot;

  const line = `M${points
    .map((p) => `${x(p.binCentre).toFixed(1)},${y(p.observedFrequency).toFixed(1)}`)
    .join(" L")}`;

  return (
    <View onLayout={onLayout} style={{ gap: 8, alignItems: "center" }}>
      <Svg
        viewBox={`0 0 ${S} ${S}`}
        width={side}
        height={side}
        accessibilityLabel={copy.app.reliability.figure}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <G key={g}>
            <Line
              x1={PAD}
              x2={S - PAD}
              y1={y(g)}
              y2={y(g)}
              stroke={colors.border}
              strokeDasharray="2 6"
            />
            <SvgText
              x={PAD - 6}
              y={y(g) + 3}
              textAnchor="end"
              fontSize={9}
              fontFamily={FONT}
              fill={colors.inkMuted}
            >
              {f.number(g * 100)}
            </SvgText>
            <SvgText
              x={x(g)}
              y={S - PAD + 14}
              textAnchor="middle"
              fontSize={9}
              fontFamily={FONT}
              fill={colors.inkMuted}
            >
              {f.number(g * 100)}
            </SvgText>
          </G>
        ))}

        {/* Perfect calibration. */}
        <Line
          x1={x(0)}
          y1={y(0)}
          x2={x(1)}
          y2={y(1)}
          stroke={colors.inkFaint}
          strokeWidth={1}
          strokeDasharray="4 4"
        />

        <Path d={line} stroke={colors.accent} strokeWidth={2} fill="none" />
        {points.map((p) => (
          <Circle
            key={p.binCentre}
            cx={x(p.binCentre)}
            cy={y(p.observedFrequency)}
            r={3 + 4 * Math.sqrt(p.hourCount / maxCount)}
            fill={colors.accent}
            fillOpacity={0.85}
            stroke={colors.canvas}
            strokeWidth={1.5}
          />
        ))}

        <SvgText
          x={S / 2}
          y={S - 4}
          textAnchor="middle"
          fontSize={9}
          fontFamily={FONT}
          fill={colors.inkFaint}
        >
          {copy.app.reliability.axis}
        </SvgText>
      </Svg>
      <Text style={{ fontSize: 11, color: colors.inkFaint }}>
        {copy.app.reliability.note}
      </Text>
    </View>
  );
}
