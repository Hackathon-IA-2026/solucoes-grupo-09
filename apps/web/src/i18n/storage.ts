/**
 * The reader's locale, as the browser remembers it.
 *
 * A module of its own so `i18n/index.tsx` exports only components and hooks.
 * That is a Fast Refresh rule — a file mixing components with plain exports
 * cannot be hot-replaced, so every edit to the copy dictionaries reloaded the
 * whole app — but it is also the right shape regardless: nothing here is React.
 * It is two functions over `localStorage` and one key, and it is the only place
 * in the app that touches either.
 */

import { Platform } from "react-native";
import { LOCALE_STORAGE_KEY, type Locale } from "@/i18n/locale";

/**
 * Read the stored locale without ever throwing.
 *
 * With cookies and site data blocked, Chrome's `window.localStorage` *getter*
 * itself throws `SecurityError` — an optional chain does not protect against
 * that, only a try/catch does.
 */
export function readStoredLocale(): Locale | null {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return null;
  }
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return saved === "pt" || saved === "en" ? saved : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage blocked — the choice simply will not survive a reload.
    // Same getter, same throw. A reader who blocks site data gets the default
    // locale on their next visit, which is a preference not kept rather than a
    // page that does not load.
  }
}
