/**
 * The five questions, as five cards.
 *
 * ## Why the headline of the first card is a risk class and not "Sim"
 *
 * The dashboard this is modelled on answers "Vai cortar?" with the word **Sim**.
 * That is exactly right at a day probability of 1.0 and a falsehood at 0.6, and
 * the card cannot tell which it is holding — so a yes/no headline would be true
 * on the days nobody needed it and wrong on the days somebody did.
 *
 * The product already has a word for this and uses it everywhere else: the risk
 * class, three bins with published boundaries, which the gateway returns rather
 * than the browser deciding. It reads as a verdict, it *is* a verdict, and the
 * probability sits under it so a reader can see which end of the bin they are
 * on. Nothing is lost except the false crispness.
 */

import {
  focusRing,
  motion,
  radius,
  space,
  type,
  usePalette,
  webTransition,
} from "@wattsteer/ui";
import type { ReactNode } from "react";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

/**
 * A caveat that is always in the document and only sometimes on the screen.
 *
 * The note it carries is load-bearing — the model forecasts how much will be
 * curtailed and never why — so it cannot be a `title` attribute or a tooltip
 * that only exists once a pointer arrives: there is no pointer on a phone, and
 * an attribute is not in the accessibility tree as text.
 *
 * So the sentence is rendered, always, and hidden with opacity rather than with
 * `display`. A screen reader reaches it through `aria-describedby`, the e2e
 * suite finds it in `body.textContent`, and a reader with a mouse sees it when
 * they ask. The mark opens on focus as well as on hover, because a control that
 * only answers a pointer is a control a keyboard cannot use.
 */
function HoverNote({ note, id }: { note: string; id: string }) {
  const colors = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View
      style={{
        ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
        top: space.sm,
        right: space.sm,
        zIndex: 3,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={note}
        aria-describedby={id}
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        onHoverIn={() => setOpen(true)}
        onHoverOut={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        hitSlop={8}
        style={{
          width: 16,
          height: 16,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: colors.border,
          ...(Platform.OS === "web" ? ({ cursor: "help" } as object) : null),
        }}
      >
        <Text style={{ fontSize: 10, lineHeight: 13, color: colors.inkFaint }}>
          {"\u2139"}
        </Text>
      </Pressable>

      <View
        nativeID={id}
        pointerEvents="none"
        style={{
          ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
          top: 22,
          right: 0,
          width: 250,
          padding: space.sm,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surfaceSunken,
          opacity: open ? 1 : 0,
          ...(Platform.OS === "web"
            ? ({ boxShadow: "0 10px 30px rgba(0,0,0,0.5)" } as object)
            : null),
        }}
      >
        <Text style={{ ...type.caption, color: colors.inkMuted, lineHeight: 17 }}>
          {note}
        </Text>
      </View>
    </View>
  );
}

/**
 * One question card.
 *
 * `tone` colours the headline and the border, and is passed only by the risk
 * card. The other four are figures rather than judgements, and colouring them
 * would imply a scale they are not on.
 */
export function QuestionCard({
  icon,
  question,
  answer,
  unit,
  detail,
  footnote,
  tone,
  note,
  noteId,
  onPress,
  expanded,
}: {
  icon: ReactNode;
  question: string;
  answer: string;
  unit?: string;
  detail: string;
  footnote?: string;
  tone?: string;
  /** A caveat, behind a mark in the corner. See {@link HoverNote}. */
  note?: string;
  noteId?: string;
  /**
   * Makes the card itself the control that opens its own long answer.
   *
   * Only "Por quê?" passes one today. The other four cards *are* their answer —
   * a probability, a median, a window, a list of regions — and a button that
   * leads nowhere is worse than no button, so pressability is opt-in rather
   * than a default the four have to decline.
   */
  onPress?: () => void;
  /** Whether what this card opens is open. Ignored without `onPress`. */
  expanded?: boolean;
}) {
  const colors = usePalette();
  /*
    **The note's mark stays outside the card's own button.**

    Making the whole card pressable would have put the caveat's `<button>`
    inside the card's `<button>`, which is `nested-interactive` — a WCAG 2.1.1
    failure that `e2e/accessibility.spec.ts` already caught once on this screen,
    when the selected map row wrapped the Explicar control. So the card box is
    still a plain `View`: the mark is one of its children, absolutely placed in
    the corner as before, and the *content* is the button beside it.

    The cost is that the corner of the card is not part of the press target.
    That is 16px of a card that is 188px at its narrowest, and it is the corner
    a reader reaches for when they want the caveat rather than the diagnosis.
  */
  const content = (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {icon}
        <Text
          style={{
            ...type.caption,
            color: colors.inkFaint,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
          numberOfLines={1}
        >
          {question}
        </Text>
      </View>

      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
        <Text
          style={{
            fontSize: 27,
            lineHeight: 32,
            fontWeight: "700",
            color: tone ?? colors.ink,
            fontVariant: ["tabular-nums"],
            letterSpacing: -0.8,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {answer}
        </Text>
        {unit === undefined ? null : (
          <Text style={{ ...type.label, color: colors.inkMuted }}>{unit}</Text>
        )}
      </View>

      {/*
        **The trailing lines sit on the row's bottom edge, not under a hole.**

        The five cards stretch to the tallest, which is whichever one's detail
        wraps to two lines. Measured at 1600px: every card 127px high, and the
        last line of "Vai cortar?" and of "Onde?" ended **36px** above their own
        bottom border while "Por quê?" ended 7px above its. The row's gap to the
        grid below is 12px — the same 12 the three columns use — but on those
        two columns a reader sees 48px of nothing and reads the row as belonging
        to a different block.

        `marginTop: "auto"` eats the slack above these lines instead of below
        them, so the five last lines land on one baseline and every card's
        trailing space is its own 12px of padding. The gap did not change; what
        changed is that it is now the whole of what separates the two rows.
      */}
      <View style={{ marginTop: "auto", gap: 6 }}>
        <Text style={{ ...type.caption, color: colors.inkMuted }} numberOfLines={2}>
          {detail}
        </Text>
        {footnote === undefined ? null : (
          <Text
            style={{
              ...type.caption,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
            }}
            numberOfLines={1}
          >
            {footnote}
          </Text>
        )}
      </View>
    </>
  );

  const box = {
    /*
      Exact fifths of the row, so the three columns underneath can line up
      with the card edges — the arithmetic is beside the three columns in
      `overview/overview-hero.tsx`. `flexBasis: 0` rather than a content width is what makes
      them exact; `minWidth` is what stops them becoming unreadable rather
      than merely narrow, and is the point at which the row wraps.

      The explicit `flexShrink` is not redundant: react-native-web defaults
      it to 0 where CSS defaults it to 1, so a basis alone is a floor rather
      than a preference (ADR-0001).
    */
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 188,
    gap: 6,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: tone === undefined ? colors.border : tone,
    backgroundColor: colors.surface,
  };

  return (
    <View style={box}>
      {note === undefined || noteId === undefined ? null : (
        <HoverNote note={note} id={noteId} />
      )}
      {onPress === undefined ? (
        content
      ) : (
        <Pressable
          accessibilityRole="button"
          /*
            `aria-expanded` because this is a toggle — the same press closes
            what it opened — and `aria-haspopup="dialog"` because what it opens
            is modal rather than a region below the button. No `aria-controls`:
            the sheet is portalled out of this tree and does not exist in the
            document while closed, so the attribute would point at nothing for
            all but a few seconds of the page's life.
          */
          aria-expanded={expanded}
          aria-haspopup="dialog"
          onPress={onPress}
          style={(state) => {
            const { focused = false, hovered = false } = state as {
              focused?: boolean;
              hovered?: boolean;
            };
            return {
              /*
                The card box owns the padding and the border, so this fills it
                edge to edge — a press target that stops short of the border is
                a card with a dead 12px frame, which reads as a misfire rather
                than as a margin. Negative margins rather than moving the
                padding here, because the note's mark is positioned against the
                box and would otherwise move with it.
              */
              margin: -space.md,
              padding: space.md,
              gap: 6,
              // Fills the stretched box rather than sizing to its content, or
              // the `marginTop: "auto"` inside it has no slack to eat.
              flexGrow: 1,
              borderRadius: radius.lg,
              borderCurve: "continuous",
              // The open state is a fill rather than a border: the border is
              // already the risk tone on one card in this row, and a second
              // meaning on the same property is a meaning nobody reads.
              backgroundColor:
                expanded === true || hovered ? colors.surfaceSunken : "transparent",
              ...focusRing(focused, colors.focus, -1),
              ...(Platform.OS === "web"
                ? ({
                    cursor: "pointer",
                    ...webTransition("background-color", motion.fast, motion.ease.color),
                  } as object)
                : null),
            };
          }}
        >
          {content}
        </Pressable>
      )}
    </View>
  );
}
