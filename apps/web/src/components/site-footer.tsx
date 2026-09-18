import {
  ArrowRightIcon,
  gradientBg,
  radius,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { Image } from "expo-image";
import { Link } from "expo-router";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { DEFAULT_LOCALE, localePath } from "@/i18n/locale";
import { PITCH_PATH } from "@/lib/pitch";
import { APP_HREF, CtaLink } from "./landing/cta-link";
import { PAGE_MAX } from "./landing/layout";

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    maxWidth: PAGE_MAX,
    alignSelf: "center",
    paddingHorizontal: space.lg,
    paddingBottom: space.xxxl,
    gap: space.xxl,
  },
  cta: {
    borderRadius: radius.xl,
    borderCurve: "continuous",
    borderWidth: 1,
    alignItems: "center",
    gap: space.lg,
    overflow: "hidden",
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
});

/**
 * The width, measured on the footer itself, at which it lays out wide.
 *
 * Exported because `+html.tsx` has to hold the same number in a `@container`
 * rule and `test/responsive-css.test.ts` checks that it does. A *container*
 * query and not a media query, because this number is the footer's own width
 * and the footer sits in a different box on each of the three pages that
 * render it — inside the landing scroller it is the viewport, on `/pitch` and
 * the legal pages it is the viewport less that page's gutters. A viewport
 * media query would therefore flip at the wrong width on two pages out of
 * three; `@container` asks the element the same question `onLayout` does.
 */
export const FOOTER_WIDE = 640;

/**
 * Whether the responsive switch is CSS's job. Web only — see the identical
 * note in `legal-screen.tsx`, and the CLS this exists to remove: the footer's
 * one-column→two-column switch is what `/pitch` was losing 9 points to.
 */
const CSS_RESPONSIVE = Platform.OS === "web";

/** `dataSet` → `data-*` on web; nothing on native. See `legal-screen.tsx`. */
const marker = (name: string) =>
  CSS_RESPONSIVE ? ({ dataSet: { [name]: "" } } as object) : {};
const WRAP_MARKER = marker("footerWrap");
const CTA_MARKER = marker("footerCtaBand");
const BAR_MARKER = marker("footerBar");
const RIGHTS_MARKER = marker("footerRights");
const LINKS_MARKER = marker("footerLinks");

/** Legal link (expo-router Link → real <a> on web) with a hit-slop target. */
/**
 * Where the corresponding source lives, for AGPL §13.
 *
 * A constant rather than copy: a URL is not a translation, and a repository
 * address that differed between locales would be two claims about one licence.
 */
const SOURCE_URL = "https://github.com/vtorres/WattSteer";

function LegalLink({
  href,
  label,
  testID,
}: {
  href: string;
  label: string;
  testID: string;
}) {
  const colors = usePalette();
  return (
    <Link href={href as never} asChild={true}>
      <Pressable
        accessibilityRole="link"
        testID={testID}
        hitSlop={8}
        style={{ minHeight: 28, justifyContent: "center" }}
      >
        <Text style={{ fontSize: 13, color: colors.inkMuted }}>{label}</Text>
      </Pressable>
    </Link>
  );
}

/**
 * Site CTA + footer: a grape-tinted call-to-action band over the footer
 * (centered WattSteer logo, then copyright and the legal links).
 *
 * The CTA used to take an `onCtaPress` callback because it had nowhere to
 * go — on the landing page it scrolled back to the scrape input, and on the
 * legal pages it routed home. Both were the same admission: the site had no
 * destination. It now points at `/app`, the product itself, from every page,
 * and it does so as a real anchor rather than a scripted button so the
 * static export contains a crawlable path into the app.
 *
 * Copy is the closing line of the pitch (IDEA.md §47).
 */
export function SiteFooter() {
  const { copy, routeLocale } = useI18n();
  const colors = usePalette();
  // The legal pages live under the locale prefix; `/app` does not, and its
  // footer links out to the default locale's copies rather than to a path
  // that would 404.
  const legalHref = (path: "/privacy" | "/terms" | "/references") =>
    localePath(routeLocale ?? DEFAULT_LOCALE, path);
  const year = new Date().getFullYear();
  const [width, onLayout] = useContainerWidth();
  // On web the four `wide` reads below are all overridden by the `@container`
  // rules in `+html.tsx`, so what this evaluates to before `onLayout` fires no
  // longer reaches the screen. It still drives native, where nothing else can.
  const wide = width >= FOOTER_WIDE;

  return (
    <View testID="site-footer" {...WRAP_MARKER} onLayout={onLayout} style={styles.wrap}>
      {/* CTA band */}
      <View
        testID="footer-cta"
        {...CTA_MARKER}
        style={[
          styles.cta,
          // `space.huge` top and bottom is right on a desktop band 265 px tall
          // and wrong at 400 px, where it put 144 px of empty grape around
          // three lines of text — a fifth of the phone's viewport, twice.
          {
            paddingHorizontal: wide ? space.xl : space.lg,
            paddingVertical: wide ? space.huge : space.xxxl,
          },
          // Opaque hairline (not the token's translucent white) so the
          // gradient behind can't tint it — the border stays uniform on all
          // four sides.
          { borderColor: "#26262B" },
          // Symmetric grape glow rising from the bottom-center over a uniform
          // surface base — the old diagonal gradient left one side plain and
          // the other tinted, so the border read unevenly (bright on the left).
          gradientBg(
            "radial-gradient(120% 92% at 50% 118%, rgba(141, 93, 246, 0.30) 0%, transparent 62%)",
            colors.surface,
          ),
        ]}
      >
        <Text
          accessibilityRole="header"
          aria-level={2}
          style={{
            textAlign: "center",
            maxWidth: 560,
            fontSize: 28,
            lineHeight: 34,
            fontWeight: "600",
            letterSpacing: -0.8,
            color: colors.ink,
          }}
        >
          {copy.footerCta.headline.lead}{" "}
          <Text style={{ color: colors.accent }}>{copy.footerCta.headline.accent}</Text>
        </Text>
        <Text
          style={{
            textAlign: "center",
            fontSize: 15,
            lineHeight: 22,
            color: colors.inkMuted,
          }}
        >
          {copy.footerCta.sub}
        </Text>
        <CtaLink
          testID="footer-cta-button"
          href={APP_HREF}
          label={copy.footerCta.button}
          primary={true}
          icon={<ArrowRightIcon size={16} color={colors.onAccent} />}
        />
      </View>

      {/* Divider separates the CTA from the footer block below. */}
      <View style={{ height: 1, backgroundColor: colors.border }} />

      {/* Brand: the logo mark, centered. */}
      <View style={styles.brand}>
        <Image
          source={require("../../assets/images/logo.png")}
          style={{ width: 34, height: 24 }}
          contentFit="contain"
          accessibilityLabel="WattSteer"
        />
      </View>

      {/* Copyright and the legal links — two cells, the outer edges of the
          page (desktop); stacked on mobile.

          There used to be a third, centred cell repeating `footer.tagline`
          ("Renewable curtailment intelligence."), 295 px below the CTA band's
          own `footerCta.sub` ("Day-ahead curtailment risk for the Brazilian
          grid, from open data.") — two product one-liners on one screen,
          saying the same thing at two lengths. The one next to the button is
          the one doing work, so the other is gone, and `footer.tagline` with
          it rather than being left as a key nothing renders. */}
      <View
        {...BAR_MARKER}
        style={{
          flexDirection: wide ? "row" : "column",
          alignItems: "center",
          gap: space.md,
        }}
      >
        <View
          {...RIGHTS_MARKER}
          style={{
            flex: wide ? 1 : undefined,
            alignItems: wide ? "flex-start" : "center",
          }}
        >
          <Text style={{ fontSize: 13, color: colors.inkFaint }}>
            {fill(copy.footer.rights, { year })}
          </Text>
        </View>
        <View
          testID="footer-legal-links"
          {...LINKS_MARKER}
          style={{
            flex: wide ? 1 : undefined,
            flexDirection: "row",
            // Wraps at the narrowest widths. Three links and two `space.lg`
            // gaps want 248px; a 320px phone gives this row 224 after the
            // page's gutters, so without this the third link is clipped — and
            // the third link is the one to the terms.
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: wide ? "flex-end" : "center",
            gap: space.lg,
          }}
        >
          <LegalLink
            href={legalHref("/privacy")}
            label={copy.legal.privacyLink}
            testID="footer-privacy-link"
          />
          <View
            aria-hidden={true}
            // 4 px in `inkFaint`, not 3 px in `border`. A hairline-coloured
            // dot (white at 8% over `canvas`) resolves to ~#2A2A2C and is not
            // visible at all in a 1x screenshot; `borderRadius: 2` on a 3 px
            // box was not a circle either.
            style={{
              width: space.xs,
              height: space.xs,
              borderRadius: space.xs / 2,
              backgroundColor: colors.inkFaint,
            }}
          />
          <LegalLink
            href={legalHref("/terms")}
            label={copy.legal.termsLink}
            testID="footer-terms-link"
          />
          <View
            aria-hidden={true}
            style={{
              width: space.xs,
              height: space.xs,
              borderRadius: space.xs / 2,
              backgroundColor: colors.inkFaint,
            }}
          />
          {/*
            The norms page, as a label rather than the paragraph that used to
            sit above this row.

            The paragraph stated the regulatory basis on every page and was
            removed on request: it read as a separate section between the
            centred mark and this row, and it was the heaviest thing in a
            footer of short labels. The link stays here because the page it
            points at must not become reachable only to someone who already
            knows the URL — which is the reason `/pitch` is in this row too,
            three entries along.
          */}
          <LegalLink
            href={legalHref("/references")}
            label={copy.regulatory.link}
            testID="footer-references-link"
          />
          <View
            aria-hidden={true}
            // 4 px in `inkFaint`, not 3 px in `border`. A hairline-coloured
            // dot (white at 8% over `canvas`) resolves to ~#2A2A2C and is not
            // visible at all in a 1x screenshot; `borderRadius: 2` on a 3 px
            // box was not a circle either.
            style={{
              width: space.xs,
              height: space.xs,
              borderRadius: space.xs / 2,
              backgroundColor: colors.inkFaint,
            }}
          />
          {/*
            The deck, and `PITCH_PATH` rather than a locale path: `/pitch` sits
            outside the locale tree because it is one PDF and two locale URLs
            for it would assert a translation that does not exist. It is here
            because nothing linked to it — the route shipped reachable only to
            someone who already knew the URL.
          */}
          <LegalLink
            href={PITCH_PATH}
            label={copy.pitch.footerLink}
            testID="footer-pitch-link"
          />
          <View
            aria-hidden={true}
            style={{
              width: space.xs,
              height: space.xs,
              borderRadius: space.xs / 2,
              backgroundColor: colors.inkFaint,
            }}
          />
          {/*
            **The source, because §13 of the AGPL asks for it here.**

            WattSteer is served over a network under AGPL-3.0, and §13 is the
            clause that makes that different from the GPL: a user interacting
            with it remotely must be offered the corresponding source, from the
            running instance. A repository that exists but is linked from
            nowhere satisfies the spirit of nothing — the offer has to be where
            the interaction is, which is this page.

            An absolute URL rather than a locale path, because it leaves the
            product: `LegalLink` already renders an anchor, and this is the one
            link in the row that does not point at something we serve.
          */}
          <LegalLink
            href={SOURCE_URL}
            label={copy.footer.sourceLink}
            testID="footer-source-link"
          />
        </View>
      </View>
    </View>
  );
}
