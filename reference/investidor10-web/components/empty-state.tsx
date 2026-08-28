import { FadeIn, IconCircle, SearchIcon, usePalette } from "@negotiatio/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "@/i18n";

export function EmptyState({ onReset }: { onReset: () => void }) {
  const colors = usePalette();
  const { t } = useI18n();
  return (
    <FadeIn>
      <View style={{ alignItems: "center", paddingVertical: 72, gap: 12 }}>
        <IconCircle size={56}>
          <SearchIcon size={24} color={colors.inkMuted} />
        </IconCircle>
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.ink }}>
          {t("empty.title")}
        </Text>
        <Text style={{ fontSize: 14, color: colors.inkMuted, textAlign: "center" }}>
          {t("empty.body")}
        </Text>
        <Pressable
          onPress={onReset}
          style={(state) => {
            const { hovered = false } = state as { hovered?: boolean };
            return {
              marginTop: 6,
              paddingHorizontal: 18,
              paddingVertical: 10,
              borderRadius: 999,
              backgroundColor: hovered ? colors.accentStrong : colors.accent,
              ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
            };
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "700", color: colors.onAccent }}>
            {t("empty.reset")}
          </Text>
        </Pressable>
      </View>
    </FadeIn>
  );
}
