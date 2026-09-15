import { DarkTheme, ThemeProvider } from "expo-router";
import { Stack } from "expo-router/stack";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform } from "react-native";
import { I18nProvider } from "@/i18n";

/**
 * Hold the native splash until React has a frame to hand over to.
 *
 * `app.json` already configures `expo-splash-screen` (the mark on #131316),
 * but nothing ever claimed it, so the OS hid it the moment the JS bundle
 * loaded and the first frame landed on whatever was ready — which on `/` is a
 * screen that is itself about to navigate. Claiming it here means the handover
 * is splash → `app/index.tsx`'s loading screen → the landing page, in the same
 * colours, with no white frame between any two of them.
 *
 * **Web is deliberately excluded, and that is the one deviation from the
 * reference implementation this was modelled on.** That one holds the whole
 * app behind an `isAppReady` flag that starts `false`, so its first rendered
 * output is the splash. This site is statically exported and its entire SEO
 * argument is that `dist/pt/index.html` contains the landing page's text: a
 * root layout that renders a splash until an effect fires would put a spinner
 * in all six prerendered files and hide the copy from every crawler that does
 * not run scripts. So on web the loading screen is a *route* — `/`, the one
 * place that genuinely has something to resolve — and never a gate in front of
 * pages that are already complete in their HTML.
 *
 * There are no custom fonts to wait on (`useFonts` appears nowhere in this
 * app; the reference waits on Satoshi), so there is nothing to await here and
 * an added minimum display time would be delay for its own sake.
 */
if (Platform.OS !== "web") {
  void SplashScreen.preventAutoHideAsync();
  SplashScreen.setOptions({ duration: 250, fade: true });
}

export default function RootLayout() {
  useEffect(() => {
    if (Platform.OS !== "web") {
      // Errors are swallowed on purpose: a splash that fails to hide is a
      // stuck app, and every failure mode of `hideAsync` (already hidden, no
      // splash claimed) is harmless.
      void SplashScreen.hideAsync().catch(() => {});
    }
  }, []);

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
