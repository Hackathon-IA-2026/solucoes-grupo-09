/**
 * The P10–P90 problem, solved rather than dropped.
 *
 * Every stat card and gauge in `reference/` is built for a single figure:
 * `stat-cards.tsx` takes `value: string`, `stat-card.tsx` the same, the
 * `SentimentRing` arc has one sweep, and `RiskBar` positions one marker. None
 * of them has anywhere to put an interval, and the honest reading of
 * WattSteer's forecaster is that *there is no single figure to put there* —
 * the model emits P10/P50/P90 per hour and a hurdle probability alongside it.
 *
 * Three things were rejected before landing here:
 *
 *  1. **"P50 ± x%"** — reads as a symmetric measurement error. These bands are
 *     not symmetric (a hurdle model pins P10 at zero the moment occurrence
 *     drops below an even chance) and the asymmetry is the informative part.
 *  2. **A second, smaller number under the big one** — turns the interval into
 *     a footnote, and footnotes get skipped. The band has to be *shaped*, not
 *     spelled.
 *  3. **Showing P10 and P90 as two more stat cards** — triples the card count
 *     and still leaves the reader to reconstruct that they are one quantity.
 *
 * What ships instead: the P50 stays the large tabular figure, and directly
 * beneath it a **band strip** draws the P10–P90 interval to scale on a track,
 * with the P50 marked on it. The number is read first and the width of the
 * interval is read immediately after, from the same object, without arithmetic.
 * Where several figures share a domain (`domainMax`), their strips share a
 * scale, so "wider" means wider.
 *
 * The strip degrades correctly in the case the reference components cannot
 * express at all: when P10 is 0, the interval visibly runs to the left edge,
 * which is the visual form of "this may not happen".
 */

import { radius, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { Band } from "@/lib/fixtures";

/**
 * Compact: "12.5k", "4180", "42.7". The product screens pack many figures into
 * tight rows, where an exact grouped number costs width that the band strip
 * needs. See `landing/band.ts` for the exact renderer and why they differ.
 */
export function formatMwhCompact(value: number): string {
  if (value >= 10_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * The interval, drawn to scale. `domainMax` lets a row of figures share one
 * scale; without it each strip is scaled to its own P90.
 */
export function BandStrip({
  band,
  domainMax,
  height = 8,
  tone = "accent",
}: {
  band: Band;
  domainMax?: number;
  height?: number;
  tone?: "accent" | "violet" | "muted";
}) {
  const colors = usePalette();
  const max = Math.max(domainMax ?? band.p90 * 1.15, 1e-6);
  const left = clamp01(band.p10 / max);
  const right = clamp01(band.p90 / max);
  const mid = clamp01(band.p50 / max);
  const fill =
    tone === "accent"
      ? colors.accent
      : tone === "violet"
        ? colors.violet
        : colors.inkMuted;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`P10 ${formatMwhCompact(band.p10)}, P50 ${formatMwhCompact(
        band.p50,
      )}, P90 ${formatMwhCompact(band.p90)}`}
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: colors.surfaceSunken,
        overflow: "hidden",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          left: `${left * 100}%`,
          width: `${Math.max(1.5, (right - left) * 100)}%`,
          top: 0,
          bottom: 0,
          borderRadius: height / 2,
          backgroundColor: fill,
          opacity: 0.32,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: `${mid * 100}%`,
          top: 0,
          bottom: 0,
          width: 3,
          marginLeft: -1.5,
          borderRadius: 2,
          backgroundColor: fill,
        }}
      />
    </View>
  );
}

/**
 * The headline figure: P50 large, the interval drawn beneath it to scale, and
 * the two bounds spelled out at the ends of the track.
 */
export function BandFigure({
  label,
  band,
  unit,
  domainMax,
  size = "lg",
  tone = "accent",
  footnote,
}: {
  label: string;
  band: Band;
  unit: string;
  domainMax?: number;
  size?: "lg" | "md";
  tone?: "accent" | "violet" | "muted";
  footnote?: string;
}) {
  const colors = usePalette();
  const figureSize = size === "lg" ? 40 : 28;
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text
          selectable={true}
          style={{
            fontSize: figureSize,
            lineHeight: figureSize + 4,
            fontWeight: "600",
            letterSpacing: -0.8,
            fontVariant: ["tabular-nums"],
            color: colors.ink,
          }}
        >
          {formatMwhCompact(band.p50)}
        </Text>
        <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
          {unit}
        </Text>
      </View>
      <BandStrip band={band} domainMax={domainMax} tone={tone} />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text
          style={{ fontSize: 11, color: colors.inkFaint, fontVariant: ["tabular-nums"] }}
        >
          P10 {formatMwhCompact(band.p10)}
        </Text>
        <Text style={{ fontSize: 11, color: colors.inkFaint }}>P50 marked</Text>
        <Text
          style={{ fontSize: 11, color: colors.inkFaint, fontVariant: ["tabular-nums"] }}
        >
          P90 {formatMwhCompact(band.p90)}
        </Text>
      </View>
      {footnote === undefined ? null : (
        <Text style={{ fontSize: 11, color: colors.inkFaint }}>{footnote}</Text>
      )}
    </View>
  );
}

/** A band figure in a card, for KPI rows. */
export function BandCard({
  label,
  band,
  unit,
  domainMax,
  icon,
  footnote,
  tone = "accent",
  basis,
}: {
  label: string;
  band: Band;
  unit: string;
  domainMax?: number;
  icon?: ReactNode;
  footnote?: string;
  tone?: "accent" | "violet" | "muted";
  basis?: number;
}) {
  const colors = usePalette();
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
      {icon === undefined ? null : <View>{icon}</View>}
      <BandFigure
        label={label}
        band={band}
        unit={unit}
        domainMax={domainMax}
        tone={tone}
        footnote={footnote}
      />
    </View>
  );
}
