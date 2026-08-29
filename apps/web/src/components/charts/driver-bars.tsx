/**
 * Driver attribution — the Explain screen's "why?".
 *
 * A near-direct port of `RatingDistribution` from
 * the template `breakdown.tsx` restored under `reference/`: ranked horizontal bars on
 * a shared scale, a label column on the left, a tabular percentage on the
 * right, and the comparison tick inside the track. The README's claim that it
 * is "almost exactly" this screen held up — the row geometry survived
 * unchanged.
 *
 * Two changes, both forced by the domain rather than by taste:
 *
 *  - The reference's five rows are a fixed set (5→1 stars). Drivers are
 *    ranked and variable-length, so the scale comes from the largest share
 *    rather than from 100%.
 *  - The reference's comparison tick is a second distribution. Here the
 *    interesting comparison is **observed vs typical for the feature itself**
 *    ("1.42 against a typical 0.96"), which is a text pair, not a position —
 *    so the tick becomes a value pair under the bar. A SHAP share has no
 *    "store-wide average" to tick against, and inventing one would be a chart
 *    that means nothing.
 */

import { space, TrendingDownIcon, TrendingUpIcon, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { type Copy, type Formatters, useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type { AttributedDriver, DriverReading } from "@/lib/fixtures";

/**
 * A feature reading, written in the reader's convention.
 *
 * The fixture stores `{ value: 1900, unit: "MW" }`, never `"1,900 MW"` —
 * a preformatted string bakes in en-US grouping, and `"weekend"` bakes in
 * English. Both decisions belong here, at the edge.
 */
export function formatReading(
  reading: DriverReading,
  copy: Copy,
  f: Formatters,
): string | null {
  if (reading.kind === "none") {
    return null;
  }
  if (reading.kind === "term") {
    return copy.app.drivers.terms[reading.term];
  }
  const magnitude = f.number(reading.value, reading.decimals ?? 0);
  const signed = reading.signed && reading.value > 0 ? `+${magnitude}` : magnitude;
  return reading.unit === undefined ? signed : `${signed} ${reading.unit}`;
}

export function DriverBars({ drivers }: { drivers: AttributedDriver[] }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const max = Math.max(...drivers.map((d) => d.share), 0.01);

  return (
    <View style={{ gap: space.lg }}>
      {drivers.map((driver) => {
        const raises = driver.direction === "raises";
        const barColor = raises ? colors.violet : colors.accent;
        const label = copy.app.drivers.labels[driver.code];
        const observed = formatReading(driver.observed, copy, f);
        const typical = formatReading(driver.typical, copy, f);
        return (
          <View key={driver.code} style={{ gap: 6 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 1,
                }}
              >
                {raises ? (
                  <TrendingUpIcon size={14} color={colors.violet} />
                ) : (
                  <TrendingDownIcon size={14} color={colors.accent} />
                )}
                <Text style={{ fontSize: 14, fontWeight: "500", color: colors.ink }}>
                  {label}
                </Text>
              </View>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: "700",
                  fontVariant: ["tabular-nums"],
                  color: colors.ink,
                }}
              >
                {f.percent(driver.share)}
              </Text>
            </View>

            <View
              accessibilityRole="image"
              accessibilityLabel={fill(copy.app.drivers.figure, {
                driver: label,
                share: f.percent(driver.share),
                direction: copy.app.drivers.direction[driver.direction],
              })}
              style={{
                height: 10,
                borderRadius: 5,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${(driver.share / max) * 100}%`,
                  height: "100%",
                  borderRadius: 5,
                  backgroundColor: barColor,
                }}
              />
            </View>

            {observed === null || typical === null ? null : (
              <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                {fill(copy.app.drivers.reading, { observed, typical })}
              </Text>
            )}
          </View>
        );
      })}
      <Text style={{ fontSize: 11, color: colors.inkFaint }}>
        {copy.app.drivers.note}
      </Text>
    </View>
  );
}
