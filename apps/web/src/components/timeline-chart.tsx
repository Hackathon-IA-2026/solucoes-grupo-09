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
import { useMemo, useState } from "react";
import { Platform, Text as RNText, View } from "react-native";
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
import { timeline } from "@/lib/analytics";

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
  const all = useMemo(() => timeline(result.reviews), [result.reviews]);
  const points = useMemo(() => all.slice(range === "monthly" ? -6 : -12), [all, range]);
  const [activeSel, setActive] = useState<number | null>(null);

  if (points.length === 0) return null;

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
  const activeCX = PAD.left + active * slot + slot / 2;
  const activeTop = PAD.top + chartH - (cur.count / max) * chartH;
  const scale = containerWidth > 0 ? containerWidth / W : 0;

  return (
    <Panel testID="timeline-panel" style={{ flex: 1 }}>
      <PanelHeader
        icon={<UserPlusIcon size={18} color={colors.inkMuted} />}
        title="Review volume"
        subtitle={range === "monthly" ? "Last 6 months" : "Last 12 months"}
        right={
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
                onPress={() => setRange("monthly")}
              />
              <Pill
                label="Yearly"
                size="sm"
                tone="secondary"
                accessibilityRole="radio"
                active={range === "yearly"}
                onPress={() => setRange("yearly")}
              />
            </View>
            <IconCircleButton label="More" size={32} onPress={() => {}}>
              <MoreHorizontalIcon size={16} color={colors.ink} />
            </IconCircleButton>
          </View>
        }
      />

      <View onLayout={onLayout} style={{ marginTop: 20, position: "relative" }}>
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
                {/* invisible hit area spanning the slot */}
                <Rect
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={chartH}
                  fill="transparent"
                  onPress={() => setActive(i)}
                  onPressIn={() => setActive(i)}
                />
                {/* capsule bar */}
                <Rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={barW / 2}
                  fill={isActive ? "url(#tl-active)" : "url(#tl-hatch)"}
                  onPress={() => setActive(i)}
                  onPressIn={() => setActive(i)}
                />
                {/* grape dot on inactive bar tops */}
                {!isActive ? (
                  <Circle cx={x + barW / 2} cy={y} r={5} fill={colors.violet} />
                ) : null}
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
            cx={activeCX}
            cy={activeTop}
            r={6}
            fill={colors.ink}
            stroke={colors.violet}
            strokeWidth={3}
          />
        </Svg>

        {scale > 0 ? (
          <>
            {/* lime delta bubble with a downward tail (pops on change) */}
            <FadeIn
              key={`delta-${active}-${range}`}
              pop
              duration={320}
              distance={6}
              pointerEvents="none"
              testID="timeline-delta"
              style={{
                position: "absolute",
                left: activeCX * scale - 34,
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
                <RNText
                  style={{
                    fontSize: 11,
                    fontWeight: "700",
                    color: colors.onAccent,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(1)}%
                </RNText>
              </View>
              <View
                style={{
                  width: 0,
                  height: 0,
                  borderLeftWidth: 4,
                  borderRightWidth: 4,
                  borderTopWidth: 4,
                  borderLeftColor: "transparent",
                  borderRightColor: "transparent",
                  borderTopColor: colors.accent,
                }}
              />
            </FadeIn>

            {/* glass tooltip, offset right of the bar (pops on change) */}
            <FadeIn
              key={`tip-${active}-${range}`}
              pop
              duration={320}
              distance={6}
              pointerEvents="none"
              testID="timeline-tooltip"
              style={{
                position: "absolute",
                left: activeCX * scale + 12,
                top: (activeTop + 28) * scale,
                borderRadius: radius.lg,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: "rgba(255, 255, 255, 0.1)",
                paddingHorizontal: 16,
                paddingVertical: 10,
                boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
                ...(Platform.OS === "web"
                  ? ({
                      backgroundColor: "rgba(247, 247, 247, 0.06)",
                      backdropFilter: "blur(12px)",
                    } as object)
                  : { backgroundColor: "rgba(38, 38, 43, 0.92)" }),
              }}
            >
              <RNText style={{ fontSize: 11, color: colors.inkMuted }}>
                {cur.month}
              </RNText>
              <RNText
                style={{
                  fontSize: 20,
                  fontWeight: "600",
                  color: colors.ink,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {cur.count.toLocaleString("en-US")}
              </RNText>
            </FadeIn>
          </>
        ) : null}
      </View>
    </Panel>
  );
}
