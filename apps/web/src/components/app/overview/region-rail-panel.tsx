/**
 * The four subsystems, down the rail beside the map.
 *
 * Split out of `overview-hero.tsx` with the rest of its panels. The branching
 * here is the same shape as everywhere on this screen — a forecast row and a
 * settled row answer the same question with different vocabulary, and nothing
 * may render one under the other's label — and it is the third such block the
 * hero was carrying inline.
 *
 * The window sentence above the rows is load-bearing. The headline reads the
 * *settled day* and these four read the *last 24 hours*; in the observed state
 * that makes them 0,0 MWh and 1 843 MWh for the same region, a few hundred
 * pixels apart. Two honest numbers adjacent with no window on either is how a
 * screen manufactures a contradiction out of correct data.
 */

import { Panel, radius, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { RiskChip } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import {
  roundProbability,
  type SubsystemCode,
  subsystemMeta,
  type Technology,
  type TechnologySplit,
} from "@/lib/fixtures";
import { RegionRow } from "./region-rail";

/** One row of the rail, already reduced to what it draws. */
export interface RailRegion {
  readonly code: string;
  readonly subsystem: SubsystemCode;
  readonly name: string;
  readonly value: number;
  readonly chip: React.ReactNode;
  readonly note: string | undefined;
  /** The two fleets the row's figure divides into; see `region-rail.tsx`. */
  readonly split: TechnologySplit;
}

export function RegionRail({
  regions,
  largest,
  selected,
  hovered,
  onSelect,
  onHoverChange,
  emphasis,
  text,
}: {
  regions: readonly RailRegion[];
  /** The largest of the four, so every bar shares one scale. */
  largest: number;
  selected: SubsystemCode;
  hovered: SubsystemCode | null;
  onSelect: (code: SubsystemCode) => void;
  onHoverChange: (code: SubsystemCode | null) => void;
  /** The URL's technology selection — the fleet the rows emphasise. */
  emphasis: Technology;
  text: {
    regionsLabel: string;
    windowLabel: string;
    pickHint: string;
    /**
     * Why the two fleet figures are what they are — and it differs by state.
     * A forecast divides one modelled expectation; a settled day is two
     * separate ONS measurements whose sum is the total. Said once, under the
     * four rows, rather than on each of them.
     */
    splitNote: string;
  };
}) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <Panel style={{ gap: space.sm }}>
      <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.regionsLabel}</Text>
      {/*
        **The rail's window, said out loud.**

        The headline above reads the *settled day* and these four read the
        *last 24 hours* — two different windows, and in the observed state that
        makes them 0,0 MWh and 1 843 MWh for the same region, a few hundred
        pixels apart with nothing between them explaining it. Two honest
        numbers adjacent with no window on either is how a screen manufactures
        a contradiction out of correct data.
      */}
      <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.windowLabel}</Text>
      {/*
        **The colour key, once, above the four rows.**

        Each row's bar is cut into wind and solar, and a colour that is never
        named is a decoration. It is named here rather than on every row: the
        caveat rule in `copy.md` is that a thing the product always carries is
        read once and then never again.
      */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingBottom: space.xs,
        }}
      >
        {/*
          The emphasised fleet says so in words as well as in weight. Bold text
          and a brighter dot are the same channel twice, and the technology
          selector's only visible effect on this screen is now these two rows —
          a reader who cannot see the difference cannot see the selector work.
        */}
        <FleetKey
          tone={colors.accent}
          label={copy.app.technology.WIND}
          emphasisLabel={copy.app.split.emphasised}
          emphasised={emphasis === "WIND"}
        />
        <FleetKey
          tone={colors.violet}
          label={copy.app.technology.SOLAR}
          emphasisLabel={copy.app.split.emphasised}
          emphasised={emphasis === "SOLAR"}
        />
      </View>
      {regions.map((row) => (
        <RegionRow
          key={row.subsystem}
          code={row.code}
          name={row.name}
          value={row.value}
          unit="MWh"
          share={row.value / largest}
          selected={row.subsystem === selected}
          highlighted={row.subsystem === hovered}
          onPress={() => onSelect(row.subsystem)}
          onHoverChange={(on) => onHoverChange(on ? row.subsystem : null)}
          trailing={row.chip}
          note={row.note}
          split={row.split}
          emphasis={emphasis}
        />
      ))}
      <Text style={{ ...type.caption, color: colors.inkFaint, paddingTop: space.xs }}>
        {text.pickHint}
      </Text>
      <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
        {text.splitNote}
      </Text>
    </Panel>
  );
}

/** One entry in the rail's colour key: a dot in the fleet's colour, and its name. */
function FleetKey({
  tone,
  label,
  emphasisLabel,
  emphasised,
}: {
  tone: string;
  label: string;
  emphasisLabel: string;
  emphasised: boolean;
}) {
  const colors = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: radius.pill,
          backgroundColor: tone,
          opacity: emphasised ? 0.95 : 0.34,
        }}
      />
      <Text
        style={{
          ...type.caption,
          color: emphasised ? colors.ink : colors.inkFaint,
          fontWeight: emphasised ? "700" : "400",
        }}
      >
        {emphasised ? `${label} · ${emphasisLabel}` : label}
      </Text>
    </View>
  );
}
