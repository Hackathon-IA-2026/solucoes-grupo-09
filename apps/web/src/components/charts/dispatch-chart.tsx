/**
 * Dispatch and state of charge — the other genuinely new chart.
 *
 * The map's "chart component inventory" fog patch names an SOC profile and a
 * dispatch stack as likely gaps, and they are: nothing in `reference/` plots a
 * quantity against a second y-axis, and nothing plots a signed quantity around
 * a zero line. Both are needed here, because a battery that charges and one
 * that discharges are the same asset doing opposite things and a chart that
 * cannot show the sign cannot show a mistake.
 *
 * Read: grey bars are the curtailment offered in that hour; the stack inside
 * them is the **scheduled dispatch, per asset** — lime for the battery's
 * charge, amber for the load's up-shift — and the violet line is the battery's
 * state of charge on its own axis. Below the zero line, the same two assets
 * giving energy back: the battery discharging, and the load taking its shifted
 * consumption. The interesting failure this makes visible — the one the
 * research warns the LP relaxation produces — is charging and discharging in
 * the same hour, which shows as a bar with both signs.
 *
 * **Per asset rather than one aggregate bar**, because "the assets absorbed
 * 640 MWh" and "the battery absorbed 300 of it while the load moved 340" are
 * different statements and only the second one is actionable. The aggregate is
 * still readable off the stack: absorbed energy is the net increase in
 * flexible demand, capped by what was offered, so it is the lime plus the
 * amber less whatever sits below the line.
 */

import { useContainerWidth, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import Svg, { G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { useCopy, useFormat } from "@/i18n";
import type { HourlyDispatch } from "@/lib/fixtures";

const W = 640;
const H = 220;
const PAD = { top: 16, right: 40, bottom: 28, left: 44 };
const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

export function DispatchChart({
  dispatch,
  energyCapacityMwh,
}: {
  dispatch: HourlyDispatch[];
  energyCapacityMwh: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const [containerWidth, onLayout] = useContainerWidth();

  if (dispatch.length === 0) {
    return null;
  }

  // The domain has to hold the stack, not only the tallest single quantity:
  // a battery charging at 100 MW under a load shifting 50 would otherwise be
  // drawn out of the top of the chart.
  const max = Math.max(
    ...dispatch.map((d) =>
      Math.max(d.offeredMwh, d.absorbedMwh, d.batteryChargeMw + d.loadShiftUpMw),
    ),
    1,
  );
  const socMax = Math.max(energyCapacityMwh, 1);
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const slot = chartW / dispatch.length;
  const barW = Math.min(18, slot * 0.62);
  const scale = containerWidth > 0 ? containerWidth / W : 0;

  const x = (i: number) => PAD.left + i * slot + slot / 2;
  const y = (v: number) => PAD.top + chartH - (v / max) * chartH;
  const socY = (v: number) => PAD.top + chartH - (v / socMax) * chartH;

  const socPath = `M${dispatch
    .map((d, i) => `${x(i).toFixed(1)},${socY(d.stateOfChargeMwh).toFixed(1)}`)
    .join(" L")}`;

  return (
    <View onLayout={onLayout}>
      <Svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={scale > 0 ? scale * H : H}
        accessibilityLabel={copy.app.dispatch.figure}
      >
        {[1, 0.5, 0].map((g) => (
          <G key={g}>
            <Line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(max * g)}
              y2={y(max * g)}
              stroke={colors.border}
              strokeDasharray="2 6"
            />
            <SvgText
              x={PAD.left - 8}
              y={y(max * g) + 3}
              textAnchor="end"
              fontSize={9}
              fontFamily={FONT}
              fill={colors.inkMuted}
            >
              {f.number(max * g)}
            </SvgText>
            <SvgText
              x={W - PAD.right + 6}
              y={socY(socMax * g) + 3}
              textAnchor="start"
              fontSize={9}
              fontFamily={FONT}
              fill={colors.violet}
            >
              {f.number(socMax * g)}
            </SvgText>
          </G>
        ))}

        {dispatch.map((d, i) => {
          const bx = x(i) - barW / 2;
          const offeredH = Math.max(0, (d.offeredMwh / max) * chartH);
          const chargeH = Math.max(0, (d.batteryChargeMw / max) * chartH);
          const shiftUpH = Math.max(0, (d.loadShiftUpMw / max) * chartH);
          // Below the line, at a third of the scale: giving energy back is a
          // real quantity but it is not the subject of the chart, and drawing
          // it at full height would make an hour with no curtailment look like
          // the busiest one.
          const belowScale = 0.35;
          const dischargeH = (d.batteryDischargeMw / max) * chartH * belowScale;
          const shiftDownH = (d.loadShiftDownMw / max) * chartH * belowScale;
          return (
            <G key={d.hourLocal}>
              {offeredH > 0 ? (
                <Rect
                  x={bx}
                  y={PAD.top + chartH - offeredH}
                  width={barW}
                  height={offeredH}
                  rx={3}
                  fill={colors.inkFaint}
                  fillOpacity={0.28}
                />
              ) : null}
              {chargeH > 0 ? (
                <Rect
                  x={bx}
                  y={PAD.top + chartH - chargeH}
                  width={barW}
                  height={chargeH}
                  rx={3}
                  fill={colors.accent}
                />
              ) : null}
              {shiftUpH > 0 ? (
                <Rect
                  x={bx}
                  y={PAD.top + chartH - chargeH - shiftUpH}
                  width={barW}
                  height={shiftUpH}
                  rx={3}
                  fill={colors.warning}
                />
              ) : null}
              {d.batteryDischargeMw > 0 ? (
                <Rect
                  x={bx}
                  y={PAD.top + chartH}
                  width={barW}
                  height={Math.max(2, dischargeH)}
                  rx={2}
                  fill={colors.violet}
                  fillOpacity={0.55}
                />
              ) : null}
              {d.loadShiftDownMw > 0 ? (
                <Rect
                  x={bx}
                  y={PAD.top + chartH + Math.max(2, dischargeH)}
                  width={barW}
                  height={Math.max(2, shiftDownH)}
                  rx={2}
                  fill={colors.warning}
                  fillOpacity={0.45}
                />
              ) : null}
              {d.hourLocal % 3 === 0 ? (
                <SvgText
                  x={x(i)}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={9}
                  fontFamily={FONT}
                  fill={colors.inkMuted}
                >
                  {String(d.hourLocal).padStart(2, "0")}
                </SvgText>
              ) : null}
            </G>
          );
        })}

        <Line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + chartH}
          y2={PAD.top + chartH}
          stroke={colors.borderStrong}
        />
        <Path d={socPath} stroke={colors.violet} strokeWidth={2} fill="none" />
      </Svg>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 14,
          marginTop: 8,
        }}
      >
        <Key color={colors.inkFaint} label={copy.app.dispatch.offered} faded={true} />
        <Key color={colors.accent} label={copy.app.dispatch.batteryCharge} />
        <Key color={colors.warning} label={copy.app.dispatch.loadShiftUp} />
        <Key color={colors.violet} label={copy.app.dispatch.soc} />
        <Key color={colors.violet} label={copy.app.dispatch.discharge} faded={true} />
        <Key
          color={colors.warning}
          label={copy.app.dispatch.loadShiftDown}
          faded={true}
        />
      </View>
    </View>
  );
}

function Key({
  color,
  label,
  faded = false,
}: {
  color: string;
  label: string;
  faded?: boolean;
}) {
  const colors = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 12,
          height: 8,
          borderRadius: 2,
          backgroundColor: color,
          opacity: faded ? 0.4 : 1,
        }}
      />
      <Text style={{ fontSize: 11, color: colors.inkMuted }}>{label}</Text>
    </View>
  );
}
