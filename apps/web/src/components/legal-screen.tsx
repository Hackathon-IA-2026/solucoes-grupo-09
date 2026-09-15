import {
  LegalHero,
  LegalSection,
  LegalSidebar,
  layout,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { Image } from "expo-image";
import { Link } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { LanguageSwitch } from "@/components/language-switch";
import { useLegalToc } from "@/hooks/use-legal-toc";
import { useI18n } from "@/i18n";
import { localePath } from "@/i18n/locale";
import { SeoHead } from "./seo-head";
import { SiteFooter } from "./site-footer";

export interface LegalContentSection {
  id: string;
  title: string;
  content: ReactNode;
}

/** Breakpoint at which the TOC sidebar moves beside the content. */
const WIDE = 1024;

/**
 * Shared legal-page shell (terms / privacy): a home-linking header, a
 * scroll-tracked TOC sidebar (beside the content on desktop, inline on
 * mobile), the hero, the measured sections, and the site footer — all in the
 * WattSteer design system.
 */
export function LegalScreen({
  headTitle,
  description,
  path,
  badge,
  updated,
  title,
  intro,
  sidebarTitle,
  sections,
}: {
  headTitle: string;
  description: string;
  path: "/terms" | "/privacy";
  badge: string;
  updated: string;
  title: string;
  intro: string;
  sidebarTitle: string;
  sections: readonly LegalContentSection[];
}) {
  const { locale, copy } = useI18n();
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= WIDE;
  const toc = sections.map((s) => ({ id: s.id, title: s.title }));
  const { activeSection, scrollRef, registerSection, onScroll, scrollToSection } =
    useLegalToc(toc);

  const sidebar = (
    <LegalSidebar
      title={sidebarTitle}
      sections={toc}
      activeSection={activeSection}
      onSectionPress={scrollToSection}
    />
  );

  return (
    <>
      <SeoHead
        locale={locale}
        path={path}
        title={headTitle}
        description={description}
        ogType="article"
      />

      <View onLayout={onLayout} style={{ flex: 1, backgroundColor: colors.canvas }}>
        {/* Header: centered logo linking home, language switch at the right. */}
        <View
          style={{
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: space.lg,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          {/* Home means *this locale's* home. A bare "/" here would bounce a
              reader out to the resolver at `/` and let it decide their
              language for them mid-visit — right only while their stored
              choice survives, and a silent reset to Portuguese when it does
              not. */}
          {/* `dismissTo`: pop back to the landing screen already in the stack
              rather than push a second copy of it. See `localePath`. */}
          <Link href={localePath(locale) as never} dismissTo={true} asChild={true}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={copy.legal.homeLink}
              testID="legal-home-link"
              hitSlop={8}
              style={
                Platform.OS === "web" ? ({ cursor: "pointer" } as object) : undefined
              }
            >
              <Image
                source={require("../../assets/images/logo.png")}
                style={{ width: 38, height: 27 }}
                contentFit="contain"
                accessibilityLabel="WattSteer"
              />
            </Pressable>
          </Link>

          {/* The legal pages are locale-prefixed too, so they need the way
              across: /en/privacy ⇄ /pt/privacy, same page, other language.
              Absolutely positioned so the logo stays optically centered. */}
          <View
            style={{
              position: "absolute",
              right: space.lg,
              top: 0,
              bottom: 0,
              justifyContent: "center",
            }}
          >
            <LanguageSwitch testID="legal-language-switch" />
          </View>
        </View>

        <View
          style={{
            flex: 1,
            flexDirection: wide ? "row" : "column",
            gap: space.xl,
            width: "100%",
            maxWidth: layout.page,
            alignSelf: "center",
            paddingHorizontal: space.lg,
          }}
        >
          {wide ? (
            <View
              testID="legal.sidebar.container"
              style={{ width: 280, alignSelf: "flex-start", paddingTop: space.xl }}
            >
              {sidebar}
            </View>
          ) : null}

          <ScrollView
            ref={scrollRef}
            testID="legal.content.container"
            onScroll={onScroll}
            scrollEventThrottle={16}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingVertical: space.xl,
              paddingBottom: 128,
              // Side gutters keep the cards clear of the overlay scrollbar.
              paddingHorizontal: space.lg,
              maxWidth: 820,
              width: "100%",
              alignSelf: "center",
            }}
          >
            {wide ? null : <View style={{ marginBottom: space.xl }}>{sidebar}</View>}

            <LegalHero badge={badge} updated={updated} title={title} intro={intro} />

            {sections.map((section) => (
              <LegalSection
                key={section.id}
                id={section.id}
                title={section.title}
                onLayout={registerSection(section.id)}
              >
                {section.content}
              </LegalSection>
            ))}

            <SiteFooter />
          </ScrollView>
        </View>
      </View>
    </>
  );
}
