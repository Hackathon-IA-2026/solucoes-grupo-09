import { formatCompact, type ScrapeResult } from "@noviq/core";
import {
  HashIcon,
  hatchGrape,
  IconCircleButton,
  LayersIcon,
  MoreHorizontalIcon,
  Panel,
  PanelHeader,
  PieChartIcon,
  radius,
  usePalette,
} from "@noviq/ui";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, G, Line, Pattern, Rect } from "react-native-svg";
import { distributionPct, keywords, sentimentMix, versionStats } from "@/lib/analytics";

/** Reference `RatingDistribution`: icon-circle header, 5→1 star bars. */
export function RatingDistribution({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const dist = distributionPct(result.reviews);
  // Store-wide histogram (crawled from the product page) → comparison ticks.
  const histogram = result.appInfo?.histogram;
  const histogramTotal =
    histogram?.length === 5 ? histogram.reduce((a, b) => a + b, 0) : 0;
  const storeDist =
    histogram?.length === 5 && histogramTotal > 0
      ? histogram.map((n) => (n / histogramTotal) * 100)
      : null;
  // Bars and store markers must share ONE scale or marker positions lie
  // (and an all-zero scrape would pin every marker at the bar edge).
  const max = Math.max(1, ...dist, ...(storeDist ?? []));
  return (
    <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
      <PanelHeader
        icon={<LayersIcon size={18} color={colors.inkMuted} />}
        title="Rating breakdown"
        subtitle={`${dist[4].toFixed(0)}% love it`}
      />
      <View style={{ flex: 1, marginTop: 12, justifyContent: "space-evenly", gap: 12 }}>
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
                {storeDist ? (
                  // Store-wide marker: where the whole store sits for this star.
                  <View
                    // `img` role: aria-label is prohibited on a bare div.
                    accessibilityRole="image"
                    accessibilityLabel={`Store-wide: ${storeDist[star - 1].toFixed(1)}%`}
                    style={{
                      position: "absolute",
                      left: `${(storeDist[star - 1] / max) * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: 2,
                      backgroundColor: colors.ink,
                      opacity: 0.55,
                    }}
                  />
                ) : null}
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
      {storeDist ? (
        <View
          style={{ marginTop: 14, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <View
            style={{ width: 2, height: 10, backgroundColor: colors.ink, opacity: 0.55 }}
          />
          <Text style={{ fontSize: 12, color: colors.inkFaint }}>
            store-wide distribution marker — your scrape vs all ratings
          </Text>
        </View>
      ) : null}
    </Panel>
  );
}

/**
 * Reference `SentimentRing` (redesigned): a 259° arc gauge with rounded caps
 * and a bottom gap — lime positive, grape neutral, HATCHED negative — the
 * total scraped count in the center, and a 3-column legend with counts.
 */
export function SentimentRing({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const mix = sentimentMix(result.reviews);
  const total = result.count;
  const segs = [
    {
      key: "positive",
      value: mix.positive,
      color: colors.accent,
      hatch: false,
      label: "Positive",
      count: Math.round((mix.positive / 100) * total),
    },
    {
      key: "neutral",
      value: mix.neutral,
      color: colors.violet,
      hatch: false,
      label: "Neutral",
      count: Math.round((mix.neutral / 100) * total),
    },
    {
      key: "negative",
      value: mix.negative,
      color: colors.violet,
      hatch: true,
      label: "Negative",
      count: Math.round((mix.negative / 100) * total),
    },
  ];

  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const r = 74;
  const stroke = 22;
  const c = 2 * Math.PI * r;
  const sweep = 0.72; // 259° arc, gap at the bottom
  const rotation = 90 + ((1 - sweep) * 360) / 2;

  let acc = 0;
  return (
    <Panel testID="sentiment-panel" style={{ flexGrow: 1, flexBasis: 300 }}>
      <PanelHeader
        icon={<PieChartIcon size={18} color={colors.inkMuted} />}
        title="Sentiment split"
        subtitle="Across all reviews"
        right={
          <IconCircleButton label="More" size={32} onPress={() => {}}>
            <MoreHorizontalIcon size={16} color={colors.ink} />
          </IconCircleButton>
        }
      />

      <View style={{ alignSelf: "center", marginTop: 12, width: size, height: size }}>
        <Svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          <Defs>
            <Pattern
              id="gauge-hatch"
              width={7}
              height={7}
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <Rect width={7} height={7} fill={colors.violet} opacity={0.18} />
              <Line
                x1={0}
                y1={0}
                x2={0}
                y2={7}
                stroke={colors.violet}
                strokeWidth={3.5}
                opacity={0.7}
              />
            </Pattern>
          </Defs>
          <G transform={`rotate(${rotation} ${cx} ${cy})`}>
            {/* track */}
            <Circle
              cx={cx}
              cy={cy}
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
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={seg.hatch ? "url(#gauge-hatch)" : seg.color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(len - 6, 0)} ${c}`}
                  strokeDashoffset={-acc}
                />
              );
              acc += len;
              return el;
            })}
          </G>
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
              fontSize: 30,
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {formatCompact(total)}
          </Text>
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>reviews analyzed</Text>
        </View>
      </View>

      {/* legend stats */}
      <View
        style={{
          marginTop: 8,
          flexDirection: "row",
          borderTopWidth: 1,
          borderTopColor: colors.border,
          paddingTop: 16,
        }}
      >
        {segs.map((seg) => (
          <View key={seg.key} style={{ flex: 1, alignItems: "center" }}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {formatCompact(seg.count)}
            </Text>
            <View
              style={{
                marginTop: 4,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
              }}
            >
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  ...(seg.hatch ? hatchGrape() : { backgroundColor: seg.color }),
                }}
              />
              <Text style={{ fontSize: 12, color: colors.inkMuted }}>{seg.label}</Text>
            </View>
          </View>
        ))}
      </View>
      <Text style={{ marginTop: 10, fontSize: 12, color: colors.inkFaint }}>
        from star ratings + review-text analysis
      </Text>
    </Panel>
  );
}

/** Reference `KeywordPanel`: icon-circle header + tone-tinted pills. */
export function KeywordPanel({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const words = keywords(result.reviews);
  if (words.length === 0) {
    return null;
  }
  const max = Math.max(...words.map((w) => w.count));
  return (
    <Panel>
      <PanelHeader
        icon={<HashIcon size={18} color={colors.inkMuted} />}
        title="What people mention"
        subtitle="Top keywords"
      />
      <View style={{ marginTop: 16, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {words.map((word) => {
          const scale = 0.85 + (word.count / max) * 0.55;
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
              style={[
                styles.keywordPill,
                { borderColor: tone.border, backgroundColor: tone.bg },
              ]}
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

const styles = StyleSheet.create({
  keywordPill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});

/** Reference `VersionPanel`: icon-circle header + lime rating bars per release. */
export function VersionPanel({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const breakdown = versionStats(result.reviews, result.appInfo?.versionHistory);
  const versions = breakdown.stats;
  if (versions.length === 0) {
    return null;
  }
  return (
    <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
      <PanelHeader
        icon={<LayersIcon size={18} color={colors.inkMuted} />}
        title="Ratings by version"
        subtitle="Recent releases"
      />
      {breakdown.approximate ? (
        <Text style={{ marginTop: 8, fontSize: 12, color: colors.inkFaint }}>
          approximated from App Store release dates
          {breakdown.excluded > 0
            ? ` · ${breakdown.excluded} older ${
                breakdown.excluded === 1 ? "review" : "reviews"
              } predate the known releases`
            : ""}
        </Text>
      ) : null}
      <View style={{ marginTop: 16, gap: 4 }}>
        {versions.map((v) => (
          <Pressable
            key={v.version}
            style={(state) => {
              const { hovered = false } = state as { hovered?: boolean };
              return {
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                borderRadius: radius.md,
                paddingHorizontal: 8,
                paddingVertical: 8,
                backgroundColor: hovered ? "rgba(38, 38, 43, 0.6)" : "transparent",
              };
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                width: 56,
                fontSize: 12,
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
          </Pressable>
        ))}
      </View>
    </Panel>
  );
}
