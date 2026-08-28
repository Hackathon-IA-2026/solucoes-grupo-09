import {
  ClockIcon,
  DownloadIcon,
  IconCircle,
  layout,
  Panel,
  radius,
  SmileIcon,
  space,
  useContainerWidth,
  usePalette,
} from "@zalytix/ui";
import { StyleSheet, Text, View } from "react-native";
import { sampleResult } from "@/lib/sample-data";
import { RatingDistribution, SentimentRing } from "./breakdown";
import { Heatmap } from "./heatmap";
import { StatCards } from "./stat-cards";
import { TimelineChart } from "./timeline-chart";

/**
 * Landing-page showcase: the REAL dashboard components rendered over a
 * deterministic sample scrape (clearly labeled) — fully interactive, so
 * visitors can play with the toggles before ever pasting a link.
 */
export function Showcase() {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 900;
  const result = sampleResult();

  return (
    <View
      testID="showcase"
      onLayout={onLayout}
      style={{
        width: "100%",
        maxWidth: layout.page + 128,
        alignSelf: "center",
        paddingHorizontal: space.lg,
        paddingTop: space.huge,
        // Matches the footer's uniform 32px rhythm so the CTA below has equal
        // space above and below it.
        paddingBottom: space.xxl,
        gap: space.xl,
      }}
    >
      {/* Section heading */}
      <View style={{ alignItems: "center" }}>
        <View
          style={[
            styles.previewBadge,
            {
              borderColor: colors.border,
              backgroundColor: colors.surface,
              marginBottom: space.xl,
            },
          ]}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: colors.violet,
            }}
          />
          <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
            Live preview · sample data
          </Text>
        </View>
        <Text
          accessibilityRole="header"
          aria-level={2}
          style={{
            textAlign: "center",
            fontSize: wide ? 40 : 30,
            lineHeight: wide ? 44 : 34,
            fontWeight: "600",
            letterSpacing: -1,
            color: colors.ink,
          }}
        >
          Every scrape ends in
          <Text style={{ color: colors.accent }}> this.</Text>
        </Text>
        <Text
          style={{
            textAlign: "center",
            fontSize: 15,
            lineHeight: 23,
            color: colors.inkMuted,
            maxWidth: 560,
            marginTop: space.lg,
            marginBottom: space.lg,
          }}
        >
          Sentiment split, review-volume trends, activity heatmaps, version-by-version
          ratings — computed from every scraped review. Go ahead, the charts below are
          interactive.
        </Text>
      </View>

      <StatCards result={result} />

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg }}>
        <View style={{ flex: wide ? 1.5 : undefined }}>
          <TimelineChart result={result} />
        </View>
        <View style={{ flex: wide ? 1 : undefined }}>
          <SentimentRing result={result} />
        </View>
      </View>

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg }}>
        <View style={{ flex: wide ? 1 : undefined }}>
          <Heatmap result={result} />
        </View>
        <View style={{ flex: wide ? 1 : undefined }}>
          <RatingDistribution result={result} />
        </View>
      </View>

      {/* Feature trio */}
      <View
        style={{
          marginTop: space.lg,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: space.lg,
        }}
      >
        <Feature
          icon={<SmileIcon size={18} color={colors.accent} />}
          title="Sentiment intelligence"
          body="Every review is scored and split into positive, neutral and negative — see exactly what's dragging your rating and what users love."
        />
        <Feature
          icon={<ClockIcon size={18} color={colors.violet} />}
          title="Trends & activity"
          body="Monthly volume, the hours reviews actually land, and ratings tracked release-by-release so regressions surface immediately."
        />
        <Feature
          icon={<DownloadIcon size={18} color={colors.accent} />}
          title="Own your data"
          body="Clean RFC-4180 CSV and pretty JSON exports with every field — ratings, dates, versions, helpful votes and developer responses."
        />
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  previewBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  const colors = usePalette();
  return (
    <Panel style={{ flexGrow: 1, flexBasis: 280, gap: space.md }}>
      <IconCircle>{icon}</IconCircle>
      <Text style={{ fontSize: 16, fontWeight: "600", color: colors.ink }}>{title}</Text>
      <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>{body}</Text>
    </Panel>
  );
}
