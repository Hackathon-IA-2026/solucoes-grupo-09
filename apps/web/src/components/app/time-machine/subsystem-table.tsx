/**
 * The four subsystems of the replayed day, each against its own pinned band.
 *
 * Where a dashboard would put an "accuracy %" column, this one draws the band
 * and puts the settled dot on it. One day cannot produce an accuracy — the band
 * is meant to be missed about one day in five — so the column shows *where*
 * the day landed and lets the band say how wide the claim was. The deviation
 * beside it is the server's `deviation_mwh`, in MWh and signed.
 *
 * The national row is the wire's: a settled total that is the sum of four
 * (measurements add) and a band that is the joint row of one publication, or
 * the sentence that says why there is none. It is never four P50s added, and
 * nothing in this file could add them.
 */

import { subsystemMeta } from "@wattsteer/core";
import type { ReplayCompare, ReplayCompareSubsystem } from "@wattsteer/core/api";
import { LayersIcon, Panel, PanelHeader, radius, space, usePalette } from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import type { ReviewState } from "@/components/app/use-replay-review";
import { useCopy, useFormat } from "@/i18n";
import { mwh, signedMwh } from "@/i18n/time-machine";
import type { SubsystemCode } from "@/lib/fixtures";

type Band = NonNullable<ReplayCompareSubsystem["dayTotal"]>;

/** The band on its own row's scale, with the settled day marked on it. */
function PlacementStrip({ band, settled }: { band: Band; settled: number | null }) {
  const colors = usePalette();
  const top = Math.max(band.p90, settled ?? 0) * 1.1;
  if (top <= 0) {
    return null;
  }
  const at = (value: number) => `${Math.min(100, (value / top) * 100)}%` as const;
  const width = `${((band.p90 - band.p10) / top) * 100}%` as const;
  const inside = settled !== null && settled >= band.p10 && settled <= band.p90;
  return (
    <View
      style={{
        height: 12,
        minWidth: 72,
        flexGrow: 1,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceSunken,
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          left: at(band.p10),
          width,
          height: 12,
          borderRadius: radius.pill,
          backgroundColor: colors.violetSoft,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: at(band.p50),
          width: 2,
          height: 12,
          backgroundColor: colors.violet,
        }}
      />
      {settled === null ? null : (
        <View
          style={{
            position: "absolute",
            left: at(settled),
            marginLeft: -5,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: inside ? colors.ink : colors.warning,
            borderWidth: 2,
            borderColor: colors.surface,
          }}
        />
      )}
    </View>
  );
}

function Cell({
  children,
  basis,
  align = "left",
  strong = false,
  muted = false,
}: {
  children: string;
  basis: number;
  align?: "left" | "right";
  strong?: boolean;
  muted?: boolean;
}) {
  const colors = usePalette();
  return (
    <Text
      numberOfLines={2}
      style={{
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: basis,
        minWidth: 0,
        textAlign: align,
        fontSize: 13,
        fontWeight: strong ? "700" : "500",
        fontVariant: ["tabular-nums"],
        color: muted ? colors.inkFaint : colors.ink,
      }}
    >
      {children}
    </Text>
  );
}

export function SubsystemTable({
  state,
  selected,
  onSelect,
}: {
  state: ReviewState<ReplayCompare>;
  selected: SubsystemCode;
  onSelect: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.timeMachine.compare;

  const header = (
    <PanelHeader
      icon={<LayersIcon size={18} color={colors.inkMuted} />}
      title={text.title}
      subtitle={text.subtitle}
    />
  );
  if (state.status !== "read") {
    return (
      <Panel style={{ gap: space.md }}>
        {header}
        <Text style={{ fontSize: 13, color: colors.inkMuted }}>
          {state.status === "refused"
            ? copy.error[state.code]
            : copy.app.timeMachine.refreshing}
        </Text>
      </Panel>
    );
  }

  const compare = state.value;
  const national = compare.national;

  return (
    <Panel style={{ gap: space.sm, opacity: state.refreshing ? 0.7 : 1 }}>
      {header}
      <View
        style={{
          flexDirection: "row",
          gap: space.sm,
          paddingHorizontal: space.sm,
          paddingTop: space.sm,
        }}
      >
        {[
          [text.columns.subsystem, 70, "left"],
          [text.columns.p50, 70, "right"],
          [text.columns.settled, 70, "right"],
          [text.columns.deviation, 70, "right"],
          [text.columns.placement, 100, "left"],
        ].map(([label, basis, align]) => (
          <Text
            key={label as string}
            style={{
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: basis as number,
              minWidth: 0,
              textAlign: align as "left" | "right",
              fontSize: 11,
              fontWeight: "600",
              color: colors.inkMuted,
            }}
          >
            {label as string}
          </Text>
        ))}
      </View>
      {compare.subsystems.map((row) => {
        const active = row.subsystem === selected;
        const pressable = row.replayable && !active;
        return (
          <Pressable
            key={row.subsystem}
            accessibilityRole="button"
            aria-pressed={active}
            accessibilityLabel={subsystemMeta(row.subsystem).onsDisplayName}
            disabled={!pressable}
            onPress={() => onSelect(row.subsystem)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: space.sm,
              paddingVertical: 10,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: active ? colors.accent : "transparent",
              backgroundColor: active ? colors.accentSoft : "transparent",
              ...(Platform.OS === "web" && pressable
                ? ({ cursor: "pointer" } as object)
                : null),
            }}
          >
            <Cell basis={70} strong={true}>
              {subsystemMeta(row.subsystem).short}
            </Cell>
            <Cell basis={70} align="right" muted={row.dayTotal === null}>
              {row.dayTotal === null ? text.bandAbsent : mwh(row.dayTotal.p50, f)}
            </Cell>
            <Cell basis={70} align="right" muted={row.settledTotalMwh === null}>
              {row.settledTotalMwh === null
                ? text.settledAbsent
                : mwh(row.settledTotalMwh, f)}
            </Cell>
            <Cell basis={70} align="right" muted={row.deviationMwh === null}>
              {row.deviationMwh === null ? "" : signedMwh(row.deviationMwh, f)}
            </Cell>
            <View
              style={{ flexGrow: 1, flexShrink: 1, flexBasis: 100, minWidth: 0, gap: 4 }}
            >
              {row.dayTotal === null ? null : (
                <PlacementStrip band={row.dayTotal} settled={row.settledTotalMwh} />
              )}
              <Text numberOfLines={1} style={{ fontSize: 11, color: colors.inkMuted }}>
                {row.placement === null
                  ? row.dayTotal === null
                    ? (copy.error[
                        row.dayTotalUnavailableReason as keyof typeof copy.error
                      ] ?? "")
                    : text.settledAbsent
                  : text.placement[row.placement]}
              </Text>
            </View>
          </Pressable>
        );
      })}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.sm,
          paddingVertical: 10,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <Cell basis={70} strong={true}>
          {text.national}
        </Cell>
        <Cell basis={70} align="right" muted={national.dayTotal === null}>
          {national.dayTotal === null ? text.bandAbsent : mwh(national.dayTotal.p50, f)}
        </Cell>
        <Cell basis={70} align="right" muted={national.settledTotalMwh === null}>
          {national.settledTotalMwh === null
            ? text.settledAbsent
            : mwh(national.settledTotalMwh, f)}
        </Cell>
        <Cell basis={70} align="right" muted={national.deviationMwh === null}>
          {national.deviationMwh === null ? "" : signedMwh(national.deviationMwh, f)}
        </Cell>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 100, minWidth: 0, gap: 4 }}>
          {national.dayTotal === null ? null : (
            <PlacementStrip band={national.dayTotal} settled={national.settledTotalMwh} />
          )}
          <Text style={{ fontSize: 11, lineHeight: 15, color: colors.inkMuted }}>
            {national.placement === null
              ? national.dayTotalUnavailableReason === null
                ? text.settledAbsent
                : text.nationalAbsent[national.dayTotalUnavailableReason]
              : text.placement[national.placement]}
          </Text>
        </View>
      </View>
      <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
        {text.nationalSettledNote}
      </Text>
      <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
        {text.note}
      </Text>
    </Panel>
  );
}
