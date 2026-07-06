import { Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { radius, space } from "@/theme/tokens";

/** Lilac uppercase kicker pill — the section-label pattern (one per section). */
export function KickerPill({ label }: { label: string }) {
  const colors = usePalette();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: colors.accentSoft,
        borderRadius: radius.pill,
        paddingHorizontal: space.lg,
        paddingVertical: 6,
      }}
    >
      <Text
        style={{
          color: colors.onAccentSoft,
          fontSize: 12,
          fontWeight: "800",
          letterSpacing: 1.1,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </View>
  );
}
