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

import { BRL_PER_MWH } from "@wattsteer/core";
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
import { BandFigure, BandStrip } from "@/components/charts/band-figure";
import { DispatchChart } from "@/components/charts/dispatch-chart";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  type Band,
  type BatteryAsset,
  buildForecast,
  buildMitigationSteps,
  type CurtailmentBasis,
  DEFAULT_BATTERY,
  DEFAULT_LOAD,
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
  const copy = useCopy();
  const f = useFormat();
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
        <title>{copy.app.mitigate.metaTitle}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell>
        <ScreenTitle
          title={copy.app.mitigate.title}
          lede={fill(copy.app.mitigate.lede, {
            subsystem: meta.onsDisplayName,
            technology: copy.app.technology[params.technology].toLowerCase(),
            date: f.date(params.date),
          })}
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
            title={copy.app.mitigate.basisTitle}
            subtitle={
              basis === "p50"
                ? copy.app.mitigate.basisMedian
                : copy.app.mitigate.basisConservative
            }
            right={
              <View style={{ flexDirection: "row", gap: 6 }}>
                <MiniPill
                  label={copy.app.mitigate.basisMedianPill}
                  active={basis === "p50"}
                  onPress={() => setBasis("p50")}
                />
                <MiniPill
                  label={copy.app.mitigate.basisConservativePill}
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
              ? copy.app.mitigate.basisMedianBody
              : copy.app.mitigate.basisConservativeBody}
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
              label={copy.app.mitigate.recovered}
              band={active.recovered}
              unit="MWh"
              domainMax={domainMax}
              footnote={copy.app.mitigate.recoveredNote}
            />
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            {active.avoidability === null ? (
              <View style={{ gap: space.sm }}>
                <Text style={{ fontSize: 13, color: colors.inkMuted }}>
                  {copy.app.mitigate.avoided}
                </Text>
                <Text style={{ fontSize: 40, fontWeight: "600", color: colors.inkFaint }}>
                  —
                </Text>
                <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                  {copy.app.mitigate.avoidedUndefined}
                </Text>
              </View>
            ) : (
              <BandFigure
                label={copy.app.mitigate.avoided}
                band={percentBand(active.avoidability)}
                unit="%"
                domainMax={100}
                tone="violet"
                footnote={copy.app.mitigate.avoidedNote}
              />
            )}
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300, gap: space.sm }}>
            <Text style={{ fontSize: 13, color: colors.inkMuted }}>
              {copy.app.mitigate.economicTitle}
            </Text>
            <Text
              style={{
                fontSize: 32,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {f.brlThousands(active.recovered.p50 * BRL_PER_MWH)}
            </Text>
            <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
              {fill(copy.app.mitigate.economicNote, {
                rate: f.brl(BRL_PER_MWH),
              })}
            </Text>
          </Panel>
        </View>

        <Panel>
          <PanelHeader
            icon={<ZapIcon size={18} color={colors.inkMuted} />}
            title={copy.app.mitigate.dispatchTitle}
            subtitle={fill(copy.app.mitigate.dispatchSubtitle, {
              step: copy.app.mitigate.steps[active.key],
            })}
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
              title={copy.app.mitigate.batteryTitle}
              subtitle={copy.app.mitigate.assetSubtitle}
              right={
                <Toggle
                  label={copy.app.mitigate.includeBattery}
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
              title={copy.app.mitigate.loadTitle}
              subtitle={copy.app.mitigate.assetSubtitle}
              right={
                <Toggle
                  label={copy.app.mitigate.includeLoad}
                  value={loadOn}
                  onValueChange={setLoadOn}
                />
              }
            />
            <View style={{ marginTop: space.lg, opacity: loadOn ? 1 : 0.45 }}>
              <LoadEditor load={load} onChange={setLoad} />
            </View>
          </Panel>
        </View>

        <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
          <Pill
            label={fill(copy.app.mitigate.reset, {
              power: f.number(DEFAULT_BATTERY.maxPowerMw),
              energy: f.number(DEFAULT_BATTERY.energyCapacityMwh),
              shift: f.number(DEFAULT_LOAD.maxShiftMw),
            })}
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
          {copy.app.mitigate.footnote}
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
  const copy = useCopy();
  const f = useFormat();
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
          {copy.app.mitigate.steps[step.key]}
        </Text>
        {revealed ? null : (
          <MiniPill label={copy.app.mitigate.reveal} active={false} onPress={onReveal} />
        )}
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
              {f.compact(step.remaining.p50)}
            </Text>
            <Text style={{ fontSize: 13, color: colors.inkMuted }}>
              {copy.app.mitigate.remaining}
            </Text>
          </View>
          <BandStrip band={step.remaining} domainMax={domainMax} tone="muted" />
          <Text
            style={{
              fontSize: 11,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
          >
            {`P10 ${f.compact(step.remaining.p10)} · P90 ${f.compact(step.remaining.p90)}`}
          </Text>
          {delta === null ? (
            <Text style={{ fontSize: 12, color: colors.inkFaint }}>
              {copy.app.mitigate.baselineStep}
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: colors.accent, fontWeight: "700" }}>
              {fill(copy.app.mitigate.stepDelta, { delta: f.compact(delta) })}
            </Text>
          )}
        </>
      ) : (
        <Text style={{ fontSize: 12, color: colors.inkFaint }}>
          {copy.app.mitigate.hidden}
        </Text>
      )}

      {/* Keeps the three cards the same height when one is still hidden. */}
      <View style={{ flexGrow: 1 }} />
    </View>
  );
}
