import { space, useContainerWidth, usePalette } from "@wattsteer/ui";
import Head from "expo-router/head";
import { useCallback, useRef } from "react";
import { ScrollView, View } from "react-native";
import { Engines } from "@/components/landing/engines";
import { Hero } from "@/components/landing/hero";
import { LandingNav } from "@/components/landing/landing-nav";
import { Provenance } from "@/components/landing/provenance";
import { Section, type SectionId } from "@/components/landing/section";
import { Showcase } from "@/components/landing/showcase";
import { SiteFooter } from "@/components/site-footer";
import { SITE_URL } from "@/lib/config";

const TITLE = "WattSteer — renewable curtailment intelligence for the Brazilian grid";
const DESCRIPTION =
  "Day-ahead curtailment risk for all four Brazilian subsystems, forecast as a P10–P90 range from ONS open data — with the grid conditions behind it and the storage and flexible demand that could absorb it.";

/** Canonical URL: one unambiguous form (trailing slash, matching sitemap.xml). */
const CANONICAL_URL = `${SITE_URL}/`;

/**
 * The landing page.
 *
 * Structure, and why it is in this order: the hero *is* the forecast, because
 * a visitor with nothing to type needs to be shown the subject rather than
 * asked for it; then the four engines, which is the answer to "so it's a
 * forecast, and?"; then the three post-forecast screens over fixture data;
 * then where the data comes from and what the product refuses to claim.
 *
 * Everything renders from `components/landing/fixtures.ts` — no fetch, no
 * effects that depend on a network — so the static export contains the full
 * text of the page and the SEO argument for static rendering still holds.
 * When the forecast API exists, the fixture module is the only seam that has
 * to change.
 */
export default function Home() {
  const colors = usePalette();
  const scrollRef = useRef<ScrollView>(null);
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 900;

  // Section offsets are measured, not hard-coded, so the nav keeps working
  // when copy reflows — and it works identically on native, where a URL
  // fragment would not.
  const offsets = useRef<Partial<Record<SectionId, number>>>({});
  const onSectionLayout = useCallback((id: SectionId, y: number) => {
    offsets.current[id] = y;
  }, []);
  const scrollTo = useCallback((id: SectionId) => {
    const y = offsets.current[id];
    if (y !== undefined) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
    }
  }, []);

  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={CANONICAL_URL} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content={CANONICAL_URL} />
        <meta property="og:site_name" content="WattSteer" />
      </Head>

      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.canvas }}
        contentContainerStyle={{ flexGrow: 1 }}
        onLayout={onLayout}
      >
        <LandingNav onNavigate={scrollTo} />

        <Section
          id="forecast"
          testID="landing-hero"
          onSectionLayout={onSectionLayout}
          paddingTop={space.xxl}
        >
          <Hero onExplain={() => scrollTo("engines")} />
        </Section>

        <Section id="engines" testID="landing-engines" onSectionLayout={onSectionLayout}>
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
          <Section id="showcase" testID="landing-showcase">
            <Showcase wide={wide} />
          </Section>
        </View>

        <Section
          id="provenance"
          testID="landing-provenance"
          onSectionLayout={onSectionLayout}
        >
          <Provenance wide={wide} />
        </Section>

        <SiteFooter />
      </ScrollView>
    </>
  );
}
