/**
 * Editable `FlexibilityAsset` parameters for Mitigate.
 *
 * These are **scenario inputs, not an inventory** — ONS publishes no
 * flexibility-asset registry, so every number here is the user's assumption
 * and the screen says so. The editor is a stepper rather than a slider on
 * purpose: the same code ships to iOS and Android, React Native has no
 * built-in slider, and a stepper gives exact, repeatable values (a demo where
 * the presenter cannot get back to "100 MW / 300 MWh" is a bad demo).
 * `reference/investidor10-web/components/amount-slider.tsx` exists and would
 * port, but a slider's affordance is "explore a continuum" and these are
 * quantities people quote.
 */

import { focusRing, radius, space, usePalette } from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { ASSET_LIMITS, type BatteryAsset, type ShiftableLoadAsset } from "@/lib/fixtures";

interface Limit {
  min: number;
  max: number;
  step: number;
}

function round(value: number, step: number): number {
  const decimals = step < 1 ? 2 : 0;
  return Number(value.toFixed(decimals));
}

export function Stepper({
  label,
  value,
  limit,
  format,
  onChange,
}: {
  label: string;
  value: number;
  limit: Limit;
  format: (value: number) => string;
  onChange: (next: number) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const set = (next: number) => {
    onChange(round(Math.max(limit.min, Math.min(limit.max, next)), limit.step));
  };
  return (
    <View style={{ flexGrow: 1, flexBasis: 180, gap: 6 }}>
      <Text style={{ fontSize: 11, color: colors.inkFaint }}>{label}</Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surfaceSunken,
          paddingHorizontal: 6,
          paddingVertical: 4,
        }}
      >
        <StepButton
          label={fill(copy.app.assets.decrease, { label })}
          glyph="−"
          disabled={value <= limit.min}
          onPress={() => set(value - limit.step)}
        />
        <Text
          style={{
            fontSize: 15,
            fontWeight: "700",
            fontVariant: ["tabular-nums"],
            color: colors.ink,
          }}
        >
          {format(value)}
        </Text>
        <StepButton
          label={fill(copy.app.assets.increase, { label })}
          glyph="+"
          disabled={value >= limit.max}
          onPress={() => set(value + limit.step)}
        />
      </View>
    </View>
  );
}

function StepButton({
  label,
  glyph,
  disabled,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={(state) => {
        const { pressed } = state;
        const { focused = false } = state as { focused?: boolean };
        return {
          width: 30,
          height: 30,
          borderRadius: 15,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
          opacity: disabled ? 0.35 : pressed ? 0.7 : 1,
          ...focusRing(focused, colors.focus, 1),
          ...(Platform.OS === "web" && !disabled
            ? ({ cursor: "pointer" } as object)
            : null),
        };
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: "700", color: colors.ink }}>{glyph}</Text>
    </Pressable>
  );
}

export function BatteryEditor({
  battery,
  onChange,
}: {
  battery: BatteryAsset;
  onChange: (next: BatteryAsset) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const duration =
    battery.maxPowerMw > 0 ? battery.energyCapacityMwh / battery.maxPowerMw : 0;
  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Stepper
          label={copy.app.assets.batteryPower}
          value={battery.maxPowerMw}
          limit={ASSET_LIMITS.batteryPowerMw}
          format={(v) => `${f.number(v)} MW`}
          onChange={(maxPowerMw) => onChange({ ...battery, maxPowerMw })}
        />
        <Stepper
          label={copy.app.assets.batteryEnergy}
          value={battery.energyCapacityMwh}
          limit={ASSET_LIMITS.batteryEnergyMwh}
          format={(v) => `${f.number(v)} MWh`}
          onChange={(energyCapacityMwh) => onChange({ ...battery, energyCapacityMwh })}
        />
        <Stepper
          label={copy.app.assets.roundTrip}
          value={battery.roundTripEfficiency}
          limit={ASSET_LIMITS.roundTripEfficiency}
          format={(v) => f.percent(v)}
          onChange={(roundTripEfficiency) =>
            onChange({ ...battery, roundTripEfficiency })
          }
        />
        <Stepper
          label={copy.app.assets.initialSoc}
          value={battery.initialStateOfCharge}
          limit={ASSET_LIMITS.initialStateOfCharge}
          format={(v) => f.percent(v)}
          onChange={(initialStateOfCharge) =>
            onChange({ ...battery, initialStateOfCharge })
          }
        />
      </View>
      <Text style={{ fontSize: 11, color: colors.inkFaint }}>
        {fill(copy.app.assets.batteryNote, { hours: f.number(duration, 1) })}
      </Text>
    </View>
  );
}

export function LoadEditor({
  load,
  onChange,
}: {
  load: ShiftableLoadAsset;
  onChange: (next: ShiftableLoadAsset) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Stepper
          label={copy.app.assets.loadConnection}
          value={load.maxPowerMw}
          limit={ASSET_LIMITS.loadConnectionMw}
          format={(v) => `${f.number(v)} MW`}
          onChange={(maxPowerMw) => onChange({ ...load, maxPowerMw })}
        />
        <Stepper
          label={copy.app.assets.loadShift}
          value={load.maxShiftMw}
          limit={ASSET_LIMITS.loadShiftMw}
          format={(v) => `${f.number(v)} MW`}
          onChange={(maxShiftMw) => onChange({ ...load, maxShiftMw })}
        />
        <Stepper
          label={copy.app.assets.loadWindow}
          value={load.shiftWindowHours}
          limit={ASSET_LIMITS.shiftWindowHours}
          format={(v) => `±${f.number(v)} h`}
          onChange={(shiftWindowHours) => onChange({ ...load, shiftWindowHours })}
        />
        <Stepper
          label={copy.app.assets.loadDailyEnergy}
          value={load.dailyEnergyMwh}
          limit={ASSET_LIMITS.loadDailyEnergyMwh}
          format={(v) => `${f.number(v)} MWh`}
          onChange={(dailyEnergyMwh) => onChange({ ...load, dailyEnergyMwh })}
        />
      </View>
      <Text style={{ fontSize: 11, color: colors.inkFaint }}>
        {copy.app.assets.loadNote}
      </Text>
    </View>
  );
}
