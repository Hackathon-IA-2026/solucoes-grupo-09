import { type Palette, palette } from "@/theme/tokens";
import { useColorScheme } from "./use-color-scheme";

/** The active palette, SSR-safe (light during static render, then hydrated). */
export function usePalette(): Palette {
  return palette(useColorScheme());
}
