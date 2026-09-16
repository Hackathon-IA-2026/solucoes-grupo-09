/**
 * WattSteer design tokens v3 — ported 1:1 from the reference app
 * (`reference/app/globals.css`). Dark-only, like the
 * reference (`color-scheme: dark`): charcoal canvas, near-black raised cards,
 * lime primary with dark-olive text, grape violet secondary, hairline
 * white/8% borders, 24px cards and pill controls.
 *
 * oklch values from the reference converted to hex:
 *   background oklch(0.17 .005 285)  → #131316
 *   card       oklch(0.215 .006 285) → #1B1B1F
 *   secondary  oklch(0.27 .006 285)  → #26262B
 *   foreground oklch(0.97 0 0)       → #F7F7F7
 *   muted-fg   oklch(0.68 .01 285)   → #A2A2AC
 *   lime       oklch(0.9 .19 120)    → #D0F244  (on-lime oklch(0.2 .03 130) → #1E2B10)
 *   grape      oklch(0.62 .2 285)    → #8D5DF6
 *   destructive oklch(0.63 .21 25)   → #EA4A3D
 *   chart-3/4/5 → cyan #38C3DD · orange #EDA23F · pink #ED6BB0
 */

export interface Palette {
  /** Page background (ref `--background`). */
  canvas: string;
  /** Slightly lifted wash for glows/zebra zones. */
  canvasTint: string;
  /** Raised cards (ref `--card`). */
  surface: string;
  /** Inset panels, chips, input fields (ref `--secondary`/`--muted`). */
  surfaceSunken: string;
  /** Primary text (ref `--foreground`). */
  ink: string;
  /** Secondary text (ref `--muted-foreground`). */
  inkMuted: string;
  /** Tertiary text — muted at 70%. */
  inkFaint: string;
  /** Hairline borders (ref `--border`, white/8%). */
  border: string;
  /** Input borders (ref `--input`, white/12%). */
  borderStrong: string;
  /** Primary action — lime (ref `--lime`/`--primary`). */
  accent: string;
  accentStrong: string;
  /** Text on lime fills (ref `--lime-foreground`). */
  onAccent: string;
  /** Lime at 15% for tinted chips (ref `bg-lime/15`). */
  accentSoft: string;
  onAccentSoft: string;
  /** Secondary accent — grape violet (ref `--grape`). */
  violet: string;
  violetSoft: string;
  onVioletSoft: string;
  /** Display highlight = lime text on dark (ref hero `text-lime`). */
  highlight: string;
  success: string;
  successSoft: string;
  onSuccessSoft: string;
  /** ref `--destructive`. */
  danger: string;
  dangerSoft: string;
  onDangerSoft: string;
  warning: string;
  warningSoft: string;
  onWarningSoft: string;
  info: string;
  infoSoft: string;
  onInfoSoft: string;
  /** Stars are lime in the reference. */
  star: string;
  focus: string;
  /** Grape gradient (ref timeline active bar). */
  gradient: string;
  shadowCard: string;
  shadowFloat: string;
}

const dark: Palette = {
  canvas: "#131316",
  canvasTint: "#18181C",
  surface: "#1B1B1F",
  surfaceSunken: "#26262B",
  ink: "#F7F7F7",
  inkMuted: "#A2A2AC",
  /*
    `#87878F` until the palette was measured against WCAG AA rather than
    eyeballed. On `surfaceSunken` — the sunken card the honesty notes, the
    split tracks and most footnotes sit on — it was **4.23:1**, under the 4.5
    floor for body text, and footnotes are the smallest text this product sets.
    It passed on the other three surfaces (5.20, 4.97, 4.82), which is why it
    survived: the failure needed the faintest ink and the lightest card at the
    same time, and nothing rendered that pair on a screen an automated check
    was looking at.

    `#8F8F97` is the smallest change with margin: 4.69 on `surfaceSunken`, 5.78
    / 5.52 / 5.35 on the rest. It stays plainly below `inkMuted` — the three
    inks are still three steps — so nothing about the hierarchy moves.
    `test/contrast.test.ts` measures every ink against every surface and would
    have caught this on the day the token was written.
  */
  inkFaint: "#8F8F97",
  border: "rgba(255, 255, 255, 0.08)",
  borderStrong: "rgba(255, 255, 255, 0.14)",
  accent: "#D0F244",
  accentStrong: "#DDFA62",
  onAccent: "#1E2B10",
  accentSoft: "rgba(208, 242, 68, 0.15)",
  onAccentSoft: "#D0F244",
  violet: "#8D5DF6",
  violetSoft: "rgba(141, 93, 246, 0.15)",
  onVioletSoft: "#B393FF",
  highlight: "#D0F244",
  success: "#D0F244",
  successSoft: "rgba(208, 242, 68, 0.15)",
  onSuccessSoft: "#D0F244",
  danger: "#EA4A3D",
  dangerSoft: "rgba(234, 74, 61, 0.15)",
  onDangerSoft: "#FF8A7E",
  warning: "#EDA23F",
  warningSoft: "rgba(237, 162, 63, 0.15)",
  onWarningSoft: "#F5BE74",
  info: "#38C3DD",
  infoSoft: "rgba(56, 195, 221, 0.15)",
  onInfoSoft: "#7FDCEE",
  star: "#D0F244",
  focus: "#D0F244",
  gradient: "linear-gradient(180deg, #8D5DF6 0%, rgba(141, 93, 246, 0.35) 100%)",
  shadowCard: "0 1px 2px rgba(0, 0, 0, 0.35), 0 6px 20px rgba(0, 0, 0, 0.30)",
  shadowFloat: "0 24px 60px rgba(0, 0, 0, 0.55), 0 4px 14px rgba(0, 0, 0, 0.40)",
};

/** The reference is dark-only (`color-scheme: dark`) — both schemes resolve dark. */
export function palette(_scheme: string | null | undefined): Palette {
  return dark;
}

export { dark };

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

/** Ref: --radius 1rem; cards are rounded-3xl (24), inner blocks 2xl (16). */
export const radius = {
  sm: 10,
  md: 13,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const type = {
  hero: { fontSize: 40, lineHeight: 42, fontWeight: "600" },
  heroLarge: { fontSize: 60, lineHeight: 63, fontWeight: "600" },
  h2: { fontSize: 28, lineHeight: 34, fontWeight: "600" },
  h3: { fontSize: 20, lineHeight: 26, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 26, fontWeight: "400" },
  bodySmall: { fontSize: 14, lineHeight: 22, fontWeight: "400" },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "500" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
} as const;

export const motion = {
  fast: 150,
  base: 220,
  slow: 300,
} as const;

export const layout = {
  /**
   * The content column, and the one every full-width surface uses.
   *
   * 1280, not 1152. The landing page and the app screens were built against
   * two different numbers — the landing capped at `1152 + space.lg * 8` and the
   * app shell, the legal pages and `/pitch` at 1152 — so the site visibly
   * narrowed by 128 px the moment a reader left the marketing page. One
   * constant, because two surfaces of one product have no reason to disagree
   * about how wide the product is.
   */
  page: 1280,
  prose: 680,
  desktop: 1024,
  touch: 44,
} as const;
