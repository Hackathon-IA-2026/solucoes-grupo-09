/**
 * The Time Machine, as a dashboard — `/app/time-machine`.
 *
 * Served **beside** `/app/replay`, not instead of it, while the layout is
 * checked: both read the same replay of the same day, so a reader can hold the
 * two up against each other and every number should agree.
 *
 * ## What it adds, and what it declined
 *
 * The layout is a reviewer's mock of a one-page day review, and most of it is
 * buildable honestly: the D−1 band beside the settled day, the four subsystems
 * against their bands, the two gates and the settled record on one timeline,
 * the evidence beside the forecast, and every identity behind the day. Four of
 * its panels are not, and each was replaced rather than drawn:
 *
 * - **"Accuracy 92 %" / MAPE** became the band's measured coverage over many
 *   days. One day cannot produce an accuracy, and a percentage error on a day
 *   whose hours are mostly zero is undefined.
 * - **"Probable cause" with a confidence score** became ONS's stated reason and
 *   the document behind it. WattSteer forecasts how much; the reason is ONS's.
 * - **Intraday revisions** ("pré-operação", "tempo real") do not exist —
 *   day-ahead is the only horizon — so the timeline has the two D−1 gates, the
 *   settled record and ONS's rewrite of it, and says so.
 * - **"Lessons learned" and model-tuning recommendations** became ONS's own
 *   programme beside what the grid did, stated as facts, and what the fleet
 *   would have absorbed. A lesson drawn from one day is a cause asserted from
 *   one day, and a change to the model is the gate's decision, not a screen's.
 *
 * ## The rules this screen keeps, which are the replay's
 *
 * The honesty block comes first and is not collapsible. Nothing is computed
 * here: the deviation and the placement come from `replay-accuracy.ts` for the
 * pinned day and from the server for the comparison and the timeline, the
 * national band is the joint row, and every absence is a sentence from the
 * dictionaries. The fleet controls re-plan and never re-forecast.
 */

import {
  encodeScenario,
  replayTargetDate,
  SUBSYSTEM_DISPLAY_ORDER,
  subsystemMeta,
} from "@wattsteer/core";
import type { Replay } from "@wattsteer/core/api";
import {
  ArrowUpDownIcon,
  CalendarDaysIcon,
  CheckIcon,
  Panel,
  PanelHeader,
  PieChartIcon,
  Pill,
  radius,
  SlidersHorizontalIcon,
  space,
  TrendingUpIcon,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import { type ReactNode, useEffect } from "react";
import { Text, View } from "react-native";
import { AnswerFeedback } from "@/components/app/answer-feedback";
import { AppShell, MiniPill, ScreenTitle } from "@/components/app/app-shell";
import { BatteryEditor, LoadEditor } from "@/components/app/asset-editor";
import { useCoverage } from "@/components/app/figures/use-coverage";
import { useSimilarDays } from "@/components/app/figures/use-similar-days";
import {
  ForecastStamp,
  HonestyNote,
  ProvenanceBadge,
  VintageBadge,
} from "@/components/app/honesty";
import { PlanVsActualPanel } from "@/components/app/overview/plan-vs-actual-panel";
import {
  fixtureBattery,
  fixtureLoad,
  scenarioBattery,
  scenarioLoad,
  withBattery,
  withLoad,
} from "@/components/app/scenario";
import { ReadingState } from "@/components/app/thinking-orb";
import { EvidenceTabs } from "@/components/app/time-machine/evidence-tabs";
import { GateTimeline } from "@/components/app/time-machine/gate-timeline";
import { KpiCard } from "@/components/app/time-machine/kpi-card";
import { SubsystemTable } from "@/components/app/time-machine/subsystem-table";
import { TraceabilityPanel } from "@/components/app/time-machine/traceability-panel";
import { useAppParams } from "@/components/app/use-app-params";
import { useGridContext } from "@/components/app/use-grid-context";
import { useReplay } from "@/components/app/use-replay";
import { useReplayDays } from "@/components/app/use-replay-days";
import {
  useDayReasons,
  useReplayAttribution,
  useReplayCompare,
  useReplayTimeline,
} from "@/components/app/use-replay-review";
import { useScenario } from "@/components/app/use-scenario";
import { EpisodeList } from "@/components/charts/episode-list";
import { PlanVsExecuted } from "@/components/charts/plan-vs-executed";
import { ReviewChart } from "@/components/charts/review-chart";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { dayLabel, provenanceNote, vintageExtent, vintageNote } from "@/i18n/replay";
import { mwh, signedMwh } from "@/i18n/time-machine";
import { apiUrl } from "@/lib/api-url";
import { API_URL } from "@/lib/config";
import { replayDay, replayDayId, type SubsystemCode } from "@/lib/fixtures";
import { dispatchSeries, forecastHours, observedHours, REPLAY_LANE } from "@/lib/replay";
import { forecastError, placementOf } from "@/lib/replay-accuracy";
import { likelyWindow, replayableSubsystems } from "@/lib/time-machine";

/** How many recent days the picker shows before it folds. */
const FOLDED_DAYS = 8;

export default function TimeMachineDashboard() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine;
  const params = useAppParams();
  const day = replayDay(params.episode);
  const days = useReplayDays(day.subsystem);
  const scenarioState = useScenario(day.subsystem, day.date, {
    targetDate: replayTargetDate,
    followTargetDate: true,
  });
  const state = useReplay(scenarioState.scenario);
  const compare = useReplayCompare(day.date, REPLAY_LANE);
  const timeline = useReplayTimeline(day.date, day.subsystem);
  const attribution = useReplayAttribution(day.date, day.subsystem, REPLAY_LANE);
  const reasons = useDayReasons(day.date, day.subsystem);
  const analogues = useSimilarDays(day.subsystem, day.date, "gate_late");
  const coverage = useCoverage("gate_late");
  const context = useGridContext(day.subsystem, day.date);

  /*
    **Do not sit on a day that cannot answer** — the rule `/app/replay` applies,
    for its reason: a default or a link can name a day the deployment has no
    forecast for, and the honest move is towards one it does.

    `params.setParams` is a new function on every render of `useAppParams`, and
    listing it would re-run this effect each render; the probe's answer and the
    selected day are what decide it, and both are listed.
  */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note above
  useEffect(() => {
    if (days.status !== "known" || days.viewable.length === 0) {
      return;
    }
    if (!days.viewable.some((candidate) => candidate.id === day.id)) {
      params.setParams({ episode: days.viewable[0]?.id });
    }
  }, [days, day.id]);

  const offered = days.status === "known" ? days.viewable : [day];
  const shown = offered.slice(0, FOLDED_DAYS).some((candidate) => candidate.id === day.id)
    ? offered.slice(0, FOLDED_DAYS)
    : [day, ...offered.slice(0, FOLDED_DAYS - 1)];

  // Only the subsystems the comparison says can answer are pressable, so the
  // pill never moves a reader onto a refusal it already knew about.
  const answering =
    compare.status === "read"
      ? replayableSubsystems(compare.value)
      : new Set<SubsystemCode>();
  const selectSubsystem = (code: SubsystemCode) =>
    params.setParams({ episode: replayDayId(day.date, code) });

  const controls = (
    <View style={{ gap: space.sm }}>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
      >
        {shown.map((candidate) => (
          <MiniPill
            key={candidate.id}
            label={dayLabel(candidate, copy, f)}
            active={candidate.id === day.id}
            onPress={() => params.setParams({ episode: candidate.id })}
          />
        ))}
      </View>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
      >
        <Text style={{ fontSize: 12, fontWeight: "600", color: colors.inkMuted }}>
          {text.subsystems}
        </Text>
        {SUBSYSTEM_DISPLAY_ORDER.map((code) => (
          <MiniPill
            key={code}
            label={subsystemMeta(code).short}
            active={code === day.subsystem}
            disabled={code !== day.subsystem && !answering.has(code)}
            disabledHint={text.subsystemUnavailable}
            onPress={() => selectSubsystem(code)}
          />
        ))}
        <View style={{ flexGrow: 1 }} />
        <Pill
          label={text.currentScreen}
          size="sm"
          tone="secondary"
          accessibilityRole="link"
          onPress={() => router.push(`/app/replay?episode=${day.id}`)}
        />
      </View>
    </View>
  );

  const scored = state.status === "replayed";
  const frame = (right: ReactNode, body: ReactNode) => (
    <>
      <Head>
        <title>{text.metaTitle}</title>
        <meta name="robots" content="noindex,follow" />
      </Head>
      <AppShell fullWidth={true}>
        <ScreenTitle
          title={text.title}
          lede={scored ? copy.app.timeMachine.lede : copy.app.timeMachine.ledeAbsent}
          right={right}
        />
        <Text style={{ fontSize: 12, lineHeight: 18, color: colors.inkFaint }}>
          {text.betaNote}
        </Text>
        {controls}
        {body}
      </AppShell>
    </>
  );

  if (scenarioState.scenario === null) {
    const code = scenarioState.readout.ok ? "BAD_INPUT" : scenarioState.readout.code;
    return frame(
      null,
      <HonestyNote
        title={copy.app.replay.refusalTitle}
        points={[copy.error[code], copy.app.replay.refusalNote]}
      />,
    );
  }
  if (state.status === "refused") {
    return frame(
      null,
      <HonestyNote
        title={copy.app.replay.refusalTitle}
        points={[copy.error[state.code], copy.app.replay.refusalNote]}
      />,
    );
  }
  if (state.status === "replaying") {
    return frame(
      null,
      <>
        <ReadingState title={copy.app.replay.replayingTitle} />
        <HonestyNote
          title={copy.app.replay.replayingTitle}
          tone="neutral"
          points={[copy.app.replay.replayingNote, copy.app.replay.replayingLive]}
        />
      </>,
    );
  }
  if (state.status === "observedOnly") {
    // A pre-F1 day: ONS's record and the comparison around it, and no number of
    // WattSteer's — every artifact was fitted on this day.
    return frame(
      null,
      <>
        <HonestyNote
          title={copy.app.replay.observedOnlyTitle}
          right={<VintageBadge fidelity={state.view.vintageFidelity} />}
          points={[
            copy.error[state.view.refusal.code],
            copy.app.replay.observedOnlyNote,
            vintageNote(state.view.vintageFidelity, copy, f),
          ]}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <View
            style={{
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: 420,
              minWidth: 0,
              gap: space.lg,
            }}
          >
            <GateTimeline state={timeline} />
          </View>
          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 420, minWidth: 0 }}>
            <SubsystemTable
              state={compare}
              selected={day.subsystem}
              onSelect={selectSubsystem}
            />
          </View>
        </View>
      </>,
    );
  }

  const replay = state.replay;
  const scenario = scenarioState.scenario;
  const auditLinks = [
    {
      key: "replay",
      label: text.audit.replay,
      url: auditUrl("/v1/replay", {
        d: day.date,
        s: encodeScenario(scenario),
        lane: REPLAY_LANE,
      }),
    },
    {
      key: "compare",
      label: text.audit.compare,
      url: auditUrl(`/v1/replay/compare/${day.date}`, { lane: REPLAY_LANE }),
    },
    {
      key: "timeline",
      label: text.audit.timeline,
      url: auditUrl(`/v1/replay/timeline/${day.date}`, { subsystem: day.subsystem }),
    },
    {
      key: "attribution",
      label: text.audit.attribution,
      url: auditUrl(`/v1/replay/attribution/${day.date}`, {
        subsystem: day.subsystem,
        lane: REPLAY_LANE,
      }),
    },
  ];

  return frame(
    <ForecastStamp origin={replay.forecastOrigin} thresholdMw={replay.thresholdMw} />,
    <>
      {/*
        **First, and not collapsible**, as on `/app/replay`: which artifact
        produced this forecast and how far the settled record can be trusted
        change what every number below means.
      */}
      <HonestyNote
        title={copy.app.replay.honestyTitle}
        columns={true}
        right={
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, flexShrink: 1 }}>
            <ProvenanceBadge provenance={replay.integrity.provenance} />
            <VintageBadge fidelity={replay.vintageFidelity} />
          </View>
        }
        points={[
          provenanceNote(replay, copy, f),
          vintageNote(replay.vintageFidelity, copy, f),
          ...vintageExtent(replay.integrity, copy),
          copy.app.replay.claimsNote,
        ]}
      />

      <Headline replay={replay} coverage={coverage} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Panel
          style={{
            flexGrow: 3,
            flexShrink: 1,
            flexBasis: 560,
            minWidth: 0,
            gap: space.md,
          }}
        >
          <PanelHeader
            icon={<CalendarDaysIcon size={18} color={colors.inkMuted} />}
            title={fill(text.chart.title, {
              subsystem: subsystemMeta(day.subsystem).onsDisplayName,
            })}
            subtitle={fill(text.chart.subtitle, { date: f.date(replay.targetDate) })}
          />
          <ReviewChart
            hours={forecastHours(replay.targetDate, replay.forecast.hours)}
            settled={observedHours(replay.targetDate, replay.actual.hours)}
            thresholdMw={replay.thresholdMw}
            window={likelyWindow(forecastHours(replay.targetDate, replay.forecast.hours))}
          />
          {/*
            Three day-grain figures the replay already carries, under the hours
            they summarise. The forecast peak is the ensemble's own band, never
            the largest hourly P50; the chance is the ensemble's day
            probability, never one hour's.
          */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: space.lg,
              paddingTop: space.md,
              borderTopWidth: 1,
              borderTopColor: colors.border,
            }}
          >
            <ChartFact
              label={text.chart.peakSettled}
              value={`${mwh(replay.actual.peakMw, f)} MW`}
              note={text.chart.peakSettledNote}
            />
            <ChartFact
              label={text.chart.peakForecast}
              value={`${mwh(replay.forecast.peakPower.p50, f)} MW`}
              note={fill(text.chart.peakForecastNote, {
                p10: mwh(replay.forecast.peakPower.p10, f),
                p90: mwh(replay.forecast.peakPower.p90, f),
              })}
            />
            <ChartFact
              label={text.chart.dayChance}
              value={f.percent(replay.forecast.dayOccurrenceProbability)}
              note={text.chart.dayChanceNote}
            />
          </View>
        </Panel>
        <View
          style={{
            flexGrow: 2,
            flexShrink: 1,
            flexBasis: 400,
            minWidth: 0,
            gap: space.lg,
          }}
        >
          <GateTimeline state={timeline} />
          <SubsystemTable
            state={compare}
            selected={day.subsystem}
            onSelect={selectSubsystem}
          />
        </View>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <EvidenceTabs
          attribution={attribution}
          analogues={analogues}
          reasons={reasons}
          audit={auditLinks}
        />
        <TraceabilityPanel replay={replay} timeline={timeline} />
        <View
          style={{
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 320,
            minWidth: 0,
            gap: space.sm,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <TrendingUpIcon size={18} color={colors.inkMuted} />
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.ink }}>
              {text.context.title}
            </Text>
          </View>
          <PlanVsActualPanel state={context} subsystem={day.subsystem} />
          <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
            {text.context.note}
          </Text>
        </View>
      </View>

      <Fleet replay={replay} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380, minWidth: 0 }}>
          <PanelHeader
            icon={<ZapIcon size={18} color={colors.inkMuted} />}
            title={copy.app.replay.batteryTitle}
            subtitle={copy.app.replay.fleetSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <BatteryEditor
              battery={fixtureBattery(scenarioBattery(scenario))}
              onChange={(next) => scenarioState.update(withBattery(scenario, next))}
            />
          </View>
        </Panel>
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380, minWidth: 0 }}>
          <PanelHeader
            icon={<SlidersHorizontalIcon size={18} color={colors.inkMuted} />}
            title={copy.app.replay.loadTitle}
            subtitle={copy.app.replay.fleetSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <LoadEditor
              load={fixtureLoad(scenarioLoad(scenario))}
              onChange={(next) => scenarioState.update(withLoad(scenario, next))}
            />
          </View>
        </Panel>
      </View>
      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {copy.app.replay.fleetNote}
      </Text>

      <AnswerFeedback
        surface="replay"
        subject={{
          subsystem: day.subsystem,
          targetDate: day.date,
          lane: REPLAY_LANE,
          artifactId: replay.forecastOrigin.runLabel,
        }}
        testID="time-machine-feedback"
      />
    </>,
  );
}

/** A gateway URL for the audit tab. The same base every read on the page uses. */
function auditUrl(path: string, query: Record<string, string | undefined>): string {
  const url = apiUrl(API_URL, path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * The five headline cards.
 *
 * The deviation is `forecastError` — the one subtraction `replay-accuracy.ts`
 * owns, of a measurement and one band's P50 — and the placement is
 * `placementOf`. The track record is coverage over many days; no card grades
 * this day with a percentage.
 */
function Headline({
  replay,
  coverage,
}: {
  replay: Replay;
  coverage: ReturnType<typeof useCoverage>;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine.kpi;
  const band = replay.forecast.dayTotal;
  const settled = replay.actual.totalMwh;
  const error = forecastError(band, settled);
  const placement = placementOf(band, settled);
  const window = likelyWindow(forecastHours(replay.targetDate, replay.forecast.hours));

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
      <KpiCard
        testID="kpi-forecast"
        tone="forecast"
        icon={<CalendarDaysIcon size={16} color={colors.violet} />}
        title={text.forecastTitle}
        kicker={text.forecastKicker}
        value={mwh(band.p50, f)}
        unit="MWh"
        lines={[
          fill(text.forecastBand, { p10: mwh(band.p10, f), p90: mwh(band.p90, f) }),
          window === null
            ? text.forecastNoWindow
            : fill(text.forecastWindow, {
                from: f.hour(window.fromHour),
                to: f.hour(window.toHour + 1),
              }),
        ]}
      />
      <KpiCard
        testID="kpi-settled"
        tone="settled"
        icon={<CheckIcon size={16} color={colors.ink} />}
        title={text.settledTitle}
        kicker={text.settledKicker}
        value={mwh(settled, f)}
        unit="MWh"
        lines={[fill(text.settledDeviation, { value: signedMwh(error, f) })]}
      />
      <KpiCard
        testID="kpi-deviation"
        tone="neutral"
        icon={<ArrowUpDownIcon size={16} color={colors.inkMuted} />}
        title={text.deviationTitle}
        kicker={text.deviationKicker}
        value={signedMwh(error, f)}
        unit="MWh"
        lines={[
          fill(copy.app.replay.accuracyPlacement[placement], {
            p10: mwh(band.p10, f),
            p90: mwh(band.p90, f),
          }),
        ]}
      />
      <KpiCard
        testID="kpi-coverage"
        tone="record"
        icon={<PieChartIcon size={16} color={colors.info} />}
        title={text.coverageTitle}
        kicker={text.coverageKicker}
        value={coverage.status === "read" ? f.percent(coverage.coverage.dayTotal) : null}
        absent={
          coverage.status === "reading"
            ? copy.app.timeMachine.refreshing
            : text.coverageAbsent
        }
        lines={
          coverage.status === "read"
            ? [
                fill(text.coverageValue, {
                  share: f.percent(coverage.coverage.dayTotal),
                  days: f.number(coverage.coverage.days),
                }),
                fill(text.coverageTarget, {
                  target: f.percent(coverage.coverage.target),
                }),
                ...(replay.integrity.provenance === "fold_holdout"
                  ? [text.coverageServingNote]
                  : []),
              ]
            : []
        }
      />
      <KpiCard
        testID="kpi-fleet"
        tone="fleet"
        icon={<ZapIcon size={16} color={colors.accentStrong} />}
        title={text.recoveredTitle}
        kicker={text.recoveredKicker}
        value={mwh(replay.avoidedEnergyMwh, f)}
        unit="MWh"
        lines={[
          fill(text.recoveredFloor, {
            floor: mwh(replay.recoveredFloorMwh, f),
            met: replay.floorMet ? copy.app.replay.floorMet : copy.app.replay.floorMissed,
          }),
          replay.avoidability === null
            ? fill(copy.app.replay.avoidabilityUndefined, {
                mw: f.number(replay.thresholdMw),
              })
            : `${copy.app.replay.headlineAvoided}: ${f.percent(replay.avoidability, 1)}`,
        ]}
      />
    </View>
  );
}

/**
 * What the fleet would have done: the scheduled and the executed dispatch as
 * two series, the fenced perfect-foresight bound, and the episodes.
 */
function Fleet({ replay }: { replay: Replay }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.replay;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
      <Panel style={{ flexGrow: 3, flexShrink: 1, flexBasis: 560, minWidth: 0 }}>
        <PanelHeader
          icon={<ZapIcon size={18} color={colors.inkMuted} />}
          title={copy.app.timeMachine.fleet.title}
          subtitle={copy.app.timeMachine.fleet.note}
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
          {text.planVsExecutedNote}
        </Text>
      </Panel>
      <View
        style={{ flexGrow: 2, flexShrink: 1, flexBasis: 380, minWidth: 0, gap: space.lg }}
      >
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
            {text.foresightLabel}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xl }}>
            <Scalar
              label={text.foresightRecovered}
              value={`${mwh(replay.upperBound.recoveredMwh, f)} MWh`}
            />
            <Scalar
              label={text.foresightGap}
              value={`${mwh(replay.upperBound.forecastValueGapMwh, f)} MWh`}
            />
          </View>
          <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
            {text.foresightNote}
          </Text>
        </View>
        <EpisodeList
          episodes={replay.episodes}
          maxGapHours={replay.maxGapHours}
          title={text.episodesTitle}
          subtitle={fill(text.episodesSubtitle, { mw: f.number(replay.thresholdMw) })}
          columns={text.episodeColumns}
          note={text.episodeNote}
          empty={text.episodesEmpty}
        />
      </View>
    </View>
  );
}

function ChartFact({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  const colors = usePalette();
  return (
    <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 0, gap: 4 }}>
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>{label}</Text>
      <Text
        style={{
          fontSize: 24,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
          color: colors.ink,
        }}
      >
        {value}
      </Text>
      <Text style={{ fontSize: 11, lineHeight: 16, color: colors.inkFaint }}>{note}</Text>
    </View>
  );
}

function Scalar({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 140, minWidth: 0, gap: 4 }}>
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>{label}</Text>
      <Text
        style={{
          fontSize: 22,
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
