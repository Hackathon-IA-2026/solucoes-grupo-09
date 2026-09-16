import {
  focusRing,
  radius,
  space,
  useContainerWidth,
  usePalette,
  WattSteerWordmark,
} from "@wattsteer/ui";
import { Link } from "expo-router";
import type { ComponentProps, ComponentType } from "react";
import {
  type GestureResponderEvent,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { LanguageSwitch } from "@/components/language-switch";
import { useCopy, useI18n } from "@/i18n";
import { localePath } from "@/i18n/locale";
import { PITCH_PATH } from "@/lib/pitch";
import { fragmentHref, type SectionId } from "@/lib/section-fragment";
import { PAGE_MAX } from "./layout";

/**
 * The landing page's own header.
 *
 * The template's `TopNavFull` was a *dashboard* header — tab pills, a
 * notification bell, an avatar — which the placeholder landing page was
 * rendering because it was the only nav that existed. It promises an
 * application to a visitor who has not entered one yet, and its avatar
 * promises an account this product does not have. So the landing page gets a
 * marketing header instead: wordmark, section links, one call to action.
 *
 * It was kept at the time on the assumption the app screens would want it.
 * They did not — they use `AppShell` — so it has been deleted rather than
 * left as a dead file the hardcoded-copy guard would have to exempt.
 */
export function LandingNav({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const copy = useCopy();
  const colors = usePalette();
  const { locale } = useI18n();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 860;

  return (
    <View
      testID="landing-nav"
      onLayout={onLayout}
      style={{
        width: "100%",
        maxWidth: PAGE_MAX,
        alignSelf: "center",
        paddingHorizontal: space.lg,
        paddingTop: space.xl,
        paddingBottom: space.sm,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space.lg,
      }}
    >
      {/* The wordmark is a link, and it points at *this locale's* root rather
          than at `/`. Sending it to `/` would bounce an English reader through
          the resolver there, which is only correct for as long as their stored
          choice survives — and is a silent reset to Portuguese the moment it
          does not. `localePath` keeps the trailing slash, so the logo and the
          sitemap name one URL rather than two. */}
      <Link href={localePath(locale) as never} asChild={true}>
        <Pressable
          testID="nav-home-link"
          accessibilityRole="link"
          accessibilityLabel={copy.nav.home}
          hitSlop={8}
          style={(state) => {
            const { focused = false } = state as { focused?: boolean };
            return {
              borderRadius: radius.md,
              padding: space.xs,
              ...focusRing(focused, colors.focus),
              ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
            };
          }}
        >
          <WattSteerWordmark />
        </Pressable>
      </Link>

      {wide ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xl }}>
          {copy.nav.links.map((link) => (
            <NavLink
              key={link.target}
              label={link.label}
              href={fragmentHref(link.target as SectionId)}
              onPress={() => onNavigate(link.target as SectionId)}
            />
          ))}
          {/*
            The deck, last in the row because it leaves the page and the four
            before it do not. `PITCH_PATH` rather than a literal: `/pitch` is
            outside the locale tree, so a hand-written `/pt/pitch` would 404
            while still reading correctly here.
          */}
          <NavLink label={copy.pitch.navLink} href={PITCH_PATH} />
        </View>
      ) : null}

      {/*
        No CTA here. The hero states the offer and carries the primary action a
        few hundred pixels below; repeating it in the nav gave the page two
        identical lime buttons competing for the same click, and the nav one
        arrived before the visitor had been told what they were opening.
      */}
      <LanguageSwitch testID="nav-language-switch" />
    </View>
  );
}

/**
 * A nav item. Every one of them is a **real anchor**, and the four in-page
 * ones are anchors for a reason the original version of this file did not
 * consider.
 *
 * The reasoning it shipped with was about crawlability: these are in-page
 * scroll targets rather than routes, the crawlable links out of this page are
 * the CTA (`/app`), the deck and the footer's legal links, and a fake
 * `href="#forecast"` would add nothing a crawler could follow. That half still
 * holds — a fragment is not a new URL for an index, and nothing below has
 * changed it.
 *
 * What it missed is **shareability**, which is a property of the reader and
 * not of the crawler. A `<div role="button">` that scrolls leaves the address
 * bar reading `/pt/` at every point on a page 5,264 px tall, so a reader who
 * wants to send somebody "the bit about how it works" has nothing to send.
 * With `href="#engines"` they can copy the URL after clicking, middle-click or
 * cmd-click the item to open that section in a new tab, and see where the link
 * goes in the status bar before they take it — none of which a button can do
 * at any price.
 *
 * So the `href` is not decoration: `Section` gives each section a matching DOM
 * `id`, and the click handler below defers to the browser for every click it
 * should not own. `onPress` handles only the plain left click, which it
 * cancels so the smooth scroll (and the `pushState` beside it) can do the
 * work; a modified click falls through to the browser and opens the fragment
 * URL in a new tab or window, which is the whole point of it being a link.
 *
 * `href` is a react-native-web prop — `View` renders an `<a>` when it is
 * present — so it is passed on web only and the component is unchanged on
 * native, where a fragment means nothing and `onPress` is the whole story.
 */
function NavLink({
  label,
  href,
  onPress,
}: {
  label: string;
  /**
   * Where the item points. `#engines` for an in-page section, `PITCH_PATH` for
   * the one item that leaves the page.
   */
  href: string;
  /**
   * The in-page scroll, for the fragment items. Its presence is what tells
   * this component which of the two kinds of link it is rendering: the route
   * item has no handler because expo-router's `Link` owns its navigation.
   */
  onPress?: () => void;
}) {
  const colors = usePalette();
  const inPage = onPress !== undefined;

  const handlePress = (event: GestureResponderEvent): void => {
    if (!browserShouldHandle(event)) {
      event.preventDefault?.();
      onPress?.();
    }
  };

  const pressable = (
    <Anchor
      accessibilityRole="link"
      accessibilityLabel={label}
      // Only the in-page items carry their own `href`: `Link asChild` injects
      // one for the route item, and passing a second here would be two sources
      // for the same attribute.
      {...(inPage && Platform.OS === "web" ? { href } : null)}
      onPress={inPage ? handlePress : undefined}
      hitSlop={8}
      style={(state) => {
        const { focused = false } = state as { focused?: boolean };
        return {
          paddingVertical: space.sm,
          paddingHorizontal: space.xs,
          borderRadius: radius.sm,
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      {/*
        Hover moves the *colour*, not the opacity — which is why the label is
        rendered from the press state rather than beside it. The link used to
        sit at `inkMuted` × 0.82 opacity, which resolves to 5.1:1 on `canvas`:
        the page's only navigation, set fainter than its own footnotes.
        `inkMuted` is 7.33:1 and `ink` on hover is 17.31:1, so the hover reads
        more clearly than the fade did and the resting state is legible.
      */}
      {(state) => {
        const { hovered = false } = state as { hovered?: boolean };
        return (
          <Text
            style={{
              fontSize: 14,
              fontWeight: "500",
              color: hovered ? colors.ink : colors.inkMuted,
            }}
          >
            {label}
          </Text>
        );
      }}
    </Anchor>
  );
  return inPage ? (
    pressable
  ) : (
    <Link href={href as never} asChild={true}>
      {pressable}
    </Link>
  );
}

/**
 * `Pressable`, told about the one web-only prop it already forwards.
 *
 * react-native-web's `View` renders an `<a>` when it is handed an `href`, and
 * `Pressable` spreads its unknown props onto the `View` it renders — which is
 * exactly how expo-router's own `Link asChild` produces an anchor here for the
 * deck. React Native's types do not describe that prop, because on native
 * there is no anchor to describe, so this cast is the narrowest way to say so.
 */
const Anchor = Pressable as ComponentType<
  ComponentProps<typeof Pressable> & { href?: string }
>;

/**
 * Whether the browser, rather than this component, should handle a click.
 *
 * The rule is expo-router's own — `eventShouldPreventDefault` in
 * `useLinkToPathProps` — reproduced rather than imported because that helper
 * is not exported and this link goes nowhere the router knows about. A
 * modified click (cmd, ctrl, shift, alt, or any button but the primary one) is
 * a request to open `/pt/#engines` somewhere else, and intercepting it to
 * scroll *this* tab would throw away the one thing the reader gains from these
 * being links at all. On native there is no mouse event and nothing to defer
 * to.
 */
function browserShouldHandle(event: GestureResponderEvent): boolean {
  if (Platform.OS !== "web") {
    return false;
  }
  const mouse = event as unknown as {
    button?: number;
    metaKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  };
  return (
    mouse.metaKey === true ||
    mouse.altKey === true ||
    mouse.ctrlKey === true ||
    mouse.shiftKey === true ||
    (mouse.button !== undefined && mouse.button !== 0)
  );
}
