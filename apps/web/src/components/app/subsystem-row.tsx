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
import { BandStrip } from "@/components/charts/band-figure";
import { RiskChip } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  type SubsystemDayForecast,
  splitFor,
  subsystemMeta,
  type Technology,
} from "@/lib/fixtures";

export function SubsystemRow({
  forecast,
  emphasis,
  domainMax,
  selected,
  onPress,
}: {
  forecast: SubsystemDayForecast;
  /**
   * Which scalar of this row's split to name under the subsystem. The row used
   * to print `forecast.technology`, which existed because the forecast itself
   * was per-technology; it is not, so the selection names one half of the
   * expectation instead of claiming to describe the whole row.
   */
  emphasis: Technology;
  domainMax: number;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(forecast.subsystem);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={fill(copy.app.overview.rowFigure, {
        subsystem: meta.onsDisplayName,
      })}
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
            {`${copy.app.technology[emphasis]} ${f.compact(splitFor(forecast.split, emphasis))} MWh · ${meta.code}`}
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
            {copy.app.overview.rowEnergy}
          </Text>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {/*
              The **expectation**, not the median. The label says "expected"
              and now means it: on a subsystem under an even chance to curtail
              at all, the median is flatly zero, and a row headlined with it
              reads as "nothing happening" for a day that carries real expected
              energy. The strip underneath still shows where the median sits.
            */}
            {`${f.compact(forecast.dayExpectedMwh)} MWh`}
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
            {`P10 ${f.compact(forecast.dailyEnergy.p10)}`}
          </Text>
          <Text
            style={{
              fontSize: 10,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
          >
            {fill(copy.app.overview.rowPeak, {
              low: f.compact(forecast.peakPower.p10),
              high: f.compact(forecast.peakPower.p90),
            })}
          </Text>
          <Text
            style={{
              fontSize: 10,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`P90 ${f.compact(forecast.dailyEnergy.p90)}`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
