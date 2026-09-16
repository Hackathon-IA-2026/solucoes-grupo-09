/**
 * The orb a screen shows while it is waiting for the gateway.
 *
 * ## Why this exists rather than a package
 *
 * `thinking-orbs-native` was the suggestion, and it is not on npm — the name
 * 404s. Reaching for the nearest published substitute would have brought
 * `@shopify/react-native-skia` and `react-native-reanimated` with it: a native
 * canvas and a worklet runtime, added to an app whose entire web delivery is a
 * **static export** already carrying 500 KB of gzipped JavaScript to a landing
 * page. Two heavy dependencies for a loading indicator is the wrong trade on a
 * surface where total blocking time is the one thing keeping mobile Lighthouse
 * off 100.
 *
 * So the orb is ours, and it is not a reimplementation from scratch either: it
 * is `components/voice/voice-orb.tsx`'s visual language — concentric rings, a
 * core, one sweeping arc — reduced to the single state a loading indicator has.
 * The product gains a consistent idiom instead of a second one: the shape that
 * means "WattSteer is working on it" is the same shape whether the work is a
 * voice turn or a gateway read.
 *
 * ## Views, not SVG, for the reason the voice orb gives
 *
 * Emphasis in this product is a `focusRing`, which is a CSS `outline`, and **an
 * outline on an SVG element is drawn around its bounding box** — which on this
 * repo's Brazil map painted a rectangle across half the country. A control
 * built from `View`s cannot reproduce that, and these orbs sit inside panels
 * that can be focused.
 *
 * ## Reduced motion
 *
 * Every animation drops, including the sweep. A reader who asked for no motion
 * did not mean "none except the interesting one". What remains is still legible
 * as a waiting state, because the geometry — rings around a dimmed core —
 * differs from anything else on the screen without moving at all.
 */

import { motion, space, usePalette, useReducedMotion } from "@wattsteer/ui";
import { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";

/** The three rings, as a fraction of the orb's size. */
const RINGS = [1, 0.72, 0.46] as const;

export function ThinkingOrb({
  size = 44,
  accessibilityLabel,
}: {
  size?: number;
  /** Screen-reader name. Omitted where a heading already says "loading". */
  accessibilityLabel?: string;
}) {
  const colors = usePalette();
  const reduced = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      sweep.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        // Slower than the voice orb's sweep. That one accompanies a model
        // thinking about a sentence; this accompanies a network read, and a
        // fast spinner on a slow request reads as impatience rather than as
        // progress.
        duration: 1800,
        easing: Easing.linear,
        // No native driver on web; RNW animates on the JS thread.
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep, reduced]);

  const rotate = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <View
      accessibilityRole={accessibilityLabel === undefined ? "none" : "image"}
      accessibilityLabel={accessibilityLabel}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {RINGS.map((scale) => (
        <View
          key={scale}
          style={{
            position: "absolute",
            width: size * scale,
            height: size * scale,
            borderRadius: (size * scale) / 2,
            borderWidth: 1,
            // Each ring fainter than the one outside it, so the orb reads as
            // depth rather than as three separate circles. There is one border
            // token, so the falloff is opacity on it rather than a second
            // colour invented here.
            borderColor: colors.border,
            opacity: scale === 1 ? 1 : scale,
          }}
        />
      ))}
      {/*
        The sweeping arc. A ring with three transparent borders and one in the
        accent, rotated — which is the cheapest arc there is, needs no SVG, and
        cannot be given an outline by a focus ring.
      */}
      <Animated.View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2,
          borderTopColor: colors.accent,
          borderRightColor: "transparent",
          borderBottomColor: "transparent",
          borderLeftColor: "transparent",
          transform: [{ rotate }],
        }}
      />
      <View
        style={{
          width: size * 0.2,
          height: size * 0.2,
          borderRadius: size * 0.1,
          backgroundColor: colors.accentSoft,
        }}
      />
    </View>
  );
}

/**
 * A skeleton line — the other half of a waiting screen.
 *
 * Deliberately **not** shaped like the thing it is waiting for. The note this
 * replaces made the argument and it still holds: *"um esqueleto com formato de
 * faixa seria uma faixa"* — a skeleton in the shape of a P10–P90 band is a
 * band, drawn before any number exists, and this product does not draw bands it
 * does not have. These are neutral bars of text width: they say "something is
 * coming" without saying what it will be worth.
 */
export function SkeletonLine({
  width = "100%",
  height = 12,
}: {
  width?: number | `${number}%`;
  height?: number;
}) {
  const colors = usePalette();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: motion.slow,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: motion.slow,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  return (
    <Animated.View
      style={{
        width,
        height,
        borderRadius: height / 2,
        backgroundColor: colors.surfaceSunken,
        // Faint on purpose — "bem fraco". A skeleton that competes with the
        // chrome around it is a screen that looks broken rather than busy.
        opacity: reduced
          ? 0.5
          : pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] }),
      }}
    />
  );
}

/**
 * What a screen shows while the gateway is answering.
 *
 * This replaces a `HonestyNote` — a bordered box with a title and a paragraph
 * explaining that nothing would be drawn before the response arrived. The
 * paragraph was true and it was the wrong shape for the moment: a reader
 * waiting on a request is not reading an essay about epistemics, they are
 * waiting, and three lines of prose on a blank screen reads as an error.
 *
 * The argument it made is not lost, it is **enacted**. The skeletons are
 * neutral text-width bars and deliberately not band-shaped, which is the same
 * point the note was making in words: a skeleton in the shape of a P10–P90
 * band *is* a band, drawn before any number exists. The code now demonstrates
 * the claim the copy used to assert, and `SkeletonLine`'s docstring carries the
 * reasoning for the next person.
 */
export function ReadingState({ title }: { title: string }) {
  const colors = usePalette();
  return (
    <View
      testID="reading-state"
      accessibilityRole="progressbar"
      accessibilityLabel={title}
      style={{ alignItems: "center", gap: space.lg, paddingVertical: space.xxl }}
    >
      <ThinkingOrb size={56} />
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.inkMuted }}>
        {title}
      </Text>
      {/*
        Three bars of uneven width. Even ones read as a table that failed to
        load; uneven ones read as text that has not arrived, which is closer to
        the truth on every screen that uses this.
      */}
      <View style={{ width: "100%", maxWidth: 420, gap: space.sm }}>
        <SkeletonLine width="72%" />
        <SkeletonLine width="100%" />
        <SkeletonLine width="54%" />
      </View>
    </View>
  );
}
