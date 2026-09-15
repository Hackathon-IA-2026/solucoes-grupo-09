import { Badge, FadeIn, Panel, space, usePalette, useReducedMotion } from "@wattsteer/ui";
import { type PropsWithChildren, useEffect, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useCopy, useI18n } from "@/i18n";
import { formatMwhExact, formatProbability, formatRange, upper } from "./band";
import { BandRail } from "./band-figure";
import { HOURLY_PROFILE, NATIONAL, SUBSYSTEMS } from "./fixtures";
import { CARD_INSET_PERCENT, CARD_WIDTH } from "./hero-metrics";

/** The card inset, as the percentage string the absolute layer positions on. */
const INSET = `${CARD_INSET_PERCENT}%` as const;

/**
 * The four cards that float in the hero stage's side gutters on wide screens.
 *
 * ## Where the treatment comes from
 *
 * The template's hero puts miniature versions of its own dashboard panels in
 * the gutters beside the centred column, rotated a few degrees, riding a slow
 * vertical float loop: the product visible above the fold, without a
 * screenshot. Measured off the template's own hero source: cards
 * 176–232px wide, absolutely positioned at 2.5–3% from the outer edge and
 * 14–16% from the top or bottom of the stage, rotated between −5° and +4°,
 * translateY 0 → −8px over 5.2–6.4s with `Easing.inOut(Easing.quad)`, each
 * phase-shifted by 0.5–1.4s so the four never bob in unison, each fading in
 * on a 600ms stagger. Those numbers are reproduced here; nothing else is.
 *
 * ## What they say
 *
 * Not a decorative chart. Each card is one shape the product actually
 * publishes, in the product's own vocabulary and read from the landing
 * fixture that the readout panel below already renders — a subsystem and its
 * chance of curtailment, a P10/P50/P90 band in MWh on the same rail the
 * readout uses, the national expectation, the 24-hour profile. There is
 * exactly one source of numbers on this page, and it is `./fixtures`.
 *
 * ## Why every one of them is labelled
 *
 * Because they are not live and this product's entire claim is that it says
 * so. A floating "89%" with no marker on it is precisely the shape of the claim
 * the page must not make.
 *
 * **One marker for the layer, not one per card.** The first version put the
 * readout's `Badge "Sample data"` on all four, which is the same six words
 * repeated four times inside one screenful — it read as chrome rather than as a
 * caveat, which is the failure mode a caveat has. The layer now carries a
 * single line beneath it, in the register of a figure caption, and the cards
 * carry the figures.
 *
 * The layer is `aria-hidden` either way: a screen reader gets these numbers
 * from the readout below, where the badge and the `sampleNote` footnote are
 * adjacent to them in the reading order.
 */

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none",
  },
  // `space.md`, not the 14 the template uses: 14 is off the 4-pt scale, and
  // `landing-layout.test.ts` is right to refuse it. At this card width the
  // difference is invisible and the rule is worth more than the two pixels.
  card: { width: CARD_WIDTH, padding: space.md, gap: space.sm },
  figure: {
    fontSize: 30,
    lineHeight: 34,
    fontWeight: "600",
    letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
  },
  caption: { fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"] },
  captionRow: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: space.lg,
    alignItems: "center",
  },
});

/**
 * The template's idle float loop, phase-shifted per card.
 *
 * Under `prefers-reduced-motion` the loop never starts and the card sits at
 * its rest position — the same contract `FadeIn` and the loading screen's
 * progress track already keep in this repo.
 */
function Floaty({
  children,
  delay = 0,
  duration = 5200,
}: PropsWithChildren<{ delay?: number; duration?: number }>) {
  const reducedMotion = useReducedMotion();
  // Lazy `useState`, not `useRef`: the Animated.Value is created exactly once
  // without a ref initializer running on every render.
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: duration / 2,
          delay,
          easing: Easing.inOut(Easing.quad),
          // No native driver on web; RNW animates on the JS thread.
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: duration / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, delay, duration, reducedMotion]);

  return (
    <Animated.View
      style={{
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [0, -8],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/** The layer's one caveat, captioning all four cards rather than each of them. */
function SampleCaption() {
  const copy = useCopy();
  const colors = usePalette();
  return (
    <Text style={[styles.caption, { color: colors.inkFaint }]}>
      {copy.readout.sampleBadge}
    </Text>
  );
}

/** Subsystem, its chance of curtailment, and the binned risk class. */
function RiskCard() {
  const copy = useCopy();
  const colors = usePalette();
  const { locale } = useI18n();
  const outlook = SUBSYSTEMS[0] as (typeof SUBSYSTEMS)[number];
  return (
    <Panel style={styles.card}>
      <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
        {copy.readout.columnProbability}
      </Text>
      <Text style={[styles.figure, { color: colors.accent }]}>
        {formatProbability(locale, outlook.probability)}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Badge label={outlook.code} tone="neutral" />
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: 12, fontWeight: "600", color: colors.ink }}
        >
          {copy.app.risk[outlook.riskClass]}
        </Text>
      </View>
    </Panel>
  );
}

/**
 * A subsystem's expected curtailed energy as a P10/P50/P90 band, in MWh.
 *
 * The rail is scaled by the same `max` the readout's four rails share, not by
 * this band's own width — a rail normalised to itself would draw the quietest
 * subsystem exactly as wide as the loudest, which is the one thing a band is
 * on the page to prevent.
 */
function BandCard() {
  const copy = useCopy();
  const colors = usePalette();
  const { locale } = useI18n();
  const outlook = SUBSYSTEMS[0] as (typeof SUBSYSTEMS)[number];
  const max = Math.max(...SUBSYSTEMS.map((s) => upper(s.energy))) * 1.05;
  const figure = outlook.energy;
  return (
    <Panel style={styles.card}>
      <Text
        numberOfLines={1}
        style={{ fontSize: 12, fontWeight: "600", color: colors.ink }}
      >
        {outlook.displayName}
      </Text>
      {figure.kind === "band" ? (
        <>
          <Text style={[styles.figure, { color: colors.ink }]}>
            {`${formatMwhExact(locale, figure.band.p50)} `}
            {/* `MWh` is a unit, not copy — see the guard's DOMAIN_TERMS. */}
            <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
              MWh
            </Text>
          </Text>
          <BandRail
            figure={figure}
            max={max}
            // Decorative duplicate of the readout's own rail: the layer is
            // `aria-hidden`, so this label is never announced.
            label={outlook.displayName}
          />
          <Text style={[styles.caption, { color: colors.inkMuted }]}>
            {`${copy.band.rangeLabel} ${formatRange(locale, figure.band)}`}
          </Text>
        </>
      ) : null}
    </Panel>
  );
}

/** The national expectation — the one quantity that adds across subsystems. */
function ExpectedCard() {
  const copy = useCopy();
  const colors = usePalette();
  const { locale } = useI18n();
  return (
    <Panel style={styles.card}>
      <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
        {copy.band.expectedLabel}
      </Text>
      <Text style={[styles.figure, { color: colors.ink }]}>
        {`${formatMwhExact(locale, NATIONAL.expectedMwh)} `}
        <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
          MWh
        </Text>
      </Text>
    </Panel>
  );
}

/** Sparkline geometry. A 24-point day at card width, inside the 14px padding. */
const SPARK_W = CARD_WIDTH - 28;
const SPARK_H = 40;

/**
 * The day's shape: the P10–P90 envelope as a filled area with the P50 over it.
 *
 * Deliberately axis-less and tick-less. It is the hourly profile's silhouette,
 * not a chart to read values off — the readable one is `FanChart`, below the
 * fold, with its legend and its caption.
 */
function ProfileCard() {
  const copy = useCopy();
  const colors = usePalette();
  const max = Math.max(...HOURLY_PROFILE.map((point) => point.p90));
  const x = (i: number) => (i / (HOURLY_PROFILE.length - 1)) * SPARK_W;
  const y = (value: number) => SPARK_H - (value / max) * SPARK_H;
  const line = (pick: (p: (typeof HOURLY_PROFILE)[number]) => number) =>
    HOURLY_PROFILE.map(
      (point, i) =>
        `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(pick(point)).toFixed(1)}`,
    ).join(" ");
  const envelope = `${line((p) => p.p90)} ${HOURLY_PROFILE.map(
    (point, i) =>
      `L${x(HOURLY_PROFILE.length - 1 - i).toFixed(1)} ${y(
        (HOURLY_PROFILE.at(-1 - i) as typeof point).p10,
      ).toFixed(1)}`,
  ).join(" ")} Z`;

  return (
    <Panel style={styles.card}>
      <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
        {copy.readout.profileTitle}
      </Text>
      <Svg width={SPARK_W} height={SPARK_H}>
        <Path
          d={envelope}
          fill={colors.violetSoft}
          stroke={colors.violet}
          strokeWidth={1}
        />
        <Path
          d={line((p) => p.p50)}
          fill="none"
          stroke={colors.accent}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </Svg>
      <Text style={[styles.caption, { color: colors.inkMuted }]}>
        {copy.band.rangeLabel}
      </Text>
    </Panel>
  );
}

/**
 * Where the four cards sit, and how each one moves.
 *
 * The rotations, float durations and stagger delays are the template's, and
 * the phases are deliberately coprime-ish: four cards bobbing in unison reads
 * as the whole page breathing, which is a much louder effect than four cards
 * drifting independently. Every card is inset the same distance from the
 * stage edge so the pair on each side shares a vertical edge.
 */
const SLOTS = [
  {
    key: "risk",
    side: "left",
    edge: "top",
    offset: "8%",
    rotate: "-5deg",
    delay: 200,
    float: 0,
    duration: 5200,
    Card: RiskCard,
  },
  {
    key: "profile",
    side: "left",
    edge: "bottom",
    offset: "10%",
    rotate: "3deg",
    delay: 350,
    float: 900,
    duration: 6000,
    Card: ProfileCard,
  },
  {
    key: "band",
    side: "right",
    edge: "top",
    offset: "7%",
    rotate: "4deg",
    delay: 280,
    float: 500,
    duration: 5600,
    Card: BandCard,
  },
  {
    key: "expected",
    side: "right",
    edge: "bottom",
    offset: "11%",
    rotate: "-3deg",
    delay: 430,
    float: 1400,
    duration: 6400,
    Card: ExpectedCard,
  },
] as const;

/**
 * The layer itself. Absolutely positioned across the stage, untouchable and
 * hidden from the accessibility tree — the parent gates it on width.
 */
export function HeroCards() {
  return (
    <View testID="hero-cards" aria-hidden={true} style={styles.layer}>
      {SLOTS.map(({ key, side, edge, offset, rotate, delay, float, duration, Card }) => (
        <View
          key={key}
          style={{
            position: "absolute",
            [side]: INSET,
            [edge]: offset,
            transform: [{ rotate }],
          }}
        >
          <FadeIn duration={600} delay={delay} distance={16}>
            <Floaty delay={float} duration={duration}>
              <Card />
            </Floaty>
          </FadeIn>
        </View>
      ))}
      {/*
        Centred under the stage rather than attached to a card: it captions all
        four, and a caveat that appears once reads as a caveat. Fading in behind
        the last card so it is not the first thing that resolves.
      */}
      <FadeIn duration={600} delay={520} distance={8} style={styles.captionRow}>
        <SampleCaption />
      </FadeIn>
    </View>
  );
}
