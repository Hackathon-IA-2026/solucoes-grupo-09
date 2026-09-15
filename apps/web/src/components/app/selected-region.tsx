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
 * **It carries the refusal too.** With no artifact promoted the four forecast
 * panels are absent, and a reader who picks a region then has nothing at all to
 * confirm the pick. `row` is nullable for that: the strip still names the
 * region and still offers Explain, and says why there are no numbers instead of
 * showing none.
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
import { RiskChip } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { type SubsystemCode, subsystemMeta } from "@/lib/fixtures";
import type { OutlookRow } from "@/lib/network";

export function SelectedRegion({
  subsystem,
  row,
  onExplain,
}: {
  subsystem: SubsystemCode;
  /** The selected subsystem's forecast row, or `null` when none was published. */
  row: OutlookRow | null;
  onExplain: () => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(subsystem);

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
            {row === null ? null : <RiskChip probability={row.occurrenceProbability} />}
          </View>
        </View>

        {/*
          Explain is now a control with a name on it, rather than a meaning the
          click had to be guessed to carry. `docs/plans/voice-copilot.md` §3.1
          draws exactly this line for the agent — `highlight` never navigates,
          `explain` does — so after this the mouse and the voice agree on what
          selecting a region means, which they did not before.
        */}
        <PillButton
          testID="selected-region-explain"
          label={fill(copy.app.overview.rowExplainLabel, {
            subsystem: meta.onsDisplayName,
          })}
          onPress={onExplain}
          primary={true}
          icon={<ArrowRightIcon size={16} color={colors.onAccent} />}
        />
      </View>

      {row === null ? (
        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkMuted }}>
          {copy.app.overview.selectedAbsent}
        </Text>
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
