import {
  ArrowRightIcon,
  gradientBg,
  layout,
  PillButton,
  radius,
  space,
  usePalette,
} from "@zalytix/ui";
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
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
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
 * (centered Zalytix bolt logo + wordmark, then copyright · tagline · legal
 * links). `onCtaPress` scrolls to the hero on the landing page; legal pages
 * route home instead.
 */
export function SiteFooter({ onCtaPress }: { onCtaPress: () => void }) {
  const colors = usePalette();
  const year = new Date().getFullYear();

  return (
    <View testID="site-footer" style={styles.wrap}>
      {/* CTA band */}
      <View
        testID="footer-cta"
        style={[
          styles.cta,
          { borderColor: colors.border },
          gradientBg(
            "linear-gradient(135deg, #1B1B1F 0%, rgba(141, 93, 246, 0.28) 100%)",
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
          Turn any app's reviews into{" "}
          <Text style={{ color: colors.accent }}>clean data.</Text>
        </Text>
        <Text
          style={{
            textAlign: "center",
            fontSize: 15,
            lineHeight: 22,
            color: colors.inkMuted,
          }}
        >
          Free, no signup. Paste an App Store or Google Play link and go.
        </Text>
        <PillButton
          testID="footer-cta-button"
          label="Scrape an app"
          primary={true}
          onPress={onCtaPress}
          icon={<ArrowRightIcon size={16} color={colors.onAccent} />}
        />
      </View>

      {/* Divider separates the CTA from the footer block below. */}
      <View style={{ height: 1, backgroundColor: colors.border }} />

      {/* Brand: the bolt logo + wordmark, centered. */}
      <View style={styles.brand}>
        <Image
          source={require("../../assets/images/bolt-logo.png")}
          style={{ width: 28, height: 26 }}
          contentFit="contain"
          accessibilityLabel="Zalytix"
        />
        <Text
          style={{
            fontSize: 18,
            fontWeight: "600",
            letterSpacing: -0.4,
            color: colors.ink,
          }}
        >
          Zalytix
        </Text>
      </View>

      {/* Copyright · tagline · legal links */}
      <View style={styles.row}>
        <Text style={{ fontSize: 13, color: colors.inkFaint }}>
          © Zalytix {year}. All rights reserved.
        </Text>
        <Text style={{ fontSize: 13, color: colors.inkFaint }}>
          App Store & Google Play review intelligence.
        </Text>
        <View
          testID="footer-legal-links"
          style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}
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
