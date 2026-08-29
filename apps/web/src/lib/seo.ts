import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type LocalizedPath,
  languageTag,
  localePath,
} from "@/i18n/locale";
import { SITE_URL } from "./config";

/**
 * The absolute URL of a page in a locale — the one form that `sitemap.xml`,
 * `<link rel="canonical">` and every `hreflang` alternate must agree on.
 * Disagreement between a page's canonical and the sitemap's idea of it is the
 * usual reason hreflang gets silently ignored.
 */
export function pageUrl(locale: Locale, path: LocalizedPath = ""): string {
  return `${SITE_URL}${localePath(locale, path)}`;
}

export interface Alternate {
  hrefLang: string;
  href: string;
}

/**
 * The full alternate set for a page: one entry per locale plus `x-default`.
 *
 * `x-default` points at Portuguese. Brazil is the primary market, so a crawler
 * or user-agent that expresses no preference gets pt-BR rather than English —
 * the same rule the gate page applies to a first-time human visitor.
 */
export function alternatesFor(path: LocalizedPath = ""): Alternate[] {
  const entries: Alternate[] = LOCALES.map((locale) => ({
    hrefLang: languageTag(locale),
    href: pageUrl(locale, path),
  }));
  entries.push({ hrefLang: "x-default", href: pageUrl(DEFAULT_LOCALE, path) });
  return entries;
}

/** The gate page's own URL. It is `noindex`, so it never gets a canonical. */
export const GATE_URL = `${SITE_URL}/`;
