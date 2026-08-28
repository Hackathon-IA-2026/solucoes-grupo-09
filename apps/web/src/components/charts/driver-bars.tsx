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
import type { Driver } from "@/lib/fixtures";

export function DriverBars({ drivers }: { drivers: Driver[] }) {
  const colors = usePalette();
  const max = Math.max(...drivers.map((d) => d.share), 0.01);

  return (
    <View style={{ gap: space.lg }}>
      {drivers.map((driver) => {
        const raises = driver.direction === "raises";
        const fill = raises ? colors.violet : colors.accent;
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
                  {driver.label}
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
                {`${Math.round(driver.share * 100)}%`}
              </Text>
            </View>

            <View
              accessibilityRole="image"
              accessibilityLabel={`${driver.label}: ${Math.round(
                driver.share * 100,
              )}% of attributed magnitude, ${driver.direction} risk`}
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
                  backgroundColor: fill,
                }}
              />
            </View>

            {driver.observed === "—" ? null : (
              <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                {`observed ${driver.observed} · typical ${driver.typical}`}
              </Text>
            )}
          </View>
        );
      })}
      <Text style={{ fontSize: 11, color: colors.inkFaint }}>
        Shares are of the attributed magnitude for this subsystem-day, not of the
        curtailment itself. A driver that raises risk is not a cause of any individual
        curtailed MWh.
      </Text>
    </View>
  );
}
