import { radius, SearchIcon, usePalette, XIcon } from "@negotiatio/ui";
import { useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { useI18n } from "@/i18n";

export function SearchInput({
  value,
  onChange,
  /** Smallest width the field may shrink to (lower it when it shares a row). */
  minWidth = 200,
  /** Cap on how wide it grows (drop it to let the field fill a compact row). */
  maxWidth = 340,
}: {
  value: string;
  onChange: (next: string) => void;
  minWidth?: number;
  maxWidth?: number;
}) {
  const colors = usePalette();
  const { t } = useI18n();
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: focused ? colors.accent : colors.borderStrong,
        backgroundColor: colors.surface,
        paddingHorizontal: 14,
        height: 42,
        minWidth,
        flexGrow: 1,
        flexShrink: 1,
        maxWidth,
        ...(Platform.OS === "web"
          ? ({
              transitionProperty: "border-color",
              transitionDuration: "150ms",
            } as object)
          : null),
      }}
    >
      <SearchIcon size={16} color={focused ? colors.accent : colors.inkMuted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={t("filter.search")}
        placeholderTextColor={colors.inkFaint}
        style={[
          {
            flex: 1,
            fontSize: 14,
            color: colors.ink,
            paddingVertical: 8,
          },
          Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null,
        ]}
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => onChange("")}
          accessibilityLabel="Clear"
          hitSlop={8}
          style={Platform.OS === "web" ? ({ cursor: "pointer" } as object) : undefined}
        >
          <XIcon size={15} color={colors.inkMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}
