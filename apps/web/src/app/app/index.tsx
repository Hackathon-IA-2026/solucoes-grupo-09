/**
 * Screen 1 — Grid Overview (IDEA.md §42).
 *
 * Four subsystems, their risk, and the 24-hour profile with its P10–P90 band.
 */

import {
  FadeIn,
  LayoutDashboardIcon,
  Panel,
  PanelHeader,
  space,
  usePalette,
} from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import { Text, View } from "react-native";
import { AppShell, ScreenTitle } from "@/components/app/app-shell";
import { ForecastStamp } from "@/components/app/honesty";
import { SubsystemRow } from "@/components/app/subsystem-row";
import { sharedParams, useAppParams } from "@/components/app/use-app-params";
import { BandCard } from "@/components/charts/band-figure";
import { FanChart } from "@/components/charts/fan-chart";
import { RiskCaveat } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { buildAllForecasts, buildForecast, subsystemMeta } from "@/lib/fixtures";

export default function GridOverviewScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const all = buildAllForecasts(params.technology, params.run);
  const selected = buildForecast(params.subsystem, params.technology, params.run);
  const meta = subsystemMeta(params.subsystem);

  // One scale across all four rows, so "wider" and "bigger" mean what they look
  // like. Computed from the P90s, not the P50s.
  const domainMax = Math.max(...all.map((each) => each.dailyEnergy.p90)) * 1.05;

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
        <FadeIn style={{ gap: space.md }}>
          {all.map((forecast) => (
            <SubsystemRow
              key={forecast.subsystem}
              forecast={forecast}
              domainMax={domainMax}
              selected={forecast.subsystem === params.subsystem}
              onPress={() =>
                router.push({
                  pathname: "/app/explain" as never,
                  params: { ...sharedParams(params), subsystem: forecast.subsystem },
                })
              }
            />
          ))}
          <RiskCaveat />
        </FadeIn>

        <FadeIn delay={70}>
          <Panel>
            <PanelHeader
              icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
              title={`${meta.onsDisplayName} · ${copy.app.technology[params.technology]}`}
              subtitle={copy.app.overview.profileSubtitle}
            />
            <View style={{ marginTop: space.lg }}>
              <FanChart hours={selected.hours} thresholdMw={selected.thresholdMw} />
            </View>
          </Panel>
        </FadeIn>

        <FadeIn
          delay={140}
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
