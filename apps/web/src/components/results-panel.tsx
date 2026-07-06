import {
  averageRating,
  exportFilename,
  formatCompact,
  formatRating,
  ratingDistribution,
  reviewsToCsv,
  reviewsToJson,
  type ScrapeResult,
  storeLabel,
} from "@noviq/core";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useContainerWidth } from "@/hooks/use-container-width";
import { usePalette } from "@/hooks/use-palette";
import { exportText } from "@/lib/download";
import { radius, space } from "@/theme/tokens";
import { AppPreviewCard } from "./app-preview-card";
import { Button } from "./button";
import { FadeIn } from "./fade-in";
import { ReviewCard } from "./review-card";
import { StarRating } from "./star-rating";

const PAGE_SIZE = 20;

function StatTile({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 140,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        padding: space.lg,
        gap: 2,
        boxShadow: colors.shadowCard,
      }}
    >
      <Text
        selectable
        style={{
          color: colors.ink,
          fontSize: 26,
          fontWeight: "800",
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      <Text style={{ color: colors.inkMuted, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
    </View>
  );
}

function RatingBars({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const dist = useMemo(() => ratingDistribution(result.reviews), [result.reviews]);
  const max = Math.max(1, ...Object.values(dist));
  return (
    <View style={{ gap: space.sm }} accessibilityLabel="Rating distribution">
      {([5, 4, 3, 2, 1] as const).map((stars) => (
        <View
          key={stars}
          style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
        >
          <Text
            style={{
              width: 24,
              textAlign: "right",
              color: colors.inkMuted,
              fontSize: 13,
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
            }}
          >
            {stars}★
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
                width: `${(dist[stars] / max) * 100}%`,
                height: "100%",
                borderRadius: 4,
                backgroundColor:
                  stars >= 4 ? colors.success : stars === 3 ? colors.star : colors.danger,
              }}
            />
          </View>
          <Text
            style={{
              width: 44,
              color: colors.inkFaint,
              fontSize: 13,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatCompact(dist[stars])}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The payoff screen (Peak-End: this is the peak). Summary stats first, export
 * one tap away, then the reviews themselves in digestible pages.
 */
export function ResultsPanel({
  result,
  onNewScrape,
}: {
  result: ScrapeResult;
  onNewScrape: () => void;
}) {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [exported, setExported] = useState<string | null>(null);
  const exportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (exportTimer.current) clearTimeout(exportTimer.current);
    },
    [],
  );
  const average = useMemo(() => averageRating(result.reviews), [result.reviews]);
  const fiveStarShare = useMemo(() => {
    if (result.reviews.length === 0) return 0;
    const fives = result.reviews.filter(
      (review) => Math.round(review.rating) === 5,
    ).length;
    return Math.round((fives / result.reviews.length) * 100);
  }, [result.reviews]);

  function download(kind: "csv" | "json") {
    if (process.env.EXPO_OS === "ios") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    const content =
      kind === "csv" ? reviewsToCsv(result.reviews) : reviewsToJson(result.reviews);
    const filename = exportFilename(result.appId, result.country, kind);
    void exportText(content, filename, kind === "csv" ? "text/csv" : "application/json");
    // Visible success confirmation (micro-interaction); auto-dismisses.
    setExported(filename);
    if (exportTimer.current) clearTimeout(exportTimer.current);
    exportTimer.current = setTimeout(() => setExported(null), 4_000);
  }

  return (
    <FadeIn
      testID="results-panel"
      onLayout={onLayout}
      style={{ gap: space.xl, width: "100%" }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: space.md,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text
            accessibilityRole="header"
            aria-level={2}
            style={{ color: colors.ink, fontSize: 24, fontWeight: "800" }}
          >
            {formatCompact(result.count)} reviews scraped
          </Text>
          <Text style={{ color: colors.inkMuted, fontSize: 14 }}>
            {result.appInfo?.name ?? result.appId} · {storeLabel(result.store)} ·{" "}
            {result.country.toUpperCase()}
          </Text>
        </View>
        <Button
          label="New scrape"
          variant="secondary"
          onPress={onNewScrape}
          testID="new-scrape"
        />
      </View>

      {result.partial ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            backgroundColor: colors.warningSoft,
            borderRadius: radius.md,
            borderCurve: "continuous",
            padding: space.lg,
          }}
        >
          <Text
            selectable
            style={{ color: colors.onWarningSoft, fontSize: 14, lineHeight: 20 }}
          >
            Partial result — the scrape was cut short, so this is what we could safely
            collect. Export what's here or try again for the rest.
          </Text>
        </View>
      ) : null}

      {result.appInfo ? <AppPreviewCard appInfo={result.appInfo} /> : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <StatTile label="Reviews" value={formatCompact(result.count)} />
        <StatTile
          label="Average rating"
          value={average > 0 ? formatRating(average) : "—"}
        />
        <StatTile label="5-star share" value={`${fiveStarShare}%`} />
        <StatTile
          label="Store rating"
          value={
            result.appInfo?.averageRating != null
              ? formatRating(result.appInfo.averageRating)
              : "—"
          }
        />
      </View>

      <View
        style={{
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          padding: space.xl,
          gap: space.lg,
          flexDirection: width >= 720 ? "row" : "column",
          alignItems: width >= 720 ? "center" : "stretch",
        }}
      >
        <View style={{ alignItems: "center", gap: space.xs, minWidth: 140 }}>
          <Text
            style={{
              color: colors.ink,
              fontSize: 44,
              fontWeight: "800",
              fontVariant: ["tabular-nums"],
            }}
          >
            {average > 0 ? formatRating(average) : "—"}
          </Text>
          <StarRating rating={average} size={16} />
          <Text style={{ color: colors.inkFaint, fontSize: 12 }}>in this scrape</Text>
        </View>
        <View style={{ flex: 1 }}>
          <RatingBars result={result} />
        </View>
      </View>

      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <Button
            label="Download CSV"
            onPress={() => download("csv")}
            testID="export-csv"
          />
          <Button
            label="Download JSON"
            variant="secondary"
            onPress={() => download("json")}
            testID="export-json"
          />
        </View>
        {exported ? (
          <FadeIn duration={150} distance={4}>
            <Text
              testID="export-toast"
              accessibilityLiveRegion="polite"
              style={{ color: colors.success, fontSize: 13, fontWeight: "600" }}
            >
              ✓ Saved {exported}
            </Text>
          </FadeIn>
        ) : null}
      </View>

      <View style={{ gap: space.md }}>
        {result.reviews.slice(0, visible).map((review) => (
          <ReviewCard key={`${review.store}-${review.id}`} review={review} />
        ))}
        {visible < result.reviews.length ? (
          <Button
            label={`Show ${Math.min(PAGE_SIZE, result.reviews.length - visible)} more`}
            variant="secondary"
            fluid
            onPress={() => setVisible((count) => count + PAGE_SIZE)}
          />
        ) : null}
      </View>
    </FadeIn>
  );
}
