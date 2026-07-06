import { dark, type Palette } from "../tokens";

/** The active palette. The system is dark-only (reference: color-scheme dark). */
export function usePalette(): Palette {
  return dark;
}
