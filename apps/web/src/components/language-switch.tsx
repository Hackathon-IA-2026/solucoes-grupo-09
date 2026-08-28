import { focusRing, radius, usePalette } from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { type Locale, useI18n } from "@/i18n";

const OPTIONS: { code: Locale; label: string; name: string }[] = [
  { code: "pt", label: "PT", name: "Português" },
  { code: "en", label: "EN", name: "English" },
];

/**
 * Compact segmented control that flips the locale. Portuguese is the default.
 *
 * A segmented control rather than a dropdown: there are two options, both are
 * always visible, and the current one is legible at a glance without opening
 * anything. `accessibilityRole="radio"` with `aria-checked` is the honest
 * semantic — this is a choice between mutually exclusive states, not a button.
 */
export function LanguageSwitch({ testID }: { testID?: string }) {
  const colors = usePalette();
  const { locale, setLocale } = useI18n();

  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      accessibilityLabel={locale === "pt" ? "Idioma" : "Language"}
      style={{
        flexDirection: "row",
        alignSelf: "center",
        flexShrink: 0,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 3,
        gap: 2,
      }}
    >
      {OPTIONS.map((option) => {
        const active = option.code === locale;
        return (
          <Pressable
            key={option.code}
            testID={`locale-${option.code}`}
            accessibilityRole="radio"
            aria-checked={active}
            accessibilityLabel={option.name}
            onPress={() => setLocale(option.code)}
            hitSlop={6}
            style={(state) => {
              const { focused = false, hovered = false } = state as {
                focused?: boolean;
                hovered?: boolean;
              };
              return {
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: radius.pill,
                backgroundColor: active
                  ? colors.accent
                  : hovered
                    ? colors.surfaceSunken
                    : "transparent",
                ...focusRing(focused, colors.focus),
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
              numberOfLines={1}
              style={{
                fontSize: 12,
                fontWeight: "700",
                letterSpacing: 0.3,
                color: active ? colors.onAccent : colors.inkMuted,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
