import {
  averageRating,
  exportFilename,
  formatCompact,
  reviewsToCsv,
  reviewsToJson,
  type ScrapeResult,
  storeLabel,
} from "@noviq/core";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useContainerWidth } from "@/hooks/use-container-width";
import { usePalette } from "@/hooks/use-palette";
import { exportText } from "@/lib/download";
import { focusRing } from "@/lib/focus-ring";
import { layout, radius, space } from "@/theme/tokens";
import { NoviqWordmark, Stars } from "./brand";
import {
  KeywordPanel,
  RatingDistribution,
  SentimentRing,
  VersionPanel,
} from "./breakdown";
import { FadeIn } from "./fade-in";
import { DownloadIcon, RotateCcwIcon } from "./icons";
import { ReviewsFeed } from "./reviews-feed";
import { StatCards } from "./stat-cards";
import { TimelineChart } from "./timeline-chart";

function PillButton({
  label,
  icon,
  onPress,
  primary = false,
  testID,
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  primary?: boolean;
  testID?: string;
}) {
  const colors = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={(pressState) => {
        const { pressed } = pressState;
        const { focused = false } = pressState as { focused?: boolean };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: primary ? colors.accent : colors.border,
          backgroundColor: primary ? colors.accent : colors.surface,
          paddingHorizontal: 14,
          paddingVertical: 8,
          minHeight: 36,
          transform: [{ scale: pressed ? 0.95 : 1 }],
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web"
            ? ({
                cursor: "pointer",
                transitionProperty: "transform, filter",
                transitionDuration: "150ms",
              } as object)
            : null),
        };
      }}
    >
      {icon}
      <Text
        style={{
          fontSize: 14,
          fontWeight: primary ? "600" : "500",
          color: primary ? colors.onAccent : colors.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Reference `Dashboard`, fed by the real scrape result: top bar with export
 * pills + lime "New scrape", app identity card, stat cards, timeline +
 * sentiment ring, breakdown panels, and the filterable review feed.
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

  return (
    <FadeIn
      testID="results-panel"
      onLayout={onLayout}
      style={{
        width: "100%",
        maxWidth: layout.page,
        alignSelf: "center",
        paddingHorizontal: space.lg,
        paddingVertical: space.xl,
        gap: space.xl,
      }}
    >
      {/* Top bar */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.lg,
        }}
      >
        <NoviqWordmark />
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}
        >
          <PillButton
            testID="export-csv"
            label="CSV"
            icon={<DownloadIcon size={15} color={colors.ink} />}
            onPress={() => download("csv")}
          />
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

      {/* App identity card */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space.lg,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          padding: 20,
        }}
      >
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
        <View style={{ flex: 1, minWidth: 200 }}>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Text
              accessibilityRole="header"
              aria-level={2}
              style={{
                fontSize: 24,
                fontWeight: "600",
                letterSpacing: -0.5,
                color: colors.ink,
              }}
            >
              {appName}
            </Text>
            <View
              style={{
                borderRadius: radius.pill,
                backgroundColor: colors.surfaceSunken,
                paddingHorizontal: 10,
                paddingVertical: 4,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
                {storeLabel(result.store)} · {result.country.toUpperCase()}
              </Text>
            </View>
          </View>
          {result.appInfo?.developer || result.appInfo?.category ? (
            <Text style={{ marginTop: 4, fontSize: 14, color: colors.inkMuted }}>
              {[result.appInfo?.developer, result.appInfo?.category]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              style={{
                fontSize: 24,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {result.appInfo?.averageRating?.toFixed(1) ??
                (average > 0 ? average.toFixed(1) : "—")}
            </Text>
            <Stars value={result.appInfo?.averageRating ?? average} size={16} />
          </View>
          <Text style={{ marginTop: 4, fontSize: 12, color: colors.inkMuted }}>
            {result.appInfo?.ratingCount
              ? `${formatCompact(result.appInfo.ratingCount)} ratings`
              : `${formatCompact(result.count)} scraped`}
          </Text>
        </View>
      </View>

      <StatCards result={result} />

      {/* Charts row */}
      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg }}>
        <View style={{ flex: wide ? 1.5 : undefined }}>
          <TimelineChart result={result} />
        </View>
        <View style={{ flex: wide ? 1 : undefined }}>
          <SentimentRing result={result} />
        </View>
      </View>

      {/* Breakdown row */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <RatingDistribution result={result} />
        <VersionPanel result={result} />
        <KeywordPanel result={result} />
      </View>

      <ReviewsFeed result={result} />

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
