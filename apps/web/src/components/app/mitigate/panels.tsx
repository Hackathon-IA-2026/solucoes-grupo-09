/**
 * The Mitigate screen's panels, split from the screen that arranges them.
 *
 * `MitigateScreen` was 390 lines inside one function — over the threshold at
 * which a component stops being readable, and for the reason the Overview hit
 * the same wall: the file was the *route* and the *panels* at once. The route
 * keeps what it decides — which of the four states to draw, and the refusal
 * copy for each — and the panels that draw a solved plan live here.
 *
 * Every one of them takes a `MitigationStep` and nothing it could derive from
 * one: the step *is* the answer the solver returned, and a panel recomputing
 * any part of it would be a second implementation of the execution rule.
 * `test/one-execution-rule.test.ts` walks the repository to keep there being
 * exactly one, and it is in `apps/ml`.
 */

import type { Scenario } from "@wattsteer/core/api";
import {
  LayersIcon,
  Panel,
  PanelHeader,
  SlidersHorizontalIcon,
  space,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { BatteryEditor, LoadEditor } from "@/components/app/asset-editor";
import { withBattery, withLoad } from "@/components/app/scenario";
import { BandStrip } from "@/components/charts/band-figure";
import { DispatchChart } from "@/components/charts/dispatch-chart";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import type { BatteryAsset, MitigationStep, ShiftableLoadAsset } from "@/lib/fixtures";

/**
 * The promise: the floor in prose, the band beside it.
 *
 * (That line was the JSX comment above this block in `mitigate.tsx`; it moved
 * up into the docstring rather than being replaced by one.)
 *
 * The floor is the large figure and the band is secondary, deliberately — a
 * `p50` set at the same size would read as two competing answers to one
 * question. `domainMax` comes from the *baseline* step so every band on this
 * screen shares one scale: a narrower band has to look narrower.
 */
export function FloorPanel({
  active,
  domainMax,
}: {
  active: MitigationStep;
  /** The shared scale, from the baseline step's `p90`. */
  domainMax: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <Panel>
      <PanelHeader
        icon={<LayersIcon size={18} color={colors.inkMuted} />}
        title={copy.app.mitigate.floorTitle}
        subtitle={copy.app.mitigate.floorLabel}
      />
      <View
        style={{
          marginTop: space.lg,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: space.xl,
        }}
      >
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 320, gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text
              selectable={true}
              style={{
                fontSize: 52,
                lineHeight: 58,
                fontWeight: "600",
                letterSpacing: -1.2,
                fontVariant: ["tabular-nums"],
                color: colors.accent,
              }}
            >
              {f.compact(active.recoveredFloorMwh)}
            </Text>
            <Text style={{ fontSize: 16, fontWeight: "500", color: colors.inkMuted }}>
              MWh
            </Text>
          </View>
          <Text style={{ fontSize: 13, lineHeight: 21, color: colors.inkMuted }}>
            {fill(copy.app.mitigate.floorSentence, {
              floor: f.compact(active.recoveredFloorMwh),
            })}
          </Text>
        </View>

        {/*
        Beside the floor, never in front of it: two secondary figures at
        a fraction of the type size, with the band they belong to drawn
        under them on the shared scale.
      */}
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 260, gap: space.md }}>
          <Beside
            label={copy.app.mitigate.floorMedian}
            value={`${f.compact(active.recovered.p50)} MWh`}
          />
          <Beside
            label={copy.app.mitigate.floorHigh}
            value={`${f.compact(active.recovered.p90)} MWh`}
          />
          <BandStrip band={active.recovered} domainMax={domainMax} />
          <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
            {copy.app.mitigate.floorBesideNote}
          </Text>
        </View>
      </View>
    </Panel>
  );
}

/**
 * "Recovered" is not "delivered", and the two numbers that say so.
 *
 * (The screen's JSX comment for this block, kept as written.)
 */
export function DeliveredPanel({ active }: { active: MitigationStep }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <Panel>
      <PanelHeader
        icon={<ZapIcon size={18} color={colors.inkMuted} />}
        title={copy.app.mitigate.deliveredTitle}
        subtitle={copy.app.mitigate.deliveredSubtitle}
      />
      <View
        style={{
          marginTop: space.lg,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: space.xl,
        }}
      >
        <Scalar
          label={copy.app.mitigate.storedLabel}
          value={`${f.compact(active.storedAtHorizonEndMwh)} MWh`}
        />
        <Scalar
          label={copy.app.mitigate.lossLabel}
          value={`${f.compact(active.roundTripLossMwh)} MWh`}
        />
      </View>
      <Text
        style={{
          marginTop: space.md,
          fontSize: 11,
          lineHeight: 18,
          color: colors.inkFaint,
        }}
      >
        {copy.app.mitigate.deliveredNote}
      </Text>
    </Panel>
  );
}

/** The hour-by-hour plan, on the planning envelope. */
export function DispatchPanel({
  active,
  battery,
}: {
  active: MitigationStep;
  battery: BatteryAsset;
}) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <Panel>
      <PanelHeader
        icon={<ZapIcon size={18} color={colors.inkMuted} />}
        title={copy.app.mitigate.dispatchTitle}
        subtitle={fill(copy.app.mitigate.dispatchSubtitle, {
          step: copy.app.mitigate.steps[active.key],
        })}
      />
      <View style={{ marginTop: space.lg }}>
        <DispatchChart
          dispatch={active.dispatch}
          energyCapacityMwh={battery.energyCapacityMwh}
        />
      </View>
      <Text
        style={{
          marginTop: space.md,
          fontSize: 11,
          lineHeight: 18,
          color: colors.inkFaint,
        }}
      >
        {copy.app.mitigate.dispatchScheduled}
      </Text>
    </Panel>
  );
}

/**
 * The two fleets, editable.
 *
 * `update` writes the whole scenario rather than a field: the codec is the only
 * encoder (`use-scenario.ts`), and an editor writing a fragment would be a
 * second place that knows the wire shape.
 */
export function FleetEditors({
  scenario,
  battery,
  load,
  update,
}: {
  /** The scenario the edits are applied to — the transforms need the whole. */
  scenario: Scenario;
  battery: BatteryAsset;
  load: ShiftableLoadAsset;
  update: (next: Scenario) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
      <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380 }}>
        <PanelHeader
          icon={<ZapIcon size={18} color={colors.inkMuted} />}
          title={copy.app.mitigate.batteryTitle}
          subtitle={copy.app.mitigate.assetSubtitle}
        />
        <View style={{ marginTop: space.lg }}>
          <BatteryEditor
            battery={battery}
            onChange={(next) => update(withBattery(scenario, next))}
          />
        </View>
      </Panel>
      <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380 }}>
        <PanelHeader
          icon={<SlidersHorizontalIcon size={18} color={colors.inkMuted} />}
          title={copy.app.mitigate.loadTitle}
          subtitle={copy.app.mitigate.assetSubtitle}
        />
        <View style={{ marginTop: space.lg }}>
          <LoadEditor load={load} onChange={(next) => update(withLoad(scenario, next))} />
        </View>
      </Panel>
    </View>
  );
}

/** A small figure that sits beside a headline without competing with it. */
export function Beside({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Text style={{ fontSize: 12, color: colors.inkMuted, flexShrink: 1 }}>{label}</Text>
      <Text
        style={{
          fontSize: 18,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          color: colors.ink,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/** A labelled scalar, for the two numbers that make "recovered" honest. */
export function Scalar({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 220, gap: 4 }}>
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>{label}</Text>
      <Text
        style={{
          fontSize: 26,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          color: colors.ink,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
