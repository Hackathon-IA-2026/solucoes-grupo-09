import { focusRing, radius, space, usePalette } from "@wattsteer/ui";
import { Image } from "expo-image";
import { Link, useRouter } from "expo-router";
import Head from "expo-router/head";
import { useEffect } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { en, pt, readStoredLocale } from "@/i18n";
import {
  DEFAULT_LOCALE,
  LOCALE_NAME,
  LOCALES,
  type Locale,
  localePath,
  matchLocale,
} from "@/i18n/locale";
import { alternatesFor } from "@/lib/seo";

/**
 * The gate at bare `/`.
 *
 * Not a blank redirect. It is a real, prerendered page that ships visible
 * links to `/pt/` and `/en/`, so it works with JavaScript disabled and gives a
 * crawler an immediate path into both locale trees. That is the concrete
 * difference from client-side switching: even the page that exists only to
 * route people degrades to something readable.
 *
 * Two SEO decisions, both from `docs/specs/i18n.md`:
 *
 * - `robots` is `noindex,follow`. The gate has no unique content worth
 *   ranking, but `follow` lets crawl equity reach the two locale roots.
 * - `robots.txt` deliberately still says `Allow: /`. Pairing a `Disallow`
 *   with a `noindex` meta is self-defeating — a disallowed URL is never
 *   crawled, so the `noindex` is never read, and the URL can still be indexed
 *   from external links with an empty snippet. `noindex` alone is the whole
 *   signal.
 *
 * The redirect for a real visitor is fired pre-hydration by a small guarded
 * script in `+html.tsx`, so nobody sees this page flash on the web. The effect
 * below is the native path, where there is no HTML shell to carry that script.
 */
export default function Gate() {
  const colors = usePalette();
  const router = useRouter();

  useEffect(() => {
    // Web is handled before hydration — see `+html.tsx`. Running it here too
    // would only add a second, later navigation.
    if (Platform.OS === "web") {
      return;
    }
    const target =
      readStoredLocale() ??
      matchLocale(
        typeof navigator !== "undefined" && navigator.language
          ? [navigator.language]
          : [],
      ) ??
      DEFAULT_LOCALE;
    // `replace`, not `push`: the gate must never sit in the history stack, or
    // Back from `/pt/` lands here and bounces the visitor straight forward
    // again.
    router.replace(localePath(target) as never);
  }, [router]);

  return (
    <>
      <Head>
        <title>WattSteer — Português (Brasil) / English</title>
        <meta
          name="description"
          content="WattSteer — curtailment intelligence for the Brazilian grid. Choose a language: Português (Brasil) or English."
        />
        <meta name="robots" content="noindex,follow" />
        {alternatesFor("").map((alternate) => (
          <link
            key={alternate.hrefLang}
            rel="alternate"
            // Lowercase on purpose — see the note in `seo-head.tsx`.
            {...({ hreflang: alternate.hrefLang } as Record<string, string>)}
            href={alternate.href}
          />
        ))}
      </Head>

      <View
        testID="locale-gate"
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
          padding: space.xl,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 420,
            alignItems: "center",
            gap: space.lg,
          }}
        >
          <Image
            source={require("../../assets/images/logo.png")}
            style={{ width: 44, height: 50 }}
            contentFit="contain"
            accessibilityLabel="WattSteer"
          />

          {/* Bilingual by construction: a language chooser that picks a
              language to address the reader in has already made the choice
              for them. */}
          <Text
            accessibilityRole="header"
            aria-level={1}
            style={{
              fontSize: 22,
              fontWeight: "600",
              letterSpacing: -0.4,
              textAlign: "center",
              color: colors.ink,
            }}
          >
            WattSteer
          </Text>
          <View style={{ gap: 2, maxWidth: 400 }}>
            <Text style={tagline(colors.inkMuted)}>{pt.gate.tagline}</Text>
            <Text style={tagline(colors.inkMuted)}>{en.gate.tagline}</Text>
          </View>

          <View
            testID="gate-links"
            style={{ width: "100%", gap: space.sm, paddingTop: space.sm }}
          >
            {LOCALES.map((locale) => (
              <LocaleLink key={locale} locale={locale} />
            ))}
          </View>
        </View>
      </View>
    </>
  );
}

/** One line of the bilingual tagline. */
const tagline = (color: string) => ({
  fontSize: 14,
  lineHeight: 21,
  textAlign: "center" as const,
  color,
});

/**
 * A real `<a href>` on web (via `Link asChild`), so the chooser is usable with
 * scripting off and walkable by a crawler.
 */
function LocaleLink({ locale }: { locale: Locale }) {
  const colors = usePalette();
  const href = localePath(locale);
  return (
    <Link href={href as never} asChild={true}>
      <Pressable
        testID={`gate-link-${locale}`}
        accessibilityRole="link"
        accessibilityLabel={LOCALE_NAME[locale]}
        hitSlop={4}
        style={(state) => {
          const { pressed } = state;
          const { focused = false, hovered = false } = state as {
            focused?: boolean;
            hovered?: boolean;
          };
          return {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.md,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: hovered ? colors.borderStrong : colors.border,
            backgroundColor: hovered ? colors.surfaceSunken : colors.surface,
            paddingHorizontal: space.lg,
            paddingVertical: 14,
            transform: [{ scale: pressed ? 0.98 : 1 }],
            ...focusRing(focused, colors.focus),
            ...(Platform.OS === "web"
              ? ({
                  cursor: "pointer",
                  transitionProperty: "background-color, border-color",
                  transitionDuration: "150ms",
                } as object)
              : null),
          };
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.ink }}>
          {LOCALE_NAME[locale]}
        </Text>
        <Text
          style={{
            fontSize: 13,
            fontWeight: "600",
            letterSpacing: 0.4,
            color: colors.inkFaint,
          }}
        >
          {href}
        </Text>
      </Pressable>
    </Link>
  );
}
