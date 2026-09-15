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
 * the same rule the loading screen at `/` applies to a human visitor who has
 * never chosen.
 */
export function alternatesFor(path: LocalizedPath = ""): Alternate[] {
  const entries: Alternate[] = LOCALES.map((locale) => ({
    hrefLang: languageTag(locale),
    href: pageUrl(locale, path),
  }));
  entries.push({ hrefLang: "x-default", href: pageUrl(DEFAULT_LOCALE, path) });
  return entries;
}

// `GATE_URL` used to be exported here — the bare `/` URL, for a page that is
// `noindex` and therefore never gets a canonical. Nothing ever imported it,
// and the page it named is now the loading screen, so it is gone rather than
// renamed: a constant with no reader is a claim nothing checks.
