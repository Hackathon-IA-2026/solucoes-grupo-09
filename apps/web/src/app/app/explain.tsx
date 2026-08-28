/**
 * Screen 2 — Explain (IDEA.md §43).
 *
 * Driver attribution, narration, reliability curve — plus one panel IDEA.md
 * does not have: the restriction reasons ONS actually observed, at the grain
 * it observes them. Without it the screen would consist entirely of model
 * output while looking like it was explaining the grid.
 */

import {
  Badge,
  HashIcon,
  LayersIcon,
  Panel,
  PanelHeader,
  PieChartIcon,
  SparklesIcon,
  space,
  usePalette,
} from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import { Text, View } from "react-native";
import { AppShell, MiniPill, ScreenTitle } from "@/components/app/app-shell";
import { ForecastStamp, VintageBadge } from "@/components/app/honesty";
import { sharedParams, useAppParams } from "@/components/app/use-app-params";
import { BandFigure } from "@/components/charts/band-figure";
import { DriverBars } from "@/components/charts/driver-bars";
import { ReliabilityCurve } from "@/components/charts/reliability-curve";
import { RiskCaveat, RiskChip, RiskScale } from "@/components/charts/risk-class";
import {
  buildExplain,
  buildForecast,
  type ObservedReason,
  subsystemMeta,
} from "@/lib/fixtures";

export default function ExplainScreen() {
  const colors = usePalette();
  const params = useAppParams();
  const forecast = buildForecast(params.subsystem, params.technology, params.run);
  const explain = buildExplain(params.subsystem, params.technology);
  const meta = subsystemMeta(params.subsystem);

  return (
    <>
      <Head>
        <title>Explain — WattSteer</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell>
        <ScreenTitle
          title={`Why ${meta.onsDisplayName}?`}
          lede={`What the model is reading on ${params.date}, and how much of it to believe.`}
          right={
            <ForecastStamp
              origin={forecast.forecastOrigin}
              thresholdMw={forecast.thresholdMw}
            />
          }
        />

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Panel style={{ flexGrow: 1, flexBasis: 300, gap: space.lg }}>
            <PanelHeader
              icon={<HashIcon size={18} color={colors.inkMuted} />}
              title="Curtailment risk"
              subtitle="P(any hour above threshold)"
            />
            <RiskChip probability={forecast.occurrenceProbability} />
            <RiskScale probability={forecast.occurrenceProbability} />
            <RiskCaveat />
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            <BandFigure
              label="Expected magnitude, whole day"
              band={forecast.dailyEnergy}
              unit="MWh"
              footnote="Conditional on the day clearing the threshold at all."
            />
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            <BandFigure
              label="Peak hourly power"
              band={forecast.peakPower}
              unit="MW"
              tone="violet"
            />
          </Panel>
        </View>

        <Panel>
          <PanelHeader
            icon={<SparklesIcon size={18} color={colors.inkMuted} />}
            title="Narration"
            subtitle="Generated in the requested locale"
          />
          <Text
            style={{
              marginTop: space.lg,
              fontSize: 15,
              lineHeight: 25,
              color: colors.inkMuted,
            }}
          >
            {explain.narration}
          </Text>
          <Text style={{ marginTop: space.md, fontSize: 11, color: colors.inkFaint }}>
            Written by a language model from the attribution table below. It restates the
            numbers; it does not add any.
          </Text>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
            <PanelHeader
              icon={<LayersIcon size={18} color={colors.inkMuted} />}
              title="Driver attribution"
              subtitle="SHAP, at subsystem grain"
            />
            <View style={{ marginTop: space.lg }}>
              <DriverBars drivers={explain.drivers} />
            </View>
          </Panel>

          <Panel style={{ flexGrow: 1, flexBasis: 320 }}>
            <PanelHeader
              icon={<PieChartIcon size={18} color={colors.inkMuted} />}
              title="Reliability"
              subtitle="Forecast vs observed frequency"
              right={<VintageBadge fidelity={explain.reliabilityFidelity} />}
            />
            <View style={{ marginTop: space.lg }}>
              <ReliabilityCurve points={explain.reliability} />
            </View>
            <Text style={{ marginTop: space.md, fontSize: 11, color: colors.inkFaint }}>
              {`${explain.reliabilitySampleHours.toLocaleString("en-US")} hours over ${explain.reliabilityWindow}. The whole window predates ingestion go-live, so it is scored against ONS's current restatement of the past, not against what was knowable at the time.`}
            </Text>
          </Panel>
        </View>

        <ObservedReasonsPanel
          reasons={explain.observedReasons}
          date={explain.observedReasonsDate}
        />

        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
        >
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>Next:</Text>
          <MiniPill
            label="What could absorb it →"
            active={false}
            onPress={() =>
              router.push({
                pathname: "/app/mitigate" as never,
                params: sharedParams(params),
              })
            }
          />
        </View>
      </AppShell>
    </>
  );
}

/**
 * Observed restriction reasons.
 *
 * The single hardest thing on this screen to get right: a reason is a property
 * of a `ReportingEntity`, and there is no path in the type system from a plant
 * to one. Most curtailed energy belongs to a *conjunto*, where the reason
 * belongs to the settlement unit and may not be pushed down to member plants;
 * the eighteen Tipo I / II-B plants are their own reporting entities and their
 * reasons genuinely are observed at plant grain. So the panel labels the grain
 * per row rather than assuming one for the table.
 */
function ObservedReasonsPanel({
  reasons,
  date,
}: {
  reasons: ObservedReason[];
  date: string;
}) {
  const colors = usePalette();
  return (
    <Panel>
      <PanelHeader
        icon={<HashIcon size={18} color={colors.inkMuted} />}
        title="Observed restriction reasons"
        subtitle={`Settled by ONS for ${date}`}
      />
      <View style={{ marginTop: space.lg, gap: space.md }}>
        {reasons.map((reason) => (
          <View
            key={reason.entityLabel}
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              paddingBottom: space.md,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Badge
              label={reason.reason}
              tone={reason.reason === "REL" ? "danger" : "violet"}
            />
            <Badge label={reason.origin} tone="neutral" />
            <View style={{ flexGrow: 1, flexBasis: 200 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
                {reason.entityLabel}
              </Text>
              <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                {reason.grain === "conjunto"
                  ? "reason observed at conjunto grain"
                  : "reason observed at plant grain — this plant is its own reporting entity"}
              </Text>
            </View>
            <Text
              style={{
                fontSize: 14,
                fontWeight: "700",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {`${reason.constrainedOffMwh.toFixed(1)} MWh`}
            </Text>
            {reason.description === null ? null : (
              <Text style={{ fontSize: 11, color: colors.inkFaint, flexBasis: "100%" }}>
                {reason.description}
              </Text>
            )}
          </View>
        ))}
        <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
          Reason codes: REL external (grid) unavailability · CNF reliability requirement ·
          ENE energetic (oversupply) · PAR access-opinion restriction. Origin: LOC local,
          SIS systemic. A conjunto's reason is never allocated down to its member plants —
          that would be an allocation presented as an observation, and WattSteer does not
          compute one.
        </Text>
      </View>
    </Panel>
  );
}
