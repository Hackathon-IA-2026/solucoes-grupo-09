import { Badge, radius, space, usePalette } from "@wattsteer/ui";
import { StyleSheet, Text, View } from "react-native";
import { useCopy } from "@/i18n";
import {
  type Band,
  type Figure,
  formatMwhExact,
  formatRange,
  railFractions,
  upper,
} from "./band";

/**
 * Uncertainty primitives. **New primitives — promote to `packages/ui` once
 * the app screens want them** (this ticket may not touch `packages/ui`).
 *
 * The reference directories solve the single-figure case very well and the
 * band case not at all: `stat-cards` has one slot for one number,
 * `RiskBar` positions a single marker on a gradient and its own comment
 * concedes "the band belongs somewhere the bar cannot express". Rather than
 * bolt a subtitle onto a card built for one number — which is how a range
 * degrades into decoration — the band gets its own drawing:
 *
 *   `BandRail` — a track on which the P10–P90 interval is a **span with
 *   width**, not a label. Two forecasts with the same median and different
 *   confidence look different at a glance, which is the entire point and the
 *   thing a text suffix ("4,180 MWh (2,640–6,320)") cannot do.
 *
 *   `BandFigure` — the stat card, rebuilt around that rail. The median is
 *   still the big number, because operators read the middle first; the rail
 *   and the range sit under it at equal visual weight to the label.
 *
 * An `observed` figure renders through the same components and is *marked*
 * as observed, so a missing band always reads as a claim ("this was
 * measured") and never as an omission.
 */

const styles = StyleSheet.create({
  rail: { height: 10, borderRadius: 5, justifyContent: "center" },
  span: { position: "absolute", top: 0, bottom: 0, borderRadius: 5 },
  // `left` is a percentage of the track, so the marker is shifted back by
  // half its own width to sit *on* the value rather than beside it.
  tick: {
    position: "absolute",
    top: -3,
    width: 3,
    height: 16,
    borderRadius: 2,
    transform: [{ translateX: -1.5 }],
  },
  point: {
    position: "absolute",
    top: -3,
    width: 3,
    height: 16,
    borderRadius: 2,
    transform: [{ translateX: -1.5 }],
  },
});

/**
 * The P10–P90 interval drawn to scale on a 0..`max` track, with the median
 * as a tick inside it. `max` is shared across a group of rails so their
 * widths are comparable — a rail scaled to its own band would make every
 * forecast look equally certain.
 */
export function BandRail({
  figure,
  max,
  label,
}: {
  figure: Figure;
  max: number;
  /** Read aloud in place of the geometry. */
  label: string;
}) {
  const colors = usePalette();

  if (figure.kind === "observed") {
    const fraction = Math.max(0, Math.min(1, figure.value / (max > 0 ? max : 1)));
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={label}
        style={[styles.rail, { backgroundColor: colors.surfaceSunken }]}
      >
        <View
          style={[
            styles.point,
            { left: `${fraction * 100}%`, backgroundColor: colors.ink },
          ]}
        />
      </View>
    );
  }

  const { start, mid, end } = railFractions(figure.band, max);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[styles.rail, { backgroundColor: colors.surfaceSunken }]}
    >
      <View
        style={[
          styles.span,
          {
            left: `${start * 100}%`,
            // A zero-width span would vanish; a hairline still reads as "here".
            width: `${Math.max(end - start, 0.004) * 100}%`,
            backgroundColor: colors.violetSoft,
            borderWidth: 1,
            borderColor: colors.violet,
          },
        ]}
      />
      <View
        style={[styles.tick, { left: `${mid * 100}%`, backgroundColor: colors.accent }]}
      />
    </View>
  );
}

/** "P10–P90 · 2,640–6,320 MWh", or the observed marker. */
export function BandCaption({ figure, unit }: { figure: Figure; unit: string }) {
  const copy = useCopy();
  const colors = usePalette();
  if (figure.kind === "observed") {
    return (
      <Text style={{ fontSize: 12, color: colors.inkFaint }}>
        {copy.band.observedNote}
      </Text>
    );
  }
  return (
    <Text style={{ fontSize: 12, color: colors.inkMuted, fontVariant: ["tabular-nums"] }}>
      <Text style={{ fontWeight: "700", color: colors.onVioletSoft }}>
        {copy.band.rangeLabel}
      </Text>{" "}
      {formatRange(figure.band)} {unit}
    </Text>
  );
}

/**
 * A headline figure with its uncertainty. `size` picks the display scale;
 * `max` scales the rail against sibling figures.
 */
export function BandFigure({
  label,
  figure,
  unit,
  max,
  size = "lg",
  highlight = false,
}: {
  label: string;
  figure: Figure;
  unit: string;
  /** Rail scale. Defaults to the figure's own upper bound. */
  max?: number;
  size?: "lg" | "md";
  /** Lime card treatment, for the one figure that leads a section. */
  highlight?: boolean;
}) {
  const copy = useCopy();
  const colors = usePalette();
  const value = figure.kind === "band" ? figure.band.p50 : figure.value;
  const railMax = max ?? upper(figure) * 1.1;
  const onCard = highlight ? colors.onAccent : colors.ink;
  const onCardMuted = highlight ? "rgba(30, 43, 16, 0.7)" : colors.inkMuted;

  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 260,
        gap: space.md,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        padding: 20,
        ...(highlight
          ? { backgroundColor: colors.accent }
          : {
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            }),
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <Text style={{ flex: 1, fontSize: 14, fontWeight: "500", color: onCardMuted }}>
          {label}
        </Text>
        {figure.kind === "observed" ? (
          <Badge label={copy.band.observedLabel} tone="neutral" />
        ) : (
          <Badge label={copy.band.medianLabel} tone={highlight ? "neutral" : "violet"} />
        )}
      </View>

      <Text
        selectable={true}
        style={{
          fontSize: size === "lg" ? 44 : 30,
          lineHeight: size === "lg" ? 48 : 34,
          fontWeight: "600",
          letterSpacing: -1,
          fontVariant: ["tabular-nums"],
          color: onCard,
        }}
      >
        {formatMwhExact(value)}{" "}
        <Text style={{ fontSize: size === "lg" ? 18 : 15, fontWeight: "500" }}>
          {unit}
        </Text>
      </Text>

      {/* On the lime card the grape span would fight the fill, so the rail is
          only drawn on surface cards; the range text still carries it. */}
      {highlight ? null : (
        <BandRail figure={figure} max={railMax} label={railLabel(figure, unit, label)} />
      )}
      <BandCaption figure={figure} unit={unit} />
    </View>
  );
}

/** One accessible sentence per rail — screen readers get the numbers, not a bar. */
export function railLabel(figure: Figure, unit: string, label: string): string {
  if (figure.kind === "observed") {
    return `${label}: ${formatMwhExact(figure.value)} ${unit}, observed`;
  }
  const b: Band = figure.band;
  return `${label}: median ${formatMwhExact(b.p50)} ${unit}, 10th to 90th percentile ${formatMwhExact(b.p10)} to ${formatMwhExact(b.p90)} ${unit}`;
}
