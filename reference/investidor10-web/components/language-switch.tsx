import { radius, usePalette } from "@negotiatio/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { type Locale, useI18n } from "@/i18n";

const OPTIONS: { code: Locale; label: string }[] = [
  { code: "pt", label: "PT" },
  { code: "en", label: "EN" },
];

/** Compact segmented control that flips the app locale (PT-BR default). */
export function LanguageSwitch() {
  const colors = usePalette();
  const { locale, setLocale, t } = useI18n();

  return (
    <View
      accessibilityLabel={t("lang.label")}
      style={{
        flexDirection: "row",
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 3,
        gap: 2,
      }}
    >
      {OPTIONS.map((opt) => {
        const active = opt.code === locale;
        return (
          <Pressable
            key={opt.code}
            onPress={() => setLocale(opt.code)}
            accessibilityRole="button"
            aria-pressed={active}
            style={(state) => {
              const { hovered = false } = state as { hovered?: boolean };
              return {
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: radius.pill,
                backgroundColor: active
                  ? colors.accent
                  : hovered
                    ? colors.surfaceSunken
                    : "transparent",
                ...(Platform.OS === "web"
                  ? ({
                      cursor: "pointer",
                      transitionProperty: "background-color",
                      transitionDuration: "150ms",
                    } as object)
                  : null),
              };
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: "700",
                color: active ? colors.onAccent : colors.inkMuted,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
