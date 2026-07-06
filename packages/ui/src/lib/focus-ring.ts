import { Platform } from "react-native";

/**
 * Keyboard focus ring, web only. RN 0.86 (new architecture) renders outline*
 * styles natively too — where there is no keyboard focus state, so the ring
 * would show permanently. Native focus visibility comes from the platform.
 */
export function focusRing(focused: boolean, color: string, offset = 2): object {
  if (Platform.OS !== "web") return {};
  return {
    outlineStyle: focused ? "solid" : "none",
    outlineWidth: 2,
    outlineColor: color,
    outlineOffset: offset,
  };
}

/** Web-only CSS transition props (native animates via Animated instead). */
export function webTransition(properties: string, durationMs: number): object {
  if (Platform.OS !== "web") return {};
  return { transitionProperty: properties, transitionDuration: `${durationMs}ms` };
}
