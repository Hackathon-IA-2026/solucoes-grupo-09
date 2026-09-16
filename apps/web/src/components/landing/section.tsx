import { layout, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";
import { PAGE_MAX, sectionPad } from "@/components/landing/layout";
import type { SectionId } from "@/lib/section-fragment";

/**
 * Named scroll targets. Declared in `lib/section-fragment.ts`, because the URL
 * fragment that names one has to be parsed by a module `bun test` can import
 * and this file cannot be one — re-exported here so the components still read
 * the vocabulary from the module that renders it.
 */
export type { SectionId } from "@/lib/section-fragment";

/**
 * Page-width section wrapper.
 *
 * `onLayout` reports the section's y within the scroll content so the nav can
 * scroll to it — measured rather than hard-coded, and identical on web and
 * native, which is why the scrolling is not delegated to the browser's own
 * anchor handling.
 *
 * `nativeID` renders as a DOM `id` on web, which is what makes the nav's
 * `href="#engines"` an honest anchor rather than a decoration: the fragment
 * resolves to an element with or without JavaScript, and the same id is the
 * one `lib/section-fragment.ts` parses out of the URL. It is inert on native,
 * where the measured offset above is the whole mechanism.
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
      nativeID={id}
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
