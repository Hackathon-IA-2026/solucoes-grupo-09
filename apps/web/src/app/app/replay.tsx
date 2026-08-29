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
import { formatMwhCompact } from "@/components/charts/band-figure";
import { CompareBars, type CompareRow } from "@/components/charts/compare-bars";
import { FanChart } from "@/components/charts/fan-chart";
import { INGESTION_GO_LIVE, REPLAY_DAYS, replayDay } from "@/lib/fixtures";

export default function TimeMachineScreen() {
  const colors = usePalette();
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

  const rows: CompareRow[] = [
    {
      key: "actual",
      label: "Curtailed — settled by ONS",
      value: actual,
      tone: "actual",
      note: `${day.episode.durationHours} contiguous hours above ${day.episode.thresholdMw} MW, peak ${day.episode.peakMw} MW.`,
    },
    {
      key: "forecast",
      label: "What the D−1 run said",
      band: forecastBand,
      tone: "forecast",
      note: "P10–P90 shaded, P50 solid. Summed over the day's hours for display only — a joint day-total forecast would be narrower.",
    },
    {
      key: "recovered",
      label: "With the scenario dispatched",
      value: remaining,
      tone: "recovered",
      note: day.scenarioLabel,
    },
  ];

  return (
    <>
      <Head>
        <title>Time Machine — WattSteer</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell showSelection={false}>
        <ScreenTitle
          title="What if WattSteer had been running?"
          lede="A past day, replayed against the forecast vintage available at D−1 and scored against what ONS settled."
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
              label={candidate.label}
              active={candidate.episode.id === day.episode.id}
              onPress={() => params.setParams({ episode: candidate.episode.id })}
            />
          ))}
        </View>

        <HonestyNote
          title="What this replay is, and what it is not"
          right={
            <View style={{ flexDirection: "row", gap: 6 }}>
              <VintageBadge fidelity={day.vintageFidelity} />
              <Badge
                label={day.inTrainingWindow ? "IN-SAMPLE" : "OUT-OF-SAMPLE"}
                tone={day.inTrainingWindow ? "warning" : "accent"}
              />
            </View>
          }
          points={[
            day.inTrainingWindow
              ? `The serving model was trained on data through ${day.modelTrainedThrough}, which includes this day. Its "D−1 forecast" here is an in-sample fit, so this is a replay, not a counterfactual: treat the recovered energy as an optimistic upper bound on what the live system would have achieved.`
              : `This day postdates the serving model's training cut (${day.modelTrainedThrough}), so the D−1 forecast is genuinely out of sample. This is the closest thing on this screen to a real counterfactual.`,
            day.vintageFidelity === "revision_optimistic"
              ? `This day predates ingestion go-live (${INGESTION_GO_LIVE}). ONS rewrites history in place with no version marker, so the "actual" above is ONS's current restatement of the day, not what was published at the time. Prior vintages are unrecoverable and this can never be repaired retroactively.`
              : `This day postdates ingestion go-live (${INGESTION_GO_LIVE}), so every value here is the one that was genuinely knowable at the time — an as-of read, not today's restatement.`,
            "Recovered energy is what this dispatch achieves under this scenario against this forecast vintage. It is a property of the scenario, not of the day, and changing any asset parameter changes it.",
            "MWh recovered and % avoided are the only claims made. No carbon saving is derivable from recovered renewable energy without a marginal-emissions model, and none is offered.",
          ]}
        />

        <Panel>
          <PanelHeader
            icon={<RotateCcwIcon size={18} color={colors.inkMuted} />}
            title={day.label}
            subtitle="Actual vs forecast vs recovered"
          />
          <View style={{ marginTop: space.lg }}>
            <CompareBars rows={rows} />
          </View>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Headline
            label="Renewable energy curtailed"
            value={`${formatMwhCompact(actual)} MWh`}
            tone="ink"
          />
          <Headline
            label="Potentially recovered"
            value={`${formatMwhCompact(day.recoveredMwh)} MWh`}
            tone="accent"
          />
          <Headline
            label="Curtailment avoided"
            value={avoidedShare === null ? "—" : `↓ ${(avoidedShare * 100).toFixed(1)}%`}
            tone="accent"
          />
        </View>

        <Panel>
          <PanelHeader
            icon={<ClockIcon size={18} color={colors.inkMuted} />}
            title="Hour by hour"
            subtitle="What was forecast, and what happened"
          />
          <View style={{ marginTop: space.lg }}>
            <FanChart
              hours={day.forecast}
              observed={day.observed}
              thresholdMw={day.episode.thresholdMw}
              observedLabel="Settled actual"
            />
          </View>
        </Panel>

        <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
          An episode is a read-time view of curtailment hours, never a stored row — it
          carries the {day.episode.thresholdMw} MW threshold and the 0-hour gap tolerance
          that produced it, and a different threshold would produce a different episode
          from the same data.
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
