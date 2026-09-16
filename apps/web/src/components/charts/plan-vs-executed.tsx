/**
 * The plan and what happened, drawn as **two series**.
 *
 * `docs/specs/replay.md`, story 30 and contract decision 5: *"they are equal
 * only when the realisation equals the planning basis. Drawing one is what
 * makes 'planned against P50' get read as 'assumed P50 came true'."* That is
 * the whole reason this component exists rather than the Mitigate screen's
 * `DispatchChart` being reused — that chart draws one plan, on the planning
 * envelope, which is the right picture for a day that has not happened yet and
 * the wrong one for a day that has.
 *
 * Read: the grey bars are what was **actually** curtailed in that hour, hour by
 * hour, settled by ONS. The dashed line is what the plan **scheduled** the
 * fleet to take, built at D−1 against the P50 envelope. The solid line is what
 * the fleet **would have taken**, scored against the day that happened.
 *
 * The two lines separate in both directions, and the separations mean opposite
 * things — which is exactly what a single series hides:
 *
 *  - **Solid below dashed** — the forecast ran high, so the scheduled amount
 *    was never there to take. A real, reported shortfall.
 *  - **Grey above both** — the forecast ran low, so real curtailment sat in the
 *    hour that the plan never asked for and the fleet correctly left alone.
 *    Taking it would be an intraday re-optimisation against information the
 *    plan did not have; the spec calls that hindsight and forbids it, and the
 *    unabsorbed excess flows straight into remaining energy.
 *
 * **This component computes nothing.** Both series arrive as scored hours off
 * the replay contract — the only implementation of the execution rule in this
 * repository is `apps/ml/src/wattsteer_ml/optimizer/simulator.py`, and
 * `test/one-execution-rule.test.ts` walks the repository to keep it the only
 * one. What is here is a scale, two paths and a legend.
 */

import { useContainerWidth, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import Svg, { G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { useCopy, useFormat } from "@/i18n";
import type { HourlyDispatch } from "@/lib/fixtures";

const W = 640;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 46 };
const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

export function PlanVsExecuted({
  scheduled,
  executed,
  actualHours,
}: {
  /** The plan, on the P50 envelope. */
  scheduled: HourlyDispatch[];
  /** What the execution rule did against the settled day. */
  executed: HourlyDispatch[];
  /** What ONS settled, hour by hour — the bars, and the denominator's shape. */
  actualHours: number[];
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const [containerWidth, onLayout] = useContainerWidth();

  if (executed.length === 0 || scheduled.length === 0) {
    return null;
  }

  const top = Math.max(
    ...actualHours,
    ...scheduled.map((hour) => hour.absorbedMwh),
    ...executed.map((hour) => hour.absorbedMwh),
    1,
  );
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const slot = chartW / executed.length;
  const barW = Math.max(3, slot * 0.5);
  const scale = containerWidth > 0 ? containerWidth / W : 0;

  const x = (i: number) => PAD.left + i * slot + slot / 2;
  const y = (value: number) => PAD.top + chartH - (value / top) * chartH;
  const path = (hours: HourlyDispatch[]) =>
    `M${hours.map((hour, i) => `${x(i).toFixed(1)},${y(hour.absorbedMwh).toFixed(1)}`).join(" L")}`;

  return (
    <View onLayout={onLayout}>
      <Svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={scale > 0 ? scale * H : H}
        accessibilityLabel={copy.app.replay.planVsExecutedFigure}
      >
        {[1, 0.5, 0].map((line) => (
          <G key={line}>
            <Line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(top * line)}
              y2={y(top * line)}
              stroke={colors.border}
              strokeDasharray="2 6"
            />
            <SvgText
              x={PAD.left - 8}
              y={y(top * line) + 3}
              textAnchor="end"
              fontSize={9}
              fontFamily={FONT}
              fill={colors.inkMuted}
            >
              {f.number(top * line)}
            </SvgText>
          </G>
        ))}

        {actualHours.map((mwh, i) => {
          const height = Math.max(0, (mwh / top) * chartH);
          // `h${hour}` or `i${index}`, never a bare number that could be
          // either. The fallback was `executed[i]?.hourLocal ?? i`, so a row
          // with no executed entry keyed on its index — and an index collides
          // with another row's *hour* the moment the two namespaces overlap,
          // which for a 24-hour day is every index. Prefixing separates them.
          const hour = executed[i]?.hourLocal;
          const key = hour === undefined ? `i${i}` : `h${hour}`;
          // The label still wants a number, and still falls back to the index —
          // which is correct *for an axis tick*, where the position is the
          // meaning. It was only wrong as a React key, where the value has to
          // be unique across siblings rather than merely plausible.
          const hourLocal = hour ?? i;
          return (
            <G key={key}>
              {height > 0 ? (
                <Rect
                  x={x(i) - barW / 2}
                  y={PAD.top + chartH - height}
                  width={barW}
                  height={height}
                  rx={3}
                  fill={colors.inkFaint}
                  fillOpacity={0.26}
                />
              ) : null}
              {hourLocal % 3 === 0 ? (
                <SvgText
                  x={x(i)}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={9}
                  fontFamily={FONT}
                  fill={colors.inkMuted}
                >
                  {String(hourLocal).padStart(2, "0")}
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
        {/*
          The plan first and underneath, dashed: it is the claim being checked,
          and the solid line is the check.
        */}
        <Path
          d={path(scheduled)}
          stroke={colors.violet}
          strokeWidth={2}
          strokeDasharray="5 4"
          fill="none"
        />
        <Path d={path(executed)} stroke={colors.accent} strokeWidth={2} fill="none" />
      </Svg>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 8 }}>
        <Key color={colors.inkFaint} label={copy.app.replay.seriesActual} faded={true} />
        <Key color={colors.violet} label={copy.app.replay.seriesScheduled} />
        <Key color={colors.accent} label={copy.app.replay.seriesExecuted} />
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
