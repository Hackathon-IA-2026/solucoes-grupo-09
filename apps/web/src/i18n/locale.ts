/**
 * Locale identity — deliberately free of React and React Native imports.
 *
 * Kept separate from the provider so the dictionaries and their invariants can
 * be tested without pulling the whole RN runtime into a unit test, and so a
 * non-React consumer (a script, a future server route) can ask what the
 * default locale is.
 */

export type Locale = "pt" | "en";

export const LOCALES: readonly Locale[] = ["pt", "en"];

/**
 * Portuguese, by decision rather than by fallback: the audience is Brazilian
 * grid operators and renewable IPPs, and the data is ONS's. English is the
 * second locale, not the source one.
 */
export const DEFAULT_LOCALE: Locale = "pt";

/** The key the browser stores the visitor's choice under. */
export const LOCALE_STORAGE_KEY = "wattsteer.locale";

/** The BCP-47 tag for a locale, for `<html lang>` and `Intl`. */
export function languageTag(locale: Locale): string {
  return locale === "pt" ? "pt-BR" : "en";
}
