import { Redirect, useLocalSearchParams } from "expo-router";
import { Stack } from "expo-router/stack";
import { I18nProvider } from "@/i18n";
import { isLocale, LOCALES } from "@/i18n/locale";

/**
 * The locale segment: `/pt/…` and `/en/…`.
 *
 * `generateStaticParams` is what turns one source tree into two prerendered
 * ones. Declared here on the segment layout, it cascades to every route nested
 * under it, so the exporter emits `index`, `privacy` and `terms` once per
 * locale — six real HTML files rather than one Portuguese one with the English
 * copy locked inside the JS bundle.
 *
 * The param is the **single source of truth** for the locale of everything
 * below. Nothing in this subtree reads `navigator.language` or the stored
 * preference to decide what to render: the file at `/en/privacy` is English
 * because its path says so, which is the entire reason the prefix exists.
 * Browser preference is consulted in exactly one place — the gate at `/` —
 * and only to choose where to send a first-time visitor.
 */
export function generateStaticParams(): { locale: string }[] {
  return LOCALES.map((locale) => ({ locale }));
}

export default function LocaleLayout() {
  const { locale } = useLocalSearchParams<{ locale: string }>();

  // Only `pt` and `en` are ever generated, so this cannot fire in the static
  // export. It can fire on the client: the production server falls back to
  // index.html for an unknown path, which hands `/de/privacy` to the router.
  // Rendering *something* in a locale we do not have would be worse than
  // sending the visitor back to the chooser.
  if (!isLocale(locale)) {
    return <Redirect href="/" />;
  }

  return (
    <I18nProvider locale={locale}>
      <Stack screenOptions={{ headerShown: false }} />
    </I18nProvider>
  );
}
