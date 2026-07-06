import { formatCompact, type ScrapeResult } from "@noviq/core";
import { useMemo, useState } from "react";
import { Text as RNText, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Pattern,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { useContainerWidth } from "@/hooks/use-container-width";
import { usePalette } from "@/hooks/use-palette";
import { timeline } from "@/lib/analytics";
import { radius } from "@/theme/tokens";

const W = 520;
const H = 200;
const PAD = { top: 16, right: 8, bottom: 24, left: 8 };

/**
 * Reference `TimelineChart`: monthly review volume as rounded bars — hatched
 * grape fill, with the active month in a grape gradient plus a dark tooltip —
 * computed from the real scraped review dates.
 */
export function TimelineChart({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const [, onLayout] = useContainerWidth();
  const [active, setActive] = useState<number | null>(null);
  const points = useMemo(() => timeline(result.reviews), [result.reviews]);

  if (points.length === 0) return null;

  const max = Math.max(...points.map((p) => p.count)) * 1.1;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const barGap = 10;
  const barW = Math.max(6, chartW / points.length - barGap);
  const activeIdx = active ?? Math.max(0, points.length - 3);
  const activePoint = points[activeIdx];
  const activeH = (activePoint.count / max) * chartH;
  const activeX = PAD.left + activeIdx * (barW + barGap) + barW / 2;
  const activeY = PAD.top + chartH - activeH;
  const tipW = 84;
  const tipX = Math.min(Math.max(activeX - tipW / 2, PAD.left), W - PAD.right - tipW);
  const tipY = Math.max(activeY - 44, 0);

  return (
    <View
      onLayout={onLayout}
      style={{
        flex: 1,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 20,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <View>
          <RNText style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
            Review volume
          </RNText>
          <RNText
            style={{ marginTop: 4, fontSize: 18, fontWeight: "600", color: colors.ink }}
          >
            {points.length > 1
              ? `${points[0].month} – ${points[points.length - 1].month}`
              : points[0].month}
          </RNText>
        </View>
        <View
          style={{
            borderRadius: radius.pill,
            backgroundColor: colors.accent,
            paddingHorizontal: 12,
            paddingVertical: 5,
          }}
        >
          <RNText style={{ fontSize: 12, fontWeight: "600", color: colors.onAccent }}>
            Monthly
          </RNText>
        </View>
      </View>

      <View style={{ marginTop: 16 }}>
        <Svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          accessibilityLabel="Monthly review volume chart"
        >
          <Defs>
            <LinearGradient id="barActive" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.violet} />
              <Stop offset="1" stopColor={colors.violet} stopOpacity={0.35} />
            </LinearGradient>
            <Pattern
              id="hatch"
              width={6}
              height={6}
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <Rect width={6} height={6} fill={colors.violet} opacity={0.12} />
              <Line
                x1={0}
                y1={0}
                x2={0}
                y2={6}
                stroke={colors.violet}
                strokeWidth={2.4}
                opacity={0.5}
              />
            </Pattern>
          </Defs>

          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <Line
              key={g}
              x1={PAD.left}
              x2={W - PAD.right}
              y1={PAD.top + chartH * g}
              y2={PAD.top + chartH * g}
              stroke={colors.border}
              strokeDasharray="3 5"
            />
          ))}

          {points.map((point, i) => {
            const h = Math.max(2, (point.count / max) * chartH);
            const x = PAD.left + i * (barW + barGap);
            const y = PAD.top + chartH - h;
            const isActive = i === activeIdx;
            return (
              <Rect
                key={point.month + String(i)}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={6}
                fill={isActive ? "url(#barActive)" : "url(#hatch)"}
                onPress={() => setActive(i)}
                onPressIn={() => setActive(i)}
              />
            );
          })}

          {points.map((point, i) => (
            <SvgText
              key={`label-${point.month}-${String(i)}`}
              x={PAD.left + i * (barW + barGap) + barW / 2}
              y={H - 6}
              textAnchor="middle"
              fontSize={10}
              fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
              fill={i === activeIdx ? colors.ink : colors.inkMuted}
            >
              {point.month}
            </SvgText>
          ))}

          {/* Tooltip for the active month. */}
          <Rect x={tipX} y={tipY} width={tipW} height={36} rx={9} fill={colors.ink} />
          <SvgText
            x={tipX + tipW / 2}
            y={tipY + 15}
            textAnchor="middle"
            fontSize={10}
            fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
            fill={colors.canvas}
          >
            {`${activePoint.month} · ${activePoint.avg.toFixed(1)}★`}
          </SvgText>
          <SvgText
            x={tipX + tipW / 2}
            y={tipY + 28}
            textAnchor="middle"
            fontSize={11}
            fontWeight="600"
            fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
            fill={colors.canvas}
          >
            {formatCompact(activePoint.count)}
          </SvgText>
          <Circle
            cx={activeX}
            cy={activeY}
            r={4}
            fill={colors.violet}
            stroke={colors.surface}
            strokeWidth={2}
          />
        </Svg>
      </View>
    </View>
  );
}
