import { usePalette } from "@noviq/ui";
import Head from "expo-router/head";
import { useRef } from "react";
import { Platform, ScrollView } from "react-native";
import { Dashboard } from "@/components/dashboard";
import { ScraperHero } from "@/components/scraper-hero";
import { Showcase } from "@/components/showcase";
import { useScrape } from "@/hooks/use-scrape";
import { SITE_URL } from "@/lib/config";

const TITLE = "App Store & Google Play Review Scraper — Free CSV Export | Noviq";
const DESCRIPTION =
  "Scrape every App Store and Google Play review into clean data — sentiment, trends, version history, CSV/JSON export. Free, no signup required.";

/** Canonical URL: one unambiguous form (trailing slash, matching sitemap.xml). */
const CANONICAL_URL = `${SITE_URL}/`;

// One <script> per schema: the most compatible shape for JSON-LD consumers.
const JSON_LD_SCHEMAS = [
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Noviq",
    url: CANONICAL_URL,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: DESCRIPTION,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    screenshot: `${SITE_URL}/og.png`,
    featureList:
      "App Store review scraping, Google Play review scraping, sentiment analysis, rating trends, version history, activity heatmap, CSV export, JSON export",
  }),
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Noviq",
    url: CANONICAL_URL,
    logo: `${SITE_URL}/icon-512.png`,
  }),
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Noviq",
    url: CANONICAL_URL,
  }),
];

export default function Home() {
  const colors = usePalette();
  const { state, busy, submit, cancel, reset } = useScrape();
  const scrollRef = useRef<ScrollView>(null);

  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={CANONICAL_URL} />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="en_US" />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content={CANONICAL_URL} />
        <meta property="og:site_name" content="Noviq" />
        <meta property="og:image" content={`${SITE_URL}/og.png`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="Noviq — turn any app's reviews into clean data."
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={`${SITE_URL}/og.png`} />
        <meta
          name="twitter:image:alt"
          content="Noviq — turn any app's reviews into clean data."
        />
        {Platform.OS === "web"
          ? JSON_LD_SCHEMAS.map((schema) => (
              <script key={schema.slice(0, 60)} type="application/ld+json">
                {schema}
              </script>
            ))
          : null}
      </Head>

      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.canvas }}
        contentContainerStyle={{ flexGrow: 1 }}
      >
        {state.phase === "completed" ? (
          <Dashboard result={state.result} onNewScrape={reset} />
        ) : (
          <>
            <ScraperHero
              state={state}
              busy={busy}
              onSubmit={submit}
              onCancel={cancel}
              onDismissError={reset}
            />
            {/* The product, shown — real dashboard components on sample data. */}
            {busy ? null : (
              <Showcase
                onTryIt={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
              />
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}
