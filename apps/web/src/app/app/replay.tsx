/**
 * Screen 4 — Time Machine (IDEA.md §45 / §47).
 *
 * The pitch wants this screen to close with "612 MWh curtailed, 281 MWh
 * recoverable, ↓45.9 %". It can — but only with the labelling in front of the
 * number rather than behind it, because two separate things change what the
 * naive reading means and neither is a detail:
 *
 *  1. **A replay is only a counterfactual if the model never saw the day.**
 *     `docs/specs/replay.md` settles that by refusing to replay a day no
 *     artifact held out, rather than by labelling one — a caveat above a
 *     45.9 % does not stop the 45.9 % from being quoted. So the badge here is
 *     a *provenance statement*, `SERVED` or `FOLD-HOLDOUT`, naming the
 *     artifact that produced the forecast and the windows it was fitted on, so
 *     the claim is checkable rather than asserted. The prototype's `IN-SAMPLE`
 *     branch compared the replayed date against the *serving* artifact's
 *     training cut — the right question asked of the wrong artifact — and it
 *     is deleted rather than left unreachable.
 *  2. **Pre-go-live data is revision-optimistic.** ONS rewrites history in
 *     place; all of 2025 was rewritten in 2026 under the same filenames with
 *     no version marker, and prior vintages are unrecoverable. So for any date
 *     before WattSteer began ingesting, the "actual" being scored against is
 *     ONS's *current* restatement of that day, not what was published at the
 *     time. This can never be repaired retroactively.
 *
 * The honesty block therefore sits **above** the headline figures, not under
 * them, and is not collapsible. It changes what the numbers mean; a reader who
 * only sees the numbers has been misled by omission.
 *
 * **Nothing on this screen is computed here.** Every figure is read off the
 * object `GET /v1/replay` returned. `docs/specs/flex-optimizer.md` calls it the
 * single most important line in that spec — the simulator that scores a live
 * plan and the one that scores a replayed plan are the same function, imported
 * rather than reimplemented — and `test/one-execution-rule.test.ts` walks the
 * whole repository to keep it true. Four consequences of reading rather than
 * computing, each of which was a defect in the prototype:
 *
 *  - the day band is `forecast.day_total`, drawn from the path ensemble, and
 *    **not** the componentwise sum of the 24 hourly quantiles;
 *  - the denominator is `actual.total_mwh`, the whole local day, and not the
 *    episode total — a percentage whose denominator moves with `threshold_mw`
 *    is the failure the optimizer spec already ruled out;
 *  - the scheduled and the executed dispatch are drawn as two series;
 *  - the fleet controls re-plan and never re-forecast, because the forecast in
 *    the request path is a pinned row and no interaction can reach a model.
 *
 * And the day the model was fitted on gets no number at all: a pre-F1 date is
 * refused with the clause it failed, and what it is owed instead — the settled
 * profile, its episodes and the perfect-foresight bound, which needs no
 * forecast — is rendered in its place.
 */

import { type ErrorCode, replayTargetDate } from "@wattsteer/core";
import type {
  CurtailmentEpisode,
  Replay,
  ReplayObservedOnly,
  Scenario,
} from "@wattsteer/core/api";
import {
  ClockIcon,
  LayersIcon,
  Panel,
  PanelHeader,
  Pill,
  RotateCcwIcon,
  radius,
  SlidersHorizontalIcon,
  space,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import Head from "expo-router/head";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { AppShell, MiniPill, ScreenTitle } from "@/components/app/app-shell";
import { BatteryEditor, LoadEditor } from "@/components/app/asset-editor";
import {
  ForecastStamp,
  HonestyNote,
  ProvenanceBadge,
  VintageBadge,
} from "@/components/app/honesty";
import {
  fixtureBattery,
  fixtureLoad,
  scenarioBattery,
  scenarioLoad,
  withBattery,
  withLoad,
} from "@/components/app/scenario";
import { useAppParams } from "@/components/app/use-app-params";
import { useReplay } from "@/components/app/use-replay";
import { useScenario } from "@/components/app/use-scenario";
import { CompareBars, type CompareRow } from "@/components/charts/compare-bars";
import { FanChart } from "@/components/charts/fan-chart";
import { PlanVsExecuted } from "@/components/charts/plan-vs-executed";
import { type Copy, type Formatters, useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  type BatteryAsset,
  INGESTION_GO_LIVE,
  REPLAY_DAYS,
  type ReplayCandidateDay,
  replayDay,
  type ShiftableLoadAsset,
  subsystemMeta,
} from "@/lib/fixtures";
import { dispatchSeries, forecastHours, observedHours } from "@/lib/replay";

/** The parts the caveat's two lists are drawn from, as the copy map spells them. */
type VintagePart = keyof Copy["app"]["replay"]["vintagePart"];

/**
 * A replayed day's name: the date in the reader's convention, then the ONS
 * subsystem.
 *
 * No technology. The picker offers a date and a subsystem, and the forecast
 * behind a replayed day has one head per subsystem — a technology in this label
 * would be a division the model does not make, printed as if it did.
 */
function dayLabel(day: ReplayCandidateDay, copy: Copy, f: Formatters): string {
  return fill(copy.app.replay.dayLabel, {
    date: f.date(day.date),
    subsystem: subsystemMeta(day.subsystem).onsDisplayName,
  });
}

/**
 * The provenance sentence: which artifact produced this forecast, and what it
 * was fitted on.
 *
 * Two branches, and neither is a warning. A `served` day's forecast was
 * published before the day began, which is the strongest statement available
 * and needs no fold to make it — `held_out_by` is `null` there, and that is the
 * contract's own shape rather than a missing value. A `fold_holdout` day names
 * its fold, the fold's artifact and **both** recorded windows: the training
 * block and the calibration window, because the calibration window is where
 * the isotonic fit and the two conformal scalars were fitted, so a day inside
 * it would have shaped the interval this screen promises a floor from.
 *
 * There is no third branch. The prototype had one — `IN-SAMPLE` — and it is
 * gone rather than disabled: under `docs/specs/replay.md` a day no artifact
 * held out is refused, so the branch is unreachable by construction and dead
 * code that says otherwise is a claim the product does not make.
 */
function provenanceNote(replay: Replay, copy: Copy, f: Formatters): string {
  const heldOut = replay.integrity.heldOutBy;
  if (heldOut === null) {
    return fill(copy.app.replay.provenanceServedNote, {
      published: f.dateTime(replay.forecastOrigin.publishedAt),
    });
  }
  return fill(copy.app.replay.provenanceFoldHoldoutNote, {
    fold: heldOut.fold,
    artifact: heldOut.artifactId,
    trainFrom: f.date(heldOut.trainWindow[0]),
    trainTo: f.date(heldOut.trainWindow[1]),
    calibrationFrom: f.date(heldOut.calibrationWindow[0]),
    calibrationTo: f.date(heldOut.calibrationWindow[1]),
  });
}

/**
 * The two sentences a `revision_optimistic` day owes a reader: *what* the
 * caveat touches, and *how big* it is.
 *
 * Both are read off the response rather than written here. The parts come from
 * `integrity.vintage_affects` / `vintage_exempt` and this function only spells
 * them, so a part the service stops claiming stops being named on screen; and
 * the size is `revision_premium_recovered_mwh`, which is `null` until ONS has
 * restated days held in both vintages. `null` renders as the word
 * **unmeasured** — never as a zero, and never as silence, because a caveat
 * whose size is not stated reads as a caveat that is small.
 *
 * Nothing is emitted for a `point_in_time` day: there is no restatement to
 * bound, and a sentence saying so would make the honest case look qualified.
 */
function vintageExtent(integrity: Replay["integrity"], copy: Copy): string[] {
  if (integrity.vintageFidelity !== "revision_optimistic") {
    return [];
  }
  const spell = (parts: readonly string[]): string =>
    parts
      .map((part) => copy.app.replay.vintagePart[part as VintagePart] ?? part)
      .join(", ");
  return [
    fill(copy.app.replay.vintageExtentNote, {
      affects: spell(integrity.vintageAffects),
      exempt: spell(integrity.vintageExempt),
    }),
    integrity.revisionPremiumRecoveredMwh === null
      ? copy.app.replay.revisionPremiumUnmeasured
      : fill(copy.app.replay.revisionPremiumMeasured, {
          mwh: integrity.revisionPremiumRecoveredMwh,
        }),
  ];
}

/** The vintage sentence proper, on either side of go-live. */
function vintageNote(
  fidelity: Replay["vintageFidelity"],
  copy: Copy,
  f: Formatters,
): string {
  return fill(
    fidelity === "revision_optimistic"
      ? copy.app.replay.revisionOptimisticNote
      : copy.app.replay.pointInTimeNote,
    { goLive: f.date(INGESTION_GO_LIVE) },
  );
}

export default function TimeMachineScreen() {
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const day = replayDay(params.episode);
  // The replayed day is the selection, so the scenario in the address bar
  // follows it — and it is validated under the replay's own `target_date`
  // clause, which is the shape and then somebody else's judgement. The window
  // verdict belongs to the replayable predicate on the server, which reads the
  // fold calendar; restating any of it here would put a second implementation
  // of that predicate on the far side of a network hop.
  const scenarioState = useScenario(day.subsystem, day.date, {
    targetDate: replayTargetDate,
    followTargetDate: true,
  });
  // Before the refusal branch below, because a hook cannot be called
  // conditionally. It parks itself on a `null` scenario.
  const state = useReplay(scenarioState.scenario);

  const picker = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {REPLAY_DAYS.map((candidate) => (
        <MiniPill
          key={candidate.id}
          label={dayLabel(candidate, copy, f)}
          active={candidate.id === day.id}
          onPress={() => params.setParams({ episode: candidate.id })}
        />
      ))}
    </View>
  );

  const frame = (right: ReactNode, body: ReactNode) => (
    <>
      <Head>
        <title>{copy.app.replay.metaTitle}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell showSelection={false}>
        <ScreenTitle
          title={copy.app.replay.title}
          lede={copy.app.replay.lede}
          right={right}
        />
        {picker}
        {body}
      </AppShell>
    </>
  );

  // A scenario the refusal table would not let near a solver never gets a
  // replay drawn for it. The code is rendered from the dictionaries; the
  // gateway's own developer prose is not on this screen and never reaches a
  // reader.
  if (scenarioState.scenario === null) {
    const code = scenarioState.readout.ok ? "BAD_INPUT" : scenarioState.readout.code;
    return frame(null, <Refusal code={code} onReset={scenarioState.reset} />);
  }

  if (state.status === "refused") {
    return frame(null, <Refusal code={state.code} onReset={scenarioState.reset} />);
  }

  // In flight. An absence, not a skeleton of numbers that are not there yet.
  if (state.status === "replaying") {
    return frame(
      null,
      <HonestyNote
        title={copy.app.replay.replayingTitle}
        tone="neutral"
        points={[copy.app.replay.replayingNote]}
      />,
    );
  }

  const scenario = scenarioState.scenario;
  const fleet = (
    <FleetControls
      scenario={scenario}
      onBattery={(next) => scenarioState.update(withBattery(scenario, next))}
      onLoad={(next) => scenarioState.update(withLoad(scenario, next))}
      onReset={scenarioState.reset}
    />
  );

  if (state.status === "observedOnly") {
    return frame(null, <ObservedOnly view={state.view} fleet={fleet} />);
  }

  return frame(
    <ForecastStamp
      origin={state.replay.forecastOrigin}
      thresholdMw={state.replay.thresholdMw}
    />,
    <Replayed replay={state.replay} fleet={fleet} />,
  );
}

/**
 * The replayed day.
 *
 * The order on screen is the argument: the honesty block, then one headline for
 * recovered energy with the promised floor beside it, then the comparison, then
 * the two profiles, then the fenced upper bound, then the episodes, then the
 * fleet. Nothing above the honesty block, and nothing collapsible in it.
 */
function Replayed({ replay, fleet }: { replay: Replay; fleet: ReactNode }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();

  const episode = replay.episodes[0];
  const rows: CompareRow[] = [
    {
      key: "actual",
      label: copy.app.replay.rowActual,
      // `actual.total_mwh`: the whole local day. An episode is the run of hours
      // above the threshold, so using it here would make the headline share
      // move when the threshold moves — the reduction would look better simply
      // for having drawn the episode more tightly.
      value: replay.actual.totalMwh,
      tone: "actual",
      note:
        episode === undefined
          ? undefined
          : fill(copy.app.replay.rowActualNote, {
              hours: f.number(episode.durationHours),
              mw: f.number(episode.thresholdMw),
              peak: f.number(replay.actual.peakMw),
            }),
    },
    {
      key: "forecast",
      label: copy.app.replay.rowForecast,
      // `forecast.day_total` off the payload, not the componentwise sum of the
      // hourly ones. Quantiles are not additive: adding 24 P90s assumes every
      // hour lands at its 90th percentile together, which describes a day far
      // worse than a 90th-percentile day. The forecaster emits a path ensemble
      // precisely so the joint total exists on the contract, and
      // `test/no-summed-bands.test.ts` is the standing guard that no web code
      // path rebuilds it.
      band: replay.forecast.dayTotal,
      tone: "forecast",
      note: copy.app.replay.rowForecastNote,
    },
    {
      key: "remaining",
      label: copy.app.replay.rowRemaining,
      value: replay.optimizedCurtailmentMwh,
      tone: "recovered",
      note: copy.app.replay.rowRemainingNote,
    },
  ];

  return (
    <>
      <HonestyNote
        title={copy.app.replay.honestyTitle}
        right={
          <View style={{ flexDirection: "row", gap: 6 }}>
            <ProvenanceBadge provenance={replay.integrity.provenance} />
            <VintageBadge fidelity={replay.vintageFidelity} />
          </View>
        }
        points={[
          provenanceNote(replay, copy, f),
          vintageNote(replay.vintageFidelity, copy, f),
          ...vintageExtent(replay.integrity, copy),
          copy.app.replay.scenarioNote,
          copy.app.replay.claimsNote,
        ]}
      />

      {/*
        One headline, because absorbed, recovered and avoided are one quantity
        with three names and three boxes would imply three facts. Beside it, the
        promise the product made at D−1 and whether the day cleared it.
      */}
      <Panel>
        <PanelHeader
          icon={<ZapIcon size={18} color={colors.inkMuted} />}
          title={copy.app.replay.headlineRecovered}
          subtitle={copy.app.replay.scoredOnObserved}
        />
        <View
          style={{
            marginTop: space.lg,
            flexDirection: "row",
            flexWrap: "wrap",
            gap: space.xl,
          }}
        >
          <View style={{ flexGrow: 1, flexBasis: 300, gap: 6 }}>
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
                {f.compact(replay.avoidedEnergyMwh)}
              </Text>
              <Text style={{ fontSize: 16, fontWeight: "500", color: colors.inkMuted }}>
                MWh
              </Text>
            </View>
            <Text style={{ fontSize: 13, lineHeight: 21, color: colors.inkMuted }}>
              {fill(copy.app.replay.headlineSentence, {
                recovered: f.compact(replay.avoidedEnergyMwh),
                actual: f.compact(replay.actual.totalMwh),
              })}
            </Text>
          </View>

          <View style={{ flexGrow: 1, flexBasis: 260, gap: space.sm }}>
            <Beside
              label={copy.app.replay.floorLabel}
              value={`${f.compact(replay.recoveredFloorMwh)} MWh`}
            />
            <Beside
              label={copy.app.replay.floorMetLabel}
              value={
                replay.floorMet ? copy.app.replay.floorMet : copy.app.replay.floorMissed
              }
            />
            <Beside
              label={copy.app.replay.floorMarginLabel}
              value={`${f.compact(replay.floorMarginMwh)} MWh`}
            />
            <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
              {copy.app.replay.floorNote}
            </Text>
          </View>
        </View>
      </Panel>

      {/*
        Avoidability, on the day total. `null` is "there was nothing to avoid",
        which is a different statement from 0 % and is rendered as one: no hour
        of this day reached the threshold, so the ratio has no denominator worth
        dividing by rather than a numerator that came out at zero.
      */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Panel style={{ flexGrow: 1, flexBasis: 300, gap: space.sm }}>
          <Text style={{ fontSize: 13, color: colors.inkMuted }}>
            {copy.app.replay.headlineAvoided}
          </Text>
          <Text
            style={{
              fontSize: 40,
              lineHeight: 46,
              fontWeight: "600",
              letterSpacing: -0.8,
              fontVariant: ["tabular-nums"],
              color: replay.avoidability === null ? colors.inkFaint : colors.ink,
            }}
            accessibilityLabel={
              replay.avoidability === null
                ? fill(copy.app.replay.avoidabilityUndefined, {
                    mw: f.number(replay.thresholdMw),
                  })
                : undefined
            }
          >
            {replay.avoidability === null
              ? "—"
              : `↓ ${f.percent(replay.avoidability, 1)}`}
          </Text>
          <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
            {replay.avoidability === null
              ? fill(copy.app.replay.avoidabilityUndefined, {
                  mw: f.number(replay.thresholdMw),
                })
              : copy.app.replay.avoidabilityNote}
          </Text>
        </Panel>
        <Panel style={{ flexGrow: 1, flexBasis: 300, gap: space.sm }}>
          <Text style={{ fontSize: 13, color: colors.inkMuted }}>
            {copy.app.replay.headlineCurtailed}
          </Text>
          <Text
            style={{
              fontSize: 40,
              lineHeight: 46,
              fontWeight: "600",
              letterSpacing: -0.8,
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {`${f.compact(replay.actual.totalMwh)} MWh`}
          </Text>
          <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
            {copy.app.replay.denominatorNote}
          </Text>
        </Panel>
      </View>

      <Panel>
        <PanelHeader
          icon={<RotateCcwIcon size={18} color={colors.inkMuted} />}
          title={copy.app.replay.compareTitle}
          subtitle={copy.app.replay.compareSubtitle}
        />
        <View style={{ marginTop: space.lg }}>
          <CompareBars rows={rows} />
        </View>
      </Panel>

      <Panel>
        <PanelHeader
          icon={<ClockIcon size={18} color={colors.inkMuted} />}
          title={copy.app.replay.hourlyTitle}
          subtitle={copy.app.replay.hourlySubtitle}
        />
        <View style={{ marginTop: space.lg }}>
          <FanChart
            hours={forecastHours(replay.targetDate, replay.forecast.hours)}
            observed={observedHours(replay.targetDate, replay.actual.hours)}
            thresholdMw={replay.thresholdMw}
            observedLabel={copy.app.replay.settledActual}
          />
        </View>
      </Panel>

      {/*
        Two series, because drawing one is what makes "planned against P50" get
        read as "assumed P50 came true".
      */}
      <Panel>
        <PanelHeader
          icon={<ZapIcon size={18} color={colors.inkMuted} />}
          title={copy.app.replay.planVsExecutedTitle}
          subtitle={copy.app.replay.planVsExecutedSubtitle}
        />
        <View style={{ marginTop: space.lg }}>
          <PlanVsExecuted
            scheduled={dispatchSeries(replay.dispatch)}
            executed={dispatchSeries(replay.executed)}
            actualHours={replay.actual.hours}
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
          {copy.app.replay.planVsExecutedNote}
        </Text>
      </Panel>

      <PerfectForesight
        recoveredMwh={replay.upperBound.recoveredMwh}
        avoidability={replay.upperBound.avoidability}
        gapMwh={replay.upperBound.forecastValueGapMwh}
      />

      <Episodes episodes={replay.episodes} maxGapHours={replay.maxGapHours} />

      {fleet}
    </>
  );
}

/**
 * A pre-F1 day: what happened, and the bound. No plan, and no number for a plan
 * that was never built.
 *
 * `docs/specs/replay.md` refuses these days rather than labelling them, and
 * pays a year of the window for it: every artifact was fitted on
 * 2024-04 → 2025-03, so an out-of-sample forecast for a day inside it does not
 * exist, and a recovered figure computed from an in-sample fit is an upper
 * bound of unknown size. The screen says which clause refused it, in one
 * sentence and from the typed code, and then shows the two things that need no
 * model: the settled day and what perfect foresight could have taken out of it.
 *
 * `scored`, `avoided_energy_mwh` and `recovered_floor_mwh` are **absent** here
 * rather than zero, and the screen renders no placeholder for them: a zero
 * would be a claim about a plan WattSteer was never asked to build.
 */
function ObservedOnly({ view, fleet }: { view: ReplayObservedOnly; fleet: ReactNode }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <>
      <HonestyNote
        title={copy.app.replay.observedOnlyTitle}
        right={<VintageBadge fidelity={view.vintageFidelity} />}
        points={[
          // The typed code, rendered in the reader's locale. The envelope's own
          // `message` is developer prose for a log and never reaches a screen.
          copy.error[view.refusal.code],
          copy.app.replay.observedOnlyNote,
          vintageNote(view.vintageFidelity, copy, f),
          copy.app.replay.claimsNote,
        ]}
      />

      <Panel style={{ gap: space.sm }}>
        <Text style={{ fontSize: 13, color: colors.inkMuted }}>
          {copy.app.replay.headlineCurtailed}
        </Text>
        <Text
          style={{
            fontSize: 40,
            lineHeight: 46,
            fontWeight: "600",
            letterSpacing: -0.8,
            fontVariant: ["tabular-nums"],
            color: colors.ink,
          }}
        >
          {`${f.compact(view.actual.totalMwh)} MWh`}
        </Text>
        <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
          {copy.app.replay.denominatorNote}
        </Text>
      </Panel>

      <PerfectForesight
        recoveredMwh={view.upperBound.recoveredMwh}
        avoidability={view.upperBound.avoidability}
        gapMwh={null}
      />

      <Episodes episodes={view.episodes} maxGapHours={view.maxGapHours} />

      {fleet}
    </>
  );
}

/**
 * The perfect-foresight bound, in its own block and carrying its label
 * verbatim.
 *
 * `docs/specs/replay.md` fences it and the fence is the point: it lives under
 * `upper_bound`, never in `avoided_energy_mwh` and never in `scored`, and a
 * test asserts no headline field can be populated from it. On screen the fence
 * is visual as well as structural — a separate block with its own border, no
 * panel header, and the label spelled out rather than compressed into a word
 * like "potential".
 *
 * The gap is `forecast_value_gap_mwh`: perfect foresight minus what the plan
 * achieved, which is the only honest use of a hindsight number. It is absent on
 * an observed-only day rather than zero, because WattSteer achieved nothing
 * there — it was never asked.
 */
function PerfectForesight({
  recoveredMwh,
  avoidability,
  gapMwh,
}: {
  recoveredMwh: number;
  avoidability: number | null;
  gapMwh: number | null;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: colors.borderStrong,
        backgroundColor: colors.surfaceSunken,
        padding: space.lg,
        gap: space.sm,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: "700", color: colors.ink }}>
        {copy.app.replay.foresightLabel}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xl }}>
        <Scalar
          label={copy.app.replay.foresightRecovered}
          value={`${f.compact(recoveredMwh)} MWh`}
        />
        <Scalar
          label={copy.app.replay.foresightAvoidability}
          value={avoidability === null ? "—" : f.percent(avoidability, 1)}
        />
        {gapMwh === null ? null : (
          <Scalar
            label={copy.app.replay.foresightGap}
            value={`${f.compact(gapMwh)} MWh`}
          />
        )}
      </View>
      <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
        {copy.app.replay.foresightNote}
      </Text>
    </View>
  );
}

/**
 * The episodes, each carrying the parameters that produced it.
 *
 * An episode is a read-time view of hours and never a stored row, so an
 * unstamped duration cannot be compared with another one: the threshold and the
 * gap tolerance travel on the response and are printed beside every episode
 * rather than assumed by the screen.
 */
function Episodes({
  episodes,
  maxGapHours,
}: {
  episodes: CurtailmentEpisode[];
  maxGapHours: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  if (episodes.length === 0) {
    return null;
  }
  return (
    <Panel>
      <PanelHeader
        icon={<LayersIcon size={18} color={colors.inkMuted} />}
        title={copy.app.replay.episodesTitle}
        subtitle={copy.app.replay.episodesSubtitle}
      />
      <View style={{ marginTop: space.lg, gap: space.sm }}>
        {episodes.map((episode) => (
          <Text
            key={episode.startedAt}
            style={{
              fontSize: 12,
              lineHeight: 19,
              color: colors.inkMuted,
              fontVariant: ["tabular-nums"],
            }}
          >
            {fill(copy.app.replay.episodeRow, {
              from: f.dateTime(episode.startedAt),
              to: f.dateTime(episode.endedAt),
              hours: f.number(episode.durationHours),
              mwh: f.compact(episode.totalMwh),
              peak: f.number(episode.peakMw),
              mw: f.number(episode.thresholdMw),
              gap: f.number(episode.maxGapHours),
            })}
          </Text>
        ))}
      </View>
      <Text
        style={{
          marginTop: space.md,
          fontSize: 11,
          lineHeight: 18,
          color: colors.inkFaint,
        }}
      >
        {fill(copy.app.replay.episodeNote, { gap: f.number(maxGapHours) })}
      </Text>
    </Panel>
  );
}

/**
 * The fleet, edited in place.
 *
 * The same editors Mitigate uses, on the same URL-carried `Scenario` — and the
 * note beside them states the property that makes this screen a replay: moving
 * a slider re-plans and re-scores, and it cannot re-forecast, because the
 * forecast in the request path is a pinned historical row and no interaction
 * can reach a model.
 */
function FleetControls({
  scenario,
  onBattery,
  onLoad,
  onReset,
}: {
  scenario: Scenario;
  onBattery: (next: BatteryAsset) => void;
  onLoad: (next: ShiftableLoadAsset) => void;
  onReset: () => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
          <PanelHeader
            icon={<ZapIcon size={18} color={colors.inkMuted} />}
            title={copy.app.replay.batteryTitle}
            subtitle={copy.app.replay.fleetSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <BatteryEditor
              battery={fixtureBattery(scenarioBattery(scenario))}
              onChange={onBattery}
            />
          </View>
        </Panel>
        <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
          <PanelHeader
            icon={<SlidersHorizontalIcon size={18} color={colors.inkMuted} />}
            title={copy.app.replay.loadTitle}
            subtitle={copy.app.replay.fleetSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <LoadEditor load={fixtureLoad(scenarioLoad(scenario))} onChange={onLoad} />
          </View>
        </Panel>
      </View>

      <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
        <Pill label={copy.app.replay.fleetReset} tone="secondary" onPress={onReset} />
      </View>

      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {copy.app.replay.fleetNote}
      </Text>
    </>
  );
}

/**
 * A refused replay, named by its code.
 *
 * The reader gets `copy.error[code]` in their own locale, and the codes that
 * reach here — no held-out forecast, an unsettled day, a date outside the
 * window, a failed held-out assertion — each say which clause failed. There is
 * no path by which the gateway's English developer prose reaches this screen,
 * and there is no caveated answer offered in place of the refusal.
 */
function Refusal({ code, onReset }: { code: ErrorCode; onReset: () => void }) {
  const copy = useCopy();
  const colors = usePalette();
  return (
    <View style={{ gap: space.lg }}>
      <HonestyNote
        title={copy.app.replay.refusalTitle}
        tone="warning"
        points={[copy.error[code], copy.app.replay.refusalNote]}
      />
      <View style={{ flexDirection: "row" }}>
        <Pill label={copy.app.replay.refusalReset} tone="secondary" onPress={onReset} />
      </View>
      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {copy.app.replay.shareNote}
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

/** A labelled scalar inside the fenced block. */
function Scalar({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View style={{ flexGrow: 1, flexBasis: 200, gap: 4 }}>
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
