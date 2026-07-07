import { averageRating, formatCompact, type ScrapeResult } from "@noviq/core";
import {
  ArrowUpRightIcon,
  FadeIn,
  IconCircle,
  IconCircleButton,
  MessageSquareReplyIcon,
  radius,
  SmileIcon,
  StarIcon,
  space,
  UsersIcon,
  useContainerWidth,
  usePalette,
} from "@noviq/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { responseRate, sentimentMix } from "@/lib/analytics";

/**
 * Reference `StatCards` (redesigned): uniform layout — outlined icon circle
 * top-left, round arrow button top-right, muted label, huge tabular value,
 * and a bold-delta + muted-label footer. First card is the lime highlight.
 */
export function StatCards({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const columns = width >= 1100 ? 4 : width >= 560 ? 2 : 1;
  const basis: `${number}%` = columns === 4 ? "23%" : columns === 2 ? "47%" : "100%";
  // Memoized: sentimentMix runs the lexicon over every review body, and this
  // component re-renders on every onLayout/resize pass.
  const average = averageRating(result.reviews);
  const mix = sentimentMix(result.reviews);
  const replies = responseRate(result.reviews);
  const storeRating = result.appInfo?.averageRating;

  return (
    <View
      onLayout={onLayout}
      style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}
    >
      <StatCard
        highlight={true}
        delay={0}
        basis={basis}
        icon={<StarIcon size={18} color={colors.onAccent} filled={true} />}
        label="Average rating"
        value={average > 0 ? average.toFixed(1) : "—"}
        deltaValue={
          storeRating == null
            ? "—"
            : `${(average - storeRating >= 0 ? "+" : "") + (average - storeRating).toFixed(2)}`
        }
        deltaPositive={storeRating == null ? true : average >= storeRating}
        deltaLabel="vs store average"
      />
      <StatCard
        delay={70}
        basis={basis}
        icon={<UsersIcon size={18} color={colors.inkMuted} />}
        label="Reviews scraped"
        value={formatCompact(result.count)}
        deltaValue={result.partial ? "Partial" : "Complete"}
        deltaPositive={!result.partial}
        deltaLabel={result.partial ? "pull was cut short" : "full pull"}
      />
      <StatCard
        delay={140}
        basis={basis}
        icon={<MessageSquareReplyIcon size={18} color={colors.inkMuted} />}
        label="Response rate"
        value={`${replies}%`}
        deltaValue={replies > 45 ? "Healthy" : "Low"}
        deltaPositive={replies > 45}
        deltaLabel="developer replies"
      />
      <StatCard
        delay={210}
        basis={basis}
        icon={<SmileIcon size={18} color={colors.inkMuted} />}
        label="Positive sentiment"
        value={`${mix.positive}%`}
        deltaValue={`${mix.negative}%`}
        deltaPositive={false}
        deltaLabel="negative"
      />
    </View>
  );
}

function StatCard({
  basis,
  icon,
  label,
  value,
  deltaValue,
  deltaPositive,
  deltaLabel,
  highlight = false,
  delay = 0,
}: {
  basis: `${number}%`;
  icon: ReactNode;
  label: string;
  value: string;
  deltaValue: string;
  deltaPositive: boolean;
  deltaLabel: string;
  highlight?: boolean;
  delay?: number;
}) {
  const colors = usePalette();
  return (
    <FadeIn
      duration={500}
      delay={delay}
      style={{
        flexBasis: basis,
        flexGrow: 1,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        padding: 20,
        ...(highlight
          ? { backgroundColor: colors.accent }
          : {
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            }),
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <IconCircle tone={highlight ? "onAccent" : "outline"}>{icon}</IconCircle>
        <IconCircleButton
          label={`Open ${label}`}
          size={36}
          tone="inverse"
          backgroundColor={highlight ? colors.onAccent : colors.ink}
          onPress={() => {}}
        >
          <ArrowUpRightIcon size={16} color={highlight ? colors.accent : colors.canvas} />
        </IconCircleButton>
      </View>

      <Text
        style={{
          marginTop: 20,
          fontSize: 14,
          fontWeight: "500",
          color: highlight ? "rgba(30, 43, 16, 0.7)" : colors.inkMuted,
        }}
      >
        {label}
      </Text>
      <Text
        selectable={true}
        style={{
          marginTop: 4,
          fontSize: 40,
          lineHeight: 44,
          fontWeight: "600",
          letterSpacing: -0.8,
          fontVariant: ["tabular-nums"],
          color: highlight ? colors.onAccent : colors.ink,
        }}
      >
        {value}
      </Text>

      <Text
        style={{
          marginTop: 12,
          fontSize: 12,
          color: highlight ? "rgba(30, 43, 16, 0.7)" : colors.inkMuted,
        }}
      >
        <Text
          style={{
            fontWeight: "700",
            color: highlight
              ? colors.onAccent
              : deltaPositive
                ? colors.accent
                : colors.danger,
          }}
        >
          {deltaValue}
        </Text>{" "}
        {deltaLabel}
      </Text>
    </FadeIn>
  );
}
