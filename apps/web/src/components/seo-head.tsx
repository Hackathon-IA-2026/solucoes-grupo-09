import Head from "expo-router/head";
import type { Locale, LocalizedPath } from "@/i18n/locale";
import {
  alternatesFor,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_URL,
  OG_IMAGE_WIDTH,
  pageUrl,
  siteGraph,
} from "@/lib/seo";

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
  imageAlt,
  ogType = "website",
}: {
  locale: Locale;
  path: LocalizedPath;
  title: string;
  description: string;
  /** Alt text for the share card, in this page's language. */
  imageAlt: string;
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
      {/* The other locale, declared to the crawlers that read Open Graph
          rather than `hreflang` — the same pair the alternates above assert,
          in the vocabulary Facebook and LinkedIn actually parse. */}
      <meta
        property="og:locale:alternate"
        content={locale === "pt" ? "en_US" : "pt_BR"}
      />
      <meta property="og:site_name" content="WattSteer" />
      <meta property="og:image" content={OG_IMAGE_URL} />
      <meta property="og:image:width" content={String(OG_IMAGE_WIDTH)} />
      <meta property="og:image:height" content={String(OG_IMAGE_HEIGHT)} />
      <meta property="og:image:alt" content={imageAlt} />

      {/* X reads `twitter:*` first and falls back to Open Graph, so only the
          two tags with no OG equivalent are strictly needed — `card`, which
          chooses the layout, and `image:alt`, which OG spells differently.
          Title, description and image are repeated anyway because several
          non-X clients (Slack among them) read the Twitter set exclusively,
          and a card that renders everywhere is worth four duplicated tags. */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={OG_IMAGE_URL} />
      <meta name="twitter:image:alt" content={imageAlt} />

      {/* The site's identity as one linked graph. It is emitted on every
          locale-prefixed page rather than only the home page because each of
          them is a canonical URL in its own right, and a crawler that reaches
          `/pt/terms` first should still learn who publishes it. */}
      <script type="application/ld+json">
        {JSON.stringify(siteGraph(locale, description))}
      </script>
    </Head>
  );
}
