import {
  averageRating,
  exportFilename,
  formatCompact,
  formatDate,
  reviewsToCsv,
  reviewsToJson,
  type ScrapeResult,
} from "@noviq/core";
import {
  AppleIcon,
  CalendarDaysIcon,
  DownloadIcon,
  FadeIn,
  IconCircleButton,
  layout,
  Pill,
  PillButton,
  PlayIcon,
  RotateCcwIcon,
  radius,
  SlidersHorizontalIcon,
  Stars,
  space,
  useContainerWidth,
  usePalette,
} from "@noviq/ui";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { exportText } from "@/lib/download";
import {
  KeywordPanel,
  RatingDistribution,
  SentimentRing,
  VersionPanel,
} from "./breakdown";
import { Heatmap } from "./heatmap";
import { ReviewsFeed } from "./reviews-feed";
import { StatCards } from "./stat-cards";
import { TimelineChart } from "./timeline-chart";
import { TopNav } from "./top-nav";

const VIEWS = ["All", "Trends", "Sentiment", "Reviews"] as const;
type View_ = (typeof VIEWS)[number];

/**
 * Reference `Dashboard` (redesigned): TopNav, oversized hero header with the
 * grape store pill, stat cards, a functional view-filter row (All / Trends /
 * Sentiment / Reviews), timeline + heatmap, gauge + breakdowns, keyword
 * cloud, the reviews feed, and the dot footer — all from the real scrape.
 */
export function Dashboard({
  result,
  onNewScrape,
}: {
  result: ScrapeResult;
  onNewScrape: () => void;
}) {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 900;
  const [view, setView] = useState<View_>("All");
  const average = useMemo(() => averageRating(result.reviews), [result.reviews]);
  const [exported, setExported] = useState<string | null>(null);
  const exportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (exportTimer.current) clearTimeout(exportTimer.current);
    },
    [],
  );

  function download(kind: "csv" | "json") {
    if (process.env.EXPO_OS === "ios") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    const content =
      kind === "csv" ? reviewsToCsv(result.reviews) : reviewsToJson(result.reviews);
    const filename = exportFilename(result.appId, result.country, kind);
    void exportText(content, filename, kind === "csv" ? "text/csv" : "application/json");
    setExported(filename);
    if (exportTimer.current) clearTimeout(exportTimer.current);
    exportTimer.current = setTimeout(() => setExported(null), 4_000);
  }

  const appName = result.appInfo?.name ?? result.appId;
  const isApple = result.store === "apple";
  const showTrends = view === "All" || view === "Trends";
  const showSentiment = view === "All" || view === "Sentiment";
  const showReviews = view === "All" || view === "Reviews";

  return (
    <FadeIn
      testID="results-panel"
      onLayout={onLayout}
      style={{
        width: "100%",
        maxWidth: layout.page + 128,
        alignSelf: "center",
        paddingHorizontal: space.lg,
        paddingVertical: 20,
        gap: space.xl,
      }}
    >
      <TopNav onHome={onNewScrape} />

      {/* Hero header */}
      <View
        style={{
          marginTop: 12,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: space.xl,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
          {result.appInfo?.icon ? (
            <Image
              source={{ uri: result.appInfo.icon }}
              style={{ width: 64, height: 64, borderRadius: radius.lg }}
              contentFit="cover"
              accessibilityLabel={`${appName} icon`}
              transition={150}
            />
          ) : (
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: radius.lg,
                borderCurve: "continuous",
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontSize: 24, fontWeight: "700", color: colors.onAccent }}>
                {appName.slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          <View>
            <Text style={{ fontSize: 14, color: colors.inkMuted }}>
              Scraped results for
            </Text>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 12,
              }}
            >
              <Text
                accessibilityRole="header"
                aria-level={1}
                style={{
                  fontSize: wide ? 44 : 34,
                  lineHeight: wide ? 48 : 38,
                  fontWeight: "600",
                  letterSpacing: -1,
                  color: colors.ink,
                }}
              >
                {appName}
              </Text>
              {/* grape store pill */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: radius.pill,
                  backgroundColor: colors.violet,
                  paddingHorizontal: 12,
                  paddingVertical: 4,
                }}
              >
                {isApple ? (
                  <AppleIcon size={12} color="#FFFFFF" />
                ) : (
                  <PlayIcon size={12} color="#FFFFFF" />
                )}
                <Text style={{ fontSize: 12, fontWeight: "600", color: "#FFFFFF" }}>
                  {isApple ? "App Store" : "Google Play"}
                </Text>
              </View>
            </View>
            <View
              style={{
                marginTop: 6,
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Stars value={result.appInfo?.averageRating ?? average} size={15} />
              <Text style={{ fontSize: 14, color: colors.inkMuted }}>
                {(result.appInfo?.averageRating ?? average).toFixed(1)}
                {result.appInfo?.ratingCount
                  ? ` · ${formatCompact(result.appInfo.ratingCount)} ratings`
                  : ` · ${formatCompact(result.count)} scraped`}
                {result.appInfo?.developer ? ` · ${result.appInfo.developer}` : ""}
                {result.appInfo?.installsText
                  ? ` · ${result.appInfo.installsText} installs`
                  : ""}
                {result.appInfo?.updated
                  ? ` · updated ${formatDate(result.appInfo.updated)}`
                  : ""}{" "}
                · {result.country.toUpperCase()}
              </Text>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <PillButton
            testID="export-json"
            label="JSON"
            icon={<DownloadIcon size={15} color={colors.ink} />}
            onPress={() => download("json")}
          />
          <PillButton
            testID="new-scrape"
            label="New scrape"
            primary
            icon={<RotateCcwIcon size={15} color={colors.onAccent} />}
            onPress={onNewScrape}
          />
        </View>
      </View>

      {exported ? (
        <FadeIn duration={150} distance={4}>
          <Text
            testID="export-toast"
            accessibilityLiveRegion="polite"
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: colors.accent,
              textAlign: "right",
            }}
          >
            ✓ Saved {exported}
          </Text>
        </FadeIn>
      ) : null}

      {/* Partial-result banner (honesty first). */}
      {result.partial ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: "rgba(237, 162, 63, 0.3)",
            backgroundColor: colors.warningSoft,
            padding: space.lg,
          }}
        >
          <Text
            selectable
            style={{ fontSize: 14, lineHeight: 20, color: colors.onWarningSoft }}
          >
            Partial result — the scrape was cut short, so this is what we could safely
            collect. Export what's here or run it again for the rest.
          </Text>
        </View>
      ) : null}

      <StatCards result={result} />

      {/* Filter row: functional view pills + tool cluster */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {VIEWS.map((v) => (
            <Pill
              key={v}
              accessibilityRole="tab"
              label={v}
              active={view === v}
              onPress={() => setView(v)}
              testID={`view-${v.toLowerCase()}`}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <IconCircleButton label="Filter" tone="outline" size={40} onPress={() => {}}>
            <SlidersHorizontalIcon size={16} color={colors.inkMuted} />
          </IconCircleButton>
          <IconCircleButton
            label="Date range"
            tone="outline"
            size={40}
            onPress={() => {}}
          >
            <CalendarDaysIcon size={16} color={colors.inkMuted} />
          </IconCircleButton>
          <PillButton
            testID="export-csv"
            label="Download reports"
            icon={<DownloadIcon size={15} color={colors.ink} />}
            onPress={() => download("csv")}
          />
        </View>
      </View>

      {/* Charts */}
      {showTrends ? (
        <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg }}>
          <View style={{ flex: wide ? 1.5 : undefined }}>
            <TimelineChart result={result} />
          </View>
          <View style={{ flex: wide ? 1 : undefined }}>
            <Heatmap result={result} />
          </View>
        </View>
      ) : null}

      {showSentiment ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
            <SentimentRing result={result} />
            <RatingDistribution result={result} />
            <VersionPanel result={result} />
          </View>
          <KeywordPanel result={result} />
        </>
      ) : null}

      {showReviews ? <ReviewsFeed result={result} /> : null}

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          paddingVertical: space.xl,
        }}
      >
        <View
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }}
        />
        <Text style={{ fontSize: 12, color: colors.inkMuted }}>
          Scraped by Noviq · {formatCompact(result.count)} reviews processed
        </Text>
      </View>
    </FadeIn>
  );
}
