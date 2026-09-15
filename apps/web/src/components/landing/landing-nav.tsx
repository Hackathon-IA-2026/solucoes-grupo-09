import {
  focusRing,
  radius,
  space,
  useContainerWidth,
  usePalette,
  WattSteerWordmark,
} from "@wattsteer/ui";
import { Link } from "expo-router";
import { Platform, Pressable, Text, View } from "react-native";
import { LanguageSwitch } from "@/components/language-switch";
import { useCopy, useI18n } from "@/i18n";
import { localePath } from "@/i18n/locale";
import { PAGE_MAX, type SectionId } from "./section";

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
              onPress={() => onNavigate(link.target as SectionId)}
            />
          ))}
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
 * In-page scroll targets, not routes — so these are buttons, deliberately.
 * The crawlable links out of this page are the CTA (`/app`) and the footer's
 * legal links; a fake `href="#forecast"` would add nothing a crawler can use.
 */
function NavLink({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
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
    </Pressable>
  );
}
