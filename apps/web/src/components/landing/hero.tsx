import {
  ArrowRightIcon,
  Badge,
  CalendarDaysIcon,
  ClockIcon,
  gradientBg,
  Panel,
  PanelHeader,
  PillButton,
  radius,
  space,
  useContainerWidth,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import { StyleSheet, Text, View } from "react-native";
import { useCopy, useFormat, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { producerLabel } from "@/lib/domain";
import { formatMwhExact, formatProbability, formatRange, upper } from "./band";
import { BandFigure, BandRail, ExpectationFigure, useRailLabel } from "./band-figure";
import { APP_HREF, CtaLink } from "./cta-link";
import { FanChart, FanLegend } from "./fan-chart";
import {
  FORECAST_DAY,
  FORECAST_ORIGIN,
  HOURLY_PROFILE,
  NATIONAL,
  SUBSYSTEMS,
  type SubsystemOutlook,
} from "./fixtures";
import { Footnote } from "./section";

/**
 * The hero.
 *
 * The template's hero was an input plus live progress, because the product
 * began with something the visitor had to type. WattSteer has nothing to
 * type — the grid is already running and the forecast already exists — so
 * the hero's job inverts: instead of asking the visitor for the subject, the
 * hero becomes the subject. It shows tomorrow's national curtailment outlook
 * the way the product will: a headline energy figure with its band, the four
 * subsystems ranked by risk, and the 24-hour profile as a fan.
 *
 * That choice is also the honest one about what this product is. A visitor
 * who reads nothing else should leave knowing what WattSteer knows and how
 * confidently it knows it, which is exactly what a paste-a-link hero could
 * never have conveyed.
 *
 * There is no API yet, so the readout renders a fixture and says so in the
 * panel header rather than in a footnote — a fake live readout is the single
 * most damaging thing this page could do to a product whose stated value is
 * honesty about data.
 */

const styles = StyleSheet.create({
  eyebrow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});

export function Hero({ onExplain }: { onExplain: () => void }) {
  const copy = useCopy();
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 900;
  // One scale across every subsystem rail: a rail normalised to its own band
  // would make the quietest subsystem look as uncertain as the loudest.
  const subsystemMax = Math.max(...SUBSYSTEMS.map((s) => upper(s.energy))) * 1.05;

  return (
    <View onLayout={onLayout} style={{ gap: space.xxl }}>
      {/*
        Centred. The hero states the product's entire claim and has no adjacent
        column to balance against, so a left rag leaves a wide screen looking
        like the layout stopped halfway. The readout below keeps its own
        alignment, because a table of subsystems does not centre.
      */}
      <View
        style={{
          gap: space.lg,
          maxWidth: 760,
          alignSelf: "center",
          alignItems: "center",
        }}
      >
        <View
          style={[
            styles.eyebrow,
            { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: colors.accent }]} />
          <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
            {copy.hero.eyebrow}
          </Text>
        </View>

        <Text
          accessibilityRole="header"
          aria-level={1}
          style={{
            fontSize: wide ? 56 : 34,
            lineHeight: wide ? 60 : 40,
            fontWeight: "600",
            letterSpacing: -1.6,
            color: colors.inkMuted,
            textAlign: "center",
          }}
        >
          {copy.hero.headline.lead}
          <Text style={{ color: colors.ink }}>{` ${copy.hero.headline.accent}`}</Text>
        </Text>

        <Text
          style={{
            fontSize: 16,
            lineHeight: 26,
            color: colors.inkMuted,
            maxWidth: 660,
            textAlign: "center",
          }}
        >
          {copy.hero.sub}
        </Text>

        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: space.md,
            marginTop: space.sm,
          }}
        >
          <CtaLink
            testID="hero-open-app"
            href={APP_HREF}
            label={copy.hero.primaryCta}
            primary={true}
            icon={<ArrowRightIcon size={16} color={colors.onAccent} />}
          />
          <PillButton
            testID="hero-explain"
            label={copy.hero.secondaryCta}
            onPress={onExplain}
          />
        </View>
      </View>

      <Readout wide={wide} subsystemMax={subsystemMax} />
    </View>
  );
}

/** The live-readout panel: national figure, subsystem ranking, hourly fan. */
function Readout({ wide, subsystemMax }: { wide: boolean; subsystemMax: number }) {
  const copy = useCopy();
  const f = useFormat();
  const colors = usePalette();
  return (
    <View testID="hero-readout" style={{ gap: space.lg }}>
      <Panel
        style={[
          { gap: space.xl, padding: wide ? 24 : 18 },
          gradientBg(
            "radial-gradient(120% 90% at 8% -10%, rgba(141, 93, 246, 0.22) 0%, transparent 60%)",
            colors.surface,
          ),
        ]}
      >
        <PanelHeader
          icon={<CalendarDaysIcon size={18} color={colors.inkMuted} />}
          title={copy.readout.title}
          subtitle={f.date(FORECAST_DAY)}
          right={<Badge label={copy.readout.sampleBadge} tone="warning" />}
        />

        <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg }}>
          <View style={{ flex: wide ? 1 : undefined, gap: space.md }}>
            {/*
              The national figure is an expectation while `band` is null, and a
              band the day the forecaster draws a shared day-row index across
              the four subsystems. Both cases are rendered because both are in
              the contract: `national.band` is nullable on the wire, and the
              null case carries the reason it is null.
            */}
            {NATIONAL.band === null ? (
              <ExpectationFigure
                label={copy.readout.nationalLabel}
                value={NATIONAL.expectedMwh}
                unit="MWh"
                reason={NATIONAL.bandUnavailableReason}
              />
            ) : (
              <BandFigure
                label={copy.readout.nationalLabel}
                figure={{ kind: "band", band: NATIONAL.band }}
                unit="MWh"
              />
            )}
            <RiskCounts />
            <Footnote>{copy.readout.nationalGrainNote}</Footnote>
          </View>

          <View style={{ flex: wide ? 1.15 : undefined, gap: space.md }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
                {copy.readout.subsystemsTitle}
              </Text>
              <Text style={{ fontSize: 12, color: colors.inkFaint }}>
                {copy.readout.columnProbability}
              </Text>
            </View>
            {SUBSYSTEMS.map((outlook) => (
              <SubsystemRow key={outlook.code} outlook={outlook} max={subsystemMax} />
            ))}
            <Footnote>{copy.readout.additivityNote}</Footnote>
          </View>
        </View>

        <View
          style={{
            height: 1,
            backgroundColor: colors.border,
          }}
        />

        <View style={{ gap: space.md }}>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.md,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ClockIcon size={16} color={colors.inkMuted} />
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
                {copy.readout.profileTitle}
              </Text>
              <Text style={{ fontSize: 13, color: colors.inkMuted }}>
                {copy.readout.profileSub}
              </Text>
            </View>
            <FanLegend
              bandLabel={copy.band.rangeLabel}
              medianLabel={copy.band.medianLabel}
            />
          </View>

          <FanChart
            points={HOURLY_PROFILE}
            unit="MWh"
            accessibilityLabel={`${copy.readout.profileSub}. ${copy.readout.profileCaption}`}
          />
          <Footnote>{copy.readout.profileCaption}</Footnote>
        </View>

        <OriginLine />
      </Panel>

      <Footnote>{copy.readout.sampleNote}</Footnote>
    </View>
  );
}

/**
 * `docs/domain-model.md` §4: every surface that shows a forecast must name
 * its `ForecastOrigin`. The run initialisation *is* the `published_at`, so
 * this one line carries both the provenance and the vintage.
 *
 * It names two artifacts, not one. The producer of this forecast is
 * WattSteer and `run_label` is its artifact version; the weather run is a
 * separate fact and is written out as one, because a line that shows only
 * the weather run credits the forecast to the wrong party.
 */
function OriginLine() {
  const copy = useCopy();
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
      }}
    >
      <ZapIcon size={14} color={colors.inkFaint} />
      <Text style={{ fontSize: 12, color: colors.inkFaint }}>
        {`${copy.readout.originLabel}: ${fill(copy.readout.originValue, {
          producer: producerLabel[FORECAST_ORIGIN.producer],
          run: FORECAST_ORIGIN.runLabel,
          published: FORECAST_ORIGIN.publishedAt,
          weatherRun: FORECAST_ORIGIN.weatherRunLabel,
        })}`}
      </Text>
    </View>
  );
}

/**
 * `risk_class_counts` — how many subsystems sit in each bin.
 *
 * It arrives beside the national expectation in the same response, and it is
 * there for a reason: an expectation alone cannot say whether 4,580 MWh is
 * one subsystem in trouble or four subsystems mildly exposed, which is the
 * question a band was never answering either.
 */
function RiskCounts() {
  const copy = useCopy();
  const f = useFormat();
  const colors = usePalette();
  return (
    <Text style={{ fontSize: 12, color: colors.inkMuted }}>
      {fill(copy.readout.riskCounts, {
        high: f.number(NATIONAL.riskClassCounts.high),
        elevated: f.number(NATIONAL.riskClassCounts.elevated),
        low: f.number(NATIONAL.riskClassCounts.low),
      })}
    </Text>
  );
}

function SubsystemRow({ outlook, max }: { outlook: SubsystemOutlook; max: number }) {
  const copy = useCopy();
  const { locale } = useI18n();
  const railLabel = useRailLabel();
  const colors = usePalette();
  const probabilityTone =
    outlook.probability >= 0.66
      ? colors.danger
      : outlook.probability >= 0.25
        ? colors.warning
        : colors.inkMuted;

  return (
    <View
      testID={`subsystem-${outlook.code}`}
      style={{
        gap: 8,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.canvasTint,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}
        >
          <Badge label={outlook.code} tone="neutral" />
          <Text
            numberOfLines={1}
            style={{ fontSize: 13, fontWeight: "600", color: colors.ink }}
          >
            {outlook.displayName}
          </Text>
        </View>
        {/* A probability is a point estimate — it genuinely has no band, and
            showing it as bare text next to a banded magnitude is the visual
            way of saying so. */}
        <Text
          style={{
            fontSize: 15,
            fontWeight: "700",
            fontVariant: ["tabular-nums"],
            color: probabilityTone,
          }}
        >
          {formatProbability(locale, outlook.probability)}
        </Text>
      </View>

      <BandRail
        figure={outlook.energy}
        max={max}
        label={railLabel(outlook.energy, "MWh", outlook.displayName)}
      />

      <Text
        style={{ fontSize: 12, color: colors.inkMuted, fontVariant: ["tabular-nums"] }}
      >
        {outlook.energy.kind === "band"
          ? `${formatMwhExact(locale, outlook.energy.band.p50)} MWh · ${copy.band.rangeLabel} ${formatRange(locale, outlook.energy.band)}`
          : `${formatMwhExact(locale, outlook.energy.value)} MWh · ${copy.band.observedLabel}`}
      </Text>
    </View>
  );
}
