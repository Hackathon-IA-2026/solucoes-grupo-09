import {
  focusRing,
  radius,
  space,
  type,
  usePalette,
  useReducedMotion,
  WattSteerWordmark,
} from "@wattsteer/ui";
import { Link, useRouter } from "expo-router";
import Head from "expo-router/head";
import { useEffect, useState } from "react";
import { Animated, Platform, Pressable, Text, View } from "react-native";
import { readStoredLocale, useCopy, useI18n } from "@/i18n";
import { DEFAULT_LOCALE, localePath, matchLocale } from "@/i18n/locale";
import { alternatesFor } from "@/lib/seo";

/**
 * The loading screen at bare `/`.
 *
 * This slot used to hold a language chooser — two taglines, two buttons, and a
 * decision demanded of a reader who had not yet seen a single sentence of the
 * product. It is gone. `/` now resolves the locale itself and goes straight to
 * the landing page: the stored choice first, then the browser's languages,
 * then Portuguese. Nothing is asked and nothing is clicked.
 *
 * What is left is the screen a visitor sees *while* that resolution happens —
 * the brand lockup and one sentence, in the locale being resolved to. Its
 * layout is the chooser's, deliberately: the same centred 420px column, the
 * same vertical rhythm, so the frame that precedes the landing page is the one
 * this site has always shown at `/`.
 *
 * ## How long it is actually on screen
 *
 * On web, essentially never. `+html.tsx` fires the redirect from an inline
 * script in `<head>`, before the bundle is fetched and before React hydrates,
 * so a scripted browser leaves this document without painting this component.
 * That is the point of putting the decision there rather than here: a redirect
 * that waits for hydration is a redirect the visitor watches happen.
 *
 * It is on screen in the two cases that remain, and both are real:
 *
 *  - **Native**, where there is no HTML shell to carry that script. The
 *    `expo-splash-screen` plugin's image hands over to this component, which
 *    holds the frame until the effect below has navigated.
 *  - **Client-side navigation into `/`**, which never re-runs the shell's
 *    script — `[locale]/_layout.tsx` sends an unknown locale here.
 *
 * ## Scripting off
 *
 * Then nothing redirects, and a screen that says "loading" forever is a dead
 * end. So the continue link below is rendered into the HTML on every page and
 * shown **only when scripting is off**, by the `<noscript>` stylesheet in
 * `+html.tsx`. The chooser earned its no-JS pass by being two links; this
 * earns it by being one, to the locale the site defaults to, with both locale
 * roots still declared to crawlers in the `hreflang` set above it.
 *
 * `robots` stays `noindex,follow` for the same reason it always was: no unique
 * content worth ranking, but crawl equity should still reach both locale
 * roots. `robots.txt` deliberately still says `Allow: /` — a `Disallow` would
 * mean this `noindex` is never fetched and therefore never obeyed.
 */
export default function LoadingScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const { locale } = useI18n();
  const router = useRouter();

  useEffect(() => {
    // Unlike the chooser this replaces, this runs on web too. The shell's
    // pre-hydration script only sees a full document load, so a client-side
    // navigation into `/` — the redirect out of an unknown locale — would
    // otherwise sit here with nothing to move it on.
    const target =
      readStoredLocale() ??
      matchLocale(
        typeof navigator !== "undefined" && navigator.language
          ? [navigator.language]
          : [],
      ) ??
      DEFAULT_LOCALE;
    // `replace`, not `push`: this must never sit in the history stack, or Back
    // from `/pt/` lands here and bounces the visitor straight forward again.
    router.replace(localePath(target) as never);
  }, [router]);

  return (
    <>
      <Head>
        <title>WattSteer</title>
        <meta name="description" content={copy.splash.tagline} />
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
        testID="loading-screen"
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
          {/* The lockup already carries the mark, so this does not stack a
              second copy of it above the word: one brand geometry, one source
              (`packages/ui/src/lib/mark.ts`). */}
          <WattSteerWordmark />

          <Text
            testID="loading-tagline"
            style={{
              ...type.bodySmall,
              textAlign: "center",
              color: colors.inkMuted,
            }}
          >
            {copy.splash.tagline}
          </Text>

          <ProgressTrack label={copy.splash.loading} />

          {/* Hidden unless scripting is off — see the header, and the
              `<noscript>` rule in `+html.tsx` that reveals it. */}
          <View {...NOSCRIPT_ONLY} style={{ display: "none" }}>
            <Link href={localePath(locale) as never} asChild={true}>
              <Pressable
                testID="loading-continue"
                accessibilityRole="link"
                accessibilityLabel={copy.splash.continue}
                hitSlop={4}
                style={(state) => {
                  const { focused = false } = state as { focused?: boolean };
                  return {
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: colors.border,
                    paddingHorizontal: space.lg,
                    paddingVertical: space.sm,
                    ...focusRing(focused, colors.focus),
                    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                  };
                }}
              >
                <Text style={{ ...type.label, color: colors.ink }}>
                  {copy.splash.continue}
                </Text>
              </Pressable>
            </Link>
          </View>
        </View>
      </View>
    </>
  );
}

/**
 * The marker `+html.tsx`'s `<noscript>` rule selects on.
 *
 * `dataSet` is react-native-web's way to emit a `data-` attribute and has no
 * type on React Native's `ViewProps`, hence the cast; on native it spreads
 * nothing, where there is no stylesheet to reveal anything anyway and the
 * effect above always runs.
 */
const NOSCRIPT_ONLY =
  Platform.OS === "web" ? ({ dataSet: { noscriptOnly: "" } } as object) : {};

/** Track and segment widths in px — the translation below is measured in px,
 * so the two cannot be percentages. Both fit inside the 420px column at the
 * narrowest phone width this site supports. */
const TRACK = 160;
const SEGMENT = 56;

/**
 * An indeterminate progress bar, on React Native's core `Animated` rather than
 * Reanimated — the same call `FadeIn` makes, and for the same reason: half a
 * megabyte of web bundle is not worth a sliding rectangle.
 *
 * Under `prefers-reduced-motion` it does not slide. It stays put, centred and
 * dimmed, because the thing it communicates ("something is happening, briefly")
 * survives being still, and a looping animation is exactly what that setting
 * asks us not to run.
 */
function ProgressTrack({ label }: { label: string }) {
  const colors = usePalette();
  const reducedMotion = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reducedMotion) {
      return;
    }
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1100,
        // No native driver on web; RNW animates on the JS thread.
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion]);

  return (
    <View
      testID="loading-progress"
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{
        width: TRACK,
        maxWidth: "100%",
        height: 3,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceSunken,
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          width: SEGMENT,
          height: 3,
          borderRadius: radius.pill,
          backgroundColor: colors.accent,
          opacity: reducedMotion ? 0.6 : 1,
          transform: [
            {
              translateX: reducedMotion
                ? (TRACK - SEGMENT) / 2
                : progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-SEGMENT, TRACK],
                  }),
            },
          ],
        }}
      />
    </View>
  );
}
