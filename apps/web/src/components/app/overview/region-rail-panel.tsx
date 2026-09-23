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

import type { Band } from "@wattsteer/core/api";
import {
  LayersIcon,
  Panel,
  PanelHeader,
  radius,
  space,
  type,
  usePalette,
} from "@wattsteer/ui";
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
  /** The row's P10-P90, or `null` on a settled row. See `hero-figures.tsx`. */
  readonly band: Band | null;
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
  summary,
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
  };
  /**
   * The four rows added up, drawn under them inside this panel.
   *
   * A node rather than figures, because what the sum *means* forks on whether
   * a forecast was published and this panel has no business knowing that. The
   * hero composes it; the rail gives it the place where a reader can check the
   * addition by looking up.
   */
  summary?: React.ReactNode;
}) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <Panel style={{ gap: space.sm }}>
      {/*
        `PanelHeader`, not a bare caption. The rail is two cards wide now and
        heads a block a reader navigates to rather than a strip beside the map,
        which is the vocabulary this header exists for — and the window below
        stays exactly where it was, for the reason the next comment gives.
      */}
      <PanelHeader
        icon={<LayersIcon size={16} color={colors.inkMuted} />}
        title={text.regionsLabel}
        subtitle={text.windowLabel}
      />
      {/*
        **The rail's window is the header's subtitle now, and it is still said.**

        The headline elsewhere reads the *settled day* and these four read the
        *last 24 hours* — two different windows, and in the observed state that
        makes them 0,0 MWh and 1 843 MWh for the same region, a few hundred
        pixels apart with nothing between them explaining it. Two honest
        numbers adjacent with no window on either is how a screen manufactures
        a contradiction out of correct data. It moved into the header rather
        than out of the panel.
      */}
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
          subsystem={row.subsystem}
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
          band={row.band}
        />
      ))}
      {/*
        **Two footnotes gone, and neither is coming back here.**

        One told the reader to tap the map; the other was the split's paragraph
        — one head per subsystem, so wind and solar divide an expectation and a
        technology pick emphasises rather than filters. Both were under the four
        rows, and between them they were taller than a region's row.

        The tap hint had stopped being information: the map is the screen's
        subject, the rows are visibly pressable, and the hint said so on every
        render forever. The split paragraph is a real claim and is the one worth
        missing — it belongs where the division is argued rather than where it
        is drawn, which is Explicar. The rail keeps what it can carry honestly:
        the two figures, labelled, under a window that says which.
      */}
      {summary === undefined ? null : (
        <>
          {/*
            A hairline, because the sum is about the four rows above it rather
            than a sixth thing in a list of five. Inside the panel for the same
            reason: a reader checks the addition by looking up, and a separate
            card would put a page gap between a total and its parts.
          */}
          <View
            style={{ height: 1, backgroundColor: colors.border, marginTop: space.xs }}
          />
          {summary}
        </>
      )}
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
