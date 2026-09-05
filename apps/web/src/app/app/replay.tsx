/**
 * Screen 4 — Time Machine (IDEA.md §45 / §47).
 *
 * The pitch wants this screen to close with "612 MWh curtailed, 281 MWh
 * recoverable, ↓45.9%". It can — but only with the labelling in front of the
 * number rather than behind it, because two separate things are wrong with the
 * naive reading and neither is a detail:
 *
 *  1. **A replay of a period inside the model's training window is not a
 *     counterfactual.** The model has seen that day. Its D−1 "forecast" is an
 *     in-sample fit, and the recovered energy computed from it is an upper
 *     bound on what the live system would have achieved. The fixture
 *     deliberately contains days on both sides of the training cut so the
 *     screen has to distinguish them, and it does — a day inside the window
 *     gets a different, louder note than a day outside it.
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
 */

import {
  Badge,
  ClockIcon,
  Panel,
  PanelHeader,
  RotateCcwIcon,
  space,
  usePalette,
} from "@wattsteer/ui";
import Head from "expo-router/head";
import { Text, View } from "react-native";
import { AppShell, MiniPill, ScreenTitle } from "@/components/app/app-shell";
import { ForecastStamp, HonestyNote, VintageBadge } from "@/components/app/honesty";
import { useAppParams } from "@/components/app/use-app-params";
import { CompareBars, type CompareRow } from "@/components/charts/compare-bars";
import { FanChart } from "@/components/charts/fan-chart";
import { type Copy, type Formatters, useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  INGESTION_GO_LIVE,
  REPLAY_DAYS,
  type ReplayDay,
  replayDay,
  subsystemMeta,
} from "@/lib/fixtures";

/** The parts the caveat's two lists are drawn from, as the copy map spells them. */
type VintagePart = keyof Copy["app"]["replay"]["vintagePart"];

/**
 * A replayed day's name: the date in the reader's convention, then the ONS
 * subsystem and the technology. It used to be the stored string
 * "14 Sep 2025 · NORDESTE wind", which was English in the data layer and
 * an en-US date besides.
 */
function dayLabel(day: ReplayDay, copy: Copy, f: Formatters): string {
  return fill(copy.app.replay.dayLabel, {
    date: f.date(day.date),
    subsystem: subsystemMeta(day.episode.subsystem).onsDisplayName,
    technology: copy.app.technology[day.episode.technology].toLowerCase(),
  });
}

/**
 * The two sentences a `revision_optimistic` day owes a reader: *what* the
 * caveat touches, and *how big* it is.
 *
 * Both are read off the day rather than written here. The parts come from the
 * response's `vintageAffects` / `vintageExempt` and this function only spells
 * them, so a part the service stops claiming stops being named on screen; and
 * the size is `revisionPremiumRecoveredMwh`, which is `null` until ONS has
 * restated days held in both vintages. `null` renders as the word
 * **unmeasured** — never as a zero, and never as silence, because a caveat
 * whose size is not stated reads as a caveat that is small.
 *
 * Nothing is emitted for a `point_in_time` day: there is no restatement to
 * bound, and a sentence saying so would make the honest case look qualified.
 */
function vintageExtent(day: ReplayDay, copy: Copy): string[] {
  if (day.vintageFidelity !== "revision_optimistic") {
    return [];
  }
  const spell = (parts: readonly string[]): string =>
    parts
      .map((part) => copy.app.replay.vintagePart[part as VintagePart] ?? part)
      .join(", ");
  return [
    fill(copy.app.replay.vintageExtentNote, {
      affects: spell(day.vintageAffects),
      exempt: spell(day.vintageExempt),
    }),
    day.revisionPremiumRecoveredMwh === null
      ? copy.app.replay.revisionPremiumUnmeasured
      : fill(copy.app.replay.revisionPremiumMeasured, {
          mwh: day.revisionPremiumRecoveredMwh,
        }),
  ];
}

export default function TimeMachineScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const day = replayDay(params.episode);

  // The DAY total, not the episode total. An episode is the run of hours above
  // `threshold_mw`, so using it as the denominator makes the headline
  // "% avoided" move when the threshold moves — the reduction would look
  // better simply for having drawn the episode more tightly.
  const actual = day.observed.reduce((sum, h) => sum + h.constrainedOffMwh, 0);
  const remaining = actual - day.recoveredMwh;
  const avoidedShare = actual > 0 ? day.recoveredMwh / actual : null;

  // The forecast row is a band, because "what the model said at D−1" never was
  // a single number and drawing it as one beside a measured actual would be
  // exactly the dishonesty this screen exists to avoid.
  //
  // It is a JOINT day band carried on the fixture, not the componentwise sum
  // of the hourly ones. Quantiles are not additive: adding 24 P90s assumes
  // every hour lands at its 90th percentile together, which describes a day
  // far worse than a 90th-percentile day. This screen summed them until
  // `docs/specs/replay.md` caught it; the forecaster emits a path ensemble
  // precisely so the joint total exists.
  const forecastBand = day.forecastDayEnergy;

  const scenarioLabel = fill(copy.app.replay.scenarioLabel, {
    power: f.number(day.scenario.batteryPowerMw),
    energy: f.number(day.scenario.batteryEnergyMwh),
    shift: f.number(day.scenario.loadShiftMw),
  });

  const rows: CompareRow[] = [
    {
      key: "actual",
      label: copy.app.replay.rowActual,
      value: actual,
      tone: "actual",
      note: fill(copy.app.replay.rowActualNote, {
        hours: f.number(day.episode.durationHours),
        mw: f.number(day.episode.thresholdMw),
        peak: f.number(day.episode.peakMw),
      }),
    },
    {
      key: "forecast",
      label: copy.app.replay.rowForecast,
      band: forecastBand,
      tone: "forecast",
      note: copy.app.replay.rowForecastNote,
    },
    {
      key: "recovered",
      label: copy.app.replay.rowRecovered,
      value: remaining,
      tone: "recovered",
      note: scenarioLabel,
    },
  ];

  return (
    <>
      <Head>
        <title>{copy.app.replay.metaTitle}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell showSelection={false}>
        <ScreenTitle
          title={copy.app.replay.title}
          lede={copy.app.replay.lede}
          right={
            <ForecastStamp
              origin={day.forecastOrigin}
              thresholdMw={day.episode.thresholdMw}
            />
          }
        />

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {REPLAY_DAYS.map((candidate) => (
            <MiniPill
              key={candidate.episode.id}
              label={dayLabel(candidate, copy, f)}
              active={candidate.episode.id === day.episode.id}
              onPress={() => params.setParams({ episode: candidate.episode.id })}
            />
          ))}
        </View>

        <HonestyNote
          title={copy.app.replay.honestyTitle}
          right={
            <View style={{ flexDirection: "row", gap: 6 }}>
              <VintageBadge fidelity={day.vintageFidelity} />
              <Badge
                label={
                  day.inTrainingWindow
                    ? copy.app.replay.inSample
                    : copy.app.replay.outOfSample
                }
                tone={day.inTrainingWindow ? "warning" : "accent"}
              />
            </View>
          }
          points={[
            fill(
              day.inTrainingWindow
                ? copy.app.replay.inSampleNote
                : copy.app.replay.outOfSampleNote,
              { through: f.date(day.modelTrainedThrough) },
            ),
            fill(
              day.vintageFidelity === "revision_optimistic"
                ? copy.app.replay.revisionOptimisticNote
                : copy.app.replay.pointInTimeNote,
              { goLive: f.date(INGESTION_GO_LIVE) },
            ),
            ...vintageExtent(day, copy),
            copy.app.replay.scenarioNote,
            copy.app.replay.claimsNote,
          ]}
        />

        <Panel>
          <PanelHeader
            icon={<RotateCcwIcon size={18} color={colors.inkMuted} />}
            title={dayLabel(day, copy, f)}
            subtitle={copy.app.replay.compareSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <CompareBars rows={rows} />
          </View>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Headline
            label={copy.app.replay.headlineCurtailed}
            value={`${f.compact(actual)} MWh`}
            tone="ink"
          />
          <Headline
            label={copy.app.replay.headlineRecovered}
            value={`${f.compact(day.recoveredMwh)} MWh`}
            tone="accent"
          />
          <Headline
            label={copy.app.replay.headlineAvoided}
            value={avoidedShare === null ? "—" : `↓ ${f.percent(avoidedShare, 1)}`}
            tone="accent"
          />
        </View>

        <Panel>
          <PanelHeader
            icon={<ClockIcon size={18} color={colors.inkMuted} />}
            title={copy.app.replay.hourlyTitle}
            subtitle={copy.app.replay.hourlySubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <FanChart
              hours={day.forecast}
              observed={day.observed}
              thresholdMw={day.episode.thresholdMw}
              observedLabel={copy.app.replay.settledActual}
            />
          </View>
        </Panel>

        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
          {fill(copy.app.replay.episodeNote, {
            mw: f.number(day.episode.thresholdMw),
          })}
        </Text>
      </AppShell>
    </>
  );
}

function Headline({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ink" | "accent";
}) {
  const colors = usePalette();
  return (
    <View style={{ flexGrow: 1, flexBasis: 240, gap: 6 }}>
      <Text style={{ fontSize: 13, color: colors.inkMuted }}>{label}</Text>
      <Text
        style={{
          fontSize: 40,
          lineHeight: 46,
          fontWeight: "600",
          letterSpacing: -0.8,
          fontVariant: ["tabular-nums"],
          color: tone === "accent" ? colors.accent : colors.ink,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
