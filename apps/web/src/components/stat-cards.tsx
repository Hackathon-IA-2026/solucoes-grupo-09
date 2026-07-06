import { averageRating, formatCompact, type ScrapeResult } from "@noviq/core";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useContainerWidth } from "@/hooks/use-container-width";
import { usePalette } from "@/hooks/use-palette";
import { responseRate, sentimentMix } from "@/lib/analytics";
import { radius, space } from "@/theme/tokens";
import { Stars } from "./brand";
import {
  ArrowUpRightIcon,
  MessageSquareIcon,
  StarIcon,
  TrendingUpIcon,
  UsersIcon,
} from "./icons";

/**
 * Reference `StatCards`: a 4-up grid where the first (average rating) is the
 * highlighted lime card with big tabular numbers; the rest are dark cards
 * with icon labels, corner arrow chips, and pill trends.
 */
export function StatCards({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const columns = width >= 1100 ? 4 : width >= 560 ? 2 : 1;
  const basis: `${number}%` = columns === 4 ? "23%" : columns === 2 ? "47%" : "100%";
  const average = averageRating(result.reviews);
  const mix = sentimentMix(result.reviews);
  const replies = responseRate(result.reviews);
  const storeRating = result.appInfo?.averageRating ?? null;
  const storeCount = result.appInfo?.ratingCount ?? null;

  return (
    <View
      onLayout={onLayout}
      style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}
    >
      {/* Average rating — the lime hero card. */}
      <View
        style={{
          flexBasis: basis,
          flexGrow: 1,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          backgroundColor: colors.accent,
          padding: 20,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StarIcon size={16} color={colors.onAccent} filled />
            <Text style={{ fontSize: 14, fontWeight: "500", color: colors.onAccent }}>
              Average rating
            </Text>
          </View>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: "rgba(30, 43, 16, 0.1)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ArrowUpRightIcon size={16} color={colors.onAccent} />
          </View>
        </View>
        <Text
          selectable
          style={{
            marginTop: 24,
            fontSize: 48,
            lineHeight: 52,
            fontWeight: "600",
            letterSpacing: -1,
            fontVariant: ["tabular-nums"],
            color: colors.onAccent,
          }}
        >
          {average > 0 ? average.toFixed(1) : "—"}
        </Text>
        <View
          style={{
            marginTop: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Stars value={average} size={15} color={colors.onAccent} />
          <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onAccent }}>
            in this scrape
          </Text>
        </View>
      </View>

      <StatCard
        basis={basis}
        icon={<UsersIcon size={16} color={colors.inkMuted} />}
        label="Reviews scraped"
        value={formatCompact(result.count)}
        sub={result.partial ? "partial result" : "complete pull"}
        trend={result.partial ? "Partial" : "Complete"}
        trendTone={result.partial ? "neg" : "pos"}
      />
      <StatCard
        basis={basis}
        icon={<MessageSquareIcon size={16} color={colors.inkMuted} />}
        label="Response rate"
        value={`${replies}%`}
        sub="developer replies"
        trend={replies > 45 ? "Healthy" : "Low"}
        trendTone={replies > 45 ? "pos" : "neg"}
      />
      <StatCard
        basis={basis}
        icon={<TrendingUpIcon size={16} color={colors.violet} />}
        label="Positive sentiment"
        value={`${mix.positive}%`}
        sub={`${mix.negative}% negative`}
        trend={
          storeRating != null
            ? `Store ${storeRating.toFixed(1)}★${storeCount ? ` · ${formatCompact(storeCount)}` : ""}`
            : undefined
        }
      />
    </View>
  );
}

function StatCard({
  basis,
  icon,
  label,
  value,
  sub,
  trend,
  trendTone = "pos",
}: {
  basis: `${number}%`;
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  trend?: string;
  trendTone?: "pos" | "neg";
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexBasis: basis,
        flexGrow: 1,
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
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {icon}
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
            {label}
          </Text>
        </View>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: colors.surfaceSunken,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ArrowUpRightIcon size={16} color={colors.inkMuted} />
        </View>
      </View>
      <Text
        selectable
        style={{
          marginTop: 24,
          fontSize: 40,
          lineHeight: 44,
          fontWeight: "600",
          letterSpacing: -0.8,
          fontVariant: ["tabular-nums"],
          color: colors.ink,
        }}
      >
        {value}
      </Text>
      <View
        style={{
          marginTop: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <Text style={{ fontSize: 12, color: colors.inkMuted }}>{sub}</Text>
        {trend ? (
          <View
            style={{
              borderRadius: radius.pill,
              paddingHorizontal: 8,
              paddingVertical: 2,
              backgroundColor:
                trendTone === "pos" ? colors.accentSoft : colors.dangerSoft,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: "600",
                color: trendTone === "pos" ? colors.onAccentSoft : colors.onDangerSoft,
              }}
            >
              {trend}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
