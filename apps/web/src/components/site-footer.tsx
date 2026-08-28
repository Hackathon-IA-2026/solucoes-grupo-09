import {
  ArrowRightIcon,
  gradientBg,
  layout,
  radius,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { Image } from "expo-image";
import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useCopy } from "@/i18n";
import { APP_HREF, CtaLink } from "./landing/cta-link";

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    maxWidth: layout.page + 128,
    alignSelf: "center",
    paddingHorizontal: space.lg,
    paddingBottom: space.xxxl,
    gap: space.xxl,
  },
  cta: {
    borderRadius: radius.xl,
    borderCurve: "continuous",
    borderWidth: 1,
    paddingHorizontal: space.xl,
    paddingVertical: space.huge,
    alignItems: "center",
    gap: space.lg,
    overflow: "hidden",
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
});

/** Legal link (expo-router Link → real <a> on web) with a hit-slop target. */
function LegalLink({
  href,
  label,
  testID,
}: {
  href: "/privacy" | "/terms";
  label: string;
  testID: string;
}) {
  const colors = usePalette();
  return (
    <Link href={href} asChild={true}>
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
 * (centered WattSteer logo, then copyright · tagline · legal links).
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
  const copy = useCopy();
  const colors = usePalette();
  const year = new Date().getFullYear();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 640;

  return (
    <View testID="site-footer" onLayout={onLayout} style={styles.wrap}>
      {/* CTA band */}
      <View
        testID="footer-cta"
        style={[
          styles.cta,
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
          style={{ width: 30, height: 28 }}
          contentFit="contain"
          accessibilityLabel="WattSteer"
        />
      </View>

      {/* Copyright · tagline · legal links — three balanced cells so the
          tagline stays centered on the page (desktop); stacked on mobile. */}
      <View
        style={{
          flexDirection: wide ? "row" : "column",
          alignItems: "center",
          gap: space.md,
        }}
      >
        <View
          style={{
            flex: wide ? 1 : undefined,
            alignItems: wide ? "flex-start" : "center",
          }}
        >
          <Text style={{ fontSize: 13, color: colors.inkFaint }}>
            © WattSteer {year}. All rights reserved.
          </Text>
        </View>
        <View style={{ flex: wide ? 1 : undefined, alignItems: "center" }}>
          <Text style={{ fontSize: 13, color: colors.inkFaint, textAlign: "center" }}>
            Renewable curtailment intelligence.
          </Text>
        </View>
        <View
          testID="footer-legal-links"
          style={{
            flex: wide ? 1 : undefined,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: wide ? "flex-end" : "center",
            gap: space.lg,
          }}
        >
          <LegalLink href="/privacy" label="Privacy" testID="footer-privacy-link" />
          <View
            aria-hidden={true}
            style={{
              width: 3,
              height: 3,
              borderRadius: 2,
              backgroundColor: colors.border,
            }}
          />
          <LegalLink href="/terms" label="Terms" testID="footer-terms-link" />
        </View>
      </View>
    </View>
  );
}
