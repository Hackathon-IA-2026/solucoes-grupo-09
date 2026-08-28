import { CheckIcon, ChevronDownIcon, radius, usePalette } from "@negotiatio/ui";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from "react-native-reanimated";
import type { FacetOption } from "@/lib/offers";
import { Popover } from "./popover";

/** A rotating chevron driven by the open state. */
function Chevron({ open, color }: { open: boolean; color: string }) {
  const rot = useDerivedValue(() => withTiming(open ? 180 : 0, { duration: 160 }));
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <ChevronDownIcon size={16} color={color} />
    </Animated.View>
  );
}

/** One selectable row with a checkbox that pops when checked. */
function OptionRow({
  label,
  count,
  checked,
  onPress,
}: {
  label: string;
  count?: number;
  checked: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      aria-checked={checked}
      style={(state) => {
        const { hovered = false, pressed = false } = state as {
          hovered?: boolean;
          pressed?: boolean;
        };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 10,
          paddingVertical: 9,
          borderRadius: 10,
          borderCurve: "continuous",
          backgroundColor: hovered || pressed ? colors.surfaceSunken : "transparent",
          ...(Platform.OS === "web"
            ? ({
                cursor: "pointer",
                transitionProperty: "background-color",
                transitionDuration: "120ms",
              } as object)
            : null),
        };
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 6,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          borderWidth: checked ? 0 : 1.5,
          borderColor: colors.borderStrong,
          backgroundColor: checked ? colors.accent : "transparent",
        }}
      >
        {checked ? <CheckIcon size={13} color={colors.onAccent} strokeWidth={3} /> : null}
      </View>
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          fontSize: 14,
          fontWeight: checked ? "600" : "500",
          color: checked ? colors.ink : colors.inkMuted,
        }}
      >
        {label}
      </Text>
      {count != null ? (
        <Text style={{ fontSize: 12, color: colors.inkFaint }}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

export function FilterDropdown({
  label,
  icon,
  options,
  selected,
  onToggle,
  onClear,
  renderLabel,
  clearLabel,
}: {
  label: string;
  icon?: ReactNode;
  options: FacetOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  /** Map a raw value to its display label (enum/term translation). */
  renderLabel?: (value: string) => string;
  clearLabel: string;
}) {
  const colors = usePalette();
  const active = selected.length > 0;

  return (
    <Popover
      minWidth={240}
      trigger={({ open, toggle }) => (
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          aria-expanded={open}
          accessibilityLabel={label}
          style={(state) => {
            const {
              hovered = false,
              pressed = false,
              focused = false,
            } = state as {
              hovered?: boolean;
              pressed?: boolean;
              focused?: boolean;
            };
            return {
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: active || open ? colors.accent : colors.borderStrong,
              backgroundColor: active
                ? colors.accentSoft
                : hovered || open
                  ? colors.surfaceSunken
                  : colors.surface,
              paddingLeft: icon ? 12 : 16,
              paddingRight: 12,
              paddingVertical: 10,
              transform: [{ scale: pressed ? 0.97 : 1 }],
              ...(Platform.OS === "web"
                ? ({
                    cursor: "pointer",
                    outlineStyle: focused ? "solid" : "none",
                    outlineWidth: 2,
                    outlineColor: colors.focus,
                    outlineOffset: 2,
                    transitionProperty: "background-color, border-color, transform",
                    transitionDuration: "150ms",
                  } as object)
                : null),
            };
          }}
        >
          {icon}
          <Text
            style={{
              fontSize: 14,
              fontWeight: "600",
              color: active ? colors.onAccentSoft : colors.ink,
            }}
          >
            {label}
          </Text>
          {active ? (
            <View
              style={{
                minWidth: 18,
                height: 18,
                paddingHorizontal: 5,
                borderRadius: 999,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "700", color: colors.onAccent }}>
                {selected.length}
              </Text>
            </View>
          ) : null}
          <Chevron open={open} color={active ? colors.onAccentSoft : colors.inkMuted} />
        </Pressable>
      )}
    >
      {() => (
        <View style={{ maxWidth: 320 }}>
          <ScrollView
            style={{ maxHeight: 300 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {options.map((opt) => (
              <OptionRow
                key={opt.value}
                label={renderLabel ? renderLabel(opt.value) : opt.value}
                count={opt.count}
                checked={selected.includes(opt.value)}
                onPress={() => onToggle(opt.value)}
              />
            ))}
          </ScrollView>
          {active ? (
            <Pressable
              onPress={onClear}
              style={(state) => {
                const { hovered = false } = state as { hovered?: boolean };
                return {
                  marginTop: 4,
                  paddingVertical: 9,
                  borderRadius: 10,
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                  alignItems: "center",
                  backgroundColor: hovered ? colors.surfaceSunken : "transparent",
                  ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                };
              }}
            >
              <Text
                style={{ fontSize: 13, fontWeight: "600", color: colors.onDangerSoft }}
              >
                {clearLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </Popover>
  );
}
