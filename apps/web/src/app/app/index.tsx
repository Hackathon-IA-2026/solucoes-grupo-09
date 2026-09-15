/**
 * Screen 1 — Grid Overview (IDEA.md §42).
 *
 * Four subsystems, their risk, and the 24-hour profile with its P10–P90 band.
 */

import {
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
import { useState } from "react";
import { Text, View } from "react-native";
import { AppShell, ScreenTitle } from "@/components/app/app-shell";
import { ForecastStamp, HonestyNote } from "@/components/app/honesty";
import { SubsystemRow } from "@/components/app/subsystem-row";
import { sharedParams, useAppParams } from "@/components/app/use-app-params";
import { BandCard } from "@/components/charts/band-figure";
import { FanChart } from "@/components/charts/fan-chart";
import { RiskCaveat } from "@/components/charts/risk-class";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { TechnologySplitPanel } from "@/components/charts/technology-split";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  buildAllForecasts,
  buildForecast,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";

export default function GridOverviewScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  // One forecast per subsystem-day. The technology selection does not reach
  // either call: there is no per-technology forecast to build, so it can only
  // choose which scalar the split panel below emphasises.
  const all = buildAllForecasts(params.run);
  const selected = buildForecast(params.subsystem, params.run);
  const meta = subsystemMeta(params.subsystem);

  // One scale across all four rows, so "wider" and "bigger" mean what they look
  // like. Computed from the P90s, not the P50s.
  // Measured on the container, not the viewport: this screen is nested, and a
  // viewport query would put the map beside the rows inside a column that
  // cannot hold both.
  const [overviewWidth, onOverviewLayout] = useContainerWidth();
  // One hover, two affordances — see `SubsystemMap`'s `hovered` prop.
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  const side = overviewWidth >= layout.desktop;

  const domainMax = Math.max(...all.map((each) => each.dailyEnergy.p90)) * 1.05;

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

  return (
    <>
      <Head>
        <title>{copy.app.overview.metaTitle}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell>
        <ScreenTitle
          title={copy.app.overview.title}
          lede={fill(copy.app.overview.lede, { date: f.date(params.date) })}
          right={
            <ForecastStamp
              origin={selected.forecastOrigin}
              thresholdMw={selected.thresholdMw}
            />
          }
        />

        {/*
          Staged entrance, borrowed from the results dashboard this screen is
          modelled on: the eye is given an order to read the answer in —
          subsystems, then the profile, then the day totals — instead of the
          whole page arriving at once. Each block is offset by one step, and
          `FadeIn` collapses to an instant render under prefers-reduced-motion.
        */}
        {/*
          The shell badge says `FIXTURE DATA` in the chrome, which is a label.
          This screen builds every band from `@/lib/fixtures` and issues no
          request, and no artifact is promoted for serving, so there is no
          forecast it could be showing instead. The product states absences in
          this component everywhere else; it owes this screen the same.
        */}
        <HonestyNote
          title={copy.app.overview.fixtureTitle}
          points={[copy.app.overview.fixtureNote]}
        />

        <FadeIn style={{ gap: space.md }} onLayout={onOverviewLayout}>
          {/*
            Map and rows side by side once there is room for both, stacked
            below that. `side` is measured against `layout.desktop` on the
            *container* rather than the viewport, so the pair reflows correctly
            inside whatever it is nested in.

            The map keeps its own 380 px cap (`subsystem-map.tsx`), so on a wide
            screen the left column is the map at its natural size and the right
            column takes the remaining width — which is where the rows want to
            be, since their bars are the part that benefits from length. Below
            the breakpoint the rows would be squeezed to roughly half of a phone
            width, so they go back under the map instead.
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
                  forecasts={all}
                  selected={params.subsystem}
                  hovered={hovered}
                  onHoverChange={setHovered}
                  onSelect={select}
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
              {all.map((forecast) => (
                <SubsystemRow
                  key={forecast.subsystem}
                  forecast={forecast}
                  emphasis={params.technology}
                  domainMax={domainMax}
                  selected={forecast.subsystem === params.subsystem}
                  highlighted={forecast.subsystem === hovered}
                  onHoverChange={(on) => setHovered(on ? forecast.subsystem : null)}
                  onPress={() => select(forecast.subsystem)}
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
              <FanChart hours={selected.hours} thresholdMw={selected.thresholdMw} />
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
              mw: f.number(selected.thresholdMw),
            })}
          />
        </FadeIn>

        <Text style={{ fontSize: 12, color: colors.inkFaint, lineHeight: 19 }}>
          {copy.app.overview.grainNote}
        </Text>
      </AppShell>
    </>
  );
}
