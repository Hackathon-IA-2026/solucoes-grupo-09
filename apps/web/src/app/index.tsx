import { usePalette } from "@wattsteer/ui";
import Head from "expo-router/head";
import { useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { SiteFooter } from "@/components/site-footer";
import { TopNavFull } from "@/components/top-nav";
import { SITE_URL } from "@/lib/config";

const TITLE = "WattSteer — renewable curtailment intelligence for the Brazilian grid";
const DESCRIPTION =
  "Predict renewable curtailment day-ahead, understand the grid conditions driving it, and size the storage and flexible demand that could absorb it.";

/** Canonical URL: one unambiguous form (trailing slash, matching sitemap.xml). */
const CANONICAL_URL = `${SITE_URL}/`;

/**
 * Placeholder landing page. The WattSteer hero and dashboard were removed with
 * the rest of that domain; WattSteer's landing page is built separately, and
 * the four product screens after it. This keeps the shell, the navigation and
 * the footer rendering so the static export and the e2e legal suite stay green.
 */
export default function Home() {
  const colors = usePalette();
  const scrollRef = useRef<ScrollView>(null);

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
      >
        <TopNavFull />
        <View
          testID="landing-placeholder"
          style={{ paddingHorizontal: 24, paddingVertical: 96, alignItems: "center" }}
        >
          <Text
            style={{
              color: colors.ink,
              fontSize: 32,
              fontWeight: "700",
              textAlign: "center",
            }}
          >
            WattSteer
          </Text>
          <Text
            style={{
              color: colors.inkMuted,
              fontSize: 16,
              textAlign: "center",
              marginTop: 12,
              maxWidth: 560,
            }}
          >
            {DESCRIPTION}
          </Text>
        </View>
        <SiteFooter
          onCtaPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
        />
      </ScrollView>
    </>
  );
}
