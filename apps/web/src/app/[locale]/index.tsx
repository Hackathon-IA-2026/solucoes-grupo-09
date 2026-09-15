import { space, useContainerWidth, usePalette } from "@wattsteer/ui";
import { useRef } from "react";
import { ScrollView, View } from "react-native";
import { Deck } from "@/components/landing/deck";
import { Engines } from "@/components/landing/engines";
import { Hero } from "@/components/landing/hero";
import { LandingNav } from "@/components/landing/landing-nav";
import { Provenance } from "@/components/landing/provenance";
import { Section } from "@/components/landing/section";
import { Showcase } from "@/components/landing/showcase";
import { useSectionFragment } from "@/components/landing/use-section-fragment";
import { SeoHead } from "@/components/seo-head";
import { SiteFooter } from "@/components/site-footer";
import { useI18n } from "@/i18n";

/**
 * The landing page, at `/pt/` and `/en/`.
 *
 * Structure, and why it is in this order: the hero *is* the forecast, because
 * a visitor with nothing to type needs to be shown the subject rather than
 * asked for it; then the four engines, which is the answer to "so it's a
 * forecast, and?"; then the three post-forecast screens over fixture data;
 * then where the data comes from and what the product refuses to claim.
 *
 * Everything renders from `components/landing/fixtures.ts` — no fetch, no
 * effects that depend on a network — so the static export contains the full
 * text of the page, in both locales, and the SEO argument for static
 * rendering holds for each of them independently.
 */
export default function Home() {
  const { locale, copy } = useI18n();
  const colors = usePalette();
  const scrollRef = useRef<ScrollView>(null);
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 900;

  // Section offsets are measured, not hard-coded, so the nav keeps working
  // when copy reflows — and it works identically on native, where a URL
  // fragment would not. It also survives the copy being a different length
  // in each locale, which a hard-coded offset would not.
  //
  // `goTo` additionally writes the section's fragment onto the URL, and a URL
  // that arrives carrying one is scrolled to on first paint. See
  // `use-section-fragment.ts` for why that is a *pending target* spent by the
  // first layout rather than something an effect could do on mount.
  const { onSectionLayout, goTo } = useSectionFragment(scrollRef);

  return (
    <>
      <SeoHead
        locale={locale}
        path=""
        title={copy.meta.home.title}
        description={copy.meta.home.description}
      />

      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.canvas }}
        contentContainerStyle={{ flexGrow: 1 }}
        onLayout={onLayout}
      >
        <LandingNav onNavigate={goTo} />

        <Section
          id="forecast"
          testID="landing-hero"
          onSectionLayout={onSectionLayout}
          wide={wide}
          paddingTop={space.xxl}
        >
          <Hero onExplain={() => goTo("engines")} />
        </Section>

        <Section
          id="engines"
          testID="landing-engines"
          onSectionLayout={onSectionLayout}
          wide={wide}
        >
          <Engines wide={wide} />
        </Section>

        {/* Tinted band so the product panels read as a distinct zone. The
            wrapper reports the offset, not the Section inside it: a child's
            `layout.y` is relative to its parent, so measuring the Section
            here would return 0 and the nav would scroll to the wrong place. */}
        <View
          style={{ width: "100%", backgroundColor: colors.canvasTint }}
          onLayout={(event) => onSectionLayout("showcase", event.nativeEvent.layout.y)}
        >
          <Section id="showcase" testID="landing-showcase" wide={wide}>
            <Showcase wide={wide} />
          </Section>
        </View>

        <Section
          id="provenance"
          testID="landing-provenance"
          onSectionLayout={onSectionLayout}
          wide={wide}
        >
          <Provenance wide={wide} />
        </Section>

        {/* The deck last, and only after the page has made the argument in
            the product's own order: it is the same case in the order it was
            first made, which is a thing to offer a reader who has finished
            rather than one to put in front of a reader who has not started.
            Its own file states why the PDF is not embedded here. */}
        <Section
          id="deck"
          testID="landing-deck"
          onSectionLayout={onSectionLayout}
          wide={wide}
        >
          <Deck wide={wide} />
        </Section>

        <SiteFooter />
      </ScrollView>
    </>
  );
}
