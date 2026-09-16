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
import { ObservedBadge } from "@/components/app/honesty";
import { BandStrip } from "@/components/charts/band-figure";
import { observedFill } from "@/components/charts/observed-scale";
import { RiskChip } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { splitFor, subsystemMeta, type Technology } from "@/lib/fixtures";
import type { ObservedRow, OutlookRow } from "@/lib/network";

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

  /*
    **The selected row is not a button, and the unselected rows are.**

    Every row was a `<button>`, and the selected one also contains one — the
    named Explain control, which is rendered only there. A button inside a
    button is invalid HTML and a WCAG 4.1.2 failure; axe rates
    `nested-interactive` *serious* and it fired on exactly one row at a time,
    which is why it survived: whichever row you happened to look at was
    usually fine.

    The fix costs nothing because the outer press on that row does nothing.
    `onPress` is `onSelect(subsystem)` and the row is already the selection, so
    activating it writes the value it already holds. A control whose only
    behaviour is a no-op has no claim on a tab stop, and taking it away leaves
    the selected row with exactly one focusable thing in it — Explain, which is
    the only action that row still has to offer.

    Pointer behaviour is untouched: the `Pressable` still handles the click and
    still draws hover, so a mouse user sees and gets what they always did.
    `focusable={false}` is what keeps `react-native-web` from giving a
    role-less pressable a `tabIndex` of its own; without it the element stays in
    the tab order as an unlabelled stop, which is a worse outcome than the
    violation it replaces.
  */
  const nestsExplainButton = selected;
  return (
    <Pressable
      accessibilityRole={nestsExplainButton ? undefined : "button"}
      focusable={!nestsExplainButton}
      accessibilityLabel={
        nestsExplainButton
          ? undefined
          : fill(copy.app.overview.rowFigure, { subsystem: meta.onsDisplayName })
      }
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

/**
 * One subsystem's **settled** figures, beside the observed map.
 *
 * The sibling of {@link SubsystemRow}, and the reason it is a sibling rather
 * than a mode of it: every line in that row is a forecast — a risk chip, an
 * expectation, a P10–P90 strip, a peak band — and this row has none of those
 * quantities to put in those places. A single component with four nullable
 * fields would render this row as that row with holes in it, which is the exact
 * shape of the mistake the whole split exists to prevent. Two components cannot
 * be wired to the wrong data: `ObservedRow` has no `dailyEnergy` to pass.
 *
 * What it keeps from its sibling is everything that is about *selecting* rather
 * than about forecasting: the accent border on the selected row, the
 * `Selecionado` badge, the hover that the map lights from the other end, and
 * the named Explain control on the selected row only. The affordance is the
 * screen's, not the forecast's, and losing it when no model is promoted is how
 * this screen came to have less to click on in the state it is actually in.
 *
 * **The bar is a share, not a band.** One track, filled to this region's share
 * of the largest of the four, in the observed cyan and at the same value the
 * map paints that region with — so the row and the region read as one figure
 * seen twice. It is deliberately a *solid* bar: `BandStrip` draws an interval
 * with a median marked inside it, and there is no interval here.
 */
export function ObservedSubsystemRow({
  observed,
  domainMax,
  selected,
  highlighted = false,
  onPress,
  onExplain,
  onHoverChange,
}: {
  observed: ObservedRow;
  /** The largest of the four, so the bars share one scale. */
  domainMax: number;
  selected: boolean;
  highlighted?: boolean;
  onPress: () => void;
  /**
   * Open Explain for this subsystem. Optional, and absent in the state where a
   * forecast row is already on the screen carrying one: two Explain controls
   * for the same region, in two lists, would be one too many.
   */
  onExplain?: () => void;
  onHoverChange?: (hovered: boolean) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(observed.subsystem);
  const share = domainMax <= 0 ? 0 : Math.min(1, observed.last24hMwh / domainMax);

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
          gap: space.sm,
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
            {observed.onsDisplayName}
          </Text>
          <Text style={{ fontSize: 11, color: colors.inkFaint }}>
            {fill(copy.app.overview.settledSplit, {
              wind: f.compact(observed.split.windMwh),
              solar: f.compact(observed.split.solarMwh),
            })}
          </Text>
          {selected ? (
            <View style={{ marginTop: 6, alignSelf: "flex-start" }}>
              <Badge label={copy.app.overview.selectedBadge} tone="accent" />
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <ObservedBadge />
          {selected && onExplain !== undefined ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={fill(copy.app.overview.rowExplainLabel, {
                subsystem: meta.onsDisplayName,
              })}
              onPress={(event) => {
                // The row underneath handles a press too — without this, one tap
                // both navigates and re-selects on the way out.
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
            {copy.app.observed.rowEnergy}
          </Text>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {`${f.compact(observed.last24hMwh)} MWh`}
          </Text>
        </View>
        <View
          style={{
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.surfaceSunken,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              height: "100%",
              // `Math.max` so a region that settled small is still a visible
              // sliver rather than nothing at all: an empty track would read as
              // "no data", and this is data saying "almost none".
              width: `${Math.max(share * 100, share > 0 ? 1.5 : 0)}%`,
              borderRadius: 4,
              backgroundColor: observedFill(share, colors),
            }}
          />
        </View>
      </View>
    </Pressable>
  );
}
