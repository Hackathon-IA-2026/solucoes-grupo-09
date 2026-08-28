/**
 * Screen 3 — Mitigate (IDEA.md §44). The screen that sells the product.
 *
 * The reveal is IDEA.md's: no action → + battery → + flexible load, each step
 * knocking the remaining curtailment down. Two things are different from the
 * sketch, and both are the point of the prototype:
 *
 *  1. **Every figure is a band.** The sketch reads `786 → 524 MWh, −33%`.
 *     There is no 786: the day's curtailment is an interval, and a fixed fleet
 *     covers a *smaller share* of a bigger event, so the percentage avoided is
 *     itself an interval — and an inverted one, worst at P90. Reporting −33%
 *     would be reporting the median twice and calling it a plan.
 *  2. **The optimizer has to be pointed at a point of the band, and the screen
 *     says which.** `docs/research/optimizer-formulation.md` §7 lays out P50 /
 *     P10 / robust-Γ / scenario-based and deliberately does not choose (that
 *     is ticket 011). So the choice is a visible control here: build the plan
 *     on the median, or on P10 for a defensible floor. Either way the plan is
 *     then scored against all three realisations, which is what turns
 *     "MWh recovered" back into an interval instead of a promise.
 */

import {
  Panel,
  PanelHeader,
  Pill,
  radius,
  SlidersHorizontalIcon,
  space,
  Toggle,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import Head from "expo-router/head";
import { useState } from "react";
import { Text, View } from "react-native";
import { AppShell, MiniPill, ScreenTitle } from "@/components/app/app-shell";
import { BatteryEditor, LoadEditor } from "@/components/app/asset-editor";
import { ForecastStamp, HeuristicNote } from "@/components/app/honesty";
import { useAppParams } from "@/components/app/use-app-params";
import { BandFigure, BandStrip, formatMwh } from "@/components/charts/band-figure";
import { DispatchChart } from "@/components/charts/dispatch-chart";
import {
  type Band,
  type BatteryAsset,
  buildForecast,
  buildMitigationSteps,
  type CurtailmentBasis,
  DEFAULT_BATTERY,
  DEFAULT_LOAD,
  ECONOMIC_ASSUMPTION_BRL_PER_MWH,
  type MitigationStep,
  type ShiftableLoadAsset,
  subsystemMeta,
} from "@/lib/fixtures";

const NO_ASSET_BATTERY: BatteryAsset = {
  ...DEFAULT_BATTERY,
  maxPowerMw: 0,
  energyCapacityMwh: 0,
};
const NO_ASSET_LOAD: ShiftableLoadAsset = { ...DEFAULT_LOAD, maxShiftMw: 0 };

function percentBand(band: Band): Band {
  return { p10: band.p10 * 100, p50: band.p50 * 100, p90: band.p90 * 100 };
}

export default function MitigateScreen() {
  const colors = usePalette();
  const params = useAppParams();
  const forecast = buildForecast(params.subsystem, params.technology, params.run);
  const meta = subsystemMeta(params.subsystem);

  const [battery, setBattery] = useState<BatteryAsset>(DEFAULT_BATTERY);
  const [load, setLoad] = useState<ShiftableLoadAsset>(DEFAULT_LOAD);
  const [batteryOn, setBatteryOn] = useState(true);
  const [loadOn, setLoadOn] = useState(true);
  const [basis, setBasis] = useState<CurtailmentBasis>("p50");
  const [revealed, setRevealed] = useState(2);

  const steps = buildMitigationSteps({
    forecast,
    battery: batteryOn ? battery : NO_ASSET_BATTERY,
    load: loadOn ? load : NO_ASSET_LOAD,
    basis,
  });
  const active = steps[Math.min(revealed, steps.length - 1)];
  const baseline = steps[0].remaining;
  const domainMax = baseline.p90 * 1.05;

  return (
    <>
      <Head>
        <title>Mitigate — WattSteer</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell>
        <ScreenTitle
          title="What can we do?"
          lede={`${meta.onsDisplayName} ${params.technology}, ${params.date}. Storage and flexible demand sized against the day-ahead forecast.`}
          right={
            <ForecastStamp
              origin={forecast.forecastOrigin}
              thresholdMw={forecast.thresholdMw}
            />
          }
        />

        <Panel>
          <PanelHeader
            icon={<SlidersHorizontalIcon size={18} color={colors.inkMuted} />}
            title="Plan against"
            subtitle={
              basis === "p50"
                ? "the median forecast (P50)"
                : "a conservative forecast (P10)"
            }
            right={
              <View style={{ flexDirection: "row", gap: 6 }}>
                <MiniPill
                  label="P50 median"
                  active={basis === "p50"}
                  onPress={() => setBasis("p50")}
                />
                <MiniPill
                  label="P10 conservative"
                  active={basis === "p10"}
                  onPress={() => setBasis("p10")}
                />
              </View>
            }
          />
          <Text
            style={{
              marginTop: space.md,
              fontSize: 12,
              lineHeight: 19,
              color: colors.inkMuted,
            }}
          >
            {basis === "p50"
              ? "The plan is optimal if the median comes true. If the day comes in below P50 the assets will have committed to charging from energy that was never curtailed — the P10 column below is what that costs."
              : "The plan is feasible against a pessimistic realisation, so the recovered energy is a floor rather than a median. It systematically under-uses the fleet, which is the direction of error worth preferring."}
          </Text>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          {steps.map((step, index) => (
            <StepCard
              key={step.key}
              step={step}
              previous={index > 0 ? steps[index - 1] : null}
              domainMax={domainMax}
              revealed={index <= revealed}
              onReveal={() => setRevealed(index)}
              isActive={index === revealed}
            />
          ))}
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            <BandFigure
              label="Energy recovered"
              band={active.recovered}
              unit="MWh"
              domainMax={domainMax}
              footnote="One plan, scored against all three realisations of the forecast. The interval is the forecast's, not the optimizer's."
            />
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            {active.avoidability === null ? (
              <View style={{ gap: space.sm }}>
                <Text style={{ fontSize: 13, color: colors.inkMuted }}>
                  Curtailment avoided
                </Text>
                <Text style={{ fontSize: 40, fontWeight: "600", color: colors.inkFaint }}>
                  —
                </Text>
                <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                  Undefined, not zero: with no assets there is nothing to divide by. A
                  zero here would read as "nothing could be avoided".
                </Text>
              </View>
            ) : (
              <BandFigure
                label="Curtailment avoided"
                band={percentBand(active.avoidability)}
                unit="%"
                domainMax={100}
                tone="violet"
                footnote="Inverted on purpose: the share avoided is lowest on the P90 realisation, because a fixed fleet covers less of a bigger event."
              />
            )}
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300, gap: space.sm }}>
            <Text style={{ fontSize: 13, color: colors.inkMuted }}>
              Economic scenario (labelled)
            </Text>
            <Text
              style={{
                fontSize: 32,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {`R$ ${Math.round(
                (active.recovered.p50 * ECONOMIC_ASSUMPTION_BRL_PER_MWH) / 1000,
              ).toLocaleString("en-US")}k`}
            </Text>
            <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
              {`At an assumed R$ ${ECONOMIC_ASSUMPTION_BRL_PER_MWH}/MWh, on the P50 realisation. This is a scenario, not a settlement value, and it is the only place R$ appears. No carbon claim is derivable from any of this and none is made.`}
            </Text>
          </Panel>
        </View>

        <Panel>
          <PanelHeader
            icon={<ZapIcon size={18} color={colors.inkMuted} />}
            title="Dispatch"
            subtitle={`${active.label} · scored on the P50 realisation`}
          />
          <View style={{ marginTop: space.lg }}>
            <DispatchChart
              dispatch={active.dispatch}
              energyCapacityMwh={batteryOn ? battery.energyCapacityMwh : 1}
            />
          </View>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
            <PanelHeader
              icon={<ZapIcon size={18} color={colors.inkMuted} />}
              title="Battery"
              subtitle="Scenario input, not an inventory"
              right={
                <Toggle
                  label="Include battery"
                  value={batteryOn}
                  onValueChange={setBatteryOn}
                />
              }
            />
            <View style={{ marginTop: space.lg, opacity: batteryOn ? 1 : 0.45 }}>
              <BatteryEditor battery={battery} onChange={setBattery} />
            </View>
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
            <PanelHeader
              icon={<SlidersHorizontalIcon size={18} color={colors.inkMuted} />}
              title="Flexible load"
              subtitle="Scenario input, not an inventory"
              right={
                <Toggle label="Include load" value={loadOn} onValueChange={setLoadOn} />
              }
            />
            <View style={{ marginTop: space.lg, opacity: loadOn ? 1 : 0.45 }}>
              <LoadEditor load={load} onChange={setLoad} />
            </View>
          </Panel>
        </View>

        <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
          <Pill
            label="Reset to 100 MW / 300 MWh + 70 MW"
            tone="secondary"
            onPress={() => {
              setBattery(DEFAULT_BATTERY);
              setLoad(DEFAULT_LOAD);
              setBatteryOn(true);
              setLoadOn(true);
            }}
          />
        </View>

        <HeuristicNote />

        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
          ONS publishes no flexibility-asset registry, so every parameter above is your
          assumption. Mitigate is a what-if tool, not an inventory — the scenario is
          encoded in the URL rather than saved, so a link is the whole of sharing it.
        </Text>
      </AppShell>
    </>
  );
}

function StepCard({
  step,
  previous,
  domainMax,
  revealed,
  isActive,
  onReveal,
}: {
  step: MitigationStep;
  previous: MitigationStep | null;
  domainMax: number;
  revealed: boolean;
  isActive: boolean;
  onReveal: () => void;
}) {
  const colors = usePalette();
  const delta = previous === null ? null : previous.remaining.p50 - step.remaining.p50;

  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 260,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: isActive ? colors.accent : colors.border,
        backgroundColor: colors.surface,
        padding: 20,
        gap: space.md,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text style={{ fontSize: 14, fontWeight: "700", color: colors.ink }}>
          {step.label}
        </Text>
        {revealed ? null : <MiniPill label="Reveal" active={false} onPress={onReveal} />}
      </View>

      {revealed ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
            <Text
              style={{
                fontSize: 32,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                letterSpacing: -0.6,
                color: colors.ink,
              }}
            >
              {formatMwh(step.remaining.p50)}
            </Text>
            <Text style={{ fontSize: 13, color: colors.inkMuted }}>MWh remaining</Text>
          </View>
          <BandStrip band={step.remaining} domainMax={domainMax} tone="muted" />
          <Text
            style={{
              fontSize: 11,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`P10 ${formatMwh(step.remaining.p10)} · P90 ${formatMwh(step.remaining.p90)}`}
          </Text>
          {delta === null ? (
            <Text style={{ fontSize: 12, color: colors.inkFaint }}>
              The day as forecast, with nothing dispatched.
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: colors.accent, fontWeight: "700" }}>
              {`−${formatMwh(delta)} MWh vs the previous step (P50)`}
            </Text>
          )}
        </>
      ) : (
        <Text style={{ fontSize: 12, color: colors.inkFaint }}>
          Hidden — reveal it in order to see the step change.
        </Text>
      )}

      {/* Keeps the three cards the same height when one is still hidden. */}
      <View style={{ flexGrow: 1 }} />
    </View>
  );
}
