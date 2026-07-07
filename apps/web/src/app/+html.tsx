import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

/**
 * Static-render HTML shell (web only). Everything here ships in the initial
 * HTML — no client JS required — which is what search engines and social
 * crawlers read. Per-page tags live in each route's <Head>.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />
        <meta name="color-scheme" content="dark" />
        {/* Versioned icon link: browsers cache favicons per-origin in a
            separate store that survives hard refreshes — localhost ports are
            shared across every locally-run app, so bust with a query param
            (bump ?v= when the mark changes). */}
        <link rel="icon" href="/favicon.ico?v=2" sizes="32x32" />
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
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
