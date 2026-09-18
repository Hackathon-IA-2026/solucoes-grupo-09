import { space, usePalette } from "@wattsteer/ui";
import { Link } from "expo-router";
import { Platform, Text, View } from "react-native";
import { useI18n } from "@/i18n";
import { DEFAULT_LOCALE, localePath } from "@/i18n/locale";

/**
 * The regulatory basis, stated where every page ends.
 *
 * A specialist review (Relatório de Conformidade, 15/09/2026, NC-01/AC-01)
 * found the product *practising* REN ANEEL 1.030 and NT DOP 0022 — ONS's
 * reason is shown as published, and Mitigate refuses a plan outside category IV
 * — without ever *saying* so. One sentence here and the page it links to are
 * the whole fix; nothing about what the screens compute changes.
 *
 * One component for both chromes, the site footer and the app shell, so the
 * two cannot state the basis differently.
 */
export function RegulatoryNote() {
  const { copy, routeLocale } = useI18n();
  const colors = usePalette();
  return (
    <View testID="regulatory-note" style={{ gap: space.xs }}>
      <Text style={{ fontSize: 12, lineHeight: 18, color: colors.inkFaint }}>
        {copy.regulatory.note}
      </Text>
      {/* The app lives outside the locale tree, so it links to the default
          locale's copy, as the footer's legal links already do. */}
      <Link
        href={localePath(routeLocale ?? DEFAULT_LOCALE, "/references") as never}
        testID="regulatory-note-link"
        style={{
          fontSize: 12,
          lineHeight: 18,
          color: colors.inkMuted,
          textDecorationLine: "underline",
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        }}
      >
        {copy.regulatory.link}
      </Link>
    </View>
  );
}
