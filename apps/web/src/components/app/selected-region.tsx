/**
 * Which region the screen is about, said once, where the reader is looking.
 *
 * **Why this exists at all.** Clicking the map or a row used to navigate to
 * Explain, so "I picked a region" and "I left the screen" were the same event
 * and there was nothing to confirm. Now a click *selects*, and a selection
 * re-points four panels that sit below the fold on a laptop and far below it on
 * a phone. Without this strip the whole response to a click could happen
 * off-screen: the reader clicks the NE, the viewport does not move, and the
 * screen looks broken.
 *
 * **A summary under the map, not a scroll into the panels.** The alternative
 * was to scroll the panel block into view on every selection. Rejected: this is
 * a comparison screen, and scrolling takes the map — the thing a reader is
 * comparing from — off the screen, so they have to scroll back to make the next
 * comparison. It also makes a keyboard user's arrow key fling the page around,
 * which is the behaviour arrow keys must not have. A strip immediately under
 * the map answers "which one did I pick and what does it say" in place, costs
 * no motion, and leaves the reader's next click exactly where their last one
 * was.
 *
 * **It carries the refusal too, and no longer carries it alone.** With no
 * artifact promoted there is no forecast row for this region — `row` is
 * nullable for exactly that — but there *is* a settled figure, and a strip that
 * said only "no numbers" while the same number sat in a panel below it was
 * telling a reader less than the screen knew. So the two are separate props and
 * the strip states whichever it has:
 *
 *  - `row` present → the forecast: a risk chip, the expectation, the interval.
 *  - `row` null, `observed` present → the settlement: the badge, the figure,
 *    the window it covers, and the sentence saying the forecast is the thing
 *    that is missing.
 *
 * **Never both.** They are claims about two different days and a strip carrying
 * both would be inviting the arithmetic nobody should do. In the state where a
 * forecast exists the settled figures are a panel of their own, further down,
 * under their own heading.
 */

import {
  ArrowRightIcon,
  Badge,
  PillButton,
  radius,
  space,
  usePalette,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { ObservedBadge, useNoModelPromoted } from "@/components/app/honesty";
import { RiskChip } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { type SubsystemCode, subsystemMeta } from "@/lib/fixtures";
import type { ObservedRow, OutlookRow } from "@/lib/network";

export function SelectedRegion({
  subsystem,
  row,
  observed = null,
  observedWindow,
  onExplain,
  onWhatToDo,
}: {
  subsystem: SubsystemCode;
  /** The selected subsystem's forecast row, or `null` when none was published. */
  row: OutlookRow | null;
  /**
   * The selected subsystem's settled row. Read only when `row` is `null` — see
   * this file's header on why the strip never states both.
   */
  observed?: ObservedRow | null;
  /** The window `observed` covers, named. Required whenever `observed` is. */
  observedWindow?: string;
  onExplain: () => void;
  /**
   * Raises Mitigar over the page, the way `onExplain` raises Explicar.
   *
   * Optional, and the button is absent without it: this strip is also rendered
   * where no page owns that sheet's state, and a control that opens nothing is
   * worse than no control.
   */
  onWhatToDo?: () => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(subsystem);
  /* Which cause the absence sentence may name. See `useNoModelPromoted`. */
  const noModelPromoted = useNoModelPromoted();

  return (
    <View
      testID="selected-region"
      // Announced, not only drawn. The selection can change from four places —
      // a region, a row, a chip in the chrome, an arrow key — and a screen
      // reader that is not on the control that changed it would otherwise hear
      // nothing at all about the four panels having been re-pointed. This is
      // the one element that names the new selection, so it is the one that
      // speaks it.
      accessibilityLiveRegion="polite"
      style={{
        // The accent border is the same mark the selected row and the selected
        // region on the map carry. Three surfaces, one vocabulary for "this
        // one" — a fourth treatment here would read as a fourth thing.
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.accent,
        backgroundColor: colors.canvasTint,
        padding: 14,
        gap: space.sm,
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
        <View style={{ flexShrink: 1, gap: 4 }}>
          <Text style={{ fontSize: 11, color: colors.inkFaint }}>
            {copy.app.overview.selectedTitle}
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Badge label={meta.code} tone="accent" />
            <Text
              testID="selected-region-name"
              style={{ fontSize: 16, fontWeight: "700", color: colors.ink }}
            >
              {meta.onsDisplayName}
            </Text>
            {row === null ? (
              observed === null ? null : (
                <ObservedBadge />
              )
            ) : (
              <RiskChip probability={row.occurrenceProbability} />
            )}
          </View>
        </View>

        {/*
          Explain is now a control with a name on it, rather than a meaning the
          click had to be guessed to carry. `docs/plans/voice-copilot.md` §3.1
          draws exactly this line for the agent — `highlight` never navigates,
          `explain` does — so after this the mouse and the voice agree on what
          selecting a region means, which they did not before.
        */}
        {/*
          A column, so the second control sits *under* the first rather than
          beside it: the row above already wraps, and a second pill in it would
          drop to a new line only at the widths where the strip is narrow — so
          the pair would be stacked on a phone and side by side on a laptop,
          which is two layouts to reason about for one decision.

          `alignItems: "stretch"` rather than the pills' own widths, because
          two pills of different label lengths left-aligned under each other
          read as a ragged list; stretched, they are one control group.
        */}
        <View style={{ alignItems: "stretch", gap: space.sm }}>
          <PillButton
            testID="selected-region-explain"
            label={fill(copy.app.overview.rowExplainLabel, {
              subsystem: meta.onsDisplayName,
            })}
            onPress={onExplain}
            primary={true}
            icon={<ArrowRightIcon size={16} color={colors.onAccent} />}
          />
          {onWhatToDo === undefined ? null : (
            <PillButton
              testID="selected-region-mitigate"
              label={copy.app.overview.selectedMitigateLabel}
              onPress={onWhatToDo}
            />
          )}
        </View>
      </View>

      {row === null ? (
        <>
          {observed === null ? null : (
            <>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                  color: colors.ink,
                }}
              >
                {fill(copy.app.observed.selectedFigure, {
                  mwh: f.compact(observed.dayMwh),
                  wind: f.compact(observed.split.windMwh),
                  solar: f.compact(observed.split.solarMwh),
                })}
              </Text>
              <Text
                style={{
                  fontSize: 11,
                  color: colors.info,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {observedWindow}
              </Text>
            </>
          )}
          <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkMuted }}>
            {noModelPromoted
              ? copy.app.overview.selectedAbsent
              : copy.app.overview.selectedUnpublished}
          </Text>
        </>
      ) : (
        <>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {`${copy.app.overview.rowEnergy} ${f.compact(row.dayExpectedMwh)} MWh · ${copy.band.rangeLabel} ${f.compact(row.dailyEnergy.p10)}–${f.compact(row.dailyEnergy.p90)}`}
          </Text>
          <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
            {copy.app.overview.selectedNote}
          </Text>
        </>
      )}
    </View>
  );
}
