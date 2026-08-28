import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

/**
 * Static-render HTML shell (web only). Everything here ships in the initial
 * HTML — no client JS required — which is what search engines and social
 * crawlers read. Per-page tags live in each route's <Head>.
 *
 * `lang` is `pt-BR` because the export renders the default locale and that
 * locale is Portuguese. It cannot vary per page: `docs/specs/i18n.md` records
 * that this shell is global with no per-route access, which is precisely the
 * limitation locale-prefixed routes would remove. `I18nProvider` rewrites the
 * attribute on the client when a visitor switches, so the prerendered value is
 * correct for the prerendered content and correct again after a switch.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />
        <meta name="color-scheme" content="dark" />
        {/* Versioned icon link: browsers cache favicons per-origin in a
            separate store that survives hard refreshes — localhost ports are
            shared across every locally-run app, so bust with a query param
            (bump ?v= when the mark changes). */}
        <link rel="icon" href="/favicon.ico?v=4" sizes="32x32" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content="#FFFFFF"
        />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#131522" />
        <ScrollViewStyleReset />
        {/* Match the page background before hydration to avoid a white flash. */}
        <style
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static critical CSS
          dangerouslySetInnerHTML={{
            __html: `
              body { background-color: #131316; }

              @media (prefers-reduced-motion: reduce) {
                *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
              }

              /* Hero headline, wide variant from first paint (matches the
                 wideHeadline breakpoint in the hero). The static
                 render emits the narrow variant (it can't measure); without
                 this, the post-hydration resize counts as layout shift. */
              @media (min-width: 960px) {
                [data-hero-headline] {
                  font-size: 44px !important;
                  line-height: 50px !important;
                  max-width: 1000px !important;
                  white-space: normal !important;
                }
              }
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
