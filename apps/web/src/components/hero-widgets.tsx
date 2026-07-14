import { averageRating } from "@zalytix/core";
import {
  FadeIn,
  hatchGrape,
  Panel,
  radius,
  StarIcon,
  Stars,
  usePalette,
  useReducedMotion,
} from "@zalytix/ui";
import { type PropsWithChildren, useEffect, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Pattern,
  Rect,
  Stop,
} from "react-native-svg";
import { sentimentMix, timeline } from "@/lib/analytics";
import { sampleResult } from "@/lib/sample-data";

/**
 * Floating mini-dashboard widgets that flank the hero on wide screens — the
 * product visible above the fold. Real components in miniature, computed
 * from the same sample dataset as the showcase, with the reference's
 * `zalytix-float` idle animation (reduced-motion aware).
 */

const styles = StyleSheet.create({
  sentimentChip: {
    marginTop: 8,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
});

/** Gentle vertical float loop (ref `zalytix-float`), phase-shifted per widget. */
function Floaty({
  children,
  delay = 0,
  duration = 5200,
}: PropsWithChildren<{ delay?: number; duration?: number }>) {
  const reducedMotion = useReducedMotion();
  // Lazy useState (not useRef) so the Animated.Value is created exactly once
  // without reading/writing a ref during render.
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: duration / 2,
          delay,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: duration / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, delay, duration, reducedMotion]);

  return (
    <Animated.View
      style={{
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [0, -8],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

function MiniStat() {
  const colors = usePalette();
  const result = sampleResult();
  const average = averageRating(result.reviews);
  return (
    <View
      style={{
        width: 176,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        backgroundColor: colors.accent,
        padding: 16,
        boxShadow: "0 24px 50px rgba(0,0,0,0.45)",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <StarIcon size={13} color={colors.onAccent} filled={true} />
        <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onAccent }}>
          Average rating
        </Text>
      </View>
      <Text
        style={{
          marginTop: 10,
          fontSize: 34,
          lineHeight: 38,
          fontWeight: "600",
          letterSpacing: -0.8,
          fontVariant: ["tabular-nums"],
          color: colors.onAccent,
        }}
      >
        {average.toFixed(1)}
      </Text>
      <View style={{ marginTop: 6 }}>
        <Stars value={average} size={12} color={colors.onAccent} />
      </View>
    </View>
  );
}

function MiniBars() {
  const colors = usePalette();
  const result = sampleResult();
  const points = timeline(result.reviews).slice(-6);
  const W = 196;
  const H = 96;
  const max = Math.max(1, ...points.map((p) => p.count)) * 1.15;
  const slot = W / Math.max(1, points.length);
  const barW = Math.min(18, slot * 0.5);
  const active = Math.max(0, points.length - 2);
  const cur = points[active];
  const prev = points[active - 1] ?? cur;
  const delta = prev?.count ? ((cur.count - prev.count) / prev.count) * 100 : 0;

  return (
    <Panel style={{ width: 228, padding: 16 }}>
      <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
        Review volume
      </Text>
      <View style={{ marginTop: 10, alignItems: "center" }}>
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <Defs>
            <LinearGradient id="hw-active" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.violet} />
              <Stop offset="1" stopColor={colors.violet} stopOpacity={0.55} />
            </LinearGradient>
            <Pattern
              id="hw-hatch"
              width={6}
              height={6}
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <Rect width={6} height={6} fill={colors.violet} opacity={0.1} />
              <Line
                x1={0}
                y1={0}
                x2={0}
                y2={6}
                stroke={colors.violet}
                strokeWidth={2.5}
                opacity={0.5}
              />
            </Pattern>
          </Defs>
          {points.map((point, i) => {
            const h = Math.max((point.count / max) * (H - 10), barW);
            const x = i * slot + (slot - barW) / 2;
            const y = H - h;
            const isActive = i === active;
            return (
              <G key={`${point.month}-${String(i)}`}>
                <Rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={barW / 2}
                  fill={isActive ? "url(#hw-active)" : "url(#hw-hatch)"}
                />
                {isActive ? null : (
                  <Circle cx={x + barW / 2} cy={y} r={3} fill={colors.violet} />
                )}
              </G>
            );
          })}
        </Svg>
        {/* lime delta pill over the active bar */}
        <View
          style={{
            position: "absolute",
            top: -6,
            left: active * slot + slot / 2 - 4 + (228 - 32 - W) / 2,
            borderRadius: radius.pill,
            backgroundColor: colors.accent,
            paddingHorizontal: 8,
            paddingVertical: 3,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              fontWeight: "700",
              color: colors.onAccent,
              fontVariant: ["tabular-nums"],
            }}
          >
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(1)}%
          </Text>
        </View>
      </View>
    </Panel>
  );
}

function MiniRing() {
  const colors = usePalette();
  const result = sampleResult();
  const mix = sentimentMix(result.reviews);
  const size = 92;
  const r = 34;
  const stroke = 11;
  const c = 2 * Math.PI * r;
  const sweep = 0.72;
  const rotation = 90 + ((1 - sweep) * 360) / 2;
  const segs = [
    { key: "p", value: mix.positive, color: colors.accent, hatch: false },
    { key: "n", value: mix.neutral, color: colors.violet, hatch: false },
    { key: "x", value: mix.negative, color: colors.violet, hatch: true },
  ];
  let acc = 0;
  return (
    <Panel
      style={{
        width: 200,
        padding: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <Pattern
              id="hw-gauge-hatch"
              width={6}
              height={6}
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <Rect width={6} height={6} fill={colors.violet} opacity={0.18} />
              <Line
                x1={0}
                y1={0}
                x2={0}
                y2={6}
                stroke={colors.violet}
                strokeWidth={2.8}
                opacity={0.7}
              />
            </Pattern>
          </Defs>
          <G transform={`rotate(${rotation} ${size / 2} ${size / 2})`}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={colors.surfaceSunken}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${sweep * c} ${c}`}
            />
            {segs.map((seg) => {
              const len = (seg.value / 100) * sweep * c;
              const el = (
                <Circle
                  key={seg.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={seg.hatch ? "url(#hw-gauge-hatch)" : seg.color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(len - 3, 0)} ${c}`}
                  strokeDashoffset={-acc}
                />
              );
              acc += len;
              return el;
            })}
          </G>
        </Svg>
      </View>
      <View>
        <Text
          style={{
            fontSize: 22,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
            color: colors.ink,
          }}
        >
          {mix.positive}%
        </Text>
        <Text style={{ fontSize: 12, color: colors.inkMuted }}>
          {/* biome-ignore lint/style/useConsistentCurlyBraces: the \n escape needs an expression container */}
          positive{"\n"}sentiment
        </Text>
      </View>
    </Panel>
  );
}

function MiniReview() {
  const colors = usePalette();
  return (
    <Panel style={{ width: 232, padding: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: colors.accentSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onAccentSoft }}>
            MC
          </Text>
        </View>
        <View>
          <Text style={{ fontSize: 12, fontWeight: "600", color: colors.ink }}>
            Maya Chen
          </Text>
          <Stars value={5} size={9} />
        </View>
      </View>
      <Text
        numberOfLines={2}
        style={{ marginTop: 8, fontSize: 12, lineHeight: 17, color: colors.inkMuted }}
      >
        Best focus timer I've used — the insights genuinely changed my routine.
      </Text>
      <View style={[styles.sentimentChip, hatchGrape()]}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onVioletSoft }}>
          sentiment: positive
        </Text>
      </View>
    </Panel>
  );
}

/**
 * The four floating widgets, absolutely positioned in the hero's side gutters
 * (wide screens only — the parent gates rendering). Decorative: hidden from
 * the accessibility tree and untouchable.
 */
export function HeroWidgets() {
  return (
    <View
      testID="hero-widgets"
      aria-hidden={true}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: "none",
      }}
    >
      <View
        style={{
          position: "absolute",
          left: "3%",
          top: "16%",
          transform: [{ rotate: "-5deg" }],
        }}
      >
        <FadeIn duration={600} delay={200} distance={16}>
          <Floaty delay={0}>
            <MiniStat />
          </Floaty>
        </FadeIn>
      </View>
      <View
        style={{
          position: "absolute",
          left: "2.5%",
          bottom: "14%",
          transform: [{ rotate: "3deg" }],
        }}
      >
        <FadeIn duration={600} delay={350} distance={16}>
          <Floaty delay={900} duration={6000}>
            <MiniReview />
          </Floaty>
        </FadeIn>
      </View>
      <View
        style={{
          position: "absolute",
          right: "2.5%",
          top: "14%",
          transform: [{ rotate: "4deg" }],
        }}
      >
        <FadeIn duration={600} delay={280} distance={16}>
          <Floaty delay={500} duration={5600}>
            <MiniBars />
          </Floaty>
        </FadeIn>
      </View>
      <View
        style={{
          position: "absolute",
          right: "3%",
          bottom: "15%",
          transform: [{ rotate: "-3deg" }],
        }}
      >
        <FadeIn duration={600} delay={430} distance={16}>
          <Floaty delay={1400} duration={6400}>
            <MiniRing />
          </Floaty>
        </FadeIn>
      </View>
    </View>
  );
}
