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
import { type Formatters, formattersFor } from "./format";
import { DEFAULT_LOCALE, type Locale, languageTag } from "./locale";
import { readStoredLocale, writeStoredLocale } from "./storage";

/**
 * Locale state for the app.
 *
 * **Portuguese is the default**, and that is a product decision rather than a
 * fallback: the audience is Brazilian grid operators and renewable IPPs, and
 * the data is ONS's. English is the second locale, not the source one.
 *
 * The provider has two modes, and the difference is the whole point of
 * `docs/specs/i18n.md`:
 *
 * - **Route-driven** (`<I18nProvider locale={…}>`), used by
 *   `app/[locale]/_layout.tsx`. The URL is the single source of truth. The
 *   browser is never consulted, nothing is read back out of storage to decide
 *   what to render, and there is therefore nothing for hydration to disagree
 *   with: the static file at `/en/privacy` is English because its path says
 *   so. The language switch under this provider is a *link*, not a toggle.
 * - **Client-driven** (no `locale` prop), used by the root layout for the
 *   routes that are not locale-prefixed — `/app`, which is `noindex` and has
 *   no SEO stake in its URL. There the stored preference still drives a
 *   state toggle, exactly as before.
 *
 * Browser/device language is read in exactly one place in the product: the
 * loading screen at `/`, to decide where to send a visitor who has never
 * chosen. A visitor who *has* chosen is sent by `LOCALE_STORAGE_KEY`, which is
 * read first — the language switch writes it on every switch, and that is the
 * whole of how a choice persists.
 */

export type { Locale } from "./locale";
export { DEFAULT_LOCALE, LOCALES, languageTag } from "./locale";
/*
  Re-exported, not moved away from: `readStoredLocale` was part of this
  module's public surface and `app/index.tsx` reads it. The definition moved
  to `i18n/storage.ts` so this file exports only components and hooks — a file
  that mixes the two cannot be hot-replaced, and every copy edit was reloading
  the whole app. A re-export costs nothing and keeps one import path.
*/
export { readStoredLocale, writeStoredLocale } from "./storage";

const dictionaries: Record<Locale, Copy> = { pt, en };

/** Keep the document language honest, for screen readers and for crawlers. */
function setDocumentLang(locale: Locale): void {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    document.documentElement.lang = languageTag(locale);
  }
}

/**
 * How many route-driven providers are currently mounted.
 *
 * The root layout's client-driven provider *wraps* the `[locale]` subtree, so
 * on a locale page both providers exist and both would otherwise want to set
 * `<html lang>`. React runs child effects before parent effects, so by the
 * time the outer provider's effect fires this counter already says a route
 * owns the attribute, and the outer one stands down. Without this the stored
 * preference would silently overwrite the URL's own locale on `/en/…`.
 */
let routeOwnedLangs = 0;

interface I18nValue {
  locale: Locale;
  /**
   * The locale the *URL* asserts, or `null` on a route that is not
   * locale-prefixed. Components use this to decide whether switching language
   * means navigating or setting state — never to decide what to render.
   */
  routeLocale: Locale | null;
  /** Only meaningful when `routeLocale` is `null`. */
  setLocale: (next: Locale) => void;
  /** The copy for the active locale. */
  copy: Copy;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale: routeLocale,
  children,
}: PropsWithChildren<{ locale?: Locale }>) {
  return routeLocale ? (
    <RouteI18nProvider locale={routeLocale}>{children}</RouteI18nProvider>
  ) : (
    <ClientI18nProvider>{children}</ClientI18nProvider>
  );
}

/** The URL decides, start to finish. No state, no storage read, no detection. */
function RouteI18nProvider({ locale, children }: PropsWithChildren<{ locale: Locale }>) {
  useEffect(() => {
    routeOwnedLangs += 1;
    setDocumentLang(locale);
    return () => {
      routeOwnedLangs -= 1;
    };
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      routeLocale: locale,
      // Switching under a route-driven provider is a navigation, which the
      // language switch performs itself; this exists only so the context
      // shape is uniform.
      setLocale: writeStoredLocale,
      copy: dictionaries[locale],
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** For the routes with no locale in their URL (`/app`). */
function ClientI18nProvider({ children }: PropsWithChildren) {
  // Always render the default first, then apply the stored choice after mount:
  // hydrating straight into a persisted "en" tree would mismatch every text
  // node of a page prerendered in Portuguese.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const saved = readStoredLocale();
    if (saved && saved !== DEFAULT_LOCALE) {
      // `localStorage` after mount — the same browser-API case the rule says
      // to suppress, and the same hydration rule `use-app-params.ts` spends
      // seventy lines on: the first client render has to agree with the
      // export, which knows nothing about this reader.
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
      setLocaleState(saved);
    }
    if (routeOwnedLangs === 0) {
      setDocumentLang(saved ?? DEFAULT_LOCALE);
    }
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
    if (routeOwnedLangs === 0) {
      setDocumentLang(next);
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, routeLocale: null, setLocale, copy: dictionaries[locale] }),
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

export type { Formatters } from "./format";

/**
 * The value formatters, bound to the active locale.
 *
 * The `/app` screens render numbers, money and timestamps on every panel, and
 * threading `locale` through each call site is exactly how one of them ends up
 * formatted in the wrong convention. `useFormat()` hands back `./format`'s
 * `formattersFor` with the locale already applied, so a component cannot
 * format against a locale it is not rendering in — and the deterministic
 * narration, which is not a component, binds the same locale the same way.
 *
 * The two things that do **not** vary are baked in there rather than here:
 * currency is always BRL and every timestamp is `America/Sao_Paulo`.
 */
export function useFormat(): Formatters {
  const { locale } = useI18n();
  return useMemo<Formatters>(() => formattersFor(locale), [locale]);
}

export type { Copy } from "./copy.en";
export { en } from "./copy.en";
export { pt } from "./copy.pt";
export { GRID_TIME_ZONE, GRID_TIME_ZONE_LABEL } from "./format";
