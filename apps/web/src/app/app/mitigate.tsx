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

import { Panel, Pill, radius, Sheet, space, usePalette } from "@wattsteer/ui";
import Head from "expo-router/head";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import {
  AppShell,
  MiniPill,
  ScreenTitle,
  SectionBlock,
} from "@/components/app/app-shell";
import { Stepper } from "@/components/app/asset-editor";
import { ConformityBadge, HonestyNote, SolveStamp } from "@/components/app/honesty";
import {
  Beside,
  DeliveredPanel,
  DispatchPanel,
  FleetEditors,
  FloorPanel,
} from "@/components/app/mitigate/panels";
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
import { ThinkingOrb } from "@/components/app/thinking-orb";
import { useAppParams } from "@/components/app/use-app-params";
import { useOptimization } from "@/components/app/use-optimization";
import { useScenario } from "@/components/app/use-scenario";
import { useServing } from "@/components/app/use-serving";
import { NO_BRIEFING_DATA } from "@/components/briefing/briefing-data";
import { usePublishBriefingSubject } from "@/components/briefing/briefing-subject";
import { BandStrip } from "@/components/charts/band-figure";
import { type Copy, useCopy, useFormat, useI18n } from "@/i18n";
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

/**
 * Mitigar, as a route and as a section of `/app`. See `explain.tsx` for what
 * `embedded` buys and why the section does not publish its own briefing.
 */
export default function MitigateScreen({
  embedded = false,
  sheet,
}: {
  embedded?: boolean;
  /**
   * A third container for the same body: over the page rather than in it.
   *
   * The same prop, for the same reason, as `explain.tsx`'s — see its docstring.
   * The difference is that here the accordion **stays**: this is an experiment
   * in whether "O que fazer?" under the map reads better than a disclosure
   * three thousand pixels down, and removing the section before the answer is
   * in would leave nothing to compare it against. Drop the prop and the two
   * call sites and the page is exactly as it was.
   *
   * Owned by `/app` because the press that opens it is in the hero, several
   * components away, and a toggle whose two halves live in different subtrees
   * needs its state above both.
   */
  sheet?: { readonly open: boolean; readonly onClose: () => void };
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const serving = useServing();
  const params = useAppParams();
  const meta = subsystemMeta(params.subsystem);
  const scenarioState = useScenario(params.subsystem, params.date);
  // Before the refusal branch below, because a hook cannot be called
  // conditionally. It parks itself on a `null` scenario.
  const optimization = useOptimization(scenarioState.scenario);

  /*
    Published for the briefing host. Mitigar is the only screen that solves a
    plan, so it is the only one whose briefing can carry a `counterfactual`.

    The pair is two *scored* figures — the baseline step's remaining median and
    the last step's — never a difference between them. Each step is a solve of
    its own against the same three envelopes, so both numbers are quantities the
    optimizer reported. Subtracting them here would manufacture a marginal the
    solver never scored, which `test/no-summed-bands.test.ts` exists to forbid.
  */
  const solved = optimization.status === "solved" ? optimization.steps : null;
  const lastStep = solved?.at(-1) ?? null;
  usePublishBriefingSubject(
    {
      context: { locale, screen: "mitigate", params, serving },
      data: NO_BRIEFING_DATA,
      counterfactual:
        solved === null ||
        lastStep === undefined ||
        lastStep === null ||
        solved[0] === undefined
          ? undefined
          : {
              action: lastStep.key === "battery" ? "battery" : "shiftable_load",
              baselineMwh: solved[0].remaining.p50,
              optimizedMwh: lastStep.remaining.p50,
            },
    },
    !embedded,
  );
  const [revealed, setRevealed] = useState(2);

  // The stamp is read off the answer, never off the request: the threshold and
  // the resolved forecast origin are what the plan was optimised against, and a
  // screen that sourced them from anywhere else could label a plan with a
  // forecast it was not built on.
  const stamped = optimization.status === "solved" ? optimization.steps[0] : null;
  /**
   * Whether a plan was actually drawn, which the lede turns on.
   *
   * Same rule as the Overview and Explain: the lede must describe the panels
   * that are on the screen, not the ones that would be there in the other
   * state. "Storage and flexible demand sized against the day-ahead forecast"
   * is the first line a reader meets, and on every branch below except the last
   * it describes a plan that was never drawn — most visibly in the refusal
   * branch, where the sentence under it says the scenario was refused.
   */
  const planned = optimization.status === "solved";

  const title = copy.app.mitigate.title;
  const lede = fill(planned ? copy.app.mitigate.lede : copy.app.mitigate.ledeAbsent, {
    subsystem: meta.onsDisplayName,
    date: f.date(params.date),
  });
  /* Same mark as Visão da rede and Explicar: a re-solve keeps the plan and
     says it is being redone, rather than replacing it with a sentence. */
  const resolving = optimization.status === "solved" && optimization.refreshing === true;
  const right = (
    <>
      {stamped === null ? null : (
        <SolveStamp
          forecastOrigin={stamped.forecastOrigin}
          thresholdMw={stamped.thresholdMw}
        />
      )}
      {/*
        The ordem de corte, beside the origin stamp rather than under the plan:
        both are statements about *where this plan came from*, and a reader
        auditing one is auditing the other in the same glance. Read off the
        step on screen, not off the first solve, so switching to "sem ação" —
        which schedules nothing and checks nothing — drops the mark instead of
        leaving a rule marked as applied to an empty plan.
      */}
      <ConformityBadge conformity={lastStep?.conformity ?? null} />
      {resolving ? (
        <ThinkingOrb size={18} accessibilityLabel={copy.app.overview.refreshingLabel} />
      ) : null}
    </>
  );

  /*
    One frame for four returns. This screen wrote the `Head` + `AppShell` +
    header preamble out four times — once per branch — which is four places to
    forget the same line, and adding the embedded form would have made it eight.
  */
  const frame = (body: ReactNode) => {
    /* Out of the JSX because `noLeakedRender` reads a ternary whose alternate
       is a variable as a value that might render itself. */
    const inSection = sheet?.open === true ? null : body;
    return embedded ? (
      <>
        {/*
          The accordion keeps its body unless the sheet is holding it. Two live
          copies of these panels would be two sets of steppers writing the same
          scenario, and `app-shell.tsx` records the same rule from the last time
          one element was nearly mounted twice.
        */}
        <SectionBlock id="mitigate" title={title} lede={lede} right={right}>
          {inSection}
        </SectionBlock>
        {sheet === undefined ? null : (
          <Sheet
            open={sheet.open}
            onClose={sheet.onClose}
            title={title}
            lede={lede}
            closeLabel={copy.app.shell.closeSheet}
          >
            {/* The solve stamp and the ordem de corte ride along: they say what
                the plan was optimised against, and a reader who opened the
                sheet from under the map has not seen them anywhere else. */}
            {right}
            {body}
          </Sheet>
        )}
      </>
    ) : (
      <>
        <Head>
          <title>{copy.app.mitigate.metaTitle}</title>
          <meta name="robots" content="noindex,follow" />
        </Head>
        <AppShell>
          <ScreenTitle title={title} lede={lede} right={right} />
          {body}
        </AppShell>
      </>
    );
  };

  // A scenario the refusal table would not let near a solver never gets a plan
  // drawn for it. The code is rendered from the dictionaries; the gateway's own
  // developer prose is not on this screen and never reaches a reader.
  if (scenarioState.scenario === null) {
    const code = scenarioState.readout.ok ? "BAD_INPUT" : scenarioState.readout.code;
    return frame(<Refusal code={code} onReset={scenarioState.reset} />);
  }

  const scenario = scenarioState.scenario;
  const battery = fixtureBattery(scenarioBattery(scenario));
  const load = fixtureLoad(scenarioLoad(scenario));
  const brlPerMwh = scenarioBrlPerMwh(scenario);

  // The solver refused, or could not be reached. Same treatment as a refused
  // link: the code, in the reader's language, and no plan drawn beside it.
  if (optimization.status === "refused") {
    return frame(<Refusal code={optimization.code} onReset={scenarioState.reset} />);
  }

  // Solving. An absence, not a skeleton of numbers that are not there yet.
  if (optimization.status !== "solved") {
    return frame(
      <HonestyNote
        title={copy.app.mitigate.solvingTitle}
        tone="neutral"
        points={[copy.app.mitigate.solvingNote, copy.app.mitigate.solvingLive]}
      />,
    );
  }

  const steps = optimization.steps;
  const active = steps[Math.min(revealed, steps.length - 1)];
  const baseline = steps[0].remaining;
  const domainMax = baseline.p90 * 1.05;

  return frame(
    <>
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

      <FloorPanel active={active} domainMax={domainMax} />

      {/* Quantiles do not add, and the floor is not a day-level claim. */}
      <HonestyNote
        title={copy.app.mitigate.notJointTitle}
        tone="warning"
        points={[copy.app.mitigate.notJointBody]}
      />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 300 }}>
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
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 320, gap: space.sm }}>
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

      <DeliveredPanel active={active} />

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

      <DispatchPanel active={active} battery={battery} />

      <FleetEditors
        scenario={scenario}
        battery={battery}
        load={load}
        update={scenarioState.update}
      />

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

      {/*
        What the badge in the header stands for, in one sentence, at the bottom
        where a footnote belongs. The badge says the rule was applied; this says
        what applying it means, and it is here rather than beside the badge
        because it is a standing truth and not news — the same reason the
        cause caveat moved off the Overview and into a card's corner.
      */}
      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {copy.app.mitigate.conformityNote}
      </Text>
    </>,
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
        flexShrink: 1,
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
          <BandStrip band={step.remaining} domainMax={domainMax} />
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
