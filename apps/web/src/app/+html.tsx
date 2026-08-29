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
        {/* The gate's redirect, fired before hydration so a returning visitor
            never sees the chooser flash. Guarded on the pathname because this
            shell is global: on any other page it is a no-op, including on the
            server's SPA fallback, which answers unknown paths with the gate's
            HTML. With scripting off nothing happens and the gate's two real
            links do the job — which is the point of the gate being a page. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: inline pre-hydration redirect
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
  var p=location.pathname;
  if(p!=="/"&&p!=="/index.html")return;
  var s=null;try{s=localStorage.getItem("wattsteer.locale");}catch(e){}
  var l=(s==="pt"||s==="en")?s:null;
  if(!l){var tags=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""]);
    for(var i=0;i<tags.length;i++){var m=String(tags[i]).toLowerCase().split("-")[0];
      if(m==="pt"||m==="en"){l=m;break;}}}
  location.replace("/"+(l||"pt")+"/");
}catch(e){}})();`,
          }}
        />
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
