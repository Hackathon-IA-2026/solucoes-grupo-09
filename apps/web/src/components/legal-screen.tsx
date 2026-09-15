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

/**
 * Breakpoint at which the TOC sidebar moves beside the content.
 *
 * Measured on the *page*, not on a nested box: `onLayout` below sits on the
 * screen's outermost `View`, so this number is the viewport width and the
 * media query in `+html.tsx` that mirrors it can be a plain `min-width`.
 * `test/responsive-css.test.ts` asserts the two agree.
 */
export const LEGAL_WIDE = 1024;
const WIDE = LEGAL_WIDE;

/**
 * Whether the responsive switch is CSS's job rather than JavaScript's.
 *
 * Only on web, and only because a stylesheet resolves before the bundle has
 * even been fetched. Native has no such thing, so there the measured width
 * stays the source of truth — which is also why both branches below have to
 * keep working.
 */
const CSS_RESPONSIVE = Platform.OS === "web";

/**
 * The `data-` hooks the media query selects on.
 *
 * `dataSet` is react-native-web's way to emit a `data-` attribute; it has no
 * counterpart on React Native's `ViewProps`, hence the cast, and it spreads
 * nothing on native — where there is no stylesheet to select with anyway.
 */
const marker = (name: string) =>
  CSS_RESPONSIVE ? ({ dataSet: { [name]: "" } } as object) : {};
const COLUMNS_MARKER = marker("legalColumns");
const SIDE_MARKER = marker("legalSidebarSide");
const INLINE_MARKER = marker("legalSidebarInline");

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
        imageAlt={copy.meta.imageAlt}
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
          {...COLUMNS_MARKER}
          style={{
            flex: 1,
            // On web this is the *narrow* arrangement unconditionally, and the
            // media query in `+html.tsx` is what makes it a row at 1024px.
            // `wide` is measured, so it is false until `onLayout` fires — which
            // is after hydration, which is after the static HTML has painted.
            // Measured on the export, the column→row switch moved the whole
            // content pane and scored 0.195 CLS on both legal pages at desktop
            // width, costing them ~9 Lighthouse points each. CSS resolves at
            // first paint and cannot be late. Native has no stylesheet, so it
            // keeps the measured boolean.
            flexDirection: CSS_RESPONSIVE ? "column" : wide ? "row" : "column",
            gap: space.xl,
            width: "100%",
            maxWidth: layout.page,
            alignSelf: "center",
            paddingHorizontal: space.lg,
          }}
        >
          {/* Both placements exist in the web DOM and CSS shows exactly one.
              The sidebar cannot be *moved* by a media query — beside the
              content it sits outside the scroller and stays put while the page
              scrolls, and inline it scrolls away with the text, which is two
              different parents rather than two styles. Rendering both is the
              price of having neither of them appear late. The hidden copy is
              `display:none`, so it is out of the accessibility tree and out of
              the tab order; only one TOC is ever reachable. */}
          {CSS_RESPONSIVE || wide ? (
            <View
              testID="legal.sidebar.container"
              {...SIDE_MARKER}
              style={{
                width: 280,
                alignSelf: "flex-start",
                paddingTop: space.xl,
                ...(CSS_RESPONSIVE ? { display: "none" as const } : null),
              }}
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
            {CSS_RESPONSIVE || !wide ? (
              <View
                testID="legal.sidebar.inline"
                {...INLINE_MARKER}
                style={{ marginBottom: space.xl }}
              >
                {sidebar}
              </View>
            ) : null}

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
