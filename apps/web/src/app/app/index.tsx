/**
 * Screen 1 — Visão da rede (IDEA.md §42), read from the **real** gateway.
 *
 * Two halves, and today only one of them answers.
 *
 * **The forecast half** — the map, the four rows, the hourly fan and the two
 * day bands — is `GET /v1/grid/outlook` and `GET /v1/forecast/day-ahead`. Both
 * refuse in production right now, because no artifact is promoted on either
 * serving lane and nothing has been published; `use-network.ts` documents the
 * exact state and the exact codes. When they refuse, these panels are
 * **absent** — not skeletons, not zeroed bands, not a flat line at zero — and
 * the screen says which clause refused, from the typed code, in the reader's
 * locale.
 *
 * **The observed half** — the settled grid across the four subsystems, the
 * selected subsystem's settled day, and its recent episodes — is
 * `GET /v1/grid/now`, `GET /v1/curtailment/hours` and
 * `GET /v1/curtailment/episodes`. None of them loads a model and all three
 * answer today. `docs/specs/api-surface.md` names exactly these three as what
 * the Overview shows when no artifact is promoted, and that is what it shows.
 *
 * **The observed half renders in both states, and stays observed in both.** It
 * is not a fallback that disappears when a forecast arrives: what the grid has
 * actually been doing is worth the same on a day that is forecast as on a day
 * that is not. It is drawn by different components from the forecast half for
 * the reason `lib/network.ts` gives — the failure being designed against is a
 * settled total in the place a forecast band was, under the label the band had.
 */

import {
  ClockIcon,
  FadeIn,
  LayoutDashboardIcon,
  layout,
  MapIcon,
  Panel,
  PanelHeader,
  PieChartIcon,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { AppShell, ScreenTitle } from "@/components/app/app-shell";
import { ForecastAbsent } from "@/components/app/forecast-absent";
import { ForecastStamp, HonestyNote, VintageBadge } from "@/components/app/honesty";
import { SubsystemRow } from "@/components/app/subsystem-row";
import {
  gateProfileOf,
  sharedParams,
  useAppParams,
} from "@/components/app/use-app-params";
import {
  type ForecastNetwork,
  type ObservedNetwork,
  useNetwork,
} from "@/components/app/use-network";
import { BandCard } from "@/components/charts/band-figure";
import { EpisodeList } from "@/components/charts/episode-list";
import { FanChart } from "@/components/charts/fan-chart";
import { ObservedProfile } from "@/components/charts/observed-profile";
import { RiskCaveat } from "@/components/charts/risk-class";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { TechnologySplitPanel } from "@/components/charts/technology-split";
import { useVoiceHighlight } from "@/components/voice/use-voice-agent";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import { forecastHours, forecastRow, nowRows, outlookRows } from "@/lib/network";

export default function GridOverviewScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const meta = subsystemMeta(params.subsystem);
  const state = useNetwork({
    subsystem: params.subsystem,
    targetDate: params.date,
    gateProfile: gateProfileOf(params.run),
  });

  /**
   * Choosing a subsystem, defined once.
   *
   * The map and the rows are two affordances over one action, and the action
   * is "open Explain for this subsystem, carrying the rest of the selection
   * along". Written out twice it would be two actions that currently agree —
   * and the way that drifts is a new shared parameter added to `sharedParams`
   * and threaded through only one of them.
   */
  const select = (subsystem: SubsystemCode) =>
    router.push({
      pathname: "/app/explain" as never,
      params: { ...sharedParams(params), subsystem },
    });

  const frame = (right: ReactNode, body: ReactNode) => (
    <>
      <Head>
        <title>{copy.app.overview.metaTitle}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell>
        <ScreenTitle
          title={copy.app.overview.title}
          lede={fill(copy.app.overview.lede, { date: f.date(params.date) })}
          right={right}
        />
        {body}
      </AppShell>
    </>
  );

  if (state.status === "reading") {
    return frame(
      null,
      <HonestyNote
        title={copy.app.overview.readingTitle}
        tone="neutral"
        points={[copy.app.overview.readingNote]}
      />,
    );
  }

  if (state.status === "refused") {
    // Even the settled grid did not answer. There is nothing on this screen
    // that does not depend on it, so there is nothing to draw but the sentence
    // — and a sentence is what a reader can act on, where an empty page is not.
    return frame(
      null,
      <HonestyNote
        title={copy.app.overview.refusedTitle}
        tone="warning"
        points={[copy.error[state.code], copy.app.overview.refusedNote]}
      />,
    );
  }

  const observed = state.observed;
  const forecast = state.status === "read" ? state.forecast : null;

  return frame(
    forecast === null ? null : (
      <ForecastStamp
        origin={forecast.forecast.forecastOrigin}
        thresholdMw={forecast.forecast.thresholdMw}
      />
    ),
    <>
      {state.status === "observedOnly" ? (
        <ForecastAbsent
          code={state.code}
          title={copy.app.overview.absentTitle}
          note={copy.app.overview.absentNote}
        />
      ) : null}

      {forecast === null ? null : (
        <ForecastPanels forecast={forecast} onSelect={select} />
      )}

      <ObservedPanels observed={observed} subsystem={params.subsystem} />

      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {fill(copy.app.overview.grainNote, { subsystem: meta.onsDisplayName })}
      </Text>
    </>,
  );
}

/**
 * Everything a promoted model pays for.
 *
 * Rendered only in the `read` state, and therefore not rendered at all today.
 * It is written in full rather than stubbed, because "these screens must light
 * up with no further edits" is only true if the code that lights up already
 * exists: the day a lane is promoted and a gate publishes, `use-network.ts`
 * returns `read` and this component is what appears.
 */
function ForecastPanels({
  forecast,
  onSelect,
}: {
  forecast: ForecastNetwork;
  onSelect: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const meta = subsystemMeta(params.subsystem);
  const rows = outlookRows(forecast.outlook);
  const selected = forecastRow(forecast.forecast);
  const [overviewWidth, onOverviewLayout] = useContainerWidth();
  // One hover, two affordances — see `SubsystemMap`'s `hovered` prop.
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  /**
   * The third end of the same affordance: the voice agent lights both.
   *
   * `subsystem-map.tsx` already lifted the highlight because *"hovering a
   * region lights its row and hovering a row lights its region"*. A `highlight`
   * tool call is a third source for that one value and not a new mechanism —
   * `docs/plans/voice-copilot.md` §3.1 says so, and it is what makes the demo's
   * first step work: the reader asks which region to worry about, and the
   * answer is the NE lighting up on the screen they are already on, with **no
   * navigation at all**.
   *
   * The pointer wins where there is one. A reader moving a mouse is making a
   * live choice; the agent's emphasis is an answer to a question they asked a
   * moment ago, and an answer that fought the pointer would read as the map
   * being stuck.
   */
  const spoken = useVoiceHighlight();
  const active = hovered ?? spoken;
  const side = overviewWidth >= layout.desktop;

  // One scale across all four rows, so "wider" and "bigger" mean what they look
  // like. Computed from the P90s, not the P50s.
  const domainMax = Math.max(...rows.map((each) => each.dailyEnergy.p90)) * 1.05;

  return (
    <>
      <FadeIn style={{ gap: space.md }} onLayout={onOverviewLayout}>
        {/*
          Map and rows side by side once there is room for both, stacked below
          that. `side` is measured against `layout.desktop` on the *container*
          rather than the viewport, so the pair reflows correctly inside
          whatever it is nested in.
        */}
        <View
          style={{
            flexDirection: side ? "row" : "column",
            alignItems: side ? "flex-start" : "stretch",
            gap: space.md,
          }}
        >
          <Panel style={side ? { width: 420 } : undefined}>
            <PanelHeader
              icon={<MapIcon size={18} color={colors.inkMuted} />}
              title={copy.app.overview.map.title}
              subtitle={copy.app.overview.map.subtitle}
            />
            <View style={{ marginTop: space.lg }}>
              <SubsystemMap
                forecasts={rows}
                selected={params.subsystem}
                hovered={active}
                onHoverChange={setHovered}
                onSelect={onSelect}
              />
            </View>
            <Text
              style={{
                fontSize: 11,
                color: colors.inkFaint,
                lineHeight: 17,
                marginTop: space.md,
              }}
            >
              {copy.app.overview.map.boundaryNote}
            </Text>
          </Panel>

          <View style={{ flex: side ? 1 : undefined, gap: space.md }}>
            {rows.map((row) => (
              <SubsystemRow
                key={row.subsystem}
                forecast={row}
                emphasis={params.technology}
                domainMax={domainMax}
                selected={row.subsystem === params.subsystem}
                highlighted={row.subsystem === active}
                onHoverChange={(on) => setHovered(on ? row.subsystem : null)}
                onPress={() => onSelect(row.subsystem)}
              />
            ))}
          </View>
        </View>
        <RiskCaveat />
      </FadeIn>

      <FadeIn delay={70}>
        <Panel>
          <PanelHeader
            icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
            title={meta.onsDisplayName}
            subtitle={copy.app.overview.profileSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <FanChart
              hours={forecastHours(forecast.forecast)}
              thresholdMw={forecast.forecast.thresholdMw}
            />
          </View>
        </Panel>
      </FadeIn>

      <FadeIn delay={140}>
        <Panel>
          <PanelHeader
            icon={<PieChartIcon size={18} color={colors.inkMuted} />}
            title={copy.app.split.title}
            subtitle={copy.app.split.subtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <TechnologySplitPanel
              split={selected.split}
              expectedMwh={selected.dayExpectedMwh}
              emphasis={params.technology}
            />
          </View>
        </Panel>
      </FadeIn>

      <FadeIn
        delay={210}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}
      >
        <BandCard
          label={copy.app.overview.dailyEnergy}
          band={selected.dailyEnergy}
          unit="MWh"
          footnote={copy.app.overview.dailyEnergyNote}
        />
        <BandCard
          label={copy.app.overview.peakPower}
          band={selected.peakPower}
          unit="MW"
          tone="violet"
          footnote={fill(copy.app.overview.peakPowerNote, {
            mw: f.number(forecast.forecast.thresholdMw),
          })}
        />
      </FadeIn>
    </>
  );
}

/**
 * The settled grid. Three panels, no model behind any of them.
 *
 * Each names the day or the window it covers, because an observed figure whose
 * period is not stated is not comparable with anything — and, on a screen whose
 * other half is about *tomorrow*, a reader has to be able to tell at a glance
 * which of the two a number belongs to.
 */
function ObservedPanels({
  observed,
  subsystem,
}: {
  observed: ObservedNetwork;
  subsystem: SubsystemCode;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(subsystem);
  const rows = nowRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER);

  return (
    <>
      <FadeIn delay={70}>
        <Panel>
          <PanelHeader
            icon={<ClockIcon size={18} color={colors.inkMuted} />}
            title={copy.app.overview.settledTitle}
            subtitle={fill(copy.app.overview.settledSubtitle, {
              hour: f.dateTime(observed.now.latestSettledHour),
              lag: f.number(observed.now.lagHours),
            })}
            right={<VintageBadge fidelity={observed.now.vintageFidelity} />}
          />
          <View style={{ marginTop: space.lg, gap: space.sm }}>
            {rows.map((row) => (
              <View
                key={row.subsystem}
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: 8,
                }}
              >
                <Text
                  style={{
                    flexGrow: 1,
                    flexBasis: 160,
                    fontSize: 13,
                    fontWeight: row.subsystem === subsystem ? "700" : "500",
                    color: row.subsystem === subsystem ? colors.ink : colors.inkMuted,
                  }}
                >
                  {row.onsDisplayName}
                </Text>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: "700",
                    fontVariant: ["tabular-nums"],
                    color: colors.ink,
                  }}
                >
                  {`${f.compact(row.last24hConstrainedOffMwh)} MWh`}
                </Text>
                <Text
                  style={{
                    flexBasis: "100%",
                    fontSize: 11,
                    color: colors.inkFaint,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {fill(copy.app.overview.settledSplit, {
                    wind: f.compact(row.split.windMwh),
                    solar: f.compact(row.split.solarMwh),
                  })}
                </Text>
              </View>
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
            {fill(copy.app.overview.settledNationalNote, {
              mwh: f.compact(observed.now.national.last24hConstrainedOffMwh),
            })}
          </Text>
        </Panel>
      </FadeIn>

      <FadeIn delay={140}>
        <Panel>
          <PanelHeader
            icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
            title={fill(copy.app.overview.settledDayTitle, {
              subsystem: meta.onsDisplayName,
            })}
            subtitle={fill(copy.app.overview.settledDaySubtitle, {
              date: f.date(observed.hoursDate),
            })}
          />
          <View style={{ marginTop: space.lg }}>
            <ObservedProfile
              hours={observed.hours}
              emptyLabel={copy.app.overview.settledDayEmpty}
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
            {copy.app.overview.settledDayNote}
          </Text>
        </Panel>
      </FadeIn>

      <FadeIn delay={210}>
        <EpisodeList
          episodes={observed.episodes.episodes}
          maxGapHours={observed.episodes.maxGapHours}
          title={copy.app.overview.episodesTitle}
          subtitle={fill(copy.app.overview.episodesSubtitle, {
            from: f.date(observed.episodes.from.slice(0, 10)),
            to: f.date(observed.episodes.to.slice(0, 10)),
            mw: f.number(observed.episodes.thresholdMw),
          })}
          row={copy.app.overview.episodeRow}
          note={copy.app.overview.episodeNote}
          empty={copy.app.overview.episodesEmpty}
        />
      </FadeIn>
    </>
  );
}
