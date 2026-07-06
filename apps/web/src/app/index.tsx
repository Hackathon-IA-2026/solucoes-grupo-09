import Head from "expo-router/head";
import { Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { ProgressPanel } from "@/components/progress-panel";
import { ResultsPanel } from "@/components/results-panel";
import { ScrapeCard } from "@/components/scrape-card";
import {
  FAQ_ENTRIES,
  Faq,
  FeatureGrid,
  HowItWorks,
  SiteFooter,
} from "@/components/sections";
import { SiteHeader } from "@/components/site-header";
import { useContainerWidth } from "@/hooks/use-container-width";
import { usePalette } from "@/hooks/use-palette";
import { useScrape } from "@/hooks/use-scrape";
import { SITE_URL } from "@/lib/config";
import { layout, radius, space } from "@/theme/tokens";

const TITLE = "Noviq — Scrape App Store & Google Play reviews to CSV";
const DESCRIPTION =
  "Paste any App Store or Google Play link and get every review — ratings, dates, developer responses — exported to CSV or JSON in about a minute. Free, no signup.";

// One <script> per schema (not an array in a single tag): the most
// compatible shape for third-party JSON-LD consumers — several browser
// SEO extensions and older parsers assume one top-level object per tag.
const JSON_LD_SCHEMAS = [
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Noviq",
    url: SITE_URL,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: DESCRIPTION,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  }),
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ENTRIES.map((entry) => ({
      "@type": "Question",
      name: entry.q,
      acceptedAnswer: { "@type": "Answer", text: entry.a },
    })),
  }),
];

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const colors = usePalette();
  return (
    <View
      testID="error-banner"
      accessibilityLiveRegion="assertive"
      style={{
        backgroundColor: colors.dangerSoft,
        borderRadius: radius.md,
        borderCurve: "continuous",
        padding: space.lg,
        gap: space.md,
        width: "100%",
      }}
    >
      <Text
        selectable
        style={{
          color: colors.onDangerSoft,
          fontSize: 14,
          lineHeight: 21,
          fontWeight: "600",
        }}
      >
        {message}
      </Text>
      <Button label="Dismiss" variant="ghost" onPress={onDismiss} />
    </View>
  );
}

export default function Home() {
  const colors = usePalette();
  const insets = useSafeAreaInsets();
  const [containerWidth, onLayout] = useContainerWidth();
  // Container ≥ 880 fits copy + card side by side comfortably.
  const desktop = containerWidth >= 880;
  const { state, busy, submit, cancel, reset } = useScrape();

  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={SITE_URL} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:site_name" content="Noviq" />
        <meta property="og:image" content={`${SITE_URL}/og.png`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="Noviq — every app review, one paste away. Scrape App Store & Google Play reviews to CSV."
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={`${SITE_URL}/og.png`} />
        {/* Web only: structured data is for search engines, which only see
            the web build; native Head consumers assume single objects. */}
        {Platform.OS === "web"
          ? JSON_LD_SCHEMAS.map((schema) => (
              <script key={schema.slice(0, 60)} type="application/ld+json">
                {schema}
              </script>
            ))
          : null}
      </Head>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.canvas }}
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + space.xxl,
        }}
      >
        {/* Soft brand wash behind the hero (60% canvas, gentle 10% accent). */}
        <View
          pointerEvents="none"
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 640,
            experimental_backgroundImage: `linear-gradient(180deg, ${colors.canvasTint} 0%, ${colors.canvas} 100%)`,
          }}
        />

        <View
          onLayout={onLayout}
          style={{
            width: "100%",
            maxWidth: layout.page,
            alignSelf: "center",
            paddingHorizontal: space.lg,
            gap: space.huge,
          }}
        >
          <View style={{ gap: space.xxl }}>
            <SiteHeader />

            {state.phase === "completed" ? (
              <ResultsPanel result={state.result} onNewScrape={reset} />
            ) : (
              <View
                style={{
                  flexDirection: desktop ? "row" : "column",
                  gap: desktop ? space.xxxl : space.xxl,
                  alignItems: desktop ? "center" : "stretch",
                }}
              >
                {/* Hero copy — first thing read (serial position). */}
                <View style={{ flex: desktop ? 1 : undefined, gap: space.xl }}>
                  <Text
                    accessibilityRole="header"
                    aria-level={1}
                    style={{
                      color: colors.ink,
                      fontSize: desktop ? 60 : 40,
                      lineHeight: desktop ? 64 : 44,
                      fontWeight: "800",
                      letterSpacing: desktop ? -1.5 : -0.8,
                    }}
                  >
                    Every app review.{"\n"}One paste away.
                  </Text>
                  <Text
                    style={{
                      color: colors.inkMuted,
                      fontSize: desktop ? 19 : 16,
                      lineHeight: desktop ? 30 : 25,
                      maxWidth: 520,
                    }}
                  >
                    Paste an App Store or Google Play link. Noviq scrapes the reviews —
                    ratings, dates, developer responses — and hands you a clean CSV in
                    about a minute.
                  </Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    {[
                      "No signup",
                      "App Store + Google Play",
                      "CSV & JSON",
                      "150+ storefronts",
                    ].map((chip) => (
                      <View
                        key={chip}
                        style={{
                          backgroundColor: colors.surface,
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: radius.pill,
                          paddingHorizontal: space.md,
                          paddingVertical: 6,
                        }}
                      >
                        <Text
                          style={{
                            color: colors.inkMuted,
                            fontSize: 13,
                            fontWeight: "600",
                          }}
                        >
                          {chip}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>

                {/* The action column — card, progress, or error + card. */}
                <View
                  style={{
                    flex: desktop ? 1 : undefined,
                    maxWidth: desktop ? 480 : undefined,
                    gap: space.lg,
                    width: "100%",
                  }}
                >
                  {state.phase === "failed" ? (
                    <ErrorBanner message={state.message} onDismiss={reset} />
                  ) : null}
                  {state.phase === "submitting" ||
                  state.phase === "queued" ||
                  state.phase === "scraping" ? (
                    <ProgressPanel state={state} onCancel={cancel} />
                  ) : (
                    <ScrapeCard busy={busy} onSubmit={submit} />
                  )}
                </View>
              </View>
            )}
          </View>

          <HowItWorks />
          <FeatureGrid />
          <Faq />
          <SiteFooter />
        </View>
      </ScrollView>
    </>
  );
}
