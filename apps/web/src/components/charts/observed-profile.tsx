/**
 * A settled day, hour by hour. One series, no band, no model.
 *
 * **Why this is not `FanChart`.** The fan chart draws a forecast — a P10–P90
 * ribbon, a median, an expectation beside it, and an optional observed overlay
 * to compare against. Every one of those is a statement a model made. This
 * chart has nothing to compare against and nothing to be uncertain about: these
 * are megawatt-hours ONS settled. Reusing the fan chart with an empty forecast
 * would have drawn a ribbon of zero width along the observed line, which reads
 * as a model that predicted the day exactly.
 *
 * So it is bars, in one colour, with the threshold marked. Bars because a
 * settled hour is a quantity and not a sample from anything, and the threshold
 * because `curtailment_threshold_mw` is the definition of the quantity being
 * counted and an unstamped figure cannot be compared with another one.
 *
 * **A missing hour is a gap, not a zero.** The series is keyed by local hour
 * and any hour the response did not carry is drawn as no bar at all, with the
 * axis still running 0–23. An hour that settled at zero and an hour that has
 * not settled are different facts, and the standing rule across this product is
 * that a zero never stands in for an absence.
 */

import { radius, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { useFormat } from "@/i18n";
import type { CurtailmentHourObservation } from "@/lib/fixtures";

/** The local hours a day has. Position is the hour; there are always 24. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function ObservedProfile({
  hours,
  height = 160,
  emptyLabel,
}: {
  hours: readonly CurtailmentHourObservation[];
  height?: number;
  /** Said when the day settled with no curtailment at all. */
  emptyLabel: string;
}) {
  const colors = usePalette();
  const f = useFormat();
  const byHour = new Map(hours.map((hour) => [hour.hourLocal, hour.constrainedOffMwh]));
  const peak = Math.max(...hours.map((hour) => hour.constrainedOffMwh), 0);

  if (peak === 0) {
    return (
      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkMuted }}>
        {emptyLabel}
      </Text>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 2,
          height,
        }}
      >
        {HOURS.map((hour) => {
          const mwh = byHour.get(hour);
          return (
            <View
              key={hour}
              accessibilityRole="image"
              accessibilityLabel={
                mwh === undefined
                  ? undefined
                  : `${f.number(hour)}h · ${f.compact(mwh)} MWh`
              }
              style={{
                flex: 1,
                // An hour with no row draws nothing. A one-pixel stub would be
                // a settled zero, which is a different claim.
                height: mwh === undefined ? 0 : Math.max(2, (mwh / peak) * height),
                borderRadius: radius.sm,
                backgroundColor: colors.accent,
              }}
            />
          );
        })}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {[0, 6, 12, 18, 23].map((hour) => (
          <Text key={hour} style={{ fontSize: 10, color: colors.inkFaint }}>
            {`${String(hour).padStart(2, "0")}h`}
          </Text>
        ))}
      </View>
      <Text
        style={{
          marginTop: space.xs,
          fontSize: 11,
          color: colors.inkFaint,
          fontVariant: ["tabular-nums"],
        }}
      >
        {`${f.compact(peak)} MWh`}
      </Text>
    </View>
  );
}
