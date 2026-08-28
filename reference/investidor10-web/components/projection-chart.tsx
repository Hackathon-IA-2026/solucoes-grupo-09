import { usePalette } from "@negotiatio/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import Svg, {
  Defs,
  LinearGradient,
  Path,
  Stop,
  Circle as SvgCircle,
} from "react-native-svg";
import { type Locale, useI18n } from "@/i18n";
import { formatCurrencyCompact } from "@/i18n/format";

const H = 140;
const PAD_TOP = 12;

/**
 * Compound-growth area chart for the simulation: value of `amount` growing at
 * `ratePct` (% a.a.) from now until `years` from now. Pure SVG — same visual
 * language as the design system (lime line over a soft lime gradient fill).
 */
export function ProjectionChart({
  amount,
  ratePct,
  years,
  width,
}: {
  amount: number;
  ratePct: number;
  years: number;
  width: number;
}) {
  const colors = usePalette();
  const { t, locale } = useI18n();

  const { linePath, areaPath, points } = useMemo(() => {
    const steps = 48;
    const growth = 1 + ratePct / 100;
    const maxValue = amount * growth ** years;
    const range = Math.max(1e-6, maxValue - amount);
    const w = Math.max(1, width);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const tYears = (i / steps) * years;
      const value = amount * growth ** tYears;
      const x = (i / steps) * w;
      const y = PAD_TOP + (1 - (value - amount) / range) * (H - PAD_TOP - 4);
      pts.push({ x, y });
    }
    const line = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    const area = `${line} L${w},${H} L0,${H} Z`;
    return { linePath: line, areaPath: area, points: pts };
  }, [amount, ratePct, years, width]);

  const last = points[points.length - 1];

  /** Year tick labels along the bottom (start · mid · maturity). */
  const ticks = useMemo(() => {
    const label = (y: number) =>
      y < 1 ? `${Math.round(y * 12)}m` : `${y.toFixed(y < 3 ? 1 : 0)}a`;
    return ["0", label(years / 2), label(years)];
  }, [years]);

  if (width <= 0) {
    return <View style={{ height: H + 22 }} />;
  }

  return (
    <View>
      <Svg width={width} height={H}>
        <Defs>
          <LinearGradient id="projFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.accent} stopOpacity={0.28} />
            <Stop offset="1" stopColor={colors.accent} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>
        <Path d={areaPath} fill="url(#projFill)" />
        <Path d={linePath} stroke={colors.accent} strokeWidth={2.5} fill="none" />
        {last ? (
          <SvgCircle
            cx={last.x - 4}
            cy={last.y + 2}
            r={4}
            fill={colors.accent}
            stroke={colors.canvas}
            strokeWidth={2}
          />
        ) : null}
      </Svg>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginTop: 6,
        }}
      >
        {(["start", "mid", "end"] as const).map((pos, i) => (
          <Text key={pos} style={{ fontSize: 12, color: colors.inkFaint }}>
            {ticks[i]}
          </Text>
        ))}
      </View>
      <Text style={{ fontSize: 12, color: colors.inkFaint, marginTop: 2 }}>
        {formatCurrencyCompact(amount, locale as Locale)} →{" "}
        {formatCurrencyCompact(amount * (1 + ratePct / 100) ** years, locale as Locale)}{" "}
        {t("detail.atMaturity")}
      </Text>
    </View>
  );
}
