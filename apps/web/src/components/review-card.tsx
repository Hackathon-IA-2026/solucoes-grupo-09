import { formatDate, type Review } from "@noviq/core";
import { Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { radius, space } from "@/theme/tokens";
import { StarRating } from "./star-rating";

/** One review: rating + meta header, selectable body, optional dev response. */
export function ReviewCard({ review }: { review: Review }) {
  const colors = usePalette();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.lg,
        gap: space.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <StarRating rating={review.rating} size={14} />
        <Text style={{ color: colors.inkFaint, fontSize: 12 }} numberOfLines={1}>
          {review.userName} · {formatDate(review.date)}
          {review.appVersion ? ` · v${review.appVersion}` : ""}
        </Text>
      </View>
      {review.title ? (
        <Text selectable style={{ color: colors.ink, fontSize: 15, fontWeight: "700" }}>
          {review.title}
        </Text>
      ) : null}
      <Text selectable style={{ color: colors.inkMuted, fontSize: 14, lineHeight: 21 }}>
        {review.body}
      </Text>
      {typeof review.thumbsUp === "number" && review.thumbsUp > 0 ? (
        <Text style={{ color: colors.inkFaint, fontSize: 12 }}>
          {review.thumbsUp} found this helpful
        </Text>
      ) : null}
      {review.developerResponse ? (
        <View
          style={{
            backgroundColor: colors.surfaceSunken,
            borderRadius: radius.sm,
            borderCurve: "continuous",
            padding: space.md,
            gap: 4,
            borderLeftWidth: 3,
            borderLeftColor: colors.accent,
          }}
        >
          <Text style={{ color: colors.ink, fontSize: 12, fontWeight: "700" }}>
            Developer response · {formatDate(review.developerResponse.modified)}
          </Text>
          <Text
            selectable
            style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 19 }}
          >
            {review.developerResponse.body}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
