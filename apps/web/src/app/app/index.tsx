/**
 * Screen 1 — Grid Overview (IDEA.md §42).
 *
 * Four subsystems, their risk, and the 24-hour profile with its P10–P90 band.
 */

import {
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
import { buildAllForecasts, buildForecast, subsystemMeta } from "@/lib/fixtures";

export default function GridOverviewScreen() {
  const colors = usePalette();
  const params = useAppParams();
  const all = buildAllForecasts(params.technology, params.run);
  const selected = buildForecast(params.subsystem, params.technology, params.run);
  const meta = subsystemMeta(params.subsystem);

  // One scale across all four rows, so "wider" and "bigger" mean what they look
  // like. Computed from the P90s, not the P50s.
  const domainMax = Math.max(...all.map((f) => f.dailyEnergy.p90)) * 1.05;

  return (
    <>
      <Head>
        <title>Grid Overview — WattSteer</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell>
        <ScreenTitle
          title="Grid Overview"
          lede={`Day-ahead curtailment risk for ${params.date}, by subsystem. Every figure is a P10/P50/P90 interval, not a point.`}
          right={
            <ForecastStamp
              origin={selected.forecastOrigin}
              thresholdMw={selected.thresholdMw}
            />
          }
        />

        <View style={{ gap: space.md }}>
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
        </View>

        <Panel>
          <PanelHeader
            icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
            title={`${meta.onsDisplayName} · ${params.technology}`}
            subtitle="24-hour profile, P10–P90"
          />
          <View style={{ marginTop: space.lg }}>
            <FanChart hours={selected.hours} thresholdMw={selected.thresholdMw} />
          </View>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <BandCard
            label="Expected curtailed energy, whole day"
            band={selected.dailyEnergy}
            unit="MWh"
            footnote="A day total is a joint forecast. It is not the sum of the hourly P90s — quantiles do not add."
          />
          <BandCard
            label="Peak hourly power"
            band={selected.peakPower}
            unit="MW"
            tone="violet"
            footnote={`Hour of the largest P50. Threshold in force: ${selected.thresholdMw} MW at subsystem grain.`}
          />
        </View>

        <Text style={{ fontSize: 12, color: colors.inkFaint, lineHeight: 19 }}>
          Forecast grain is the subsystem. Observed curtailment is published per reporting
          entity — a conjunto for most of it — and restriction reasons exist only there;
          see Explain.
        </Text>
      </AppShell>
    </>
  );
}
