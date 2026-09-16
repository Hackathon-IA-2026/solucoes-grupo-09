/**
 * The labelling that has to travel with every number on these screens.
 *
 * Honesty about data vintage is a product value here, not a nicety, and the
 * domain model makes `VintageFidelity` product-visible by decision. These are
 * the components that discharge that obligation, kept together so it is easy
 * to check that a screen used them.
 */

import { producerLabel } from "@wattsteer/core";
import { Badge, ClockIcon, radius, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type { ForecastOrigin, ReplayIntegrity, VintageFidelity } from "@/lib/fixtures";

/**
 * Every surface that shows a forecast must name its `ForecastOrigin`. This is
 * that surface, and it also carries the threshold, because every episode and
 * KPI figure on the screen is a function of it.
 *
 * It names **two** artifacts. The producer of a curtailment forecast is
 * WattSteer and `runLabel` is its artifact version; the weather run the
 * forecast consumed is a different fact about a different artifact, so
 * `docs/specs/api-surface.md` puts `weather_run_label` beside the origin
 * rather than making a screen choose which of the two to call "the run". An
 * origin that is not a WattSteer forecast has no weather run to name, so the
 * clause is omitted rather than left dangling.
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
        // The row shrinks as well as its `Text`. Shrinking only the child is
        // not enough: this box sizes to content first, so the child is never
        // asked to give anything up.
        flexShrink: 1,
      }}
    >
      <ClockIcon size={13} color={colors.inkFaint} />
      {/*
        `flexShrink: 1`, because react-native-web defaults it to **0** where CSS
        defaults it to 1. Without it this line sizes to its content and never
        wraps: measured at 400px, the forecast stamp ran to 609px inside a 360px
        column and the remainder was clipped — and the remainder is the weather
        run, which is half of what the stamp exists to name.
      */}
      <Text style={{ fontSize: 11, color: colors.inkFaint, flexShrink: 1 }}>
        {fill(copy.app.stamp.published, {
          producer: producerLabel[origin.producer],
          run: origin.runLabel,
          // Brasília time, whatever clock the reader is on: a grid hour is a
          // Brazilian hour, and the `BRT` in the string says which one.
          when: f.dateTime(origin.publishedAt),
        })}
        {origin.weatherRunLabel === undefined
          ? ""
          : fill(copy.app.stamp.weatherRun, { run: origin.weatherRunLabel })}
        {thresholdMw === undefined
          ? ""
          : fill(copy.app.stamp.threshold, { mw: f.number(thresholdMw) })}
      </Text>
    </View>
  );
}

/**
 * `integrity.provenance` — how a replayed day was held out of the model that
 * forecast it.
 *
 * Deliberately **not** a warning tone, and deliberately a sibling of
 * `VintageBadge` rather than merged into it. `docs/specs/replay.md` refuses to
 * replay a day no artifact held out, so there is no in-sample case left to
 * warn about; and the two axes are the model's information set and the data's,
 * neither derived from the other. They coincide today, which is precisely the
 * argument for keeping them apart: `fold_holdout` + `point_in_time` becomes
 * populated the moment F6 freezes, and a merged badge would then be wrong with
 * no edit having been made.
 */
export function ProvenanceBadge({
  provenance,
}: {
  provenance: ReplayIntegrity["provenance"];
}) {
  const copy = useCopy();
  return (
    <Badge
      label={copy.app.replay.provenance[provenance]}
      tone={provenance === "served" ? "accent" : "info"}
    />
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

/**
 * What a solved plan was optimised against: the resolved forecast origin and
 * the threshold in force.
 *
 * A sibling of {@link ForecastStamp} rather than a use of it, because an
 * `OptimizationResult` names its origin as the **instant the run published**
 * and not as a whole `ForecastOrigin` — the producer and the run label belong
 * to the forecast route, and inventing them here would be this screen forming
 * an opinion about a run it never read.
 *
 * It replaces the prototype's heuristic caveat, which said the numbers came
 * from a greedy pass in the browser. They come from the MILP now, and the
 * honest label is the one that says which forecast it was pointed at.
 */
export function SolveStamp({
  forecastOrigin,
  thresholdMw,
}: {
  forecastOrigin: string;
  thresholdMw: number;
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
        // The row shrinks as well as its `Text`. Shrinking only the child is
        // not enough: this box sizes to content first, so the child is never
        // asked to give anything up.
        flexShrink: 1,
      }}
    >
      <ClockIcon size={13} color={colors.inkFaint} />
      {/*
        `flexShrink: 1`, because react-native-web defaults it to **0** where CSS
        defaults it to 1. Without it this line sizes to its content and never
        wraps: measured at 400px, the forecast stamp ran to 609px inside a 360px
        column and the remainder was clipped — and the remainder is the weather
        run, which is half of what the stamp exists to name.
      */}
      <Text style={{ fontSize: 11, color: colors.inkFaint, flexShrink: 1 }}>
        {fill(copy.app.stamp.optimisedAgainst, { when: f.dateTime(forecastOrigin) })}
        {fill(copy.app.stamp.threshold, { mw: f.number(thresholdMw) })}
      </Text>
    </View>
  );
}

/**
 * The mark that says a figure is **settled**, not forecast.
 *
 * The counterpart of {@link ForecastStamp} and, deliberately, the same kind of
 * obligation: every surface showing a forecast must name its origin, and — now
 * that the Overview draws a full set of observed panels in the place the
 * forecast ones occupy when a model is promoted — every surface showing an
 * observation must say that it is one. The two are never both on one panel.
 *
 * `info` tone, which is the cyan the observed map's ramp is drawn in and which
 * nothing else on these screens uses. The badge and the map are then one
 * statement rather than two: cyan means measured.
 */
export function ObservedBadge() {
  const copy = useCopy();
  return <Badge label={copy.app.observed.badge} tone="info" />;
}

/**
 * The screen-level counterpart of {@link ForecastStamp}: what the observed
 * panels are reading, and how far behind it is.
 *
 * It occupies the same slot in the screen header the forecast stamp does, so
 * the first thing a reader meets is a line naming which of the two claims the
 * screen is making — before any number is reached. Same instant, same BRT
 * clock, same typography; the difference is the claim, which is the only
 * difference there should be.
 */
export function ObservedStamp({
  latestSettledHour,
  lagHours,
}: {
  latestSettledHour: string;
  lagHours: number;
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
        // The row shrinks as well as its `Text`. Shrinking only the child is
        // not enough: this box sizes to content first, so the child is never
        // asked to give anything up.
        flexShrink: 1,
      }}
    >
      <ClockIcon size={13} color={colors.inkFaint} />
      {/*
        `flexShrink: 1`, because react-native-web defaults it to **0** where CSS
        defaults it to 1. Without it this line sizes to its content and never
        wraps: measured at 400px, the forecast stamp ran to 609px inside a 360px
        column and the remainder was clipped — and the remainder is the weather
        run, which is half of what the stamp exists to name.
      */}
      <Text style={{ fontSize: 11, color: colors.inkFaint, flexShrink: 1 }}>
        {fill(copy.app.observed.stamp, {
          when: f.dateTime(latestSettledHour),
          lag: f.number(lagHours),
        })}
      </Text>
    </View>
  );
}
