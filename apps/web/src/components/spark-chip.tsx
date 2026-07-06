import { Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { gradientBg } from "@/lib/gradient";

/**
 * Brand gradient icon chip (rounded square + glyph) — the recurring visual
 * signature on cards and steps. Gradient renders natively on the new
 * architecture and on web via the same style prop.
 */
export function SparkChip({ size = 40, glyph = "✦" }: { size?: number; glyph?: string }) {
  const colors = usePalette();
  return (
    <View
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        ...gradientBg(colors.gradient, colors.accent),
        boxShadow: "0 4px 12px rgba(80, 40, 200, 0.28)",
      }}
    >
      <Text
        style={{
          color: "#FFFFFF",
          fontSize: Math.round(size * 0.46),
          lineHeight: Math.round(size * 0.55),
          fontWeight: "700",
        }}
      >
        {glyph}
      </Text>
    </View>
  );
}
