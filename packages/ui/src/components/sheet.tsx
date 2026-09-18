import type { ReactNode } from "react";
import { useEffect } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { usePalette } from "../hooks/use-palette";
import { layout, motion, radius, space, type } from "../tokens";
import { FadeIn } from "./fade-in";
import { XIcon } from "./icons";
import { IconCircleButton } from "./pill";

/**
 * A panel that rises over the page to answer one question, and hands the page
 * back when it is closed.
 *
 * ## What is borrowed and what is ours
 *
 * The structure is the one the mascot project's `ConfirmDeleteSheet` arrived
 * at, and the reason to borrow it rather than reach for a sheet library is the
 * reason that file gives: react-native's own `Modal` already carries every part
 * of this that is hard to get right on the web. It portals out of the app tree
 * so no ancestor's `overflow` can clip it, it renders `role="dialog"` with
 * `aria-modal`, it closes on Escape through `onRequestClose`, and it brackets
 * its content with two focus sentinels so Tab cannot walk out of the dialog and
 * into the page behind. A hand-rolled overlay is a re-implementation of those
 * four things, and the fourth is the one everybody gets wrong.
 *
 * What is *not* borrowed is the mascot's `BottomSheetOverlay`, which is a thin
 * wrapper over `@expo/ui`'s native `BottomSheet` — a dependency this product
 * does not have, for a surface that is web-first. Its drag indicator and its
 * pan-to-dismiss came from that dependency and are gone with it; a pointer and
 * a keyboard are what read this product, and neither throws a sheet downwards.
 * The two escapes that replace the gesture are the ones those inputs have: the
 * close button, and the backdrop.
 *
 * ## Why it is not a bottom sheet on a desktop
 *
 * A sheet anchored to the bottom edge is a phone idiom, and it is one because a
 * phone's content column *is* the viewport: the sheet arrives under the thumb
 * and covers the thing it is about. On a 1600px window the same treatment puts
 * a full-bleed slab across the bottom of the screen — a thousand pixels of
 * travel from the card that opened it, with the eye leaving the row it was
 * reading. So the presentation follows the width: bottom-anchored and
 * full-width below `layout.desktop`, centred and capped above it. One
 * component, because it is one thing — a modal answer — and only its anchor is
 * a matter of viewport.
 *
 * Measured on the **window**, which is the one place in this package that does
 * not follow the `onLayout` rule. That rule exists because window dimensions
 * are unreliable during the static-render hydration pass — and this component
 * never renders during it: nothing mounts until a reader presses something,
 * which is long after hydration, and what it fills is the viewport rather than
 * a content column. Measuring itself instead was tried and is visibly worse:
 * `onLayout` reports after the first paint, so the panel mounted bottom-
 * anchored and full-width on a desktop and jumped to its centred size on the
 * next frame, in the middle of its own entrance.
 */
export function Sheet({
  open,
  onClose,
  title,
  lede,
  closeLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Names the dialog, and is its heading. */
  title: string;
  lede?: string;
  /** Accessible name for the close control. */
  closeLabel: string;
  children: ReactNode;
}) {
  const colors = usePalette();
  const wide = useWindowDimensions().width >= layout.desktop;

  /*
    The page behind must not scroll while this is open. Without it a wheel or a
    two-finger swipe over the backdrop scrolls the document underneath — the
    reader loses their place on a 13 000px page to a gesture they meant for the
    sheet — and a screen reader that follows the visual scroll ends up reading
    content it is meant to be held out of.

    `overflow: hidden` on the document element rather than a scroll-blocking
    handler: it is one property, it restores exactly, and it cannot leak a
    listener if this unmounts mid-gesture. The measured cost is the scrollbar's
    width in reflow on the frame it is applied, which is why the value is
    captured and put back rather than cleared to "".
  */
  useEffect(() => {
    if (!open || Platform.OS !== "web" || typeof document === "undefined") {
      return;
    }
    const element = document.documentElement;
    const previous = element.style.overflow;
    element.style.overflow = "hidden";
    return () => {
      element.style.overflow = previous;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <Modal
      visible={true}
      transparent={true}
      // The backdrop's own fade; the panel's rise is `FadeIn` below. RN's
      // "slide" would carry the backdrop up with the panel, which reads as the
      // whole screen moving rather than as something arriving over it.
      animationType="fade"
      onRequestClose={onClose}
      // VoiceOver on iOS hides the tree behind a modal only when told to.
      accessibilityViewIsModal={true}
      // react-native-web forwards unknown props to the dialog element; this is
      // the dialog's accessible name and there is no typed prop for it.
      {...(Platform.OS === "web" ? ({ "aria-label": title } as object) : null)}
    >
      {/*
        The backdrop closes on press, and is `presentation` with no tab stop:
        react-native-web gives every Pressable a tab stop regardless of role, so
        without `tabIndex={-1}` the modal's focus trap lands the reader on an
        invisible full-screen element whose Enter means "close". The mascot's
        sheet carries the same two lines for the same reason.
      */}
      <Pressable
        onPress={onClose}
        role="presentation"
        tabIndex={-1}
        style={{
          flex: 1,
          justifyContent: wide ? "center" : "flex-end",
          alignItems: "center",
          backgroundColor: colors.scrim,
          padding: wide ? space.xl : 0,
        }}
      >
        <FadeIn
          duration={motion.base}
          // A sheet rises further than a card does: the distance is what says
          // "from the edge" rather than "from nowhere". Capped small on a
          // centred dialog, which arrives where it already is.
          distance={wide ? 12 : 32}
          style={{
            width: "100%",
            maxWidth: wide ? layout.desktop : undefined,
            // 88%, not a height: the sheet is as tall as its content until the
            // content would reach the top of the window, at which point the
            // ScrollView inside takes over. A fixed height makes a two-line
            // sheet a full-screen one.
            maxHeight: wide ? "88%" : "92%",
            // ADR-0001: react-native-web defaults `flexShrink` to 0, so a
            // maxHeight alone does not let this give way inside the flex
            // backdrop — the panel would overflow the viewport instead of
            // capping.
            flexShrink: 1,
          }}
        >
          {/*
            Nested Pressable, so a press inside the panel does not reach the
            backdrop and close it. react-native's responder system gives the
            press to the innermost pressable and the outer one never fires.
          */}
          <Pressable
            onPress={() => undefined}
            role="presentation"
            tabIndex={-1}
            style={{
              // Square-cornered at the bottom edge on a phone, because the
              // sheet *is* the bottom edge there; a rounded corner over nothing
              // reads as a card that failed to reach the end of the screen.
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              borderBottomLeftRadius: wide ? radius.xl : 0,
              borderBottomRightRadius: wide ? radius.xl : 0,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.canvas,
              flexShrink: 1,
              ...(Platform.OS === "web"
                ? ({ boxShadow: colors.shadowFloat, cursor: "default" } as object)
                : null),
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: space.md,
                padding: space.xl,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              {/* `flexShrink` on the column and `flex: 1` inside it — the pair
                  `PanelHeader` documents at length. Without both, a long title
                  sizes to its content and pushes the close button off the
                  panel's right edge at 320px. */}
              <View style={{ flexShrink: 1, flex: 1, gap: 4 }}>
                <Text
                  accessibilityRole="header"
                  aria-level={2}
                  style={{ ...type.h3, color: colors.ink }}
                >
                  {title}
                </Text>
                {lede === undefined ? null : (
                  <Text style={{ ...type.bodySmall, color: colors.inkMuted }}>
                    {lede}
                  </Text>
                )}
              </View>
              {/*
                First focusable descendant, which is what the focus trap reaches
                for when the dialog opens — so the reader's first stop is the
                way out. `autoFocus` as well, because the trap only fires when
                focus tries to leave and the opening press leaves focus on the
                card behind the backdrop.
              */}
              <View {...(Platform.OS === "web" ? ({ autoFocus: true } as object) : null)}>
                <IconCircleButton
                  label={closeLabel}
                  onPress={onClose}
                  size={40}
                  tone="outline"
                  testID="sheet-close"
                >
                  <XIcon size={16} color={colors.ink} />
                </IconCircleButton>
              </View>
            </View>
            {/*
              The content scrolls inside the panel, not the page. `flexShrink`
              again: without it the ScrollView claims its content's height and
              the cap above never applies (ADR-0001).
            */}
            <ScrollView
              /*
                A tab stop on the scroller itself, which `scrollable-region-
                focusable` (WCAG 2.1.1) requires and the audit caught the first
                time this ran: react-native-web's ScrollView is a `div` with
                `overflow: auto` and no `tabIndex`, so the only way to scroll it
                was a wheel or a drag — and Explicar is several screens tall, so
                a keyboard reader could reach the panels below the fold only by
                tabbing through every control above them, and a reader with no
                controls in view could not scroll at all.

                Named, because a focusable region that announces nothing is a
                stop a screen reader cannot explain. It borrows the dialog's own
                name rather than inventing a second one.
              */
              {...(Platform.OS === "web"
                ? ({ tabIndex: 0, role: "region", "aria-label": title } as object)
                : null)}
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ padding: space.xl, gap: space.lg }}
            >
              {children}
            </ScrollView>
          </Pressable>
        </FadeIn>
      </Pressable>
    </Modal>
  );
}
