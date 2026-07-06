import { usePalette } from "@noviq/ui";
import Head from "expo-router/head";
import { useRef } from "react";
import { Platform, ScrollView } from "react-native";
import { Dashboard } from "@/components/dashboard";
import { ScraperHero } from "@/components/scraper-hero";
import { Showcase } from "@/components/showcase";
import { useScrape } from "@/hooks/use-scrape";
import { SITE_URL } from "@/lib/config";

const TITLE = "Noviq — App Review Intelligence";
const DESCRIPTION =
  "Scrape every App Store & Google Play review, score sentiment, and track trends, versions and activity — all in one jaw-dropping dashboard with CSV/JSON export. Free, no signup.";

// One <script> per schema: the most compatible shape for JSON-LD consumers.
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
          content="Noviq — turn any app's reviews into clean data."
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={`${SITE_URL}/og.png`} />
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
            {!busy ? (
              <Showcase
                onTryIt={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}
