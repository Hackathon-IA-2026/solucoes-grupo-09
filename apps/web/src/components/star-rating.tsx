import { Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";

/**
 * Fractional star rating: a gold row clipped to `rating/5` width over a faint
 * base row. Pure text glyphs — crisp everywhere, zero assets.
 */
export function StarRating({ rating, size = 16 }: { rating: number; size?: number }) {
  const colors = usePalette();
  const clamped = Math.max(0, Math.min(5, rating));
  const row = "★★★★★";
  const textStyle = { fontSize: size, lineHeight: size + 2, letterSpacing: 1 };
  return (
    <View
      accessibilityLabel={`Rated ${clamped.toFixed(1)} out of 5 stars`}
      style={{ position: "relative", alignSelf: "flex-start" }}
    >
      <Text aria-hidden style={[textStyle, { color: colors.border }]}>
        {row}
      </Text>
      <View
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: `${(clamped / 5) * 100}%`,
          overflow: "hidden",
        }}
      >
        <Text style={[textStyle, { color: colors.star }]} numberOfLines={1}>
          {row}
        </Text>
      </View>
    </View>
  );
}
