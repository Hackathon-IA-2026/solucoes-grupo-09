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
import { ObservedBadge } from "@/components/app/honesty";
import { useCopy, useFormat } from "@/i18n";
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

/**
 * A settled figure in a card — the observed counterpart of `BandCard`, and
 * shaped so that it cannot be mistaken for one.
 *
 * **The difference is the missing interval, and it is stated rather than left
 * blank.** `BandCard` prints a P50 over a P10–P90 strip drawn to scale; the
 * strip is the whole point of that component, because a forecast without its
 * interval is a claim the model never made. There is no interval here and there
 * never can be: a settled megawatt-hour has no distribution — it is the number.
 * So this card has no strip, no second row of quantile labels, and a footnote
 * that says *why* there is nothing in that space, because a reader who knows
 * the forecast card will notice the gap and is owed the reason.
 *
 * Three more things separate the two at a glance: the `Observado` badge on the
 * card (cyan, the observed hue), the window named under the figure, and the
 * unit — `MWh` under a label that says energy, where the forecast peak card
 * says `MW` under a label that says power. They are different quantities and
 * they are not written as if they were the same one measured twice.
 */
export function ObservedCard({
  label,
  value,
  unit,
  window: windowLabel,
  footnote,
  basis,
}: {
  label: string;
  value: number;
  /** `MWh`. Notation, never translated — see the dictionaries' header. */
  unit: string;
  /** The day or window this figure covers. An observation without one is not
      comparable with anything, and this screen holds two windows at once. */
  window: string;
  /** Why there is no interval here. Always said; never implied by the space. */
  footnote: string;
  basis?: number;
}) {
  const colors = usePalette();
  const f = useFormat();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: basis ?? 240,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 20,
        gap: space.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <Text
          style={{
            flexShrink: 1,
            fontSize: 13,
            fontWeight: "500",
            color: colors.inkMuted,
          }}
        >
          {label}
        </Text>
        <ObservedBadge />
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text
          selectable={true}
          style={{
            fontSize: 34,
            lineHeight: 38,
            fontWeight: "600",
            letterSpacing: -0.6,
            fontVariant: ["tabular-nums"],
            color: colors.ink,
          }}
        >
          {f.compact(value)}
        </Text>
        <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
          {unit}
        </Text>
      </View>
      <Text
        style={{
          fontSize: 11,
          color: colors.info,
          fontVariant: ["tabular-nums"],
        }}
      >
        {windowLabel}
      </Text>
      <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
        {footnote}
      </Text>
    </View>
  );
}

/**
 * The empty counterpart: the day settled, and nothing was curtailed in it.
 *
 * A separate component rather than a zero in {@link ObservedCard}, because the
 * two are different sentences and the product's standing rule is that a zero
 * never stands in for an absence. Here the absence is of *curtailment*, not of
 * data — the day did settle — so it says exactly that.
 */
export function ObservedEmptyCard({ label, basis }: { label: string; basis?: number }) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: basis ?? 240,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 20,
        gap: space.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <Text
          style={{
            flexShrink: 1,
            fontSize: 13,
            fontWeight: "500",
            color: colors.inkMuted,
          }}
        >
          {label}
        </Text>
        <ObservedBadge />
      </View>
      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkMuted }}>
        {copy.app.observed.emptyDay}
      </Text>
    </View>
  );
}
