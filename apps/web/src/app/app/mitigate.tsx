/**
 * Screen 3 — Mitigate. One plan, one promise, and the rule that makes it honest.
 *
 * **The posture is decided and this screen expresses it rather than offering
 * it.** The optimizer plans against P50, the product promises the P10 edge, and
 * the user is never asked. `docs/specs/flex-optimizer.md` settles that, and the
 * prototype's basis toggle — which used to sit at the top of this file — comes
 * out with it. The spec is worth quoting on why, because the instinct behind
 * the toggle was a good one:
 *
 * > The prototype's P50/P10 toggle was the right question asked in the wrong
 * > place. The screen was refusing to hide a modelling choice from the user;
 * > but the choice it exposed was not a preference, it was a defect in the
 * > framing.
 *
 * What replaces it is the **execution rule**, stated on screen: on the day, an
 * asset charges the scheduled amount or the amount actually being curtailed,
 * whichever is smaller. Without that sentence, "planned against P50" gets read
 * as "assumes P50 comes true", which is exactly the misreading the posture
 * depends on not happening. With it, over-planning has no downside worth
 * protecting a reader from, and the conservatism moves to the claim — where one
 * number, `recovered_floor_mwh`, can be quoted without a caveat.
 *
 * Three consequences run through the layout:
 *
 *  1. **The floor is what the prose says; the band is what the chart draws.**
 *     The P10-simulated recovery is the number in the sentence, with the median
 *     and high realisations *beside* it so a conservative promise does not hide
 *     the upside.
 *  2. **The dispatch is the *scheduled* plan on the planning envelope**, and is
 *     labelled so. Every number on this screen is read off a solved
 *     `OptimizationResult`; this file computes no KPI at all. It used to: a
 *     greedy planner and a second implementation of the execution rule ran in
 *     the browser, and `docs/specs/api-surface.md` decision 6 deleted them
 *     rather than porting them, because the rule exists once — in `apps/ml` —
 *     and this copy was the known-wrong one.
 *  3. **The scenario is the URL.** There is no account and nothing is saved, so
 *     the address bar carries the canonical blob, a stepper commits on a
 *     trailing debounce, and a link that fails the refusal table renders the
 *     code's sentence rather than a plausible plan.
 */

import {
  LayersIcon,
  Panel,
  PanelHeader,
  Pill,
  radius,
  SlidersHorizontalIcon,
  space,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import Head from "expo-router/head";
import { useState } from "react";
import { Text, View } from "react-native";
import { AppShell, MiniPill, ScreenTitle } from "@/components/app/app-shell";
import { BatteryEditor, LoadEditor, Stepper } from "@/components/app/asset-editor";
import { HonestyNote, SolveStamp } from "@/components/app/honesty";
import {
  fixtureBattery,
  fixtureLoad,
  scenarioBattery,
  scenarioBrlPerMwh,
  scenarioLoad,
  withBattery,
  withBrlPerMwh,
  withLoad,
} from "@/components/app/scenario";
import { useAppParams } from "@/components/app/use-app-params";
import { useOptimization } from "@/components/app/use-optimization";
import { useScenario } from "@/components/app/use-scenario";
import { BandStrip } from "@/components/charts/band-figure";
import { DispatchChart } from "@/components/charts/dispatch-chart";
import { type Copy, useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  ASSET_LIMITS,
  type Band,
  DEFAULT_BATTERY,
  DEFAULT_LOAD,
  type MitigationStep,
  subsystemMeta,
} from "@/lib/fixtures";

function percentBand(band: Band): Band {
  return { p10: band.p10 * 100, p50: band.p50 * 100, p90: band.p90 * 100 };
}

export default function MitigateScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const meta = subsystemMeta(params.subsystem);
  const scenarioState = useScenario(params.subsystem, params.date);
  // Before the refusal branch below, because a hook cannot be called
  // conditionally. It parks itself on a `null` scenario.
  const optimization = useOptimization(scenarioState.scenario);
  const [revealed, setRevealed] = useState(2);

  // The stamp is read off the answer, never off the request: the threshold and
  // the resolved forecast origin are what the plan was optimised against, and a
  // screen that sourced them from anywhere else could label a plan with a
  // forecast it was not built on.
  const stamped = optimization.status === "solved" ? optimization.steps[0] : null;
  const header = (
    <ScreenTitle
      title={copy.app.mitigate.title}
      lede={fill(copy.app.mitigate.lede, {
        subsystem: meta.onsDisplayName,
        date: f.date(params.date),
      })}
      right={
        stamped === null ? null : (
          <SolveStamp
            forecastOrigin={stamped.forecastOrigin}
            thresholdMw={stamped.thresholdMw}
          />
        )
      }
    />
  );

  // A scenario the refusal table would not let near a solver never gets a plan
  // drawn for it. The code is rendered from the dictionaries; the gateway's own
  // developer prose is not on this screen and never reaches a reader.
  if (scenarioState.scenario === null) {
    const code = scenarioState.readout.ok ? "BAD_INPUT" : scenarioState.readout.code;
    return (
      <>
        <Head>
          <title>{copy.app.mitigate.metaTitle}</title>
          <meta name="robots" content="noindex" />
        </Head>
        <AppShell>
          {header}
          <Refusal code={code} onReset={scenarioState.reset} />
        </AppShell>
      </>
    );
  }

  const scenario = scenarioState.scenario;
  const battery = fixtureBattery(scenarioBattery(scenario));
  const load = fixtureLoad(scenarioLoad(scenario));
  const brlPerMwh = scenarioBrlPerMwh(scenario);

  // The solver refused, or could not be reached. Same treatment as a refused
  // link: the code, in the reader's language, and no plan drawn beside it.
  if (optimization.status === "refused") {
    return (
      <>
        <Head>
          <title>{copy.app.mitigate.metaTitle}</title>
          <meta name="robots" content="noindex" />
        </Head>
        <AppShell>
          {header}
          <Refusal code={optimization.code} onReset={scenarioState.reset} />
        </AppShell>
      </>
    );
  }

  // Solving. An absence, not a skeleton of numbers that are not there yet.
  if (optimization.status !== "solved") {
    return (
      <>
        <Head>
          <title>{copy.app.mitigate.metaTitle}</title>
          <meta name="robots" content="noindex" />
        </Head>
        <AppShell>
          {header}
          <HonestyNote
            title={copy.app.mitigate.solvingTitle}
            tone="neutral"
            points={[copy.app.mitigate.solvingNote, copy.app.mitigate.solvingLive]}
          />
        </AppShell>
      </>
    );
  }

  const steps = optimization.steps;
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
        {header}

        {/*
          The execution rule, above every number it makes honest. Not a tooltip
          and not collapsible: a caveat behind an interaction is a caveat nobody
          reads, and this one changes what "planned against the median" means.
        */}
        <HonestyNote
          title={copy.app.mitigate.postureTitle}
          tone="neutral"
          points={[copy.app.mitigate.postureRule, copy.app.mitigate.postureWhy]}
          right={
            <Text style={{ fontSize: 11, color: colors.inkFaint }}>
              {copy.app.mitigate.postureSubtitle}
            </Text>
          }
        />

        {/* The promise: the floor in prose, the band beside it. */}
        <Panel>
          <PanelHeader
            icon={<LayersIcon size={18} color={colors.inkMuted} />}
            title={copy.app.mitigate.floorTitle}
            subtitle={copy.app.mitigate.floorLabel}
          />
          <View
            style={{
              marginTop: space.lg,
              flexDirection: "row",
              flexWrap: "wrap",
              gap: space.xl,
            }}
          >
            <View style={{ flexGrow: 1, flexBasis: 320, gap: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <Text
                  selectable={true}
                  style={{
                    fontSize: 52,
                    lineHeight: 58,
                    fontWeight: "600",
                    letterSpacing: -1.2,
                    fontVariant: ["tabular-nums"],
                    color: colors.accent,
                  }}
                >
                  {f.compact(active.recoveredFloorMwh)}
                </Text>
                <Text style={{ fontSize: 16, fontWeight: "500", color: colors.inkMuted }}>
                  MWh
                </Text>
              </View>
              <Text style={{ fontSize: 13, lineHeight: 21, color: colors.inkMuted }}>
                {fill(copy.app.mitigate.floorSentence, {
                  floor: f.compact(active.recoveredFloorMwh),
                })}
              </Text>
            </View>

            {/*
              Beside the floor, never in front of it: two secondary figures at
              a fraction of the type size, with the band they belong to drawn
              under them on the shared scale.
            */}
            <View style={{ flexGrow: 1, flexBasis: 260, gap: space.md }}>
              <Beside
                label={copy.app.mitigate.floorMedian}
                value={`${f.compact(active.recovered.p50)} MWh`}
              />
              <Beside
                label={copy.app.mitigate.floorHigh}
                value={`${f.compact(active.recovered.p90)} MWh`}
              />
              <BandStrip band={active.recovered} domainMax={domainMax} tone="accent" />
              <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
                {copy.app.mitigate.floorBesideNote}
              </Text>
            </View>
          </View>
        </Panel>

        {/* Quantiles do not add, and the floor is not a day-level claim. */}
        <HonestyNote
          title={copy.app.mitigate.notJointTitle}
          tone="warning"
          points={[copy.app.mitigate.notJointBody]}
        />

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            {active.avoidability === null ? (
              <View style={{ gap: space.sm }}>
                <Text style={{ fontSize: 13, color: colors.inkMuted }}>
                  {copy.app.mitigate.avoided}
                </Text>
                <Text
                  style={{ fontSize: 40, fontWeight: "600", color: colors.inkFaint }}
                  accessibilityLabel={copy.app.mitigate.avoidedUndefined}
                >
                  —
                </Text>
                <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
                  {copy.app.mitigate.avoidedUndefined}
                </Text>
              </View>
            ) : (
              <Avoidability shares={active.avoidability} />
            )}
          </Panel>

          {/* R$ once, with its assumption on screen and editable. */}
          <Panel style={{ flexGrow: 1, flexBasis: 320, gap: space.sm }}>
            <Text style={{ fontSize: 13, color: colors.inkMuted }}>
              {copy.app.mitigate.economicTitle}
            </Text>
            {/*
              The solver's own figure — recovered energy on the planning
              envelope at the assumed rate — rather than a second multiplication
              on this screen. `no_action` dispatched nothing and is priced at
              nothing, which is an absence and is drawn as one.
            */}
            <Text
              style={{
                fontSize: 32,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: active.brl === null ? colors.inkFaint : colors.ink,
              }}
              accessibilityLabel={
                active.brl === null ? copy.app.mitigate.economicNoPlan : undefined
              }
            >
              {active.brl === null ? "—" : f.brlThousands(active.brl)}
            </Text>
            <View style={{ marginTop: space.xs }}>
              <Stepper
                label={copy.app.mitigate.economicRate}
                value={brlPerMwh}
                limit={ASSET_LIMITS.brlPerMwh}
                format={(v) => `${f.brl(v)}/MWh`}
                onChange={(next) => scenarioState.update(withBrlPerMwh(scenario, next))}
              />
            </View>
            <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
              {fill(copy.app.mitigate.economicNote, { rate: f.brl(brlPerMwh) })}
            </Text>
            <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
              {copy.app.mitigate.economicOnlyMoney}
            </Text>
          </Panel>
        </View>

        {/* "Recovered" is not "delivered", and the two numbers that say so. */}
        <Panel>
          <PanelHeader
            icon={<ZapIcon size={18} color={colors.inkMuted} />}
            title={copy.app.mitigate.deliveredTitle}
            subtitle={copy.app.mitigate.deliveredSubtitle}
          />
          <View
            style={{
              marginTop: space.lg,
              flexDirection: "row",
              flexWrap: "wrap",
              gap: space.xl,
            }}
          >
            <Scalar
              label={copy.app.mitigate.storedLabel}
              value={`${f.compact(active.storedAtHorizonEndMwh)} MWh`}
            />
            <Scalar
              label={copy.app.mitigate.lossLabel}
              value={`${f.compact(active.roundTripLossMwh)} MWh`}
            />
          </View>
          <Text
            style={{
              marginTop: space.md,
              fontSize: 11,
              lineHeight: 18,
              color: colors.inkFaint,
            }}
          >
            {copy.app.mitigate.deliveredNote}
          </Text>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          {steps.map((step, index) => (
            <StepCard
              key={step.key}
              step={step}
              domainMax={domainMax}
              revealed={index <= revealed}
              onReveal={() => setRevealed(index)}
              isActive={index === revealed}
            />
          ))}
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
              energyCapacityMwh={battery.energyCapacityMwh}
            />
          </View>
          <Text
            style={{
              marginTop: space.md,
              fontSize: 11,
              lineHeight: 18,
              color: colors.inkFaint,
            }}
          >
            {copy.app.mitigate.dispatchScheduled}
          </Text>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
            <PanelHeader
              icon={<ZapIcon size={18} color={colors.inkMuted} />}
              title={copy.app.mitigate.batteryTitle}
              subtitle={copy.app.mitigate.assetSubtitle}
            />
            <View style={{ marginTop: space.lg }}>
              <BatteryEditor
                battery={battery}
                onChange={(next) => scenarioState.update(withBattery(scenario, next))}
              />
            </View>
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
            <PanelHeader
              icon={<SlidersHorizontalIcon size={18} color={colors.inkMuted} />}
              title={copy.app.mitigate.loadTitle}
              subtitle={copy.app.mitigate.assetSubtitle}
            />
            <View style={{ marginTop: space.lg }}>
              <LoadEditor
                load={load}
                onChange={(next) => scenarioState.update(withLoad(scenario, next))}
              />
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
            onPress={() =>
              scenarioState.commit(
                withLoad(withBattery(scenario, DEFAULT_BATTERY), DEFAULT_LOAD),
              )
            }
          />
        </View>

        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
          {copy.app.mitigate.shareNote}
        </Text>

        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
          {copy.app.mitigate.footnote}
        </Text>
      </AppShell>
    </>
  );
}

/**
 * The share of curtailment avoided, on each of the three realisations.
 *
 * **Not a `BandFigure`, because these three are not an interval.** A
 * `BandFigure` draws `p10 … p90` as an ascending track with `p50` marked, and
 * on the reference profile the median share is the *largest* of the three —
 * the marker would sit outside its own fill. The set is genuinely unordered
 * and for two separate, both-true reasons:
 *
 *  - the high realisation sits **below** the median because a fixed fleet
 *    covers a smaller share of a bigger event, which is the arithmetic the
 *    spec asks to be made visible rather than surprising;
 *  - the low realisation sits below both because a plan built on the median
 *    cannot absorb energy that was never curtailed.
 *
 * So the median is the figure, the track spans the smallest and the largest of
 * the three, and all three are spelled out and named by the realisation they
 * belong to.
 */
function Avoidability({ shares }: { shares: Band }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const points = percentBand(shares);
  const span: Band = {
    p10: Math.min(points.p10, points.p50, points.p90),
    p50: points.p50,
    p90: Math.max(points.p10, points.p50, points.p90),
  };
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
        {copy.app.mitigate.avoided}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text
          selectable={true}
          style={{
            fontSize: 40,
            lineHeight: 44,
            fontWeight: "600",
            letterSpacing: -0.8,
            fontVariant: ["tabular-nums"],
            color: colors.ink,
          }}
        >
          {f.percentPoints(points.p50, 1)}
        </Text>
      </View>
      <BandStrip band={span} domainMax={100} tone="violet" />
      <View style={{ gap: 2 }}>
        <Beside
          label={copy.app.mitigate.realisationLow}
          value={f.percentPoints(points.p10, 1)}
        />
        <Beside
          label={copy.app.mitigate.realisationMedian}
          value={f.percentPoints(points.p50, 1)}
        />
        <Beside
          label={copy.app.mitigate.realisationHigh}
          value={f.percentPoints(points.p90, 1)}
        />
      </View>
      <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
        {copy.app.mitigate.avoidedNote}
      </Text>
    </View>
  );
}

/** A small figure that sits beside a headline without competing with it. */
function Beside({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Text style={{ fontSize: 12, color: colors.inkMuted, flexShrink: 1 }}>{label}</Text>
      <Text
        style={{
          fontSize: 18,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          color: colors.ink,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/** A labelled scalar, for the two numbers that make "recovered" honest. */
function Scalar({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View style={{ flexGrow: 1, flexBasis: 220, gap: 4 }}>
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>{label}</Text>
      <Text
        style={{
          fontSize: 26,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          color: colors.ink,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * A refused scenario, named by its code.
 *
 * The reader gets `copy.error[code]` in their own locale. There is no path
 * here by which the gateway's English developer prose reaches a screen, which
 * is the half of the i18n rule a fixture-backed screen could otherwise skip.
 */
function Refusal({ code, onReset }: { code: keyof Copy["error"]; onReset: () => void }) {
  const copy = useCopy();
  const colors = usePalette();
  return (
    <View style={{ gap: space.lg }}>
      <HonestyNote
        title={copy.app.mitigate.refusalTitle}
        tone="warning"
        points={[copy.error[code], copy.app.mitigate.refusalNote]}
      />
      <View style={{ flexDirection: "row" }}>
        <Pill label={copy.app.mitigate.refusalReset} tone="secondary" onPress={onReset} />
      </View>
      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {copy.app.mitigate.shareNote}
      </Text>
    </View>
  );
}

/**
 * One step of the reveal: what is left, and what this step recovered.
 *
 * **The second figure used to be a delta between two cards** —
 * `previous.remaining.p50 - step.remaining.p50`, printed to a reader as the
 * energy this step recovers. It is the error `test/no-summed-bands.test.ts`
 * exists for, one operation over: the median of a difference is not the
 * difference of the medians, and no arrangement of two published bands
 * produces the marginal quantity that sentence claimed. The guard now matches
 * the shape (case D) so it cannot return by a different spelling.
 *
 * Nothing had to be invented to replace it. Every step is a solve of its own,
 * and the solver scores each one against the same three envelopes and reports
 * `scored.p50.recovered_mwh` — the energy the step's own plan absorbs on the
 * P50 realisation. That is a field on the answer, read here and not combined
 * with anything, and the sentence names the realisation it belongs to so two
 * cards can be compared without a reader inferring a difference the model
 * never scored.
 */
function StepCard({
  step,
  domainMax,
  revealed,
  isActive,
  onReveal,
}: {
  step: MitigationStep;
  domainMax: number;
  revealed: boolean;
  isActive: boolean;
  onReveal: () => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();

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
          {step.key === "no_action" ? (
            <Text style={{ fontSize: 12, color: colors.inkFaint }}>
              {copy.app.mitigate.baselineStep}
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: colors.accent, fontWeight: "700" }}>
              {fill(copy.app.mitigate.stepRecovered, {
                recovered: f.compact(step.recovered.p50),
              })}
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
