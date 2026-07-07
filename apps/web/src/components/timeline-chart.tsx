import { formatCompact, type ScrapeResult } from "@noviq/core";
import {
  FadeIn,
  IconCircleButton,
  MoreHorizontalIcon,
  Panel,
  PanelHeader,
  Pill,
  radius,
  UserPlusIcon,
  useContainerWidth,
  usePalette,
} from "@noviq/ui";
import { useState } from "react";
import { Platform, Pressable, Text as RnText, StyleSheet, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Pattern,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { type TimelinePoint, timeline } from "@/lib/analytics";

const W = 560;
const H = 240;
const PAD = { top: 30, right: 12, bottom: 28, left: 44 };
const AXIS = [1, 0.75, 0.5, 0.25, 0];
const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

/**
 * Reference `TimelineChart` (redesigned): capsule bars (grape hatch, gradient
 * when active) with a y-axis, a white connector dot, a floating lime delta
 * bubble vs the previous month, and a glass tooltip — over the real monthly
 * review volume. Tap a bar to inspect it; Monthly = 6 buckets, Yearly = 12.
 */
export function TimelineChart({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const [containerWidth, onLayout] = useContainerWidth();
  const [range, setRange] = useState<"monthly" | "yearly">("yearly");
  const all = timeline(result.reviews);
  const points = all.slice(range === "monthly" ? -6 : -12);
  const [activeSel, setActive] = useState<number | null>(null);

  if (points.length === 0) {
    return null;
  }

  const active = Math.min(activeSel ?? Math.max(0, points.length - 3), points.length - 1);
  const max = Math.max(...points.map((p) => p.count)) * 1.15;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const slot = chartW / points.length;
  const barW = Math.min(46, slot * 0.5);

  const cur = points[active];
  const prev = points[active - 1] ?? points[active];
  const delta = prev.count ? ((cur.count - prev.count) / prev.count) * 100 : 0;

  // Active bar geometry, scaled to real pixels for the overlay bubbles.
  const activeCx = PAD.left + active * slot + slot / 2;
  const activeTop = PAD.top + chartH - (cur.count / max) * chartH;
  const scale = containerWidth > 0 ? containerWidth / W : 0;

  return (
    <Panel testID="timeline-panel" style={{ flex: 1 }}>
      <PanelHeader
        icon={<UserPlusIcon size={18} color={colors.inkMuted} />}
        title="Review volume"
        subtitle={range === "monthly" ? "Last 6 months" : "Last 12 months"}
        right={<RangeControls range={range} onRange={setRange} />}
      />

      <View onLayout={onLayout} style={{ marginTop: 20, position: "relative" }}>
        <PlotSvg
          points={points}
          active={active}
          max={max}
          scale={scale}
          slot={slot}
          barW={barW}
          chartH={chartH}
          activeCx={activeCx}
          activeTop={activeTop}
        />

        {/* Hit areas: one pressable per month slot, over the plot region. */}
        {scale > 0 ? (
          <View
            style={{
              position: "absolute",
              left: PAD.left * scale,
              top: PAD.top * scale,
              width: (W - PAD.left - PAD.right) * scale,
              height: chartH * scale,
              flexDirection: "row",
            }}
          >
            {points.map((point, i) => (
              <Pressable
                key={`hit-${point.month}-${String(i)}`}
                accessibilityRole="button"
                accessibilityLabel={`Inspect ${point.month}: ${point.count} reviews`}
                onPress={() => setActive(i)}
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
          <>
            <DeltaBubble
              active={active}
              range={range}
              delta={delta}
              activeCx={activeCx}
              activeTop={activeTop}
              scale={scale}
            />
            <GlassTooltip
              active={active}
              range={range}
              cur={cur}
              activeCx={activeCx}
              activeTop={activeTop}
              scale={scale}
            />
          </>
        ) : null}
      </View>
    </Panel>
  );
}

/** Monthly/Yearly capsule toggle + the "More" button in the panel header. */
function RangeControls({
  range,
  onRange,
}: {
  range: "monthly" | "yearly";
  onRange: (range: "monthly" | "yearly") => void;
}) {
  const colors = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          borderRadius: radius.pill,
          backgroundColor: colors.surfaceSunken,
          padding: 4,
        }}
      >
        <Pill
          label="Monthly"
          size="sm"
          tone="secondary"
          accessibilityRole="radio"
          active={range === "monthly"}
          onPress={() => onRange("monthly")}
        />
        <Pill
          label="Yearly"
          size="sm"
          tone="secondary"
          accessibilityRole="radio"
          active={range === "yearly"}
          onPress={() => onRange("yearly")}
        />
      </View>
      <IconCircleButton label="More" size={32} onPress={() => {}}>
        <MoreHorizontalIcon size={16} color={colors.ink} />
      </IconCircleButton>
    </View>
  );
}

/** The SVG plot: gridlines, capsule bars, month labels, and connector dot. */
function PlotSvg({
  points,
  active,
  max,
  scale,
  slot,
  barW,
  chartH,
  activeCx,
  activeTop,
}: {
  points: TimelinePoint[];
  active: number;
  max: number;
  scale: number;
  slot: number;
  barW: number;
  chartH: number;
  activeCx: number;
  activeTop: number;
}) {
  const colors = usePalette();
  return (
    <Svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={scale > 0 ? scale * H : H}
      accessibilityLabel="Monthly review volume"
    >
      <Defs>
        <LinearGradient id="tl-active" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.violet} />
          <Stop offset="1" stopColor={colors.violet} stopOpacity={0.55} />
        </LinearGradient>
        <Pattern
          id="tl-hatch"
          width={7}
          height={7}
          patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse"
        >
          <Rect width={7} height={7} fill={colors.violet} opacity={0.1} />
          <Line
            x1={0}
            y1={0}
            x2={0}
            y2={7}
            stroke={colors.violet}
            strokeWidth={3}
            opacity={0.5}
          />
        </Pattern>
      </Defs>

      {/* gridlines + y-axis labels */}
      {AXIS.map((g) => {
        const y = PAD.top + chartH * (1 - g);
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
              {g === 0 ? "0" : formatCompact(Math.round(max * g))}
            </SvgText>
          </G>
        );
      })}

      {points.map((point, i) => {
        const h = Math.max((point.count / max) * chartH, barW);
        const x = PAD.left + i * slot + (slot - barW) / 2;
        const y = PAD.top + chartH - h;
        const isActive = i === active;
        return (
          <G key={`${point.month}-${String(i)}`}>
            {/* capsule bar (hit areas are RN Pressables overlaid below —
                SVG-level press handlers leak responder props into the
                DOM on web) */}
            <Rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={barW / 2}
              fill={isActive ? "url(#tl-active)" : "url(#tl-hatch)"}
            />
            {/* grape dot on inactive bar tops */}
            {isActive ? null : (
              <Circle cx={x + barW / 2} cy={y} r={5} fill={colors.violet} />
            )}
            <SvgText
              x={x + barW / 2}
              y={H - 6}
              textAnchor="middle"
              fontSize={11}
              fontFamily={FONT}
              fontWeight={isActive ? "600" : "400"}
              fill={isActive ? colors.ink : colors.inkMuted}
            >
              {point.month}
            </SvgText>
          </G>
        );
      })}

      {/* white connector dot at the active bar top */}
      <Circle
        cx={activeCx}
        cy={activeTop}
        r={6}
        fill={colors.ink}
        stroke={colors.violet}
        strokeWidth={3}
      />
    </Svg>
  );
}

/** lime delta bubble with a downward tail (pops on change) */
function DeltaBubble({
  active,
  range,
  delta,
  activeCx,
  activeTop,
  scale,
}: {
  active: number;
  range: "monthly" | "yearly";
  delta: number;
  activeCx: number;
  activeTop: number;
  scale: number;
}) {
  const colors = usePalette();
  return (
    <FadeIn
      key={`delta-${active}-${range}`}
      pop={true}
      duration={320}
      distance={6}
      testID="timeline-delta"
      style={{
        pointerEvents: "none",
        position: "absolute",
        left: activeCx * scale - 34,
        top: (activeTop - 16) * scale - 34,
        width: 68,
        alignItems: "center",
      }}
    >
      <View
        style={{
          borderRadius: radius.pill,
          backgroundColor: colors.accent,
          paddingHorizontal: 10,
          paddingVertical: 4,
          boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        }}
      >
        <RnText
          style={{
            fontSize: 12,
            fontWeight: "700",
            color: colors.onAccent,
            fontVariant: ["tabular-nums"],
          }}
        >
          {delta >= 0 ? "+" : ""}
          {delta.toFixed(1)}%
        </RnText>
      </View>
      <View style={[styles.deltaTail, { borderTopColor: colors.accent }]} />
    </FadeIn>
  );
}

/** glass tooltip, offset right of the bar (pops on change) */
function GlassTooltip({
  active,
  range,
  cur,
  activeCx,
  activeTop,
  scale,
}: {
  active: number;
  range: "monthly" | "yearly";
  cur: TimelinePoint;
  activeCx: number;
  activeTop: number;
  scale: number;
}) {
  const colors = usePalette();
  return (
    <FadeIn
      key={`tip-${active}-${range}`}
      pop={true}
      duration={320}
      distance={6}
      testID="timeline-tooltip"
      style={[
        styles.tooltip,
        {
          left: activeCx * scale + 12,
          top: (activeTop + 28) * scale,
        },
        Platform.OS === "web"
          ? ({
              backgroundColor: "rgba(247, 247, 247, 0.06)",
              backdropFilter: "blur(12px)",
            } as object)
          : { backgroundColor: "rgba(38, 38, 43, 0.92)" },
      ]}
    >
      <RnText style={{ fontSize: 12, color: colors.inkMuted }}>{cur.month}</RnText>
      <RnText
        style={{
          fontSize: 20,
          fontWeight: "600",
          color: colors.ink,
          fontVariant: ["tabular-nums"],
        }}
      >
        {cur.count.toLocaleString("en-US")}
      </RnText>
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  deltaTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 4,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
  tooltip: {
    pointerEvents: "none",
    position: "absolute",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
  },
});
