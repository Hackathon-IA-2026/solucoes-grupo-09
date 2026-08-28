import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform } from "react-native";
import { type Copy, en } from "./copy.en";
import { pt } from "./copy.pt";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  LOCALES,
  type Locale,
  languageTag,
} from "./locale";

/**
 * Locale state for the app.
 *
 * **Portuguese is the default**, and that is a product decision rather than a
 * fallback: the audience is Brazilian grid operators and renewable IPPs, and
 * the data is ONS's. English is the second locale, not the source one.
 *
 * **Known divergence from `docs/specs/i18n.md`.** That spec settles on
 * locale-prefixed routes (`/pt/…`, `/en/…`) so both languages are crawlable.
 * This is a client-side switch, which means the static export contains
 * Portuguese only and the English copy is invisible to a crawler. That is the
 * exact trade the spec warned about, taken deliberately to get a working
 * toggle now. The switch is the visible half of the feature and does not
 * change when routing does — the routes are what would need building, not the
 * dictionaries or the components.
 */

export type { Locale };
export { DEFAULT_LOCALE, LOCALES, languageTag };

const dictionaries: Record<Locale, Copy> = { pt, en };

/**
 * Read the stored locale without ever throwing.
 *
 * With cookies and site data blocked, Chrome's `window.localStorage` *getter*
 * itself throws `SecurityError` — an optional chain does not protect against
 * that, only a try/catch does.
 */
function readStoredLocale(): Locale | null {
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

function writeStoredLocale(locale: Locale): void {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage blocked — the choice simply will not survive a reload.
  }
}

/** Keep the document language honest, for screen readers and for crawlers. */
function setDocumentLang(locale: Locale): void {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    document.documentElement.lang = languageTag(locale);
  }
}

interface I18nValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  /** The copy for the active locale. */
  copy: Copy;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: PropsWithChildren) {
  // Always render the default first, then apply the stored choice after mount.
  // The static export is prerendered in Portuguese, so hydrating straight into
  // a persisted "en" tree would mismatch every text node and React would throw
  // the whole server tree away. An English visitor sees a brief Portuguese
  // flash instead of a hydration error.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const saved = readStoredLocale();
    if (saved && saved !== DEFAULT_LOCALE) {
      setLocaleState(saved);
    }
    setDocumentLang(saved ?? DEFAULT_LOCALE);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
    setDocumentLang(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, copy: dictionaries[locale] }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside an I18nProvider");
  }
  return ctx;
}

/** The copy for the active locale — what almost every component wants. */
export function useCopy(): Copy {
  return useI18n().copy;
}

export type { Copy };
export { en, pt };
