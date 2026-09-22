/**
 * Driver attribution — the Explain screen's "why?".
 *
 * A near-direct port of `RatingDistribution` from
 * the template `breakdown.tsx` restored under `reference/`: ranked horizontal bars on
 * a shared scale, a label column on the left, a tabular percentage on the
 * right, and the comparison tick inside the track. The README's claim that it
 * is "almost exactly" this screen held up — the row geometry survived
 * unchanged.
 *
 * Three changes, all forced by the domain rather than by taste:
 *
 *  - The reference's five rows are a fixed set (5→1 stars). Drivers are
 *    ranked and variable-length, so the scale comes from the largest share
 *    rather than from 100%.
 *  - The reference's comparison tick is a second distribution. Here the
 *    interesting comparison is **observed vs typical for the group's headline
 *    feature** ("1,42 against a typical 0,96"), which is a text pair, not a
 *    position — so the tick becomes a value pair under the bar. A SHAP share
 *    has no "store-wide average" to tick against, and inventing one would be a
 *    chart that means nothing.
 *  - The pair is **named for the feature it came from**. A group is eight to
 *    thirty features and has no single reading; printing two numbers under a
 *    group's name with nothing to attribute them to says the group read 1,42,
 *    which no group ever does.
 *
 * The component is handed all eight groups and applies the display rule
 * itself, because the rule's two halves have different owners: the selection
 * predicate is shared with the server (`@wattsteer/core/driver-display`) and
 * the merge into `other` is the client's alone (`lib/driver-rows.ts`).
 */

import {
  ArrowUpDownIcon,
  space,
  TrendingDownIcon,
  TrendingUpIcon,
  usePalette,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { type Copy, type Formatters, useCopy, useFormat } from "@/i18n";
import { driverLabel, formatContribution, formatReading } from "@/i18n/drivers";
import { fill } from "@/i18n/format";
import { type DriverRow, driverRows, HOUR_DISAGREEMENT_NOTABLE } from "@/lib/driver-rows";
import type { AttributedDriver } from "@/lib/fixtures";

export function DriverBars({
  drivers,
  notes = true,
}: {
  drivers: readonly AttributedDriver[];
  /**
   * Whether the two footnotes are drawn under the bars. `false` where the
   * screen carries them itself — the Time Machine dashboard puts them behind
   * its ⓘ — never where nothing else would say them.
   */
  notes?: boolean;
}) {
  const rows = driverRows(drivers);
  const max = Math.max(...rows.map((row) => row.share), 0.01);

  return (
    <View style={{ gap: space.lg }}>
      {rows.map((row) => (
        <DriverBar key={row.code} row={row} max={max} />
      ))}
      {notes ? <DriverNotes /> : null}
    </View>
  );
}

/** Violet raises the risk, accent lowers it, faint declines to say. Shared with the landing. */
export function driverBarColor(
  direction: DriverRow["direction"],
  colors: ReturnType<typeof usePalette>,
): string {
  if (direction === "mixed") {
    return colors.inkFaint;
  }
  return direction === "raises" ? colors.violet : colors.accent;
}

function DriverBar({ row, max }: { row: DriverRow; max: number }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const label = driverLabel(row.code, copy);
  const observed = formatReading(row.observed, copy, f);
  const typical = formatReading(row.typical, copy, f);
  const barColor = driverBarColor(row.direction, colors);
  const disagrees =
    row.hourDisagreement !== null && row.hourDisagreement >= HOUR_DISAGREEMENT_NOTABLE;

  return (
    <View style={{ gap: 6 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}
        >
          <DirectionIcon direction={row.direction} color={barColor} />
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.ink }}>
            {label}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          {/* The signed contribution itself, beside the share it is a share
              of. A share alone says how a group ranks; it never says whether
              the day moved by four MWh or four hundred. */}
          <Text
            style={{
              fontSize: 12,
              fontVariant: ["tabular-nums"],
              color: colors.inkFaint,
            }}
          >
            {fill(copy.app.drivers.contribution, {
              phi: formatContribution(row.phiMwh, f),
            })}
          </Text>
          <Text
            style={{
              fontSize: 14,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {f.percent(row.share)}
          </Text>
        </View>
      </View>

      <View
        accessibilityRole="image"
        accessibilityLabel={figureLabel(row, label, copy, f)}
        style={{
          height: 10,
          borderRadius: 5,
          backgroundColor: colors.surfaceSunken,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${(row.share / max) * 100}%`,
            height: "100%",
            borderRadius: 5,
            backgroundColor: barColor,
          }}
        />
      </View>

      {observed === null || typical === null || row.headlineFeature === null ? null : (
        <Text style={{ fontSize: 11, color: colors.inkFaint }}>
          {fill(copy.app.drivers.reading, {
            feature: row.headlineFeature,
            observed,
            typical,
          })}
        </Text>
      )}

      {row.code === "other" ? (
        <Text style={{ fontSize: 11, color: colors.inkFaint }}>
          {fill(copy.app.drivers.mergedNote, { count: f.number(row.memberCount) })}
        </Text>
      ) : null}

      {disagrees && row.hourDisagreement !== null ? (
        <Text style={{ fontSize: 11, color: colors.inkFaint }}>
          {fill(copy.app.drivers.hourDisagreement, {
            value: f.number(row.hourDisagreement, 1),
          })}
        </Text>
      ) : null}

      {row.demoted ? (
        <Text style={{ fontSize: 11, color: colors.inkFaint }}>
          {copy.app.drivers.demoted}
        </Text>
      ) : null}
    </View>
  );
}

function DirectionIcon({ direction, color }: { direction: string; color: string }) {
  if (direction === "mixed") {
    return <ArrowUpDownIcon size={14} color={color} />;
  }
  return direction === "raises" ? (
    <TrendingUpIcon size={14} color={color} />
  ) : (
    <TrendingDownIcon size={14} color={color} />
  );
}

/**
 * The bar, for a screen reader.
 *
 * `"mixed"` gets its own sentence rather than being slotted into "{direction}
 * risk": a merged row that cancelled did not raise anything and did not lower
 * anything, and "mixed risk" would be a claim neither half of it supports.
 */
function figureLabel(row: DriverRow, label: string, copy: Copy, f: Formatters): string {
  if (row.direction === "mixed") {
    return fill(copy.app.drivers.figureMixed, {
      driver: label,
      share: f.percent(row.share),
    });
  }
  return fill(copy.app.drivers.figure, {
    driver: label,
    share: f.percent(row.share),
    direction: copy.app.drivers.direction[row.direction],
  });
}

/**
 * The two footnotes under the chart.
 *
 * The first says what the shares are shares *of* — the attributed movement,
 * not the curtailment, and not "the attributed magnitude", which is what it
 * said before `docs/specs/api-surface.md` corrected it.
 *
 * The second is the sentence the screen was missing: the bars explain the
 * **expected MWh** and nothing else on the screen. The risk chip beside them
 * is a day-level occurrence probability read from the path ensemble, which is
 * not a per-hour model output and has no Shapley decomposition at all; the
 * band's P10 and P90 are not decomposed either. Adjacent panels, related
 * quantities, different questions — and the screen says so once.
 */
function DriverNotes() {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
        {copy.app.drivers.note}
      </Text>
      <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
        {copy.app.drivers.scopeNote}
      </Text>
    </View>
  );
}
