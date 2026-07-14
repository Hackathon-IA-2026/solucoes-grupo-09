import {
  LegalHero,
  LegalSection,
  LegalSidebar,
  layout,
  space,
  useContainerWidth,
  usePalette,
} from "@zalytix/ui";
import { Image } from "expo-image";
import { Link, router } from "expo-router";
import Head from "expo-router/head";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useLegalToc } from "@/hooks/use-legal-toc";
import { SITE_URL } from "@/lib/config";
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
 * Zalytix design system.
 */
export function LegalScreen({
  headTitle,
  path,
  badge,
  updated,
  title,
  intro,
  sidebarTitle,
  sections,
}: {
  headTitle: string;
  path: "/terms" | "/privacy";
  badge: string;
  updated: string;
  title: string;
  intro: string;
  sidebarTitle: string;
  sections: ReadonlyArray<LegalContentSection>;
}) {
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
      <Head>
        <title>{headTitle}</title>
        <link rel="canonical" href={`${SITE_URL}${path}`} />
        <meta name="robots" content="index,follow" />
      </Head>

      <View onLayout={onLayout} style={{ flex: 1, backgroundColor: colors.canvas }}>
        {/* Header: centered logo, links home. */}
        <View
          style={{
            alignItems: "center",
            paddingVertical: space.lg,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Link href="/" asChild={true}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Zalytix — home"
              testID="legal-home-link"
              hitSlop={8}
              style={
                Platform.OS === "web" ? ({ cursor: "pointer" } as object) : undefined
              }
            >
              <Image
                source={require("../../assets/images/logo.png")}
                style={{ width: 34, height: 38 }}
                contentFit="contain"
                accessibilityLabel="Zalytix"
              />
            </Pressable>
          </Link>
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

            <SiteFooter onCtaPress={() => router.push("/")} />
          </ScrollView>
        </View>
      </View>
    </>
  );
}
