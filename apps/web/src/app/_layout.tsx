import { DarkTheme, ThemeProvider } from "expo-router";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { I18nProvider } from "@/i18n";

export default function RootLayout() {
  // The design system is dark-only (reference: color-scheme dark).
  return (
    <ThemeProvider value={DarkTheme}>
      <I18nProvider>
        <Stack screenOptions={{ headerShown: false }} />
        <StatusBar style="light" />
      </I18nProvider>
    </ThemeProvider>
  );
}
