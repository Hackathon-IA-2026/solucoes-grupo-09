/**
 * What each region is painted, and the scale that explains it.
 *
 * Two things the map needed and neither of which is drawing. `useRegionPaint`
 * turns the four rows into a fill, an announced label and a glyph per region —
 * eighty lines of branch that sat in the middle of `SubsystemMap` between its
 * hooks and its SVG — and `MapLegend` is the ramp's key, which exists only on
 * the observed half.
 *
 * A hook rather than a plain function because it reads the palette, the copy
 * and the formatter, all of which are hooks; making it a function would mean
 * passing three context values through a signature to save a `use` prefix.
 *
 * **The forecast and observed branches stay separate all the way down**, which
 * is the reason this is one hook and not two merged with a flag: they produce
 * different *kinds* of statement. One is a binned class with a probability, the
 * other is a measured quantity with the window it was measured over, and a
 * screen reader has to be able to tell them apart as surely as an eye can.
 */

import { space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { G, Rect, Text as SvgText } from "react-native-svg";
import { clamp01, LEGEND_STOPS, observedFill } from "@/components/charts/observed-scale";
import { riskColor } from "@/components/charts/risk-color";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  type RiskClass,
  roundProbability,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import { SUBSYSTEM_LABEL_ANCHOR } from "@/lib/geo/brazil-subsystems";
import type { MapPaint, RegionPaint } from "./subsystem-map";

/** The typeface the SVG labels are set in — the map's own, shared with it. */
const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

/**
 * Move the browser's focus to another region's path.
 *
 * Arrow keys change the selection, and a selection the keyboard has moved to
 * without taking focus with it leaves the focus ring on the region the reader
 * has left — so the visible marker and the live selection would disagree, which
 * is precisely the confusion this screen is being fixed for.
 *
 * Scoped to the map's own container rather than found by document id: the
 * landing page has already been bitten once by a document-wide
 * `getElementById` resolving to a stale duplicate of a screen that was still
 * mounted (`e2e/landing-scroll.spec.ts` documents it), and a second Overview in
 * the stack would give this the same two candidates.
 *
 * Called from an effect and never from the key handler — see `keyboardTarget`
 * below for why.
 */

/** The three-step glyph from the risk chip, in SVG. Never colour alone. */
function Steps({
  klass,
  x,
  y,
  color,
  dim,
}: {
  klass: RiskClass;
  x: number;
  y: number;
  color: string;
  dim: string;
}) {
  const level = { low: 1, elevated: 2, high: 3 }[klass];
  const unit = 9;
  return (
    <G>
      {[1, 2, 3].map((step) => (
        <Rect
          key={step}
          x={x - 17 + (step - 1) * 12}
          y={y - unit * step}
          width={7}
          height={unit * step}
          rx={2}
          fill={step <= level ? color : dim}
        />
      ))}
    </G>
  );
}

export function useRegionPaint(paint: MapPaint): {
  /** The largest settled figure, and the top of the observed ramp. `0` on the
   * forecast half, where there is no ramp. */
  observedMax: number;
  painted: Map<SubsystemCode, RegionPaint>;
} {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();

  /**
   * The largest settled figure on the map, which the ramp is relative to.
   *
   * Relative rather than absolute because there is no absolute ceiling for a
   * settled day — a quiet fortnight and a record one would both wash out
   * against a fixed maximum. The legend under the map states the top of the
   * scale in megawatt-hours, so "darkest" is never read as "large" on its own.
   */
  const observedMax =
    paint.kind === "observed" ? Math.max(...paint.rows.map((row) => row.dayMwh), 0) : 0;

  const painted = new Map<SubsystemCode, RegionPaint>(
    paint.kind === "forecast"
      ? paint.rows.map((row) => {
          // The wire's class, never recomputed. `GET /v1/grid/outlook` carries
          // both `risk_class` and the `risk_bins` it was cut with; deriving it
          // again here from a local copy of the cut points would be a second
          // opinion about the same number, and the two copies are kept in step
          // by nothing.
          const klass = row.riskClass;
          const tone = riskColor(colors, klass);
          const anchor = SUBSYSTEM_LABEL_ANCHOR[row.subsystem];
          return [
            row.subsystem,
            {
              fill: tone.fg,
              label: fill(copy.app.overview.map.region, {
                subsystem: subsystemMeta(row.subsystem).onsDisplayName,
                risk: copy.app.risk[klass],
                probability: f.percentPoints(roundProbability(row.occurrenceProbability)),
              }),
              glyph: (
                <Steps
                  klass={klass}
                  x={anchor.x}
                  y={anchor.y + 34}
                  color={tone.fg}
                  dim={colors.borderStrong}
                />
              ),
            },
          ] as const;
        })
      : paint.rows.map((row) => {
          const anchor = SUBSYSTEM_LABEL_ANCHOR[row.subsystem];
          const share = observedMax === 0 ? 0 : row.dayMwh / observedMax;
          return [
            row.subsystem,
            {
              fill: observedFill(share, colors),
              // Settled energy and the window it settled over — and no risk
              // class, no probability and no mention of a day that has not
              // happened. A screen reader must be able to tell the two maps
              // apart as surely as an eye can.
              label: fill(copy.app.overview.map.regionObserved, {
                subsystem: subsystemMeta(row.subsystem).onsDisplayName,
                mwh: f.compact(row.dayMwh),
              }),
              // The figure itself, where the forecast map draws a binned glyph.
              // A number on a region is the plainest possible statement that
              // this is a measurement rather than a class.
              glyph: (
                <SvgText
                  x={anchor.x}
                  y={anchor.y + 30}
                  textAnchor="middle"
                  fontSize={26}
                  fontWeight="600"
                  fontFamily={FONT}
                  fill={colors.ink}
                >
                  {`${f.compact(row.dayMwh)} MWh`}
                </SvgText>
              ),
            },
          ] as const;
        }),
  );

  return { observedMax, painted };
}

/**
 * The observed ramp's key: "low", the stops, and the number the darkest end is.
 *
 * Only on the observed half, and the top is stated as a figure rather than left
 * implicit — without it "darker" is a comparison with nothing.
 *
 * The screen's own comment, kept as written:
 *
 *
 * The ramp, spelled out — and only in observed mode, which makes the
 * legend itself one more thing the two maps do not share.
 *
 * The forecast map needs none: its three bins are named in words on every
 * row beside it, and a legend for a categorical scale that is already
 * written out four times would be decoration. A continuous scale has no
 * such anchor, so the top of it is stated as a number — without which
 * "darker" is a comparison with nothing.
 *
 */
export function MapLegend({
  paint,
  observedMax,
}: {
  paint: MapPaint;
  observedMax: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  // Absent on the forecast half rather than empty: there is no continuous
  // scale there to key.
  if (paint.kind !== "observed") {
    return null;
  }
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        marginTop: space.sm,
      }}
    >
      <Text style={{ fontSize: 10, color: colors.inkFaint }}>
        {copy.app.overview.map.legendLow}
      </Text>
      <View style={{ flexDirection: "row", gap: 2 }}>
        {LEGEND_STOPS.map((stop) => (
          <View
            key={stop}
            style={{
              width: 22,
              height: 8,
              borderRadius: 2,
              backgroundColor: observedFill(clamp01(stop), colors),
            }}
          />
        ))}
      </View>
      <Text
        style={{
          fontSize: 10,
          color: colors.inkFaint,
          fontVariant: ["tabular-nums"],
        }}
      >
        {`${f.compact(observedMax)} MWh`}
      </Text>
    </View>
  );
}
