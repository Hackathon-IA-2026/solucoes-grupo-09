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

import type { BandUnavailableReason } from "@wattsteer/core";
import { Badge, radius, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type { Band } from "@/lib/fixtures";

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
  tone = "violet",
}: {
  band: Band;
  domainMax?: number;
  height?: number;
  tone?: "accent" | "violet" | "muted";
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const max = Math.max(domainMax ?? band.p90 * 1.15, 1e-6);
  const left = clamp01(band.p10 / max);
  const right = clamp01(band.p90 / max);
  const mid = clamp01(band.p50 / max);
  // The landing's rail: bordered span, violet, overhanging lime tick.
  const fillColor =
    tone === "accent"
      ? colors.accent
      : tone === "violet"
        ? colors.violet
        : colors.inkMuted;
  const spanFill =
    tone === "accent"
      ? colors.accentSoft
      : tone === "violet"
        ? colors.violetSoft
        : colors.borderStrong;
  // The tick has to contrast with the span it sits on, so it cannot be the
  // span's own hue: on an accent band the landing's lime tick is invisible.
  const tickColor = tone === "accent" ? colors.ink : colors.accent;
  const overhang = 3;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={fill(copy.app.band.strip, {
        p10: f.compact(band.p10),
        p50: f.compact(band.p50),
        p90: f.compact(band.p90),
      })}
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: colors.surfaceSunken,
        // No `overflow: hidden` — the median tick overhangs by design.
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          left: `${left * 100}%`,
          // A zero-width span would vanish; a hairline still reads as "here".
          width: `${Math.max(1.5, (right - left) * 100)}%`,
          top: 0,
          bottom: 0,
          borderRadius: height / 2,
          backgroundColor: spanFill,
          borderWidth: 1,
          borderColor: fillColor,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: `${mid * 100}%`,
          top: -overhang,
          height: height + overhang * 2,
          width: 3,
          marginLeft: -1.5,
          borderRadius: 2,
          backgroundColor: tickColor,
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
  tone = "violet",
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
  const copy = useCopy();
  const f = useFormat();
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
          {f.compact(band.p50)}
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
          {`P10 ${f.compact(band.p10)}`}
        </Text>
        <Text style={{ fontSize: 11, color: colors.inkFaint }}>
          {copy.app.band.medianMarked}
        </Text>
        <Text
          style={{ fontSize: 11, color: colors.inkFaint, fontVariant: ["tabular-nums"] }}
        >
          {`P90 ${f.compact(band.p90)}`}
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
  tone = "violet",
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

/**
 * The same headline, for a figure that is an **expectation** rather than a
 * quantile.
 *
 * The product's counterpart of the landing page's `ExpectationFigure`, and
 * deliberately a sibling of {@link BandFigure} rather than a `band?: Band`
 * option on it. A band and an expectation are not the same claim rendered two
 * ways: `E[Y]` is the one quantity here that survives aggregation, and the
 * space a strip and its two bounds would occupy is spent on the reason there is
 * no strip. That reason is a `BandUnavailableReason` and not a string, so a
 * missing band always reads as a statement about what the forecaster can
 * honestly publish and never as an omission — the same rule `ObservedBadge`
 * follows for a figure that has no forecast at all.
 *
 * The copy is `copy.band.*`, which the landing page also reads. That is reuse
 * and not a leak: the claim "this is an expectation, and it has no band because
 * the ensemble is drawn one subsystem at a time" is a fact about the
 * forecaster, identical on both surfaces, and restating it under a second key
 * would be two sentences that can drift apart while describing one thing.
 */
export function ExpectationFigure({
  label,
  value,
  unit,
  reason,
  size = "lg",
}: {
  label: string;
  value: number;
  unit: string;
  /**
   * Why there is no band. Keyed copy, so the figure cannot fail to say — and
   * mandatory in spirit even though the type admits `null`.
   *
   * `null` is **unrepresentable at the boundary**: `apps/api/src/api/grid.ts`
   * states that the schema makes a null `band` without a stated
   * `band_unavailable_reason` impossible, and the generated types simply carry
   * the two fields independently because JSON Schema's pairing constraint has
   * no TypeScript form. It is drawn as *nothing* rather than as a default
   * reason — inventing "no joint ensemble" for a payload that did not say so
   * would put a claim about the forecaster on screen that no artifact made,
   * which is the one failure this component exists to prevent.
   */
  reason: BandUnavailableReason | null;
  size?: "lg" | "md";
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const figureSize = size === "lg" ? 40 : 28;
  return (
    <View style={{ gap: space.sm }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
          {label}
        </Text>
        <Badge label={copy.band.expectedLabel} tone="info" />
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text
          selectable={true}
          accessibilityLabel={fill(copy.band.figureExpected, {
            label,
            value: f.number(value),
            unit,
          })}
          style={{
            fontSize: figureSize,
            lineHeight: figureSize + 4,
            fontWeight: "600",
            letterSpacing: -0.8,
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
      {reason === null ? null : (
        <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
          {copy.band.noBand[reason]}
        </Text>
      )}
    </View>
  );
}
