import { usePalette } from "@wattsteer/ui";
import { Link } from "expo-router";
import Head from "expo-router/head";
import { Text, View } from "react-native";
import { useCopy } from "@/i18n";

/**
 * Branded 404 — mainly so the exported `+not-found.html` has a real title.
 *
 * Global rather than per-locale (`docs/specs/i18n.md` leaves a scoped
 * `[locale]/+not-found` open), so it renders under the root layout's
 * client-driven provider: Portuguese by default, English once a visitor has
 * chosen it. That is better than the English-only page the spec allows as a
 * v1 compromise, and it costs four strings.
 */
export default function NotFound() {
  const copy = useCopy();
  const colors = usePalette();
  return (
    <>
      <Head>
        <title>{copy.notFound.metaTitle}</title>
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
          {copy.notFound.title}
        </Text>
        <Text style={{ fontSize: 14, color: colors.inkMuted, textAlign: "center" }}>
          {copy.notFound.body}
        </Text>
        <Link href="/" style={{ marginTop: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.accent }}>
            {copy.notFound.back}
          </Text>
        </Link>
      </View>
    </>
  );
}
