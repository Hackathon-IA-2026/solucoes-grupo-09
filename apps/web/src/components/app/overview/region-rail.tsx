/**
 * The satellite readouts that sit around the Overview hero's map.
 *
 * Deliberately small components rather than new panels: the console is a
 * *layout* experiment, not a new vocabulary. Every figure it draws is drawn by
 * something the product already ships — `BandStrip` for an interval,
 * `ObservedProfile` for a settled day, `RiskChip` for a risk class — and what
 * is new here is only where they sit.
 *
 * That constraint is the whole point of the mockup. A console that invented a
 * confident-looking number to fill a corner would look like the references it
 * is modelled on and lie the way they do: those dashboards render eight-digit
 * precision over made-up geography. This product's discipline is that a
 * forecast is an interval and a settlement is a measurement, and the two never
 * wear each other's clothes.
 */

import type { Band } from "@wattsteer/core/api";
import { radius, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { BandStrip } from "@/components/charts/band-figure";
import { useFormat } from "@/i18n";

/**
 * One headline figure: a label, a number in the product's largest type, and a
 * sentence saying what kind of claim it is.
 *
 * `band` is optional and its absence is the honest case, not a missing one. A
 * settled day has no interval and is told to say so rather than being handed a
 * strip of nothing.
 */
export function HeroStat({
  label,
  value,
  unit,
  note,
  band,
  domainMax,
  tone = "violet",
}: {
  label: string;
  value: number;
  unit: string;
  note: string;
  band?: Band;
  domainMax?: number;
  tone?: "accent" | "violet" | "muted";
}) {
  const colors = usePalette();
  const f = useFormat();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ ...type.caption, color: colors.inkFaint }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text
          style={{
            ...type.hero,
            color: colors.ink,
            fontVariant: ["tabular-nums"],
            letterSpacing: -1,
          }}
        >
          {f.compact(value)}
        </Text>
        <Text style={{ ...type.label, color: colors.inkMuted }}>{unit}</Text>
      </View>
      {band === undefined ? null : (
        <BandStrip band={band} domainMax={domainMax} tone={tone} />
      )}
      <Text style={{ ...type.caption, color: colors.inkFaint }}>{note}</Text>
    </View>
  );
}

/**
 * A region's line in the rail beside the map.
 *
 * It is a row, a bar and a share — and it is *not* `SubsystemRow`. That
 * component is the Overview's, it carries an Explain control and a badge and a
 * split sentence, and at rail width it would wrap into four lines. This is the
 * same data at the density a rail can hold, which is the experiment.
 */
export function RegionRow({
  code,
  name,
  value,
  unit,
  share,
  selected,
  highlighted,
  onPress,
  onHoverChange,
  trailing,
  note,
}: {
  /** The short code — `N`, `NE`, `SE/CO`, `S` — as the map labels it. */
  code: string;
  name: string;
  value: number;
  unit: string;
  /** Fraction of the largest of the four, for the bar. */
  share: number;
  selected: boolean;
  highlighted: boolean;
  onPress: () => void;
  onHoverChange: (on: boolean) => void;
  /** A risk chip where there is a forecast; nothing where there is not. */
  trailing?: React.ReactNode;
  /** Printed beside the figure, where the chip is too narrow to carry it. */
  note?: string;
}) {
  const colors = usePalette();
  const f = useFormat();
  return (
    <View
      style={{
        gap: 8,
        paddingVertical: space.md,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        // Selection is a border and a fill; hover is only a fill. Colour is not
        // the only channel carrying either — the selected row also keeps its
        // full-weight name where the others are muted.
        borderColor: selected ? colors.accent : "transparent",
        backgroundColor: selected || highlighted ? colors.surfaceSunken : "transparent",
      }}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      accessibilityRole="button"
      accessibilityLabel={name}
      aria-pressed={selected}
      onStartShouldSetResponder={() => {
        onPress();
        return false;
      }}
    >
      {/*
        **Two rows, and the first draft was one.**

        Name, figure and risk chip on a single line put `NORDESTE` and `NORTE`
        both through `numberOfLines={1}` in a 300px rail, and both came out as
        `NOR…`. Two of the four subsystems rendered identically — which is worse
        than a truncation, because it is a truncation that reads as a value.

        So the name gets the width of the row, and the figure gets the next
        line. The short code leads, because it is what the map writes on the
        region this row is about, and a reader matching the two should not have
        to translate.
      */}
      {/*
        **Three lines, each using the whole width.**

        Measured at 234 px of row: the name line was using 105 of it and the
        figure line 108, while the risk chip — 123 px on its own — could not fit
        beside the figure and wrapped to a fourth line. Four half-empty lines per
        region, sixteen down the rail.

        The chip sits with the figure and the name gets the whole first line.
        The chip went *up* beside the name first, which fixed the wrap and broke
        something worse: at 1280 px the rail is about 206 px, and a 44 px code
        plus a 62 px chip left 45 px for the name — so `NORDESTE` and
        `SUDESTE/CENTRO-OESTE` both rendered as three letters and an ellipsis.
        Two of the four regions reading identically is worse than a wrap, because
        a truncation reads as a value. Measured, not guessed.

        It fits on the figure's line now only because the chip lost its
        probability: 108 px of figure plus a 62 px chip and a gap is 178, inside
        206. The probability it gave up rides beside the figure as `note` — a
        number among numbers rather than a second thing inside a badge.
      */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text
          style={{
            ...type.caption,
            color: selected ? colors.accent : colors.inkFaint,
            fontVariant: ["tabular-nums"],
            // `SE/CO` is the widest of the four and was still clipping at 36.
            minWidth: 44,
          }}
          numberOfLines={1}
        >
          {code}
        </Text>
        <Text
          style={{
            ...type.label,
            color: selected ? colors.ink : colors.inkMuted,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
          }}
          /*
            **It wraps; it does not truncate.**

            `numberOfLines={1}` turned `SUDESTE/CENTRO-OESTE` into `SUD…` at
            every rail narrower than about 170 px, and at 1024 `NORDESTE` became
            `NOR…` beside it — two of the four regions reading as the same three
            letters. A truncation that reads as a value is the failure this file
            already records once, from the first draft of this row. Two lines for
            one region is cheaper than a name a reader cannot trust.
          */
          numberOfLines={2}
        >
          {name}
        </Text>
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          // At 320 px this line — figure, unit, probability, chip — wants
          // 215 px in a 212 px box. It wraps rather than overflows: the chip
          // drops under the figure, which at that width is a full-bleed row
          // with the space for it.
          flexWrap: "wrap",
          gap: 5,
        }}
      >
        <Text
          style={{
            fontSize: 22,
            lineHeight: 26,
            fontWeight: "600",
            color: colors.ink,
            fontVariant: ["tabular-nums"],
          }}
        >
          {f.compact(value)}
        </Text>
        <Text style={{ ...type.caption, color: colors.inkFaint }}>{unit}</Text>
        {note === undefined ? null : (
          <Text
            style={{
              ...type.caption,
              color: colors.inkFaint,
              fontVariant: ["tabular-nums"],
              marginStart: 4,
            }}
          >
            {note}
          </Text>
        )}
        <View style={{ flexGrow: 1, flexShrink: 1 }} />
        {trailing}
      </View>

      <View
        style={{
          height: 4,
          borderRadius: radius.pill,
          backgroundColor: colors.surfaceSunken,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${Math.max(2, Math.min(100, share * 100))}%`,
            height: "100%",
            borderRadius: radius.pill,
            backgroundColor: selected ? colors.accent : colors.violet,
          }}
        />
      </View>
    </View>
  );
}
