import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

/**
 * Static-render HTML shell (web only). Everything here ships in the initial
 * HTML — no client JS required — which is what search engines and social
 * crawlers read. Per-page tags live in each route's <Head>.
 *
 * **`lang` and the manifest link are placeholders here.** This shell is global
 * — expo-router gives it no access to the route being rendered — so it cannot
 * emit `lang="en"` for `/en/…` and `lang="pt-BR"` for `/pt/…` from React. The
 * values below are the defaults; `scripts/localize-export.ts` runs after
 * `expo export` and rewrites both per file, which is sound precisely because
 * `<html>` is outside React's hydration scope (Expo's `AppRegistry.web`
 * hydrates the `#root` div, not the document). See that script's header for
 * the evidence.
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
        {/* `/`'s redirect into the reader's locale, fired before hydration so
            the loading screen behind it is never painted. Guarded on the
            pathname because this shell is global: on any other page it is a
            no-op, including on the server's SPA fallback, which answers
            unknown paths with `/`'s HTML.

            The rule is: a stored choice, otherwise **pt-BR**. The browser's
            own languages are deliberately *not* consulted — a Brazilian
            product defaults to Portuguese, and an English-locale browser
            arriving for the first time should still land on pt. A reader who
            switched to English wrote `wattsteer.locale` doing it (see
            `language-switch.tsx`), and that choice is what carries them.

            The 900 ms is the loading screen's minimum display. Redirecting on
            the same tick made it unobservable — the landing page was already
            painted at 0 ms, so the screen existed in the bundle and never on a
            screen. It is a deliberate hold, not work being waited on: there is
            nothing to resolve here, and saying so is better than pretending a
            spinner is measuring something.

            With scripting off nothing happens, and the loading screen's
            continue link is revealed by the `<noscript>` rule below. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: inline pre-hydration redirect
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
  var p=location.pathname;
  if(p!=="/"&&p!=="/index.html")return;
  var s=null;try{s=localStorage.getItem("wattsteer.locale");}catch(e){}
  var l=(s==="pt"||s==="en")?s:"pt";
  setTimeout(function(){location.replace("/"+l+"/");},900);
}catch(e){}})();`,
          }}
        />
        {/* The one thing a scriptless browser needs and cannot be given any
            other way: a way off the loading screen. The link is in every
            page's HTML with `display:none`, and this rule — which a browser
            only applies when scripting is disabled — reveals it. `!important`
            because react-native-web writes that `display:none` as a class,
            and an author `!important` outranks both a class and an inline
            style. */}
        <noscript>
          <style
            // biome-ignore lint/security/noDangerouslySetInnerHtml: static critical CSS
            dangerouslySetInnerHTML={{
              // biome-ignore lint/security/noSecrets: a CSS rule, read as high entropy because it has no spaces
              __html: "[data-noscript-only]{display:flex!important}",
            }}
          />
        </noscript>
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
