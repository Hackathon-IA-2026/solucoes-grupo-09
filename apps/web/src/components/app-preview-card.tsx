import { type AppInfo, formatCompact, formatRating } from "@noviq/core";
import { Image } from "expo-image";
import { Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { motion, radius, space } from "@/theme/tokens";
import { FadeIn } from "./fade-in";
import { StarRating } from "./star-rating";

/**
 * The "that's my app!" moment: as soon as a pasted link resolves we show the
 * app's icon, name and rating so the user confirms the target *before*
 * spending a scrape (error prevention + recognition over recall).
 */
export function AppPreviewCard({ appInfo }: { appInfo: AppInfo }) {
  const colors = usePalette();
  const free = appInfo.price === 0;

  return (
    <FadeIn
      duration={motion.base}
      testID="app-preview"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        backgroundColor: colors.surfaceSunken,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        borderCurve: "continuous",
        padding: space.md,
      }}
    >
      {appInfo.icon ? (
        <Image
          source={{ uri: appInfo.icon }}
          style={{ width: 48, height: 48, borderRadius: 10 }}
          contentFit="cover"
          accessibilityLabel={`${appInfo.name ?? "App"} icon`}
          transition={150}
        />
      ) : (
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            backgroundColor: colors.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 20 }}>{(appInfo.name ?? "?").slice(0, 1)}</Text>
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ color: colors.ink, fontSize: 16, fontWeight: "700" }}
        >
          {appInfo.name ?? appInfo.appId}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.inkMuted, fontSize: 13 }}>
          {[appInfo.developer, appInfo.category, free ? "Free" : null]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {appInfo.averageRating != null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <StarRating rating={appInfo.averageRating} size={13} />
            <Text
              style={{
                color: colors.inkMuted,
                fontSize: 13,
                fontVariant: ["tabular-nums"],
              }}
            >
              {formatRating(appInfo.averageRating)}
              {appInfo.ratingCount ? ` (${formatCompact(appInfo.ratingCount)})` : ""}
            </Text>
          </View>
        ) : null}
      </View>
    </FadeIn>
  );
}
