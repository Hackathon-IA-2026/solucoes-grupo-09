import {
  ArrowRightIcon,
  gradientBg,
  layout,
  PillButton,
  radius,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { Image } from "expo-image";
import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

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
 * (centered WattSteer logo + wordmark, then copyright · tagline · legal
 * links). `onCtaPress` scrolls to the hero on the landing page; legal pages
 * route home instead.
 */
export function SiteFooter({ onCtaPress }: { onCtaPress: () => void }) {
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
          Stop wasting clean energy{" "}
          <Text style={{ color: colors.accent }}>before it happens.</Text>
        </Text>
        <Text
          style={{
            textAlign: "center",
            fontSize: 15,
            lineHeight: 22,
            color: colors.inkMuted,
          }}
        >
          Day-ahead curtailment risk for the Brazilian grid, from open data.
        </Text>
        <PillButton
          testID="footer-cta-button"
          label="See the forecast"
          primary={true}
          onPress={onCtaPress}
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
