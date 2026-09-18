/**
 * Locale identity — deliberately free of React and React Native imports.
 *
 * Kept separate from the provider so the dictionaries and their invariants can
 * be tested without pulling the whole RN runtime into a unit test, and so a
 * non-React consumer (the post-export script, the static server, a future
 * server route) can ask what the default locale is.
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

/** Endonyms — a language chooser names each language *in* that language. */
export const LOCALE_NAME: Record<Locale, string> = {
  pt: "Português (Brasil)",
  en: "English",
};

/** The two-letter chip label used by the in-page switch. */
export const LOCALE_LABEL: Record<Locale, string> = { pt: "PT", en: "EN" };

/** Narrowing guard — the only sanctioned way to trust a `[locale]` param. */
export function isLocale(value: unknown): value is Locale {
  return value === "pt" || value === "en";
}

/**
 * The pages that exist under every locale prefix, as the path *below* the
 * prefix. `""` is the locale root. This is the single list that the route
 * tree, `sitemap.xml` and the hreflang alternates all have to agree on.
 */
export const LOCALIZED_PATHS = ["", "/privacy", "/terms", "/references"] as const;
export type LocalizedPath = (typeof LOCALIZED_PATHS)[number];

/**
 * The URL path for a page in a locale. A locale root keeps its trailing slash
 * (`/pt/`) so there is exactly one canonical form of it, matching what the
 * sitemap says and what every wordmark in the site links to.
 *
 * ## Linking *back* to the locale root is `dismissTo`, not a plain `Link`
 *
 * Every "home" affordance on a child screen (`/pitch`, the legal pages, the
 * 404, the app chrome) targets this path, and a plain `Link` **pushes**: from
 * `/pt/` → `/pitch` → home, the stack ends up two landing screens deep, the
 * first one still mounted. Measured on the exported build, that put two
 * elements on the page for every landing section id (`forecast`, `engines`,
 * `showcase`, `provenance`, `deck`), which is how the nav stopped scrolling —
 * see `components/landing/use-section-fragment.ts`. It also leaves the stale
 * copy's `Animated.loop`s, resize observers and `popstate` listener running
 * for the rest of the visit.
 *
 * `dismissTo` pops back to the landing screen already in the stack instead,
 * so home is one screen however many times a reader goes there and back. It
 * degrades safely: expo-router replaces the current screen when the target is
 * not in the stack, which is the case for a reader who opened `/pitch`
 * directly.
 *
 * The URL that ends up in the address bar after such a navigation is `/pt`,
 * without the slash, and that is the router's doing rather than any href
 * here: expo-router rebuilds the URL from navigation state and
 * `fork/getPathFromState.js` strips trailing slashes on the way out. It is
 * cosmetic — `/pt` and `/pt/` resolve to the same file and the same route,
 * `server.ts` and `e2e/serve-dist.ts` both answer either — and the canonical
 * form this function returns is what the `<link rel=canonical>`, the sitemap
 * and every href in the site still say.
 */
export function localePath(locale: Locale, path: LocalizedPath = ""): string {
  return path === "" ? `/${locale}/` : `/${locale}${path}`;
}

/**
 * Move a pathname to another locale, preserving the page.
 *
 * Used by the language switch, which is a *link* rather than a state toggle:
 * `/en/privacy` ⇄ `/pt/privacy`. A path that is not already locale-prefixed
 * (`/`, `/app`) is prefixed rather than rewritten.
 */
export function swapLocale(pathname: string, next: Locale): string {
  const segments = pathname.split("/").filter(Boolean);
  const rest = isLocale(segments[0]) ? segments.slice(1) : segments;
  return rest.length === 0 ? `/${next}/` : `/${next}/${rest.join("/")}`;
}

/**
 * Which locale a BCP-47 tag list asks for, or `null` if none of them match.
 *
 * Deliberately prefix-matching on the primary subtag: `pt-PT` and `pt-BR` both
 * mean "give this reader Portuguese", and the site has only one Portuguese.
 * Used by the loading screen at `/` **only**, and by the copy of that same
 * rule in `+html.tsx`'s pre-hydration script — inside the `[locale]` tree the
 * URL is the single source of truth and the browser is never consulted. It is
 * also consulted *after* storage, never before: a reader who chose English
 * keeps English on a pt-BR browser.
 */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "pt" || primary === "en") {
      return primary;
    }
  }
  return null;
}
