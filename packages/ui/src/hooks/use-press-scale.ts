/**
 * How far a control gives under a press, with the reduced-motion rule applied.
 *
 * The product had four numbers — `0.97`, `0.95`, `0.95`, `0.92` — and only one
 * of the four checked `prefers-reduced-motion`, so a reader who had asked for
 * less motion still got three of them. The check belongs beside the value, and
 * a hook is the only place both can be stated together.
 *
 * Returns the *scale* rather than a transform because the value is read inside
 * `Pressable`'s style callback, where `pressed` lives and a hook cannot be
 * called. Under reduced motion it is `1`, so a call site that uses it cannot
 * accidentally animate: there is nothing to forget.
 */

import { motion } from "../tokens";
import { useReducedMotion } from "./use-reduced-motion";

export function usePressScale(): number {
  return useReducedMotion() ? 1 : motion.pressScale;
}
