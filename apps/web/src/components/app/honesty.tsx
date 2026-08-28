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
import type { ForecastOrigin, VintageFidelity } from "@/lib/fixtures";

/** `America/Sao_Paulo`, always — the whole product speaks Brasília time. */
export function formatBrasilia(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString("en-GB", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

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
        {`${origin.producer} · ${origin.runLabel} · published ${formatBrasilia(
          origin.publishedAt,
        )} BRT`}
        {thresholdMw === undefined ? "" : ` · threshold ${thresholdMw} MW`}
      </Text>
    </View>
  );
}

export function VintageBadge({ fidelity }: { fidelity: VintageFidelity }) {
  return fidelity === "point_in_time" ? (
    <Badge label="POINT-IN-TIME" tone="accent" />
  ) : (
    <Badge label="REVISION-OPTIMISTIC" tone="warning" />
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
  return (
    <HonestyNote
      title="This is a prototype heuristic, not the optimizer"
      tone="neutral"
      points={[
        "The shipped Flex Optimizer is a MILP with real binaries for the battery's charge/discharge mutual exclusion, solved by SCIP in single-digit milliseconds inside the request. Nothing on this page solves a MILP.",
        "The greedy pass here keeps the two properties whose absence would make the numbers wrong rather than approximate: absorbed energy is the net increase in flexible demand, and the assets may never import from the grid.",
        "Expect the real optimizer to recover somewhat more than this page shows, never less.",
      ]}
    />
  );
}
