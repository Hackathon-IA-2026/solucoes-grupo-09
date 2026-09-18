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

import type { ReactNode } from "react";
import { useState } from "react";
import { radius, space, type, usePalette } from "@wattsteer/ui";
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
}) {
  const colors = usePalette();
  return (
    <View
      style={{
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
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: tone === undefined ? colors.border : tone,
        backgroundColor: colors.surface,
      }}
    >
      {note === undefined || noteId === undefined ? null : (
        <HoverNote note={note} id={noteId} />
      )}
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
  );
}
