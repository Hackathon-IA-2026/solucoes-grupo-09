import { producerLabel } from "@wattsteer/core";
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
  SparklesIcon,
  space,
  useContainerWidth,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import { Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useCopy, useFormat, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
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
import { HeroCards } from "./hero-cards";
import { GUTTER_GATE, HERO_CHROME, HERO_COLUMN_MAX, MIN_STAGE } from "./hero-metrics";
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
  stage: {
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
    // Matches the reference stage's vertical padding, and keeps the intro off
    // the fold on a viewport too short for `MIN_STAGE`.
    paddingVertical: 40,
    // The floating cards are rotated and sit in the gutters; without this a
    // card's corner can push the page's horizontal scroll width past the
    // viewport at the exact widths where the gate has just opened.
    overflow: "hidden",
  },
  column: {
    gap: space.lg,
    width: "100%",
    maxWidth: HERO_COLUMN_MAX,
    alignItems: "center",
  },
});

/**
 * The hero's own width at which the headline takes its large setting.
 *
 * Exported because `+html.tsx` holds the same number in a `@container` rule —
 * the headline has to be the large size in the *static* HTML on a wide screen,
 * or it resizes when the bundle lands and the resize is layout shift. A
 * container query, not a media query: this is the hero's width, which is the
 * viewport less the section gutters. `test/responsive-css.test.ts` checks the
 * stylesheet and this constant agree.
 */
export const HERO_WIDE = 900;

/** `dataSet` → `data-*` on web; nothing on native. See `legal-screen.tsx`. */
const marker = (name: string) =>
  Platform.OS === "web" ? ({ dataSet: { [name]: "" } } as object) : {};
const HERO_ROOT_MARKER = marker("heroRoot");
const HEADLINE_MARKER = marker("heroHeadline");

export function Hero({ onExplain }: { onExplain: () => void }) {
  const copy = useCopy();
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= HERO_WIDE;
  const { height } = useWindowDimensions();
  /**
   * One viewport tall, the way the reference's hero is.
   *
   * On web this is a CSS expression rather than the measured window height on
   * purpose. The static export renders with no window, so a JS-computed height
   * would ship 523px of markup and then grow to ~700px at hydration, shoving
   * the readout down the page — layout shift on the largest element above the
   * fold. `dvh` resolves at first paint, before the bundle is fetched.
   */
  const stageMinHeight =
    Platform.OS === "web"
      ? (`max(${MIN_STAGE}px, calc(100dvh - ${HERO_CHROME}px))` as unknown as number)
      : Math.max(height - HERO_CHROME, MIN_STAGE);
  // One scale across every subsystem rail: a rail normalised to its own band
  // would make the quietest subsystem look as uncertain as the loudest.
  const subsystemMax = Math.max(...SUBSYSTEMS.map((s) => upper(s.energy))) * 1.05;

  return (
    <View onLayout={onLayout} {...HERO_ROOT_MARKER} style={{ gap: space.xxl }}>
      {/*
        The stage: one viewport tall, its content centred in it, with the
        floating cards in whatever gutter is left over. The readout is
        deliberately *outside* it — the stage is the claim, the readout is the
        evidence, and the fold is the right place to separate the two.
      */}
      <View testID="hero-stage" style={[styles.stage, { minHeight: stageMinHeight }]}>
        {/*
          Decoration, and gated on space rather than stacked or shrunk: below
          `GUTTER_GATE` there is no gutter to float in, and a card that moved
          into the column would be a second, unlabelled copy of the readout's
          own figures directly above it.
        */}
        {width >= GUTTER_GATE ? <HeroCards /> : null}

        {/*
          Centred. The hero states the product's entire claim and has no
          adjacent column to balance against, so a left rag leaves a wide
          screen looking like the layout stopped halfway. The readout below
          keeps its own alignment, because a table of subsystems does not
          centre.
        */}
        <View style={styles.column}>
          <View
            style={[
              styles.eyebrow,
              { borderColor: colors.border, backgroundColor: colors.surface },
            ]}
          >
            {/*
              A 14px mark, not the 6px filled dot that was here. The dot read
              as a status light — the shape a live indicator uses — at the top
              of a page whose readout is a fixture and says so two panels
              below. It was the one element in the hero a visitor could take
              for a connection state. The template puts this same mark at 14px
              in the accent on its own kicker pill, which is the size a 12px
              label sits beside without raising the pill's height.
            */}
            <SparklesIcon size={14} color={colors.accent} />
            {/*
              One line, always. At 400px the pill has ~314px for the label:
              400 less the 20px page gutters, less 24px of pill padding, less
              the 14px mark and the 8px gap. A wrapped eyebrow turns the pill
              into a rounded paragraph and pushes the headline down the fold.
              `numberOfLines` is the floor under that; the character budget in
              `test/i18n.test.ts` is what keeps the copy from reaching it.
            */}
            <Text
              numberOfLines={1}
              style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}
            >
              {copy.hero.eyebrow}
            </Text>
          </View>

          <Text
            accessibilityRole="header"
            aria-level={1}
            {...HEADLINE_MARKER}
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
            {/*
              `flexWrap` and `flexShrink` are load-bearing at 400px. The sub
              line is a full sentence — "Energia prevista em constrained-off
              por hora, nacional" — and in a non-wrapping row it refused to
              break, pushing the page's scroll width to 479px against a 400px
              viewport. Measured on the static export; it was the page's only
              horizontal overflow.
            */}
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                flexShrink: 1,
                gap: 10,
              }}
            >
              <ClockIcon size={16} color={colors.inkMuted} />
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
                {copy.readout.profileTitle}
              </Text>
              <Text style={{ flexShrink: 1, fontSize: 13, color: colors.inkMuted }}>
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

      {/*
        Two lines, and the first one now says which quantile it is.
        The centre figure was printed bare — "2.780 MWh · P10–P90 1.720–4.260" —
        so the four of them read as a column of magnitudes that a visitor adds
        to 4.180 and compares against a headline of 4.580 that the prose beside
        it calls an exact sum. Both numbers were right; the page simply never
        showed the quantity the headline is a sum *of*.

        So: the median is labelled `P50`, and each subsystem's `expectedMwh`
        sits under it. The second line is the one that adds — 2.960 + 700 + 590
        + 330 = 4.580 — which turns the additivity claim from an assertion into
        something a reader can check on the page in ten seconds. That is the
        page's entire thesis, and it was the one claim not checkable here.

        Showing the expectation rather than rewording the national prose,
        because the prose is true and precise: it is the *column* that was
        missing a number, and deleting a correct sentence to hide a gap is the
        opposite of what this panel is for. It also costs nothing the design
        does not already have — `expectedLabel` and `medianLabel` are existing
        strings in both locales, and the line matches the one above it.
      */}
      <View style={{ gap: 2 }}>
        <Text
          style={{ fontSize: 12, color: colors.inkMuted, fontVariant: ["tabular-nums"] }}
        >
          {outlook.energy.kind === "band"
            ? `${copy.band.medianLabel} ${formatMwhExact(locale, outlook.energy.band.p50)} MWh · ${copy.band.rangeLabel} ${formatRange(locale, outlook.energy.band)}`
            : `${formatMwhExact(locale, outlook.energy.value)} MWh · ${copy.band.observedLabel}`}
        </Text>
        <Text style={{ fontSize: 12, color: colors.ink, fontVariant: ["tabular-nums"] }}>
          {`${copy.band.expectedLabel} ${formatMwhExact(locale, outlook.expectedMwh)} MWh`}
        </Text>
      </View>
    </View>
  );
}
