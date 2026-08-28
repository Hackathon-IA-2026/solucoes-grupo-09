import { focusRing, radius, usePalette } from "@wattsteer/ui";
import { Link } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, Text } from "react-native";

/**
 * A pill-shaped call to action that is a **real link**, not a button with a
 * navigation side effect.
 *
 * `PillButton` in `@wattsteer/ui` takes `onPress`, which renders as a
 * `<div role="button">` on web: no `href`, so a crawler following the static
 * export finds no path from the landing page into the app, and a visitor
 * cannot middle-click it. The whole point of static-exporting this page is
 * that crawlers can walk it, so the CTA that carries the page's primary
 * action has to be an anchor. `Link asChild` over a `Pressable` gives an
 * `<a href>` on web and a normal navigation on native.
 *
 * **For later promotion to `packages/ui`** alongside `PillButton`, which
 * should probably grow an `href` variant rather than have this live here.
 */
export function CtaLink({
  href,
  label,
  icon,
  primary = false,
  testID,
}: {
  href: string;
  label: string;
  icon?: ReactNode;
  primary?: boolean;
  testID?: string;
}) {
  const colors = usePalette();
  return (
    // `Href` is generated from the route tree by typed routes; the app
    // section is built in parallel with this page, so the cast keeps the
    // landing page compiling before that route lands.
    <Link href={href as never} asChild={true}>
      <Pressable
        testID={testID}
        accessibilityRole="link"
        accessibilityLabel={label}
        hitSlop={8}
        style={(state) => {
          const { pressed } = state;
          const { focused = false, hovered = false } = state as {
            focused?: boolean;
            hovered?: boolean;
          };
          return {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: primary ? colors.accent : colors.border,
            backgroundColor: primary
              ? colors.accent
              : hovered
                ? colors.surfaceSunken
                : colors.surface,
            paddingHorizontal: 16,
            paddingVertical: 10,
            transform: [{ scale: pressed ? 0.95 : 1 }],
            ...focusRing(focused, colors.focus),
            ...(Platform.OS === "web"
              ? ({
                  cursor: "pointer",
                  transitionProperty: "transform, background-color",
                  transitionDuration: "150ms",
                } as object)
              : null),
          };
        }}
      >
        <Text
          style={{
            fontSize: 14,
            fontWeight: primary ? "600" : "500",
            color: primary ? colors.onAccent : colors.ink,
          }}
        >
          {label}
        </Text>
        {icon}
      </Pressable>
    </Link>
  );
}

/** Where every "open the product" affordance on the site points. */
export const APP_HREF = "/app";
