import { type Store, storeLabel } from "@noviq/core";
import { Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { radius, space } from "@/theme/tokens";

/**
 * Typographic store badge — a colored dot + label reads instantly on every
 * platform (no brand glyphs that turn into tofu off-Apple hardware).
 */
export function StoreChip({ store, country }: { store: Store; country?: string }) {
  const colors = usePalette();
  const dot = store === "apple" ? "#0A84FF" : "#34A853";
  return (
    <View
      accessibilityLabel={`${storeLabel(store)}${country ? `, storefront ${country.toUpperCase()}` : ""}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        backgroundColor: colors.surfaceSunken,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.pill,
        paddingHorizontal: space.md,
        paddingVertical: 5,
        alignSelf: "flex-start",
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <Text style={{ color: colors.ink, fontSize: 13, fontWeight: "600" }}>
        {storeLabel(store)}
      </Text>
      {country ? (
        <Text style={{ color: colors.inkFaint, fontSize: 13, fontWeight: "600" }}>
          {country.toUpperCase()}
        </Text>
      ) : null}
    </View>
  );
}
