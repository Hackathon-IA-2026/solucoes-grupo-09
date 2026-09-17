/**
 * The console's readouts: the band, the five questions, and the region table.
 *
 * Every figure below comes from a row the product already serves. The console
 * is a *layout*, not a new vocabulary — which is the constraint that decides
 * what is missing from it. The dashboard this screen is modelled on also shows
 * an accuracy percentage, an evidence-adherence score, a confidence on the
 * cause and a table of operative variables. None of those are here, because a
 * single day has no accuracy, no route serves the other three, and a figure
 * invented to fill a corner is exactly what this product spends its whole
 * surface refusing to do.
 */

import type { Band, RiskClass } from "@wattsteer/core/api";
import { radius, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { BandStrip } from "@/components/charts/band-figure";
import { riskColor } from "@/components/charts/risk-color";
import { useCopy, useFormat } from "@/i18n";
import type { SubsystemCode } from "@/lib/fixtures";
import { subsystemMeta } from "@/lib/fixtures";

/** A section heading in the console's smaller, denser scale. */
export function PanelTitle({ title, note }: { title: string; note?: string }) {
  const colors = usePalette();
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ ...type.label, color: colors.ink }}>{title}</Text>
      {note === undefined ? null : (
        <Text style={{ ...type.caption, color: colors.inkFaint }}>{note}</Text>
      )}
    </View>
  );
}

/**
 * The three quantiles side by side, P50 in the product's accent.
 *
 * Laid out as three columns rather than as a sentence because the comparison a
 * reader makes here is between the edges and the middle, and a band read left
 * to right is the one figure on the screen whose *shape* is the information.
 */
export function BandTriple({ band, domainMax }: { band: Band; domainMax?: number }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const cells = [
    { key: "p10", label: "P10", value: band.p10, accent: false },
    { key: "p50", label: "P50", value: band.p50, accent: true },
    { key: "p90", label: "P90", value: band.p90, accent: false },
  ];
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {cells.map((cell) => (
          <View
            key={cell.key}
            style={{
              flexGrow: cell.accent ? 1.4 : 1,
              flexShrink: 1,
              flexBasis: 0,
              gap: 2,
            }}
          >
            {/*
              The edges are a size smaller than the median, which fits the rail
              and is the better hierarchy anyway: P50 is the figure a reader
              acts on, and three identical numbers made them hunt for it. At one
              size they also overflowed a 260 px rail into `148,…`, which is a
              truncated quantile — worse than a small one, because it still
              looks like a number.
            */}
            <Text
              style={{
                fontSize: cell.accent ? 21 : 16,
                lineHeight: cell.accent ? 25 : 20,
                fontWeight: "600",
                color: cell.accent ? colors.violet : colors.ink,
                fontVariant: ["tabular-nums"],
                letterSpacing: -0.4,
              }}
              numberOfLines={1}
            >
              {f.compact(cell.value)}
            </Text>
            <Text
              style={{
                ...type.caption,
                color: cell.accent ? colors.violet : colors.inkFaint,
              }}
            >
              {cell.label}
            </Text>
          </View>
        ))}
      </View>
      <BandStrip band={band} domainMax={domainMax} tone="violet" />
      <Text style={{ ...type.caption, color: colors.inkFaint }}>
        {copy.app.grid.bandNote}
      </Text>
    </View>
  );
}

/** A label, a figure and an optional chip, on one line. Used down the rail. */
export function RailFact({
  label,
  value,
  note,
  trailing,
}: {
  label: string;
  value: string;
  note?: string;
  trailing?: React.ReactNode;
}) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingVertical: space.sm,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, gap: 2 }}>
        <Text style={{ ...type.caption, color: colors.inkFaint }}>{label}</Text>
        {note === undefined ? null : (
          <Text style={{ ...type.caption, color: colors.inkFaint }}>{note}</Text>
        )}
      </View>
      <Text
        style={{
          ...type.label,
          color: colors.ink,
          fontVariant: ["tabular-nums"],
          textAlign: "right",
        }}
      >
        {value}
      </Text>
      {trailing}
    </View>
  );
}

/** The three-bin risk chip, in the console's size. */
export function RiskPill({ klass }: { klass: RiskClass }) {
  const colors = usePalette();
  const copy = useCopy();
  const tone = riskColor(colors, klass);
  return (
    <View
      style={{
        paddingVertical: 3,
        paddingHorizontal: space.sm,
        borderRadius: radius.pill,
        borderCurve: "continuous",
        backgroundColor: tone.bg,
      }}
    >
      <Text style={{ ...type.caption, color: tone.fg }}>{copy.app.risk[klass]}</Text>
    </View>
  );
}

/**
 * The four subsystems as a table: figure, risk, and a share bar.
 *
 * The bar compares the four against the largest of them rather than against
 * their sum. The question this table exists for is "which region", and a share
 * of the national total answers a different one — it would put the Northeast at
 * 97 % and flatten the other three into slivers on every day the Northeast
 * leads, which is most days.
 */
export function RiskTable({
  rows,
  selected,
  hovered,
  onSelect,
  onHoverChange,
}: {
  rows: readonly {
    subsystem: SubsystemCode;
    riskClass: RiskClass;
    dailyEnergy: Band;
  }[];
  selected: SubsystemCode;
  hovered: SubsystemCode | null;
  onSelect: (code: SubsystemCode) => void;
  onHoverChange: (code: SubsystemCode | null) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const peak = Math.max(1, ...rows.map((row) => row.dailyEnergy.p50));

  return (
    <View style={{ gap: 2 }}>
      <View
        style={{
          flexDirection: "row",
          gap: space.sm,
          paddingBottom: space.xs ?? 4,
        }}
      >
        <Text
          style={{ ...type.caption, color: colors.inkFaint, flexGrow: 1, flexShrink: 1 }}
        >
          {copy.app.grid.tableSubsystem}
        </Text>
        <Text
          style={{
            ...type.caption,
            color: colors.inkFaint,
            width: 62,
            textAlign: "right",
          }}
        >
          {copy.app.grid.tableEnergy}
        </Text>
        <Text style={{ ...type.caption, color: colors.inkFaint, width: 52 }}>
          {copy.app.grid.tableRisk}
        </Text>
      </View>

      {rows.map((row) => {
        const isSelected = row.subsystem === selected;
        const tone = riskColor(colors, row.riskClass);
        return (
          <View
            key={row.subsystem}
            onPointerEnter={() => onHoverChange(row.subsystem)}
            onPointerLeave={() => onHoverChange(null)}
            onStartShouldSetResponder={() => {
              onSelect(row.subsystem);
              return false;
            }}
            accessibilityRole="button"
            accessibilityLabel={subsystemMeta(row.subsystem).onsDisplayName}
            aria-pressed={isSelected}
            style={{
              gap: 6,
              paddingVertical: space.sm,
              paddingHorizontal: space.sm,
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor:
                isSelected || row.subsystem === hovered
                  ? colors.surfaceSunken
                  : "transparent",
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: radius.pill,
                  backgroundColor: tone.fg,
                }}
              />
              <Text
                style={{
                  ...type.caption,
                  color: isSelected ? colors.ink : colors.inkMuted,
                  flexGrow: 1,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                {subsystemMeta(row.subsystem).short}
              </Text>
              <Text
                style={{
                  ...type.label,
                  color: colors.ink,
                  fontVariant: ["tabular-nums"],
                  width: 62,
                  textAlign: "right",
                }}
                numberOfLines={1}
              >
                {f.compact(row.dailyEnergy.p50)}
              </Text>
              <View style={{ width: 52, alignItems: "flex-start" }}>
                <RiskPill klass={row.riskClass} />
              </View>
            </View>
            <View
              style={{
                height: 3,
                borderRadius: radius.pill,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${Math.max(1, Math.min(100, (row.dailyEnergy.p50 / peak) * 100))}%`,
                  height: "100%",
                  backgroundColor: tone.fg,
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
