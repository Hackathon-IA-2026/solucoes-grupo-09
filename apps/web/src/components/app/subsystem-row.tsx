/**
 * One subsystem on the Grid Overview.
 *
 * IDEA.md §42 sketches this as `NORTHEAST 89% 🔴` — a name, a number and a
 * dot. Two things are added and one is taken away:
 *
 *  - **Taken away:** the raw percentage as the headline. It becomes a binned
 *    class with the rounded probability alongside it (see `risk-class.tsx`).
 *  - **Added:** the expected energy as a band on a scale shared across all
 *    four rows, so the row that matters is obvious without reading four
 *    numbers. A subsystem can be "High" risk and still be small.
 *  - **Added:** the peak band, because a 600 MW peak in three hours and a
 *    200 MW peak across twelve are different operational problems with the
 *    same daily total.
 */

import { ArrowRightIcon, focusRing, radius, space, usePalette } from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { BandStrip, formatMwh } from "@/components/charts/band-figure";
import { RiskChip } from "@/components/charts/risk-class";
import { type SubsystemDayForecast, subsystemMeta } from "@/lib/fixtures";

export function SubsystemRow({
  forecast,
  domainMax,
  selected,
  onPress,
}: {
  forecast: SubsystemDayForecast;
  domainMax: number;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  const meta = subsystemMeta(forecast.subsystem);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${meta.onsDisplayName}: open Explain`}
      onPress={onPress}
      style={(state) => {
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          borderRadius: radius.lg,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: selected ? colors.accent : colors.border,
          backgroundColor: hovered ? colors.surfaceSunken : colors.surface,
          padding: 16,
          gap: space.md,
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: "700", color: colors.ink }}>
            {meta.onsDisplayName}
          </Text>
          <Text style={{ fontSize: 11, color: colors.inkFaint }}>
            {`${forecast.technology} · ${meta.code}`}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <RiskChip probability={forecast.occurrenceProbability} />
          <ArrowRightIcon size={16} color={colors.inkFaint} />
        </View>
      </View>

      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 11, color: colors.inkFaint }}>
            Expected curtailed energy
          </Text>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {`${formatMwh(forecast.dailyEnergy.p50)} MWh`}
          </Text>
        </View>
        <BandStrip band={forecast.dailyEnergy} domainMax={domainMax} tone="accent" />
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text
            style={{
              fontSize: 10,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`P10 ${formatMwh(forecast.dailyEnergy.p10)}`}
          </Text>
          <Text
            style={{
              fontSize: 10,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`peak ${formatMwh(forecast.peakPower.p10)}–${formatMwh(
              forecast.peakPower.p90,
            )} MW`}
          </Text>
          <Text
            style={{
              fontSize: 10,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`P90 ${formatMwh(forecast.dailyEnergy.p90)}`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
