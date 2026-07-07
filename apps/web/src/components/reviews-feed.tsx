import { formatDate, type Review, type ScrapeResult } from "@noviq/core";
import {
  CornerDownRightIcon,
  focusRing,
  radius,
  SearchIcon,
  Stars,
  ThumbsUpIcon,
  usePalette,
} from "@noviq/ui";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { initials, reviewTone } from "@/lib/analytics";

type Filter = "all" | "5" | "4" | "3" | "2" | "1" | "responded";
type Sort = "recent" | "helpful" | "critical";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "5", label: "5★" },
  { id: "4", label: "4★" },
  { id: "3", label: "3★" },
  { id: "2", label: "2★" },
  { id: "1", label: "1★" },
  { id: "responded", label: "Replied" },
];

const SORTS: Array<{ id: Sort; label: string }> = [
  { id: "recent", label: "Recent" },
  { id: "helpful", label: "Helpful" },
  { id: "critical", label: "Critical" },
];

const PAGE_SIZE = 20;

/**
 * Reference `ReviewsFeed`: search, sort, star/replied filter pills, and the
 * review cards with tone-tinted avatars and lime developer-response blocks —
 * over the real scraped reviews, paginated for large pulls.
 */
export function ReviewsFeed({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const filtered = useMemo(() => {
    let list = [...result.reviews];
    if (filter === "responded") list = list.filter((r) => r.developerResponse);
    else if (filter !== "all")
      list = list.filter((r) => Math.round(r.rating) === Number(filter));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.body.toLowerCase().includes(q) ||
          r.userName.toLowerCase().includes(q),
      );
    }
    if (sort === "recent")
      list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    else if (sort === "helpful")
      list.sort((a, b) => (b.thumbsUp ?? 0) - (a.thumbsUp ?? 0));
    else list.sort((a, b) => a.rating - b.rating);
    return list;
  }, [result.reviews, filter, sort, query]);

  const shown = filtered.slice(0, visible);

  return (
    <View
      style={{
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
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View>
          <Text style={{ fontSize: 18, fontWeight: "600", color: colors.ink }}>
            Scraped reviews
          </Text>
          <Text style={{ fontSize: 14, color: colors.inkMuted }}>
            {filtered.length} of {result.reviews.length} shown
          </Text>
        </View>
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surfaceSunken,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            <SearchIcon size={14} color={colors.inkMuted} />
            <TextInput
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                setVisible(PAGE_SIZE);
              }}
              placeholder="Search reviews…"
              placeholderTextColor={colors.inkFaint}
              accessibilityLabel="Search reviews"
              style={{
                width: 150,
                fontSize: 14,
                color: colors.ink,
                paddingVertical: 0,
                ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null),
              }}
            />
          </View>
          {SORTS.map((s) => {
            const active = sort === s.id;
            return (
              <Pressable
                key={s.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => setSort(s.id)}
                style={(pressState) => {
                  const { focused = false } = pressState as { focused?: boolean };
                  return {
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? colors.accent : colors.surfaceSunken,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    ...focusRing(focused, colors.focus, 1),
                  };
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: active ? "700" : "500",
                    color: active ? colors.onAccent : colors.inkMuted,
                  }}
                >
                  {s.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Filter pills */}
      <View style={{ marginTop: 16, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <Pressable
              key={f.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Filter ${f.label}`}
              onPress={() => {
                setFilter(f.id);
                setVisible(PAGE_SIZE);
              }}
              style={(pressState) => {
                const { focused = false } = pressState as { focused?: boolean };
                return {
                  borderRadius: radius.pill,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accent : colors.surfaceSunken,
                  paddingHorizontal: 14,
                  paddingVertical: 6,
                  minHeight: 32,
                  justifyContent: "center",
                  ...focusRing(focused, colors.focus, 1),
                };
              }}
            >
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: active ? "700" : "500",
                  color: active ? colors.onAccent : colors.inkMuted,
                }}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ marginTop: 16, gap: 12 }}>
        {shown.length === 0 ? (
          <View
            style={{
              borderRadius: radius.lg,
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: colors.borderStrong,
              paddingVertical: 48,
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 14, color: colors.inkMuted }}>
              No reviews match your filters.
            </Text>
          </View>
        ) : (
          shown.map((review) => (
            <FeedReviewCard key={`${review.store}-${review.id}`} review={review} />
          ))
        )}
        {visible < filtered.length ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setVisible((count) => count + PAGE_SIZE)}
            style={{
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surfaceSunken,
              paddingVertical: 12,
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
              Show {Math.min(PAGE_SIZE, filtered.length - visible)} more
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function FeedReviewCard({ review }: { review: Review }) {
  const colors = usePalette();
  const tone = reviewTone(review);
  const toneStyle =
    tone === "positive"
      ? { bg: colors.accentSoft, text: colors.onAccentSoft }
      : tone === "negative"
        ? { bg: colors.dangerSoft, text: colors.onDangerSoft }
        : { bg: colors.violetSoft, text: colors.onVioletSoft };

  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: "rgba(19, 19, 22, 0.4)",
        padding: 16,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 12, flexShrink: 1 }}
        >
          {review.avatar ? (
            <Image
              testID="review-avatar"
              source={{ uri: review.avatar }}
              style={{ width: 36, height: 36, borderRadius: 18 }}
              contentFit="cover"
              accessibilityLabel={`${review.userName} avatar`}
              transition={100}
            />
          ) : (
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: toneStyle.bg,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: toneStyle.text }}>
                {initials(review.userName)}
              </Text>
            </View>
          )}
          <View style={{ flexShrink: 1 }}>
            <Text
              numberOfLines={1}
              style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}
            >
              {review.userName}
            </Text>
            <View
              style={{ marginTop: 2, flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Stars value={review.rating} size={12} />
              <Text style={{ fontSize: 12, color: colors.inkMuted }}>
                · {review.country.toUpperCase()}
              </Text>
            </View>
          </View>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>
            {formatDate(review.date)}
          </Text>
          {review.appVersion ? (
            <Text
              style={{
                marginTop: 2,
                fontSize: 10,
                color: colors.inkFaint,
                fontVariant: ["tabular-nums"],
              }}
            >
              v{review.appVersion}
            </Text>
          ) : null}
        </View>
      </View>

      {review.title ? (
        <Text
          selectable
          style={{ marginTop: 12, fontSize: 14, fontWeight: "600", color: colors.ink }}
        >
          {review.title}
        </Text>
      ) : null}
      <Text
        selectable
        style={{
          marginTop: review.title ? 4 : 12,
          fontSize: 14,
          lineHeight: 22,
          color: colors.inkMuted,
        }}
      >
        {review.body}
      </Text>

      {typeof review.thumbsUp === "number" && review.thumbsUp > 0 ? (
        <View
          style={{ marginTop: 12, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <ThumbsUpIcon size={14} color={colors.inkMuted} />
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>
            {review.thumbsUp} found helpful
          </Text>
        </View>
      ) : null}

      {review.developerResponse ? (
        <View
          style={{
            marginTop: 12,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: "rgba(208, 242, 68, 0.2)",
            backgroundColor: "rgba(208, 242, 68, 0.05)",
            padding: 12,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <CornerDownRightIcon size={14} color={colors.accent} />
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent }}>
              Developer
            </Text>
            <Text style={{ fontSize: 12, color: colors.inkMuted }}>
              · {formatDate(review.developerResponse.modified)}
            </Text>
          </View>
          <Text
            selectable
            style={{ marginTop: 6, fontSize: 14, lineHeight: 22, color: colors.inkMuted }}
          >
            {review.developerResponse.body}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
