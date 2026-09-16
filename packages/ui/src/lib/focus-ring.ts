import { Platform } from "react-native";
import { motion } from "../tokens";

/**
 * Keyboard focus ring, web only. RN 0.86 (new architecture) renders outline*
 * styles natively too — where there is no keyboard focus state, so the ring
 * would show permanently. Native focus visibility comes from the platform.
 */
export function focusRing(focused: boolean, color: string, offset = 2): object {
  if (Platform.OS !== "web") {
    return {};
  }
  return {
    outlineStyle: focused ? "solid" : "none",
    outlineWidth: 2,
    outlineColor: color,
    outlineOffset: offset,
  };
}

/**
 * Web-only CSS transition props (native animates via Animated instead).
 *
 * The easing defaults to `motion.ease.out` because that is what almost every
 * transition in this product is: something entering, leaving, or answering a
 * press. A caller transitioning only colour should pass `motion.ease.color` —
 * there is no movement there to give momentum to, and the plain keyword is the
 * honest answer. `motion.ease` says which to reach for and why.
 */
export function webTransition(
  properties: string,
  durationMs: number,
  easing: string = motion.ease.out,
): object {
  if (Platform.OS !== "web") {
    return {};
  }
  return {
    transitionProperty: properties,
    transitionDuration: `${durationMs}ms`,
    transitionTimingFunction: easing,
  };
}

/**
 * The opposite of `webTransition`: state that a property must **not** be eased.
 *
 * Needed where `Animated` already drives a property frame by frame. The browser
 * would otherwise apply its own transition on top of RN's interpolation, and
 * the two would fight — the marker lagging its own animation. A `0ms` duration
 * is the suppression; this exists so that reads as intent rather than as a
 * transition somebody forgot to finish, and so the rule that every real
 * transition carries a curve can stay absolute.
 */
export function webNoTransition(properties: string): object {
  if (Platform.OS !== "web") {
    return {};
  }
  return { transitionProperty: properties, transitionDuration: "0ms" };
}
