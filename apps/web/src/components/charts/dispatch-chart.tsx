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
 * Read: grey bars are the curtailment offered in that hour, the lime portion
 * is what the assets absorbed, and the violet line is the battery's state of
 * charge on its own axis. The interesting failure this makes visible — the one
 * the research warns the LP relaxation produces — is charging and discharging
 * in the same hour, which would show as a bar with both signs.
 */

import { useContainerWidth, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import Svg, { G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
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
  const [containerWidth, onLayout] = useContainerWidth();

  if (dispatch.length === 0) {
    return null;
  }

  const max = Math.max(...dispatch.map((d) => Math.max(d.offeredMwh, d.absorbedMwh)), 1);
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
        accessibilityLabel="Hourly dispatch: curtailment offered, energy absorbed, and battery state of charge"
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
              {Math.round(max * g)}
            </SvgText>
            <SvgText
              x={W - PAD.right + 6}
              y={socY(socMax * g) + 3}
              textAnchor="start"
              fontSize={9}
              fontFamily={FONT}
              fill={colors.violet}
            >
              {Math.round(socMax * g)}
            </SvgText>
          </G>
        ))}

        {dispatch.map((d, i) => {
          const bx = x(i) - barW / 2;
          const offeredH = Math.max(0, (d.offeredMwh / max) * chartH);
          const absorbedH = Math.max(0, (d.absorbedMwh / max) * chartH);
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
              {absorbedH > 0 ? (
                <Rect
                  x={bx}
                  y={PAD.top + chartH - absorbedH}
                  width={barW}
                  height={absorbedH}
                  rx={3}
                  fill={colors.accent}
                />
              ) : null}
              {d.batteryDischargeMw > 0 ? (
                <Rect
                  x={bx}
                  y={PAD.top + chartH}
                  width={barW}
                  height={Math.max(2, (d.batteryDischargeMw / max) * chartH * 0.35)}
                  rx={2}
                  fill={colors.violet}
                  fillOpacity={0.55}
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
        <Key color={colors.inkFaint} label="Curtailment offered (MWh)" faded={true} />
        <Key color={colors.accent} label="Absorbed (MWh)" />
        <Key color={colors.violet} label="Battery SOC (MWh, right axis)" />
        <Key color={colors.violet} label="Discharge (below the line)" faded={true} />
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
