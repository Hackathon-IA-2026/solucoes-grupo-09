import { ArrowUpDownIcon, CheckIcon, radius, usePalette } from "@negotiatio/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "@/i18n";
import { SORT_OPTIONS, type SortKey } from "@/lib/offers";
import { Popover } from "./popover";

export function SortMenu({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (next: SortKey) => void;
}) {
  const colors = usePalette();
  const { t } = useI18n();

  return (
    <Popover
      align="right"
      minWidth={250}
      trigger={({ open, toggle }) => (
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          aria-expanded={open}
          accessibilityLabel={t("filter.sort")}
          style={(state) => {
            const { hovered = false, pressed = false } = state as {
              hovered?: boolean;
              pressed?: boolean;
            };
            return {
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: open ? colors.accent : colors.borderStrong,
              backgroundColor: hovered || open ? colors.surfaceSunken : colors.surface,
              paddingHorizontal: 14,
              paddingVertical: 10,
              transform: [{ scale: pressed ? 0.97 : 1 }],
              ...(Platform.OS === "web"
                ? ({
                    cursor: "pointer",
                    transitionProperty: "background-color, border-color, transform",
                    transitionDuration: "150ms",
                  } as object)
                : null),
            };
          }}
        >
          <ArrowUpDownIcon size={16} color={colors.inkMuted} />
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
            {t("filter.sort")}
          </Text>
        </Pressable>
      )}
    >
      {({ close }) => (
        <View>
          {SORT_OPTIONS.map((key) => {
            const selected = key === value;
            return (
              <Pressable
                key={key}
                accessibilityRole="menuitem"
                onPress={() => {
                  onChange(key);
                  close();
                }}
                style={(state) => {
                  const { hovered = false } = state as { hovered?: boolean };
                  return {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 9,
                    borderRadius: 10,
                    backgroundColor:
                      hovered && !selected ? colors.surfaceSunken : "transparent",
                    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                  };
                }}
              >
                <View style={{ width: 16 }}>
                  {selected ? (
                    <CheckIcon size={15} color={colors.accent} strokeWidth={3} />
                  ) : null}
                </View>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: selected ? "600" : "500",
                    color: selected ? colors.ink : colors.inkMuted,
                  }}
                >
                  {t(`sort.${key}` as const)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </Popover>
  );
}
