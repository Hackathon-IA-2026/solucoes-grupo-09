/**
 * Screen 2 — Explain (IDEA.md §43).
 *
 * Driver attribution, narration, reliability curve — plus one panel IDEA.md
 * does not have: the restriction reasons ONS actually observed, at the grain
 * it observes them. Without it the screen would consist entirely of model
 * output while looking like it was explaining the grid.
 */

import type { Narration as NarrationEnvelope } from "@wattsteer/core/api";
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
import { type Copy, useCopy, useFormat } from "@/i18n";
import { driverLabel, formatReading } from "@/i18n/drivers";
import { fill } from "@/i18n/format";
import {
  buildExplain,
  buildForecast,
  buildModelCard,
  type ExplainFixture,
  type ObservedReason,
  subsystemMeta,
} from "@/lib/fixtures";

export default function ExplainScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const forecast = buildForecast(params.subsystem, params.run);
  // No technology argument, and none in the shape it returns. There is one
  // attribution per subsystem-day because there is one forecasting head per
  // subsystem, so a per-technology explanation would be explaining a model
  // that does not exist (`docs/specs/api-surface.md`, contract change 4). The
  // URL still carries `technology` — `sharedParams` still passes it on, and
  // the Overview's observed panels still read it — it simply no longer
  // reaches the diagnosis.
  const explain = buildExplain(params.subsystem);
  // Two reads, not one. The attribution is a property of the day and the
  // reliability curve is a property of the model, so `api-surface.md` §9 puts
  // them behind `/v1/diagnosis/day-ahead` and `/v1/model/card?lane=` — the
  // second keyed by lane and never by subsystem or date. The screen asks the
  // same two questions of the fixtures, so that wiring it to the two endpoints
  // is a change of source and not a change of shape.
  const card = buildModelCard();
  const meta = subsystemMeta(params.subsystem);

  return (
    <>
      <Head>
        <title>{copy.app.explain.metaTitle}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <AppShell>
        <ScreenTitle
          title={fill(copy.app.explain.title, { subsystem: meta.onsDisplayName })}
          lede={fill(copy.app.explain.lede, { date: f.date(params.date) })}
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
              title={copy.app.explain.riskTitle}
              subtitle={copy.app.explain.riskSubtitle}
            />
            <RiskChip probability={forecast.occurrenceProbability} />
            <RiskScale probability={forecast.occurrenceProbability} />
            <RiskCaveat />
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            <BandFigure
              label={copy.app.explain.magnitude}
              band={forecast.dailyEnergy}
              unit="MWh"
              footnote={copy.app.explain.magnitudeNote}
            />
          </Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}>
            <BandFigure
              label={copy.app.explain.peakPower}
              band={forecast.peakPower}
              unit="MW"
              tone="violet"
            />
          </Panel>
        </View>

        <Panel>
          <PanelHeader
            icon={<SparklesIcon size={18} color={colors.inkMuted} />}
            title={copy.app.explain.narrationTitle}
            subtitle={copy.app.explain.narrationSubtitle}
          />
          <Text
            style={{
              marginTop: space.lg,
              fontSize: 15,
              lineHeight: 25,
              color: colors.inkMuted,
            }}
          >
            <Narration explain={explain} thresholdMw={forecast.thresholdMw} />
          </Text>
          <Text style={{ marginTop: space.md, fontSize: 11, color: colors.inkFaint }}>
            {narrationNote(copy, NARRATION_SOURCE)}
          </Text>
        </Panel>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Panel style={{ flexGrow: 1, flexBasis: 380 }}>
            <PanelHeader
              icon={<LayersIcon size={18} color={colors.inkMuted} />}
              title={copy.app.explain.driversTitle}
              subtitle={copy.app.explain.driversSubtitle}
            />
            <View style={{ marginTop: space.lg }}>
              <DriverBars drivers={explain.drivers} />
            </View>
          </Panel>

          <Panel style={{ flexGrow: 1, flexBasis: 320 }}>
            <PanelHeader
              icon={<PieChartIcon size={18} color={colors.inkMuted} />}
              title={copy.app.explain.reliabilityTitle}
              subtitle={copy.app.explain.reliabilitySubtitle}
              right={<VintageBadge fidelity={card.reliabilityFidelity} />}
            />
            <View style={{ marginTop: space.lg }}>
              <ReliabilityCurve points={card.reliability} />
            </View>
            <Text style={{ marginTop: space.md, fontSize: 11, color: colors.inkFaint }}>
              {fill(copy.app.explain.reliabilityNote, {
                hours: f.exact(card.reliabilitySampleHours),
                from: f.date(card.reliabilityWindowFrom),
                to: f.date(card.reliabilityWindowTo),
              })}
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
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>
            {copy.app.explain.next}
          </Text>
          <MiniPill
            label={copy.app.explain.nextMitigate}
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
 * Which surface wrote the paragraph on this screen.
 *
 * The response carries `narration.source` so the footnote can be true in both
 * cases — a rule may withhold the model's narration, and the deterministic
 * template renders instead. This screen is still on fixtures and there is no
 * model behind a fixture, so the paragraph below genuinely is a template: it
 * is composed here, from a per-locale string and the fixture's own values.
 * Naming that rather than asserting a language model wrote it is the whole of
 * the copy change; the constant becomes `explain.narration.source` the day the
 * screen reads the endpoint.
 */
const NARRATION_SOURCE: NarrationEnvelope["source"] = "template";

function narrationNote(copy: Copy, source: NarrationEnvelope["source"]): string {
  return source === "model"
    ? copy.app.explain.narrationNoteModel
    : copy.app.explain.narrationNoteTemplate;
}

/**
 * The generated narration.
 *
 * `docs/specs/i18n.md` carves this surface out of "the API returns codes, the
 * client renders the words": there is no translation key for a sentence a
 * language model writes fresh per request, so the shipped endpoint will take a
 * `locale` and generate the prose in it. There is no model behind a fixture,
 * so the prototype composes the same sentence from a per-locale template and
 * the fixture's own values — which is what keeps this panel honest in
 * Portuguese until the real narration replaces it wholesale.
 */
function Narration({
  explain,
  thresholdMw,
}: {
  explain: ExplainFixture;
  thresholdMw: number;
}) {
  const copy = useCopy();
  const f = useFormat();
  const [top, second] = explain.drivers;
  const meta = subsystemMeta(explain.subsystem);
  return (
    <>
      {fill(copy.app.explain.narration, {
        subsystem: meta.onsDisplayName,
        mw: f.number(thresholdMw),
        top: driverLabel(top.code, copy).toLowerCase(),
        feature: top.headlineFeature,
        observed: formatReading(top.observed, copy, f) ?? "",
        typical: formatReading(top.typical, copy, f) ?? "",
        second: driverLabel(second.code, copy).toLowerCase(),
        share: f.percent(explain.narrationTopShare),
      })}
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
 *
 * `reason.description` is `dsc_restricao` as ONS wrote it, and stays in ONS's
 * Portuguese in both locales: it is a source record, not copy, and translating
 * one would be inventing evidence.
 */
function ObservedReasonsPanel({
  reasons,
  date,
}: {
  reasons: ObservedReason[];
  date: string;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <Panel>
      <PanelHeader
        icon={<HashIcon size={18} color={colors.inkMuted} />}
        title={copy.app.explain.reasonsTitle}
        subtitle={fill(copy.app.explain.reasonsSubtitle, { date: f.date(date) })}
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
                  ? copy.app.explain.grainConjunto
                  : copy.app.explain.grainPlant}
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
              {`${f.number(reason.constrainedOffMwh, 1)} MWh`}
            </Text>
            {reason.description === null ? null : (
              <Text style={{ fontSize: 11, color: colors.inkFaint, flexBasis: "100%" }}>
                {reason.description}
              </Text>
            )}
          </View>
        ))}
        <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
          {copy.app.explain.reasonLegend}
        </Text>
      </View>
    </Panel>
  );
}
