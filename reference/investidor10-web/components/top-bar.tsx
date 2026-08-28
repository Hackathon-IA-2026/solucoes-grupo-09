import { focusRing, usePalette } from "@negotiatio/ui";
import { Image } from "expo-image";
import { Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "@/i18n";
import { LanguageSwitch } from "./language-switch";

/**
 * Results-page header: just the bolt mark, centered — the same asset, layout,
 * spacing (padding 8, 40×44 mark) and hover/press feel as the reference nav.
 * The offer count sits at the left edge and the language switch at the right.
 */
export function TopBar({ count }: { count: number }) {
  const colors = usePalette();
  const { t } = useI18n();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <View style={{ flex: 1, alignItems: "flex-start" }}>
        <Text style={{ fontSize: 13, color: colors.inkFaint }}>
          {count} {t("nav.offers")}
        </Text>
      </View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Negotiatio"
        onPress={() => {
          if (Platform.OS === "web" && typeof window !== "undefined") {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        style={(state) => {
          const { pressed } = state;
          const { hovered = false, focused = false } = state as {
            hovered?: boolean;
            focused?: boolean;
          };
          return {
            padding: 8,
            borderRadius: 12,
            transform: [{ scale: pressed ? 0.94 : hovered ? 1.06 : 1 }],
            ...focusRing(focused, colors.focus),
            ...(Platform.OS === "web"
              ? ({
                  cursor: "pointer",
                  transitionProperty: "transform",
                  transitionDuration: "150ms",
                } as object)
              : null),
          };
        }}
      >
        <Image
          source={require("../../assets/images/bolt-logo.png")}
          style={{ width: 40, height: 44 }}
          contentFit="contain"
          transition={150}
          accessibilityLabel="Negotiatio"
        />
      </Pressable>
      <View style={{ flex: 1, alignItems: "flex-end" }}>
        <LanguageSwitch />
      </View>
    </View>
  );
}
