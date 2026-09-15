import { IconCircle, LinkIcon, Panel, space, usePalette, XIcon } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { useCopy } from "@/i18n";
import { SectionHeading } from "./section";

/**
 * Where the data comes from, and what the product refuses to say.
 *
 * This section has no equivalent in the reference landing page, and it is
 * the one that most needed inventing. Two reasons it earns its space rather
 * than living in the footer:
 *
 * 1. **The map treats honesty about data as a product value, not a nicety.**
 *    A public, read-only forecasting site whose whole claim is "we show our
 *    working" cannot bury the working.
 * 2. **The ODbL notice is an obligation, not a courtesy.** WattSteer's plant
 *    table is a Derivative Database and the public charts are Publicly Used
 *    Produced Works, so §4.3 requires the notice on public surfaces from day
 *    one — not at monetisation. It is rendered as visible body text here, not
 *    as a legal-page link, because that is what §4.3 asks for.
 *
 * The "will not claim" list is the same argument in the other direction:
 * every item is a number the product could plausibly have shown and
 * deliberately does not.
 */
export function Provenance({ wide }: { wide: boolean }) {
  const copy = useCopy();
  const colors = usePalette();
  const basis: `${number}%` = wide ? "31%" : "100%";

  return (
    <>
      <SectionHeading
        title={copy.provenance.title}
        sub={copy.provenance.sub}
        wide={wide}
      />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        {copy.provenance.sources.map((source) => (
          <Panel
            key={source.name}
            style={{ flexGrow: 1, flexBasis: basis, gap: space.md }}
          >
            <IconCircle>
              <LinkIcon size={18} color={colors.accent} />
            </IconCircle>
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.ink }}>
              {source.name}
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
              {source.body}
            </Text>
          </Panel>
        ))}
      </View>

      {/*
        **Out of the card, and that is the point of the section.**

        This used to sit inside a `Panel` like the source cards above it, which
        framed "what WattSteer will not claim" as one more tile in a grid of
        tiles. It is not one of those: the cards above describe the data that
        *is* here, and this describes the claims that are not. Out of the panel
        it takes the page's own width and rhythm and reads as the section's
        closing statement rather than as a sixth source.

        `space.xxl` above it because it is a section break now rather than a
        card in a stack — the gap carries what the border used to.
      */}
      <View style={{ gap: space.xl, marginTop: space.xxl }}>
        <Text
          style={{
            fontSize: 20,
            fontWeight: "600",
            color: colors.ink,
            textAlign: "center",
          }}
        >
          {copy.provenance.honesty.title}
        </Text>
        {/*
          Two columns that stay two columns.

          The list is five items and the grid was `flexBasis: 45%` with
          `flexGrow: 1`, so the fifth — alone on its row — grew to the full
          1,196 px of the card: 168 characters a line beside four siblings set
          at 84. One item of five was therefore read at twice the measure of
          the rest, and it happened to be the newest and longest one. Capping
          the item at half the row and letting `space-between` place the pair
          keeps every body at one measure, whichever row it lands on.
        */}
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "space-between",
            rowGap: space.xl,
            columnGap: space.xl,
          }}
        >
          {copy.provenance.honesty.items.map((item) => {
            /*
              **The last item sits where the others do, at the left of its
              column.** It was briefly centred with auto margins, on the
              argument that a fifth item alone on its row looked ragged under a
              column of four. That was true while this block was inside a
              `Panel`; out of the card the section has the page's own left
              edge, and an item that starts somewhere else is the thing that now
              reads as misaligned. Every body in this list begins on the same
              vertical, whichever row it lands on — which is also what makes the
              five scannable as one list rather than as four plus one.
            */
            return (
              <View
                key={item.label}
                style={{
                  flexGrow: 1,
                  flexBasis: wide ? "46%" : "100%",
                  maxWidth: wide ? "48%" : "100%",
                  flexDirection: "row",
                  gap: space.sm,
                }}
              >
                {/* 24 px across, not the 22 it was — on the 4-pt scale, and one
                  step under `IconCircle`'s 32. Top-aligned against a 22 px
                  label line, which is 1 px of optical drift and the reason the
                  label carries an explicit `lineHeight` at all. */}
                <View
                  style={{
                    width: space.xl,
                    height: space.xl,
                    borderRadius: 12,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.dangerSoft,
                  }}
                >
                  <XIcon size={14} color={colors.onDangerSoft} />
                </View>
                {/* The body used to start at the item's left edge while the
                  label started 30 px in, so every paragraph hung left of its
                  own heading. One column under the mark aligns the two. */}
                <View style={{ flex: 1, gap: space.sm }}>
                  <Text
                    style={{
                      fontSize: 15,
                      lineHeight: 22,
                      fontWeight: "600",
                      color: colors.ink,
                    }}
                  >
                    {item.label}
                  </Text>
                  <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
                    {item.body}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </>
  );
}
