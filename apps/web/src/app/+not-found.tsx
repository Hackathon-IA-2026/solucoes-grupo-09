import { usePalette } from "@noviq/ui";
import { Link } from "expo-router";
import Head from "expo-router/head";
import { Text, View } from "react-native";

const TITLE = "Page not found — Noviq";

/** Branded 404 — mainly so the exported +not-found.html has a real title. */
export default function NotFound() {
  const colors = usePalette();
  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          backgroundColor: colors.canvas,
          padding: 24,
        }}
      >
        <Text
          accessibilityRole="header"
          aria-level={1}
          style={{ fontSize: 28, fontWeight: "600", color: colors.ink }}
        >
          Page not found
        </Text>
        <Text style={{ fontSize: 14, color: colors.inkMuted, textAlign: "center" }}>
          The page you're looking for doesn't exist.
        </Text>
        <Link href="/" style={{ marginTop: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.accent }}>
            Back to Noviq
          </Text>
        </Link>
      </View>
    </>
  );
}
