import { Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { radius, space } from "@/theme/tokens";

/** Minimal header: wordmark only — nothing competes with the hero CTA. */
export function SiteHeader() {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: space.lg,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: radius.sm,
          borderCurve: "continuous",
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.onAccent, fontSize: 17, fontWeight: "900" }}>N</Text>
      </View>
      <Text
        style={{
          color: colors.ink,
          fontSize: 19,
          fontWeight: "800",
          letterSpacing: -0.3,
        }}
      >
        Noviq
      </Text>
      <View
        style={{
          backgroundColor: colors.accentSoft,
          borderRadius: radius.pill,
          paddingHorizontal: space.md,
          paddingVertical: 3,
        }}
      >
        <Text style={{ color: colors.onAccentSoft, fontSize: 11, fontWeight: "800" }}>
          BETA
        </Text>
      </View>
    </View>
  );
}
