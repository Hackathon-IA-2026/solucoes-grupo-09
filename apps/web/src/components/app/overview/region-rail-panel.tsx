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

import { Panel, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { RiskChip } from "@/components/charts/risk-class";
import { useFormat } from "@/i18n";
import { roundProbability, type SubsystemCode, subsystemMeta } from "@/lib/fixtures";
import { RegionRow } from "./region-rail";

/** One row of the rail, already reduced to what it draws. */
export interface RailRegion {
  readonly code: string;
  readonly subsystem: SubsystemCode;
  readonly name: string;
  readonly value: number;
  readonly chip: React.ReactNode;
  readonly note: string | undefined;
}

export function RegionRail({
  regions,
  largest,
  selected,
  hovered,
  onSelect,
  onHoverChange,
  text,
}: {
  regions: readonly RailRegion[];
  /** The largest of the four, so every bar shares one scale. */
  largest: number;
  selected: SubsystemCode;
  hovered: SubsystemCode | null;
  onSelect: (code: SubsystemCode) => void;
  onHoverChange: (code: SubsystemCode | null) => void;
  text: { regionsLabel: string; windowLabel: string; pickHint: string };
}) {
  const colors = usePalette();
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
      <Text style={{ ...type.caption, color: colors.inkFaint, paddingBottom: space.xs }}>
        {text.windowLabel}
      </Text>
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
        />
      ))}
      <Text style={{ ...type.caption, color: colors.inkFaint, paddingTop: space.xs }}>
        {text.pickHint}
      </Text>
    </Panel>
  );
}
