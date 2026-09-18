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
import { type ReactNode, useEffect } from "react";
import { Text, View } from "react-native";
import { AppShell, MiniPill, ScreenTitle } from "@/components/app/app-shell";
import { BatteryEditor, LoadEditor } from "@/components/app/asset-editor";
import {
  ForecastStamp,
  HonestyNote,
  ProvenanceBadge,
  VintageBadge,
} from "@/components/app/honesty";
import { AccuracyPanel } from "@/components/app/replay/accuracy-panel";
import {
  fixtureBattery,
  fixtureLoad,
  scenarioBattery,
  scenarioLoad,
  withBattery,
  withLoad,
} from "@/components/app/scenario";
import { ReadingState } from "@/components/app/thinking-orb";
import { useAppParams } from "@/components/app/use-app-params";
import { useReplay } from "@/components/app/use-replay";
import { useReplayDays } from "@/components/app/use-replay-days";
import { useScenario } from "@/components/app/use-scenario";
import { useServing } from "@/components/app/use-serving";
import { NO_BRIEFING_DATA } from "@/components/briefing/briefing-data";
import { usePublishBriefingSubject } from "@/components/briefing/briefing-subject";
import { CompareBars, type CompareRow } from "@/components/charts/compare-bars";
import { EpisodeList } from "@/components/charts/episode-list";
import { FanChart } from "@/components/charts/fan-chart";
import { PlanVsExecuted } from "@/components/charts/plan-vs-executed";
import { type Copy, type Formatters, useCopy, useFormat, useI18n } from "@/i18n";
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
  const palette = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const serving = useServing();
  const params = useAppParams();
  const day = replayDay(params.episode);
  const days = useReplayDays();
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

  /*
    Published for the briefing host. Máquina do tempo is the screen that
    re-scored the day, so it is the only one that can hand over a
    plan-beside-what-happened comparison — `compose.ts` emits the `comparison`
    scene only where these rows exist, which is here and nowhere else.
  */
  usePublishBriefingSubject({
    context: { locale, screen: "replay", params, serving },
    data: {
      ...NO_BRIEFING_DATA,
      comparison: state.status === "replayed" ? compareRows(state.replay, copy, f) : null,
    },
    counterfactual: undefined,
  });

  /*
    **Do not sit on a day that cannot answer.**

    The same rule `use-run-lanes.ts` applies to the D−1 gates, for the same
    reason: a link or a default can name a day the deployment has no forecast
    for, and the honest response is to move to one it does rather than render a
    refusal the reader cannot act on. Only ever *towards* a day that answers; if
    none do, the refusal is the truth and the screen says so.
  */
  useEffect(() => {
    if (days.status !== "known" || days.viewable.length === 0) {
      return;
    }
    if (!days.viewable.some((candidate) => candidate.id === day.id)) {
      params.setParams({ episode: days.viewable[0]?.id });
    }
  }, [days, day.id]);

  /*
    **Only the days the deployment can actually show.**

    The picker listed all four candidates and three of them were dead ends —
    press, wait, read `REPLAY_FORECAST_UNAVAILABLE`. `useReplayDays` asks the
    gateway which ones answer; see its header for the measurement and for why
    this is probed rather than a shorter list.

    While probing, the selected day is the only pill: a picker that grows from
    one to four as requests land is worse than one that starts honest, and the
    reader can already see the day they are on.
  */
  const offered =
    days.status === "known"
      ? days.viewable
      : REPLAY_DAYS.filter((candidate) => candidate.id === day.id);

  const picker = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {offered.map((candidate) => (
        <MiniPill
          key={candidate.id}
          label={dayLabel(candidate, copy, f)}
          active={candidate.id === day.id}
          onPress={() => params.setParams({ episode: candidate.id })}
        />
      ))}
      {days.status === "known" && days.viewable.length === 0 ? (
        <Text style={{ fontSize: 13, color: palette.inkMuted }}>
          {copy.app.replay.noDays}
        </Text>
      ) : null}
    </View>
  );

  /**
   * Whether a replay was scored, which the lede turns on.
   *
   * The same rule the other three screens now follow. `observedOnly` is the
   * pointed case: that branch deliberately offers the settled day *instead* of
   * a replay, and its own copy says there is "no recovered figure and no share
   * avoided — not zero, absent". A lede above it still promising a day "scored
   * against what ONS settled" contradicts the panel it introduces.
   */
  const scored = state.status === "replayed";

  const frame = (right: ReactNode, body: ReactNode) => (
    <>
      <Head>
        <title>{copy.app.replay.metaTitle}</title>
        <meta name="robots" content="noindex,follow" />
      </Head>
      <AppShell>
        <ScreenTitle
          title={copy.app.replay.title}
          lede={scored ? copy.app.replay.lede : copy.app.replay.ledeAbsent}
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

  // In flight. An absence, not a skeleton of numbers that are not there yet —
  // and an absence with its reason on it.
  //
  // This is the state a `web:export` build freezes on. `web.output` is
  // `static`, so every route is prerendered, and this screen's first render is
  // this note: replay 10 moved the Time Machine off fixtures and onto
  // `GET /v1/replay` because filling these boxes from a fixture would have
  // meant scoring a plan in the browser, which `test/one-execution-rule.test.ts`
  // forbids. That trade is not reopened here — the second point says what the
  // screen is waiting for and what it takes to see it, which is the courtesy
  // `band_unavailable_reason` and `UnmeasuredLeadTime` already extend on the
  // data side. A dead screen with no explanation is a bug report the reader
  // has to write themselves.
  if (state.status === "replaying") {
    return frame(
      null,
      <>
        {/*
          The orb, which this screen was the only waiting screen without.
          Visão da rede and Explicar both answer a wait with `ReadingState`;
          this one answered with a paragraph, and a replay is the *longest*
          wait in the product — it re-scores a past day rather than reading a
          published row. The screen with the most to wait for had the least
          to look at.

          The note stays underneath. It says which day is being re-scored and
          what it takes to see it, which a spinner cannot, and that pairing is
          the point: the orb says "working", the note says "on what".
        */}
        <ReadingState title={copy.app.replay.replayingTitle} />
        <HonestyNote
          title={copy.app.replay.replayingTitle}
          tone="neutral"
          points={[copy.app.replay.replayingNote, copy.app.replay.replayingLive]}
        />
      </>,
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
 *
 * The comparison rows are built by `compareRows` above, so this screen and any
 * briefing over it quote the same three figures.
 */
/**
 * What was forecast, what happened and what a plan would have left — one list,
 * built once.
 *
 * Extracted so the screen and the briefing read the *same* rows. Two builders
 * for one comparison is two things to drift, and a briefing quoting different
 * figures from the screen it overlays is the worst version of that.
 */
function compareRows(replay: Replay, copy: Copy, f: Formatters): CompareRow[] {
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
  return rows;
}

function Replayed({ replay, fleet }: { replay: Replay; fleet: ReactNode }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();

  const rows = compareRows(replay, copy, f);

  return (
    <>
      {/*
        **First, because it is the question a reader came with.**

        Everything below this is about the optimizer — the floor, the
        avoidability, the plan against the executed. All of it assumes the
        forecast was worth planning against, and until now the screen never
        said whether it was. The three figures were already here and were never
        subtracted.
      */}
      <AccuracyPanel band={replay.forecast.dayTotal} settled={replay.actual.totalMwh} />

      <HonestyNote
        title={copy.app.replay.honestyTitle}
        right={
          // Two badges whose words are long — `RETIDO NO FOLD` beside
          // `OTIMISTA POR REVISÃO` is 294px, and the card is 244 at 320px. The
          // row wraps rather than the pair clipping.
          // `flexShrink: 1` as well as the wrap: a flex item that cannot shrink
          // never reaches the width at which its own wrap would trigger, so the
          // pair held 294px inside a 244px card and the wrap alone did nothing.
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, flexShrink: 1 }}>
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
          {/*
            `flexBasis: 300` with no shrink is a floor, not a preference: at
            320px the column has 278 and held 300, so the sentence under the
            figure ran 22px past the card. ADR-0001 again — react-native-web
            gives `flexShrink` a 0 default, so a basis wider than the box never
            gives the difference back.
          */}
          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 300, gap: 6 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "baseline",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
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

          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 260, gap: space.sm }}>
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
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 300, gap: space.sm }}>
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
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 300, gap: space.sm }}>
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
  const copy = useCopy();
  const f = useFormat();
  /*
    **`EpisodeList`, not a second copy of it.** This screen carried its own
    rendering of the same list — the same fields, the same order, its own
    `episodeRow` sentence — which is exactly what `EpisodeList`'s docstring was
    written to prevent: *"Two spellings of the same list would be two places the
    threshold could stop being printed."* It had already become two places the
    list could stop being readable: the Overview's became a table and this one
    stayed a wall of prose.

    The words are still this screen's own. `EpisodeList` takes its title,
    subtitle, footnote and empty sentence as props for the reason its docstring
    gives — one panel covers a past day and the other a fortnight, and a
    component that owned the subtitle would say "this day" on both.
  */
  return (
    <EpisodeList
      episodes={episodes}
      maxGapHours={maxGapHours}
      title={copy.app.replay.episodesTitle}
      subtitle={fill(copy.app.replay.episodesSubtitle, {
        mw: f.number(episodes[0]?.thresholdMw ?? 0),
      })}
      columns={copy.app.replay.episodeColumns}
      note={copy.app.replay.episodeNote}
      empty={copy.app.replay.episodesEmpty}
    />
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
        // ADR-0001: a basis without a shrink is a floor. 380 in a 320px box put the //
        fleet editor 60px past the card, and nothing on the Time Machine caught // it
        because `/v1/replay` was never stubbed and this branch never rendered.
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380 }}>
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
        // ADR-0001: a basis without a shrink is a floor. 380 in a 320px box put the //
        fleet editor 60px past the card, and nothing on the Time Machine caught // it
        because `/v1/replay` was never stubbed and this branch never rendered.
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380 }}>
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
