import {
  focusRing,
  motion,
  radius,
  usePalette,
  useReducedMotion,
  webTransition,
} from "@wattsteer/ui";
import { Link } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";

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
 *
 * ## Why the pill is an inner `View` and not the `Pressable` itself
 *
 * Because a `Pressable` under `Link asChild` silently loses a **function**
 * `style`, and this component shipped with one.
 *
 * `Link asChild` renders expo-router's `Slot`, which is Radix's `Slot` with a
 * React Native shim. Radix merges the slot's props into the child's, and it
 * merges `style` by spreading: `{ ...slotStyle, ...childStyle }`. Spreading a
 * function yields `{}`. So `style={(state) => …}` on the cloned child is
 * replaced by an empty object, with no warning — it type-checks, it renders,
 * and the anchor comes out of the static export carrying no padding, no
 * border, no radius and no fill. Measured on `dist/pt/index.html`: the `<a>`
 * had `class="css-g5y9jx r-1loqt21 r-1otgn73"` and no inline style at all,
 * next to the secondary `PillButton`'s `<button>`, which had the full
 * declaration list. The primary call to action on this page was rendering as
 * bare lime text with an arrow — the only thing that survived was the colour
 * on the label, because that is set on the child `Text`.
 *
 * The fix is to put nothing state-dependent on the element `Slot` clones. The
 * `Pressable` keeps a plain object style — objects merge correctly — and the
 * pill itself is an inner `View` fed by `Pressable`'s children-as-function,
 * which is the child's own `children` prop and is not merged by the slot.
 *
 * ## Geometry
 *
 * Every number is the reference pill's, read off `PillButton` rather than
 * guessed: pill radius, a 1px border in the fill colour, 16/10 padding, a 6px
 * gap to the icon, a 14px/600 label in `onAccent`, and a 0.95 press scale over
 * a 150ms transition. A solid primary has no hover state, in the reference
 * either. `PillButton` carries the identical set and the two must not drift —
 * the primary CTA and the secondary pill sit on one line in the hero, so a
 * 1px difference in either padding reads as a step in the row.
 *
 * `justifyContent`, `flexShrink: 0` and `numberOfLines` are here for the same
 * reason they are on `PillButton`: in that row at 400px the pill is a flex
 * child, and without them it shrinks below its label and breaks the text onto
 * a second line *inside* the rounded shape.
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
  // The press scale is decoration, not feedback of last resort — the focus
  // ring and the pointer cursor both survive without it — so it comes off
  // entirely under `prefers-reduced-motion` rather than being animated
  // faster. The reference pill animates unconditionally; that is the one
  // place this deliberately does not copy it.
  const reducedMotion = useReducedMotion();
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
        // A plain object, deliberately: see the header. The anchor is only a
        // hit target and a flex child; everything visible is the `View` below.
        style={{ flexShrink: 0 }}
      >
        {(state) => {
          const { pressed } = state;
          const { focused = false, hovered = false } = state as {
            focused?: boolean;
            hovered?: boolean;
          };
          return (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                flexShrink: 0,
                borderRadius: radius.pill,
                borderCurve: "continuous",
                borderWidth: 1,
                // See PillButton: interactive controls take the stronger border.
                borderColor: primary ? colors.accent : colors.borderStrong,
                // A solid primary has no hover state — the reference's does not
                // either. The fill is already the loudest thing on the page, and
                // lightening it on hover reads as a second, quieter accent.
                backgroundColor: primary
                  ? colors.accent
                  : hovered
                    ? colors.surfaceSunken
                    : colors.surface,
                paddingHorizontal: 16,
                paddingVertical: 10,
                transform: [{ scale: pressed && !reducedMotion ? 0.95 : 1 }],
                // The ring is on the pill, not the anchor: the anchor has no
                // shape of its own, so a ring there would be a rectangle
                // around a pill.
                ...focusRing(focused, colors.focus),
                ...(reducedMotion
                  ? {}
                  : webTransition("transform, background-color", motion.fast)),
                ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 14,
                  fontWeight: primary ? "600" : "500",
                  color: primary ? colors.onAccent : colors.ink,
                }}
              >
                {label}
              </Text>
              {icon}
            </View>
          );
        }}
      </Pressable>
    </Link>
  );
}

/** Where every "open the product" affordance on the site points. */
export const APP_HREF = "/app";
