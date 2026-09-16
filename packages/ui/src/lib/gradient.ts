import { Platform } from "react-native";

/** The landing readout card's violet wash. `NationalPanel` wears the same one. */
export const READOUT_WASH =
  "radial-gradient(120% 90% at 8% -10%, rgba(141, 93, 246, 0.22) 0%, transparent 60%)";

/**
 * Brand-gradient background, cross-platform: RN Web wants CSS `backgroundImage`,
 * native (new arch) wants `experimental_backgroundImage`. A solid fallback
 * color underneath guarantees the element is never invisible if either path
 * doesn't apply.
 */
export function gradientBg(gradient: string, fallback: string): object {
  return {
    backgroundColor: fallback,
    ...(Platform.OS === "web"
      ? { backgroundImage: gradient }
      : { experimental_backgroundImage: gradient }),
  };
}

/**
 * Diagonal hatch fill (reference `.hatch-grape` / `.hatch-lime`): a
 * repeating-linear-gradient on web; native falls back to a translucent solid
 * (repeating gradients aren't supported by the native style engine).
 */
export function hatchBg(rgb: string, lineAlpha: number, baseAlpha: number): object {
  const base = `rgba(${rgb}, ${baseAlpha})`;
  if (Platform.OS !== "web") {
    return { backgroundColor: `rgba(${rgb}, ${baseAlpha + 0.22})` };
  }
  return {
    backgroundColor: base,
    backgroundImage: `repeating-linear-gradient(45deg, rgba(${rgb}, ${lineAlpha}) 0, rgba(${rgb}, ${lineAlpha}) 1.5px, transparent 1.5px, transparent 6px)`,
  };
}

/** Grape hatch (level-1 heatmap cells, negative gauge legend dot). */
export function hatchGrape(): object {
  return hatchBg("141, 93, 246", 0.55, 0.14);
}

/** Lime hatch (level-2 heatmap cells). */
export function hatchLime(): object {
  return hatchBg("208, 242, 68", 0.45, 0.1);
}
