/**
 * The orb — four statuses, four motions, and the reader's own voice driving two
 * of them.
 *
 * `docs/plans/voice-copilot.md` §5.1 sets the brief and the restraint in the
 * same breath:
 *
 * > The brief asks for futuristic. The trap is chrome that fights the data —
 * > this is a grid operations product, and a reader deciding about tomorrow's
 * > curtailment is not served by glow. So: **the futurism is in the motion and
 * > the responsiveness, not in the decoration.**
 *
 * Which is why there is no glassmorphism, no particle field and no gradient
 * mesh here, and why the one visual idea is that **the rings are the real audio
 * level**. `levelFromFloat` gives a 0..1 RMS per frame — the microphone while
 * the reader talks, the playback buffer while the agent does — and the rings
 * scale off it directly. It reacts to your actual voice, and nothing that loops
 * on a timer reads as alive the way that does.
 *
 * ## Four motions, and why each is the one it is
 *
 * | status | motion | why |
 * |---|---|---|
 * | `listening` | rings breathe outward on the **mic** level | the reader can see they are being heard, which is the one thing a microphone UI has to prove |
 * | `thinking` | a single arc sweeps, no level input | there is no audio to show; the sweep says "working" without claiming a signal it does not have |
 * | `speaking` | rings breathe on the **playback** level, core filled | same mechanism, opposite direction, and the filled core is what tells them apart with the motion stopped |
 * | `acting` | a mark travels outward, once per action | directional, because a tool call is a thing going somewhere — §5.1's "a directional pulse toward the screen edge the navigation is heading to" |
 *
 * ## Views, not SVG
 *
 * The whole orb is `View`s with `borderRadius`, and that is a deliberate
 * choice rather than a shortcut. Focus and emphasis in this product are
 * expressed with `focusRing`, which is a CSS `outline` — and **an `outline` on
 * an SVG element is drawn by the browser around the element's bounding box**,
 * which on this repo's map painted a rectangle across half of Brazil. A control
 * built from `View`s cannot reproduce that bug, and the orb is inside a
 * focusable pill.
 *
 * ## Reduced motion
 *
 * `useReducedMotion` is honoured by dropping **every** animation, including the
 * level-driven one: a ring that pulses with a voice is still motion, and a
 * reader who asked for none did not mean "none except the interesting one". The
 * four statuses stay legible with the motion gone, because each already differs
 * in geometry — ring count, core fill, and the arc's presence — and not only in
 * how it moves.
 */

import { motion, usePalette, useReducedMotion } from "@wattsteer/ui";
import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import type { VoiceStatus } from "@/lib/voice/session";
import { ringScale } from "./use-voice-agent";

export interface VoiceOrbProps {
  status: VoiceStatus;
  /** 0..1, straight from `levelFromFloat`. Never smoothed on the way here. */
  level: number;
  size?: number;
  /** Screen-reader name. The orb is decoration beside a label everywhere else. */
  accessibilityLabel?: string;
}

export function VoiceOrb({
  status,
  level,
  size = 28,
  accessibilityLabel,
}: VoiceOrbProps) {
  const colors = usePalette();
  const reduced = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;

  const sweeping = status === "thinking" || status === "connecting";
  const travelling = status === "acting";

  useEffect(() => {
    if (reduced || !(sweeping || travelling)) {
      sweep.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        // `acting` is faster than `thinking` on purpose: one is the model
        // deliberating and the other is the app already moving, and a reader
        // should be able to tell those apart without reading the label.
        duration: travelling ? motion.slow * 2 : motion.slow * 4,
        easing: travelling ? Easing.out(Easing.cubic) : Easing.inOut(Easing.quad),
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, sweeping, travelling, sweep]);

  const scale = ringScale(status, level, reduced);
  const core = Math.max(6, Math.round(size * 0.3));
  const filled = status === "speaking" || status === "acting";

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
      {/*
        Two rings and not five. Each extra ring costs a layer of paint on every
        level frame and adds nothing a reader can name — the information here is
        one scalar, and two rings already show its sign and its size.
      */}
      <Ring size={size} scale={scale} colour={colors.accent} opacity={0.25} />
      <Ring size={size * 0.66} scale={scale} colour={colors.accent} opacity={0.5} />

      {sweeping && !reduced ? (
        <Animated.View
          // A single arc: one coloured border edge on a transparent circle,
          // rotated. It is the cheapest honest "working" motion available with
          // no SVG and no library, and it cannot be mistaken for a level.
          style={{
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size,
            borderWidth: 2,
            borderColor: "transparent",
            borderTopColor: colors.accent,
            transform: [
              {
                rotate: sweep.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0deg", "360deg"],
                }),
              },
            ],
          }}
        />
      ) : null}

      {travelling && !reduced ? (
        <Animated.View
          // The directional pulse. It leaves the core and travels to the edge
          // the navigation is heading to, once per loop — the navigation itself
          // is the effect, and this is only the cue that one is happening.
          style={{
            position: "absolute",
            width: 3,
            height: 3,
            borderRadius: 3,
            backgroundColor: colors.accent,
            opacity: sweep.interpolate({
              inputRange: [0, 0.7, 1],
              outputRange: [1, 0.6, 0],
            }),
            transform: [
              {
                translateX: sweep.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, size * 0.55],
                }),
              },
            ],
          }}
        />
      ) : null}

      <View
        style={{
          width: core,
          height: core,
          borderRadius: core,
          borderWidth: filled ? 0 : 1.5,
          borderColor: colors.accent,
          backgroundColor: filled ? colors.accent : "transparent",
        }}
      />
    </View>
  );
}

function Ring({
  size,
  scale,
  colour,
  opacity,
}: {
  size: number;
  scale: number;
  colour: string;
  opacity: number;
}) {
  return (
    <View
      style={{
        position: "absolute",
        width: size,
        height: size,
        borderRadius: size,
        borderWidth: 1,
        borderColor: colour,
        opacity,
        transform: [{ scale }],
      }}
    />
  );
}
