/**
 * Noviq design tokens — the single source of truth for color, space, type,
 * radius, and motion. 60-30-10: warm neutral canvas (60), ink + surfaces (30),
 * emerald accent (10). Every text/background pair here meets WCAG AA
 * (≥ 4.5:1 body, ≥ 3:1 large text) in both schemes.
 */

export interface Palette {
  /** Page canvas (the 60%). */
  canvas: string;
  /** Soft tinted wash behind the hero. */
  canvasTint: string;
  /** Cards and raised surfaces. */
  surface: string;
  /** Subtle inset surface (input fields, code-ish chips). */
  surfaceSunken: string;
  /** Primary text. */
  ink: string;
  /** Secondary text. */
  inkMuted: string;
  /** Tertiary text / placeholders (still ≥ 4.5:1 on surface). */
  inkFaint: string;
  /** Hairline borders. */
  border: string;
  /** Stronger border (focused input). */
  borderStrong: string;
  /** The 10%: brand emerald. */
  accent: string;
  /** Accent hover/pressed. */
  accentStrong: string;
  /** Text on accent fills. */
  onAccent: string;
  /** Soft accent wash (badges, success tints). */
  accentSoft: string;
  /** Text on the soft accent wash. */
  onAccentSoft: string;
  /** Semantic. */
  danger: string;
  dangerSoft: string;
  onDangerSoft: string;
  warning: string;
  warningSoft: string;
  onWarningSoft: string;
  info: string;
  infoSoft: string;
  onInfoSoft: string;
  /** Star gold. */
  star: string;
  /** Focus ring. */
  focus: string;
}

export const light: Palette = {
  canvas: "#FAF8F4",
  canvasTint: "#F1EFE7",
  surface: "#FFFFFF",
  surfaceSunken: "#F4F2EC",
  ink: "#191C1F",
  inkMuted: "#4A5158",
  inkFaint: "#5F6871",
  border: "#E5E1D8",
  borderStrong: "#B9B4A7",
  accent: "#047857",
  accentStrong: "#065F46",
  onAccent: "#FFFFFF",
  accentSoft: "#DCF5EA",
  onAccentSoft: "#065F46",
  danger: "#B42318",
  dangerSoft: "#FDECEA",
  onDangerSoft: "#8A1C12",
  warning: "#92400E",
  warningSoft: "#FEF3E2",
  onWarningSoft: "#7C3A0D",
  info: "#1D4ED8",
  infoSoft: "#E7EEFC",
  onInfoSoft: "#1E40AF",
  star: "#D97706",
  focus: "#047857",
};

export const dark: Palette = {
  canvas: "#0E1113",
  canvasTint: "#14181B",
  surface: "#1A1F23",
  surfaceSunken: "#14181B",
  ink: "#F2F4F5",
  inkMuted: "#B5BDC4",
  inkFaint: "#9AA3AB",
  border: "#2A3136",
  borderStrong: "#4A545C",
  accent: "#2FBE8B",
  accentStrong: "#54D6A8",
  onAccent: "#06281C",
  accentSoft: "#123A2D",
  onAccentSoft: "#7FE0BC",
  danger: "#F97066",
  dangerSoft: "#3A1512",
  onDangerSoft: "#FDA29B",
  warning: "#FDB022",
  warningSoft: "#3A2A0E",
  onWarningSoft: "#FEC84B",
  info: "#7DA8F8",
  infoSoft: "#14233F",
  onInfoSoft: "#A6C4FA",
  star: "#F5A623",
  focus: "#2FBE8B",
};

export function palette(scheme: string | null | undefined): Palette {
  return scheme === "dark" ? dark : light;
}

/** 4-pt spacing scale. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  huge: 72,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** Type scale (fluid-ish: hero sizes chosen per breakpoint in components). */
export const type = {
  hero: { fontSize: 44, lineHeight: 48, fontWeight: "800" },
  heroLarge: { fontSize: 64, lineHeight: 66, fontWeight: "800" },
  h2: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  h3: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 26, fontWeight: "400" },
  bodySmall: { fontSize: 14, lineHeight: 21, fontWeight: "400" },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "500" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
} as const;

/** Motion durations (ms) — short and purposeful (150–300ms). */
export const motion = {
  fast: 150,
  base: 220,
  slow: 300,
} as const;

/** Content max-widths. */
export const layout = {
  page: 1120,
  prose: 680,
  /** Breakpoint where the hero goes two-column. */
  desktop: 1024,
  /** Minimum touch target. */
  touch: 44,
} as const;
