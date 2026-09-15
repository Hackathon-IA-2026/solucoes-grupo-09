import { layout, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";

/** Named scroll targets. The nav and the CTAs address sections by these. */
export type SectionId = "forecast" | "engines" | "showcase" | "provenance";

/**
 * The page gutter, shared by the nav, every section and the footer.
 *
 * It used to be written out as `layout.page + 128` in three files, which is
 * three chances for the header, the sections and the footer to stop lining up
 * with each other — and nothing would have failed. One constant, imported by
 * all three, means the left edge of the wordmark and the left edge of the ODbL
 * notice are the same number by construction. The 128 is eight gutters of
 * `space.lg`, so the widened page is still on the 4-pt scale.
 */
export const PAGE_MAX = layout.page + space.lg * 8;

/**
 * Vertical air above and below a section.
 *
 * `space.huge` top and bottom puts 144 px between two adjacent sections, which
 * is right on a desktop page 5,264 px tall and wrong on a phone page 8,493 px
 * tall (both measured on the exported build). Narrow drops to `space.xxxl`, so
 * the between-sections gap is 96 px there — still the largest gap on the page
 * by a factor of four, which is what the rhythm needs it to be.
 */
export function sectionPad(wide: boolean): number {
  return wide ? space.huge : space.xxxl;
}

/**
 * Page-width section wrapper. `onLayout` reports the section's y within the
 * scroll content so the nav can scroll to it — measured rather than
 * hard-coded, and identical on web and native (an anchor-hash approach would
 * only work on one of the two).
 */
export function Section({
  id,
  onSectionLayout,
  children,
  wide,
  paddingTop,
  paddingBottom,
  testID,
}: {
  id: SectionId;
  onSectionLayout?: (id: SectionId, y: number) => void;
  children: ReactNode;
  wide: boolean;
  paddingTop?: number;
  paddingBottom?: number;
  testID?: string;
}) {
  const handleLayout = (event: LayoutChangeEvent): void => {
    onSectionLayout?.(id, event.nativeEvent.layout.y);
  };
  return (
    <View
      testID={testID}
      onLayout={handleLayout}
      style={{
        width: "100%",
        maxWidth: PAGE_MAX,
        alignSelf: "center",
        paddingHorizontal: space.lg,
        paddingTop: paddingTop ?? sectionPad(wide),
        paddingBottom: paddingBottom ?? sectionPad(wide),
        gap: space.xl,
      }}
    >
      {children}
    </View>
  );
}

/** Centred section heading: title (with an optional accent clause) + lede. */
export function SectionHeading({
  title,
  accent,
  sub,
  wide,
}: {
  title: string;
  accent?: string;
  sub: string;
  wide: boolean;
}) {
  const colors = usePalette();
  return (
    <View style={{ alignItems: "center", gap: space.lg }}>
      <Text
        accessibilityRole="header"
        aria-level={2}
        style={{
          textAlign: "center",
          fontSize: wide ? 38 : 28,
          lineHeight: wide ? 44 : 34,
          fontWeight: "600",
          letterSpacing: -1,
          color: colors.ink,
        }}
      >
        {title}
        {accent === undefined ? null : (
          <Text style={{ color: colors.accent }}>{` ${accent}`}</Text>
        )}
      </Text>
      {/* The lede is capped at the design system's own prose measure rather
          than at the 620 it used to carry, which was a number with nothing
          behind it. At 15 px, 680 px is about 95 characters a line. */}
      <Text
        style={{
          textAlign: "center",
          fontSize: 15,
          lineHeight: 23,
          color: colors.inkMuted,
          maxWidth: layout.prose,
        }}
      >
        {sub}
      </Text>
    </View>
  );
}

/**
 * Small muted footnote — the honesty lines live in these.
 *
 * Capped at `layout.prose`. Inside a panel that cap is inert (a showcase panel
 * is ~380 px wide), but `engines.status` is a footnote on the *section*, and
 * it was being set across the full 1,248 px content column: 196 characters a
 * line, at 12 px, for the single most important caveat on the page. The cap
 * takes that to 108.
 *
 * `pinned` pushes the footnote to the bottom of a flex column. The three
 * showcase panels stretch to the tallest of them, and without this their
 * caveats floated at three different heights with up to 250 px of dead card
 * under the shortest — measured at 1280.
 */
export function Footnote({
  children,
  pinned = false,
}: {
  children: ReactNode;
  pinned?: boolean;
}) {
  const colors = usePalette();
  return (
    <Text
      style={{
        fontSize: 12,
        lineHeight: 19,
        color: colors.inkFaint,
        maxWidth: layout.prose,
        ...(pinned ? { marginTop: "auto" } : null),
      }}
    >
      {children}
    </Text>
  );
}
