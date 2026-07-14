import { Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { usePalette } from "../hooks/use-palette";

/**
 * Brand mark: lime rounded square with the stroked Z-path
 * "M9 9H23L9 23H23" (top bar → diagonal → bottom bar).
 */
export function ZalytixMark({
  size = 28,
  tint,
}: {
  size?: number;
  /** Square fill override (e.g. grape on the nav tile — ref `text-grape`). */
  tint?: string;
}) {
  const colors = usePalette();
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" aria-hidden={true}>
      <Rect width={32} height={32} rx={9} fill={tint ?? colors.accent} />
      <Path
        d="M9 9H23L9 23H23"
        stroke={colors.onAccent}
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function ZalytixWordmark() {
  const colors = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <ZalytixMark />
      <Text
        style={{
          fontSize: 18,
          fontWeight: "600",
          letterSpacing: -0.4,
          color: colors.ink,
        }}
      >
        Zalytix
      </Text>
    </View>
  );
}

const STAR_PATH =
  "M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.3l6.5-.9L12 2.5z";

function StarSvg({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" aria-hidden={true}>
      <Path d={STAR_PATH} fill={color} />
    </Svg>
  );
}

/**
 * Fractional star row (reference `Stars`): dimmed base stars with a
 * width-clipped lime overlay per star.
 */
export function Stars({
  value,
  size = 14,
  color,
}: {
  value: number;
  size?: number;
  /** Override the filled color (the lime stat card uses onAccent). */
  color?: string;
}) {
  const colors = usePalette();
  const filled = color ?? colors.accent;
  return (
    <View
      accessibilityLabel={`${value.toFixed(1)} out of 5 stars`}
      style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
    >
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = Math.max(0, Math.min(1, value - (i - 1)));
        return (
          <View key={i} style={{ width: size, height: size }}>
            <StarSvg size={size} color="rgba(162, 162, 172, 0.3)" />
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                bottom: 0,
                width: `${fill * 100}%`,
                overflow: "hidden",
              }}
            >
              <StarSvg size={size} color={filled} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
