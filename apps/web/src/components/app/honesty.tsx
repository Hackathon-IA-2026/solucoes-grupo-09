/**
 * The labelling that has to travel with every number on these screens.
 *
 * Honesty about data vintage is a product value here, not a nicety, and the
 * domain model makes `VintageFidelity` product-visible by decision. These are
 * the components that discharge that obligation, kept together so it is easy
 * to check that a screen used them.
 */

import { Badge, ClockIcon, radius, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { producerLabel } from "@/lib/domain";
import type { ForecastOrigin, VintageFidelity } from "@/lib/fixtures";

/**
 * Every surface that shows a forecast must name its `ForecastOrigin`. This is
 * that surface, and it also carries the threshold, because every episode and
 * KPI figure on the screen is a function of it.
 */
export function ForecastStamp({
  origin,
  thresholdMw,
}: {
  origin: ForecastOrigin;
  thresholdMw?: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
      }}
    >
      <ClockIcon size={13} color={colors.inkFaint} />
      <Text style={{ fontSize: 11, color: colors.inkFaint }}>
        {fill(copy.app.stamp.published, {
          producer: producerLabel[origin.producer],
          run: origin.runLabel,
          // Brasília time, whatever clock the reader is on: a grid hour is a
          // Brazilian hour, and the `BRT` in the string says which one.
          when: f.dateTime(origin.publishedAt),
        })}
        {thresholdMw === undefined
          ? ""
          : fill(copy.app.stamp.threshold, { mw: f.number(thresholdMw) })}
      </Text>
    </View>
  );
}

export function VintageBadge({ fidelity }: { fidelity: VintageFidelity }) {
  const copy = useCopy();
  return (
    <Badge
      label={copy.app.vintage[fidelity]}
      tone={fidelity === "point_in_time" ? "accent" : "warning"}
    />
  );
}

/**
 * A block that says what a number is *not*. Deliberately not dismissable and
 * deliberately not a tooltip: a caveat behind an interaction is a caveat
 * nobody reads, and these ones change what the number means.
 */
export function HonestyNote({
  title,
  points,
  tone = "warning",
  right,
}: {
  title: string;
  points: string[];
  tone?: "warning" | "neutral";
  right?: ReactNode;
}) {
  const colors = usePalette();
  const accent = tone === "warning" ? colors.warning : colors.borderStrong;
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        borderLeftWidth: 3,
        borderLeftColor: accent,
        backgroundColor: colors.surfaceSunken,
        padding: space.lg,
        gap: space.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "700", color: colors.ink }}>
          {title}
        </Text>
        {right}
      </View>
      {points.map((point) => (
        <View key={point} style={{ flexDirection: "row", gap: 8 }}>
          <Text style={{ fontSize: 12, color: colors.inkFaint }}>—</Text>
          <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkMuted, flex: 1 }}>
            {point}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The standing caveat for anything produced by the browser-side heuristic. */
export function HeuristicNote() {
  const copy = useCopy();
  return (
    <HonestyNote
      title={copy.app.heuristic.title}
      tone="neutral"
      points={[...copy.app.heuristic.points]}
    />
  );
}
