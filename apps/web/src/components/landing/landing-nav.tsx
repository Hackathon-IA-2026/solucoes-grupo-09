import {
  ArrowRightIcon,
  focusRing,
  layout,
  space,
  useContainerWidth,
  usePalette,
  WattSteerWordmark,
} from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { copy } from "./copy";
import { APP_HREF, CtaLink } from "./cta-link";
import type { SectionId } from "./section";

/**
 * The landing page's own header.
 *
 * The existing `TopNavFull` is a *dashboard* header — tab pills, a
 * notification bell, an avatar — which the placeholder landing page was
 * rendering because it was the only nav that existed. It promises an
 * application to a visitor who has not entered one yet, and its avatar
 * promises an account this product does not have. So the landing page gets a
 * marketing header instead: wordmark, section links, one call to action.
 *
 * `top-nav.tsx` is left untouched — the app screens are being built in
 * parallel and `TopNavFull` is theirs.
 */
export function LandingNav({ onNavigate }: { onNavigate: (section: SectionId) => void }) {
  const colors = usePalette();
  const [width, onLayout] = useContainerWidth();
  const wide = width >= 860;

  return (
    <View
      testID="landing-nav"
      onLayout={onLayout}
      style={{
        width: "100%",
        maxWidth: layout.page + 128,
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
      <View accessibilityLabel={copy.nav.home}>
        <WattSteerWordmark />
      </View>

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

      <CtaLink
        testID="nav-open-app"
        href={APP_HREF}
        label={copy.nav.cta}
        primary={true}
        icon={<ArrowRightIcon size={15} color={colors.onAccent} />}
      />
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
        const { focused = false, hovered = false } = state as {
          focused?: boolean;
          hovered?: boolean;
        };
        return {
          paddingVertical: 6,
          borderRadius: 8,
          ...focusRing(focused, colors.focus),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
          opacity: hovered ? 1 : 0.82,
        };
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}
