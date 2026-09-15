import {
  focusRing,
  layout,
  Panel,
  radius,
  space,
  type,
  useContainerWidth,
  usePalette,
  WattSteerWordmark,
} from "@wattsteer/ui";
import { Link } from "expo-router";
import Head from "expo-router/head";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { LanguageSwitch } from "@/components/language-switch";
import { SiteFooter } from "@/components/site-footer";
import { useI18n } from "@/i18n";
import { localePath } from "@/i18n/locale";
import { SITE_URL } from "@/lib/config";
import { PITCH_PDF_PATH } from "@/lib/pitch";

/**
 * The pitch deck, at `/pitch`.
 *
 * **Not locale-prefixed, and that is the decision this file turns on.** The
 * pages under `[locale]/` exist because their *content* differs per language,
 * so `/pt/terms` and `/en/terms` are two different documents and each deserves
 * its own canonical. The deck is one PDF. Prerendering it under both prefixes
 * would emit two URLs whose indexable content is byte-identical, and the
 * `hreflang` pair between them would assert a translation that does not exist.
 * So it lives beside `/app` instead — outside the locale tree, under the root
 * layout's client-driven provider, with only the chrome around the frame
 * translated.
 *
 * That choice is why `SeoHead` is not used here: it emits a locale canonical
 * and the full alternate set, both of which would be untrue of this page. The
 * head below is the `/app` shape instead — `noindex,follow`. `noindex` because
 * the page has no text a search engine should rank (the PDF at
 * `/wattsteer-pitch.pdf` is crawlable on its own and would otherwise compete
 * with the frame around it), and `follow` so the links out of the footer still
 * carry. It is consequently absent from `sitemap.xml` on purpose: listing a
 * noindexed URL there is a contradiction, which is the same rule that keeps
 * `/` and `/app` out of it.
 *
 * The embed is web-only. An `<iframe>` has no meaning under React Native, and
 * a PDF viewer is not something this app ships; on native the link above the
 * frame hands the file to the platform viewer instead. The fallback link is
 * rendered on **both** platforms rather than only as a native substitute,
 * because a desktop browser configured to download PDFs rather than display
 * them shows an empty frame and no error.
 */
export default function Pitch() {
  const { locale, copy } = useI18n();
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= WIDE;

  return (
    <>
      <Head>
        <title>{copy.pitch.metaTitle}</title>
        <meta name="description" content={copy.pitch.metaDescription} />
        <meta name="robots" content="noindex,follow" />
      </Head>

      <View
        onLayout={onLayout}
        testID="pitch-screen"
        style={{ flex: 1, backgroundColor: colors.canvas }}
      >
        {/* Same header as the legal pages: wordmark home link centered, the
            language switch pinned right so the mark stays optically centered.
            Home means the locale the reader is currently being addressed in —
            a bare "/" would bounce them through the resolver at `/` mid-visit
            and could answer in a language they did not pick. */}
        <View
          style={{
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: space.lg,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          {/* `dismissTo`, not a push: this is the link that produced the bug
              — it stacked a second landing screen on top of the one still
              mounted underneath `/pitch`, and two copies of the page means two
              elements per section id. See `localePath`. */}
          <Link href={localePath(locale) as never} dismissTo={true} asChild={true}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={copy.legal.homeLink}
              testID="pitch-home-link"
              hitSlop={8}
              style={
                Platform.OS === "web" ? ({ cursor: "pointer" } as object) : undefined
              }
            >
              <WattSteerWordmark />
            </Pressable>
          </Link>

          <View
            style={{
              position: "absolute",
              right: space.lg,
              top: 0,
              bottom: 0,
              justifyContent: "center",
            }}
          >
            <LanguageSwitch testID="pitch-language-switch" />
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingVertical: space.xl,
            paddingHorizontal: space.lg,
            gap: space.xl,
          }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: layout.page,
              alignSelf: "center",
              gap: space.lg,
            }}
          >
            <View style={{ gap: space.sm, maxWidth: layout.prose }}>
              <Text
                style={{
                  ...type.caption,
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                  color: colors.accent,
                }}
              >
                {copy.pitch.badge}
              </Text>
              <Text
                accessibilityRole="header"
                aria-level={1}
                style={{ ...type.h2, letterSpacing: -0.6, color: colors.ink }}
              >
                {copy.pitch.title}
              </Text>
              <Text style={{ ...type.body, color: colors.inkMuted }}>
                {copy.pitch.lede}
              </Text>
            </View>

            <Panel testID="pitch-panel" style={{ padding: space.sm, gap: space.sm }}>
              {/* Above the frame, not below it, and that is the whole point of
                  the ordering: the frame is 16:9 of the page width, which is
                  648px at the 1152px maximum, so anything under it starts
                  below the fold on a laptop. The reader who needs this line is
                  precisely the reader looking at a blank rectangle, and a way
                  out they have to scroll to find is not one. */}
              <View
                style={{
                  flexDirection: wide ? "row" : "column",
                  alignItems: wide ? "center" : "flex-start",
                  justifyContent: "space-between",
                  gap: space.sm,
                  paddingHorizontal: space.sm,
                  paddingTop: space.xs,
                }}
              >
                <Text
                  style={{ ...type.bodySmall, flexShrink: 1, color: colors.inkFaint }}
                >
                  {copy.pitch.fallback}
                </Text>
                <PitchPdfLink label={copy.pitch.openLabel} />
              </View>
              <PitchEmbed wide={wide} title={copy.pitch.embedTitle} />
            </Panel>
          </View>

          <SiteFooter />
        </ScrollView>
      </View>
    </>
  );
}

/** Where the frame stops being a phone-sized column and becomes a slide. */
const WIDE = 720;

/**
 * Frame geometry, measured off the deck rather than guessed: all 10 pages
 * carry `/MediaBox [0 0 1080 607.92]`, a ratio of 1.777 — 16:9 to three
 * decimals. Giving the frame that same ratio on a wide viewport means the
 * viewer fits a whole slide and the page avoids a scrollbar inside a
 * scrollbar. At 400px wide that ratio is a 225px-tall strip, which is not a
 * readable slide, so below `WIDE` the frame takes a fixed portrait height and
 * the PDF viewer's own zoom does the rest.
 */
const NARROW_EMBED_HEIGHT = 520;
const SLIDE_ASPECT = 16 / 9;

/** The embed itself — web only; `<iframe>` has no native counterpart. */
function PitchEmbed({ wide, title }: { wide: boolean; title: string }) {
  const colors = usePalette();
  if (Platform.OS !== "web") {
    return null;
  }
  return (
    <View
      testID="pitch-embed"
      style={{
        width: "100%",
        overflow: "hidden",
        borderRadius: radius.lg,
        borderCurve: "continuous",
        backgroundColor: colors.surfaceSunken,
        ...(wide ? { aspectRatio: SLIDE_ASPECT } : { height: NARROW_EMBED_HEIGHT }),
      }}
    >
      {/* biome-ignore lint/nursery/useIframeSandbox: a sandbox attribute disables the browser's own PDF viewer, which is the entire content of this frame */}
      <iframe
        title={title}
        src={`${PITCH_PDF_PATH}#view=FitH`}
        // `FitH` in the fragment, not a viewer parameter this app controls:
        // PDF fragment directives are honoured by Chrome's and Firefox's
        // built-in viewers and ignored everywhere else, which is the right
        // shape for a hint — it cannot fail loudly.
        // biome-ignore lint/nursery/noInlineStyles: a raw DOM element; a react-native-web StyleSheet does not reach it
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
      />
    </View>
  );
}

/**
 * The way to the file itself.
 *
 * A real `<a href>` on web rather than `Link` from expo-router: the deck is a
 * static asset, not a route, and expo-router would try to resolve
 * `/wattsteer-pitch.pdf` against the route tree and land on the 404 screen.
 * On native there is no anchor, so the same affordance hands the absolute URL
 * to the platform.
 */
function PitchPdfLink({ label }: { label: string }) {
  const colors = usePalette();
  const button = (
    <Pressable
      testID="pitch-pdf-link"
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={
        Platform.OS === "web"
          ? undefined
          : () => {
              void Linking.openURL(`${SITE_URL}${PITCH_PDF_PATH}`);
            }
      }
      style={(state) => {
        const { pressed } = state;
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          flexShrink: 0,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: hovered ? colors.accent : colors.borderStrong,
          backgroundColor: hovered ? colors.surfaceSunken : colors.surface,
          paddingHorizontal: space.lg,
          paddingVertical: space.sm,
          transform: [{ scale: pressed ? 0.97 : 1 }],
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
      <Text style={{ ...type.label, color: colors.ink }}>{label}</Text>
    </Pressable>
  );

  if (Platform.OS !== "web") {
    return button;
  }
  // `noreferrer` with `_blank`: the opened tab must not get a handle on this
  // window through `opener`.
  return (
    <a
      href={PITCH_PDF_PATH}
      target="_blank"
      rel="noreferrer"
      // biome-ignore lint/nursery/noInlineStyles: a raw DOM anchor; a react-native-web StyleSheet does not reach it
      style={{ textDecoration: "none" }}
    >
      {button}
    </a>
  );
}
