import type { ScrapeResult } from "@noviq/core";
import { useMemo } from "react";
import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { usePalette } from "@/hooks/use-palette";
import { distributionPct, keywords, sentimentMix, versionStats } from "@/lib/analytics";
import { radius, space } from "@/theme/tokens";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 280,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 20,
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Reference `RatingDistribution`: 5→1 star bars, lime/grape/red by band. */
export function RatingDistribution({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const dist = useMemo(() => distributionPct(result.reviews), [result.reviews]);
  const max = Math.max(1, ...dist);
  return (
    <Panel title="Rating breakdown">
      <Text style={{ marginTop: 4, fontSize: 18, fontWeight: "600", color: colors.ink }}>
        {dist[4].toFixed(0)}% love it
      </Text>
      <View style={{ marginTop: 20, gap: 12 }}>
        {[5, 4, 3, 2, 1].map((star) => {
          const pct = dist[star - 1];
          const fill =
            star >= 4 ? colors.accent : star === 3 ? colors.violet : colors.danger;
          return (
            <View
              key={star}
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
            >
              <Text
                style={{
                  width: 16,
                  textAlign: "right",
                  fontSize: 12,
                  fontWeight: "500",
                  fontVariant: ["tabular-nums"],
                  color: colors.inkMuted,
                }}
              >
                {star}
              </Text>
              <View
                style={{
                  flex: 1,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: colors.surfaceSunken,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${(pct / max) * 100}%`,
                    height: "100%",
                    borderRadius: 6,
                    backgroundColor: fill,
                  }}
                />
              </View>
              <Text
                style={{
                  width: 44,
                  textAlign: "right",
                  fontSize: 12,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                  color: colors.ink,
                }}
              >
                {pct.toFixed(1)}%
              </Text>
            </View>
          );
        })}
      </View>
    </Panel>
  );
}

/** Reference `SentimentRing`: segmented donut + legend (rating-proxy tones). */
export function SentimentRing({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const mix = useMemo(() => sentimentMix(result.reviews), [result.reviews]);
  const r = 54;
  const c = 2 * Math.PI * r;
  const segs = [
    { value: mix.positive, color: colors.accent, label: "Positive" },
    { value: mix.neutral, color: colors.violet, label: "Neutral" },
    { value: mix.negative, color: colors.danger, label: "Negative" },
  ];
  let offset = 0;
  return (
    <Panel title="Sentiment mix">
      <View
        style={{ marginTop: 12, flexDirection: "row", alignItems: "center", gap: 20 }}
      >
        <View style={{ width: 132, height: 132 }}>
          <Svg
            viewBox="0 0 132 132"
            width={132}
            height={132}
            rotation={-90}
            origin="66,66"
          >
            <Circle
              cx={66}
              cy={66}
              r={r}
              fill="none"
              stroke={colors.surfaceSunken}
              strokeWidth={14}
            />
            {segs.map((seg) => {
              const len = (seg.value / 100) * c;
              const el = (
                <Circle
                  key={seg.label}
                  cx={66}
                  cy={66}
                  r={r}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={14}
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(len - 4, 0)} ${c}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
          </Svg>
          <View
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                fontSize: 24,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {mix.positive}%
            </Text>
            <Text style={{ fontSize: 10, color: colors.inkMuted }}>positive</Text>
          </View>
        </View>
        <View style={{ flex: 1, gap: 10 }}>
          {segs.map((seg) => (
            <View
              key={seg.label}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: seg.color,
                  }}
                />
                <Text style={{ fontSize: 14, color: colors.inkMuted }}>{seg.label}</Text>
              </View>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                  color: colors.ink,
                }}
              >
                {seg.value}%
              </Text>
            </View>
          ))}
          <Text style={{ marginTop: 2, fontSize: 10, color: colors.inkFaint }}>
            from star ratings
          </Text>
        </View>
      </View>
    </Panel>
  );
}

/** Reference `KeywordPanel`: tone-tinted pills sized by mention count. */
export function KeywordPanel({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const words = useMemo(() => keywords(result.reviews), [result.reviews]);
  if (words.length === 0) return null;
  const max = Math.max(...words.map((w) => w.count));
  return (
    <Panel title="What people mention">
      <View style={{ marginTop: 16, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {words.map((word) => {
          const scale = 0.8 + (word.count / max) * 0.7;
          const tone =
            word.tone === "positive"
              ? {
                  border: "rgba(208,242,68,0.3)",
                  bg: "rgba(208,242,68,0.1)",
                  text: colors.accent,
                }
              : word.tone === "negative"
                ? {
                    border: "rgba(234,74,61,0.3)",
                    bg: "rgba(234,74,61,0.1)",
                    text: colors.danger,
                  }
                : {
                    border: "rgba(141,93,246,0.3)",
                    bg: "rgba(141,93,246,0.1)",
                    text: colors.violet,
                  };
          return (
            <View
              key={word.word}
              style={{
                flexDirection: "row",
                alignItems: "center",
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: tone.border,
                backgroundColor: tone.bg,
                paddingHorizontal: 12,
                paddingVertical: Math.round(scale * 5.5),
              }}
            >
              <Text
                style={{
                  fontSize: Math.round(scale * 13.5),
                  fontWeight: "500",
                  color: tone.text,
                }}
              >
                {word.word}
              </Text>
              <Text
                style={{
                  marginLeft: 6,
                  fontSize: Math.round(scale * 12),
                  opacity: 0.6,
                  fontVariant: ["tabular-nums"],
                  color: tone.text,
                }}
              >
                {word.count}
              </Text>
            </View>
          );
        })}
      </View>
    </Panel>
  );
}

/** Reference `VersionPanel`: per-version lime rating bars (real appVersions). */
export function VersionPanel({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const versions = useMemo(() => versionStats(result.reviews), [result.reviews]);
  if (versions.length === 0) return null;
  return (
    <Panel title="Ratings by version">
      <View style={{ marginTop: 16, gap: 4 }}>
        {versions.map((v) => (
          <View
            key={v.version}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              borderRadius: radius.md,
              paddingHorizontal: 8,
              paddingVertical: 8,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                width: 64,
                fontSize: 11,
                color: colors.inkMuted,
                fontVariant: ["tabular-nums"],
              }}
            >
              {v.version}
            </Text>
            <View
              style={{
                flex: 1,
                height: 8,
                borderRadius: 4,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${(v.rating / 5) * 100}%`,
                  height: "100%",
                  borderRadius: 4,
                  backgroundColor: colors.accent,
                }}
              />
            </View>
            <Text
              style={{
                width: 32,
                textAlign: "right",
                fontSize: 14,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {v.rating.toFixed(1)}
            </Text>
            <Text
              style={{
                width: 48,
                textAlign: "right",
                fontSize: 12,
                fontVariant: ["tabular-nums"],
                color: colors.inkMuted,
              }}
            >
              {v.reviews}
            </Text>
          </View>
        ))}
      </View>
      <Text style={{ marginTop: space.md, fontSize: 10, color: colors.inkFaint }}>
        versions reported by Google Play reviews
      </Text>
    </Panel>
  );
}
