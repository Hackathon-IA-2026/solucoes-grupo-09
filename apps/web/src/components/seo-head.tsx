import Head from "expo-router/head";
import type { Locale, LocalizedPath } from "@/i18n/locale";
import { alternatesFor, pageUrl } from "@/lib/seo";

/**
 * The head of a locale-prefixed page: its own title and description in its own
 * language, its own canonical, and the full `hreflang` set including
 * `x-default`.
 *
 * Emitted from exactly one place per page — the leaf route — because
 * `docs/specs/i18n.md` records that whether `expo-router/head` dedupes or
 * appends repeated `rel` values is unverified. Emitting once sidesteps the
 * question instead of betting on an answer.
 */
export function SeoHead({
  locale,
  path,
  title,
  description,
  ogType = "website",
}: {
  locale: Locale;
  path: LocalizedPath;
  title: string;
  description: string;
  ogType?: string;
}) {
  const canonical = pageUrl(locale, path);
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
      <meta name="robots" content="index,follow" />
      {alternatesFor(path).map((alternate) => (
        <link
          key={alternate.hrefLang}
          rel="alternate"
          // Spread with the lowercase HTML name: `expo-router/head` writes
          // link props through verbatim rather than through React DOM's
          // attribute mapping, so a JSX `hrefLang` would land in the markup
          // spelled `hrefLang`. HTML parses that case-insensitively, but
          // hreflang is fussy enough to break silently that it is not worth
          // relying on.
          {...({ hreflang: alternate.hrefLang } as Record<string, string>)}
          href={alternate.href}
        />
      ))}
      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:locale" content={locale === "pt" ? "pt_BR" : "en_US"} />
      <meta property="og:site_name" content="WattSteer" />
    </Head>
  );
}
