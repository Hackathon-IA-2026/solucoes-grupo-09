/**
 * Noviq design tokens v2 — violet SaaS system.
 * References: AppFollow brand language (vivid purple primary, amber-highlighted
 * display phrases, lilac pill kickers, floating white cards) refined with a
 * modern dashboard aesthetic (soft pastel status pills, lavender-gray panels,
 * hairline borders, layered shadows).
 *
 * 60-30-10: white/lavender canvas (60), indigo-navy ink + surfaces (30),
 * violet accent (10) with one gold display highlight per screen.
 * Every text/background pair meets WCAG AA in both schemes
 * (≥4.5:1 body, ≥3:1 large/bold display).
 */

export interface Palette {
  /** Page canvas (the 60%). */
  canvas: string;
  /** Soft lavender wash behind the hero. */
  canvasTint: string;
  /** Cards and raised surfaces. */
  surface: string;
  /** Sunken panels (inputs, seg controls, alternate sections). */
  surfaceSunken: string;
  /** Primary text — deep indigo navy. */
  ink: string;
  /** Secondary text. */
  inkMuted: string;
  /** Tertiary text / placeholders (still ≥4.5:1 on surface). */
  inkFaint: string;
  /** Hairline borders. */
  border: string;
  /** Stronger border (secondary buttons, focused input). */
  borderStrong: string;
  /** The 10%: brand violet. */
  accent: string;
  /** Accent hover/pressed. */
  accentStrong: string;
  /** Text on accent fills. */
  onAccent: string;
  /** Soft lilac wash (kicker pills, active chips, scraping state). */
  accentSoft: string;
  /** Text on the soft lilac wash. */
  onAccentSoft: string;
  /** Gold display highlight — one phrase per screen (large/bold text only). */
  highlight: string;
  /** Semantic: success (mint pills, done states). */
  success: string;
  successSoft: string;
  onSuccessSoft: string;
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
  /** Brand gradient for icon chips / logo mark (CSS gradient string). */
  gradient: string;
  /** Layered card shadow. */
  shadowCard: string;
  /** Bigger floating shadow (hero card). */
  shadowFloat: string;
}

export const light: Palette = {
  canvas: "#FFFFFF",
  canvasTint: "#F3F1FC",
  surface: "#FFFFFF",
  surfaceSunken: "#F5F5FB",
  ink: "#20243C",
  inkMuted: "#4E5470",
  inkFaint: "#666D8C",
  border: "#E7E7F2",
  borderStrong: "#C3C4DE",
  accent: "#6428E0",
  accentStrong: "#4E1DB8",
  onAccent: "#FFFFFF",
  accentSoft: "#EDE8FC",
  onAccentSoft: "#4E1DB8",
  highlight: "#A87805",
  success: "#157F3D",
  successSoft: "#E1F6EA",
  onSuccessSoft: "#116232",
  danger: "#C01F14",
  dangerSoft: "#FDE9E7",
  onDangerSoft: "#96190F",
  warning: "#8A6100",
  warningSoft: "#FFF2D2",
  onWarningSoft: "#6E4E00",
  info: "#1D4ED8",
  infoSoft: "#E8F0FE",
  onInfoSoft: "#1A44BC",
  star: "#E8A200",
  focus: "#6428E0",
  gradient: "linear-gradient(140deg, #8E5CF6 0%, #6428E0 100%)",
  shadowCard: "0 1px 2px rgba(32, 28, 80, 0.05), 0 4px 16px rgba(32, 28, 80, 0.06)",
  shadowFloat: "0 24px 60px rgba(50, 22, 128, 0.14), 0 4px 14px rgba(50, 22, 128, 0.07)",
};

export const dark: Palette = {
  canvas: "#131522",
  canvasTint: "#191C2E",
  surface: "#1E2138",
  surfaceSunken: "#181B2D",
  ink: "#F2F2FA",
  inkMuted: "#B9BCD8",
  inkFaint: "#9EA2C4",
  border: "#2C2F4A",
  borderStrong: "#4B4F76",
  accent: "#977CFF",
  accentStrong: "#B09BFF",
  onAccent: "#180E45",
  accentSoft: "#2B2452",
  onAccentSoft: "#C9BCFF",
  highlight: "#FFC94D",
  success: "#4ADE80",
  successSoft: "#12301F",
  onSuccessSoft: "#7EE2A8",
  danger: "#F97066",
  dangerSoft: "#3A1512",
  onDangerSoft: "#FDA29B",
  warning: "#FDB022",
  warningSoft: "#38290C",
  onWarningSoft: "#FEC84B",
  info: "#7DA8F8",
  infoSoft: "#16233F",
  onInfoSoft: "#A6C4FA",
  star: "#FFC94D",
  focus: "#977CFF",
  gradient: "linear-gradient(140deg, #A98BFF 0%, #7B52F0 100%)",
  shadowCard: "0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.35)",
  shadowFloat: "0 24px 60px rgba(0, 0, 0, 0.5), 0 4px 14px rgba(0, 0, 0, 0.4)",
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

/** Type scale (hero sizes chosen per breakpoint in components). */
export const type = {
  hero: { fontSize: 44, lineHeight: 48, fontWeight: "800" },
  heroLarge: { fontSize: 64, lineHeight: 66, fontWeight: "800" },
  h2: { fontSize: 28, lineHeight: 34, fontWeight: "800" },
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
