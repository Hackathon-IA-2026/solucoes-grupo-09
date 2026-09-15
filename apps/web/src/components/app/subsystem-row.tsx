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

import {
  ArrowRightIcon,
  Badge,
  focusRing,
  radius,
  space,
  usePalette,
} from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { BandStrip } from "@/components/charts/band-figure";
import { RiskChip } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { splitFor, subsystemMeta, type Technology } from "@/lib/fixtures";
import type { OutlookRow } from "@/lib/network";

export function SubsystemRow({
  forecast,
  emphasis,
  domainMax,
  selected,
  highlighted = false,
  onPress,
  onExplain,
  onHoverChange,
}: {
  forecast: OutlookRow;
  /**
   * Which scalar of this row's split to name under the subsystem. The row used
   * to print `forecast.technology`, which existed because the forecast itself
   * was per-technology; it is not, so the selection names one half of the
   * expectation instead of claiming to describe the whole row.
   */
  emphasis: Technology;
  domainMax: number;
  selected: boolean;
  /**
   * Pointed at from the map, rather than by this row's own pointer.
   *
   * Hovering a region has to light the row it belongs to, or the two
   * affordances read as two lists. It is deliberately the *same* treatment the
   * row gives its own hover — one highlight vocabulary, whichever end the
   * pointer is at.
   */
  highlighted?: boolean;
  /**
   * Select this subsystem. **Not** navigate to it.
   *
   * It used to be `router.push("/app/explain")`, so one gesture carried two
   * plausible meanings — "show me this region here" and "go explain this
   * region" — and silently did the second, leaving the four panels on this
   * screen re-pointable only from the top menu.
   */
  onPress: () => void;
  /**
   * Open Explain for this subsystem. Rendered only on the selected row.
   *
   * Only there because it answers "and now what about this one?", a question a
   * reader only has about the row they have already picked. Four Explain
   * buttons would be four navigations competing with the selection the rows
   * exist to make.
   */
  onExplain: () => void;
  onHoverChange?: (hovered: boolean) => void;
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
      onHoverIn={() => onHoverChange?.(true)}
      onHoverOut={() => onHoverChange?.(false)}
      style={(state) => {
        const { focused = false, hovered: selfHovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        const hovered = selfHovered || highlighted;
        return {
          borderRadius: radius.lg,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: selected
            ? colors.accent
            : hovered
              ? colors.borderStrong
              : colors.border,
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
          {/*
            Selection needs a *persistent* mark of its own. The accent border it
            already had is a step away from hover's `borderStrong`, and a reader
            who clicks a region and then moves the pointer has nothing on the
            row that says "this is the one the four panels are about".
          */}
          {selected ? (
            <View style={{ marginTop: 6, alignSelf: "flex-start" }}>
              <Badge label={copy.app.overview.selectedBadge} tone="accent" />
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <RiskChip probability={forecast.occurrenceProbability} />
          {/*
            The arrow used to sit here on every row, unlabelled, promising the
            navigation the whole row performed. It is a named control now, and
            only on the selected row: selecting is the row's own gesture, and an
            affordance that navigates has to say so rather than be inferred from
            a glyph.
          */}
          {selected ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={fill(copy.app.overview.rowExplainLabel, {
                subsystem: meta.onsDisplayName,
              })}
              onPress={(event) => {
                // The row underneath handles a press too. Without this, one tap
                // both navigates and re-selects on the way out — which is the
                // double meaning this whole split exists to remove.
                (
                  event as unknown as { stopPropagation?: () => void }
                ).stopPropagation?.();
                onExplain();
              }}
              hitSlop={8}
              style={(state) => {
                const { focused = false, hovered = false } = state as {
                  focused?: boolean;
                  hovered?: boolean;
                };
                return {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  borderRadius: radius.pill,
                  borderWidth: 1,
                  borderColor: colors.accent,
                  backgroundColor: hovered ? colors.accentSoft : "transparent",
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  ...focusRing(focused, colors.focus),
                  ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                };
              }}
            >
              <Text
                style={{ fontSize: 12, fontWeight: "600", color: colors.onAccentSoft }}
              >
                {copy.app.overview.rowExplain}
              </Text>
              <ArrowRightIcon size={14} color={colors.onAccentSoft} />
            </Pressable>
          ) : null}
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
