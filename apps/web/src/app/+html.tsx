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
        {/*
          The critical stylesheet: the page background before hydration (so
          there is no white flash), the reduced-motion rule, and the responsive
          layouts that CSS owns rather than JavaScript.

          ## Why any layout is CSS's job here

          Every "is this wide?" decision in this app is measured, by
          `useContainerWidth` + `onLayout`, and `onLayout` cannot fire before
          React has mounted — which cannot happen before a 500 KB bundle has
          been fetched and evaluated. The static export paints long before
          that, and it paints the `width === 0` branch: the narrow one. Every
          element whose arrangement depends on a measurement therefore *moves*
          once the bundle lands, and moving content after first paint is
          precisely what CLS counts.

          Measured on the export at desktop width, before these rules:
          `/pt/terms` and `/pt/privacy` scored 0.195 CLS — one shift, the whole
          content pane, when the TOC left it — and `/pitch` 0.190, the footer's
          one column becoming two. All three pages scored 91 on Performance for
          that reason alone; nothing else on any of them was slow.

          A stylesheet has the property `onLayout` lacks: it resolves at first
          paint, with no JavaScript at all. So for the handful of switches that
          cost real points, the CSS decides and the measured boolean is left to
          drive native, which has no stylesheet. Each rule below therefore has
          a counterpart in a component, and every breakpoint is a constant that
          component exports — `test/responsive-css.test.ts` asserts the pairs
          agree, and that no rule here selects an attribute nothing emits.

          That test exists because this exact failure had already happened: the
          rule that used to live here selected `[data-hero-headline]`, an
          attribute no component has emitted for some time, at a 960px
          breakpoint the hero no longer uses. It was matching nothing, silently,
          and the headline it was written to hold still was resizing after
          hydration. Its intent is kept below, against the element and the
          breakpoint that now exist.

          `@container` rather than `@media` wherever a component asks about
          *its own* width rather than the viewport's: the footer and the hero
          each sit inside page gutters that differ per route, so a viewport
          breakpoint would flip them at the wrong width on two pages out of
          three. Where `onLayout` sits on a full-bleed element — the legal
          screen's root — the two are the same question, and a media query is
          the simpler one.
        */}
        <style
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static critical CSS
          dangerouslySetInnerHTML={{
            __html: `
              body { background-color: #131316; }

              @media (prefers-reduced-motion: reduce) {
                *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
              }

              /* Legal pages: TOC beside the content at >= 1024px, matching
                 LEGAL_WIDE in components/legal-screen.tsx. Both placements of
                 the sidebar are in the DOM; this chooses one. */
              [data-legal-sidebar-side] { display: none !important; }
              @media (min-width: 1024px) {
                [data-legal-columns] { flex-direction: row !important; }
                [data-legal-sidebar-side] { display: flex !important; }
                [data-legal-sidebar-inline] { display: none !important; }
              }

              /* Site footer: two columns at >= 640px of its own width,
                 matching FOOTER_WIDE in components/site-footer.tsx. */
              [data-footer-wrap] {
                container-type: inline-size;
                container-name: wsfooter;
              }
              @container wsfooter (min-width: 640px) {
                [data-footer-cta-band] {
                  padding-left: 24px !important;   /* space.xl */
                  padding-right: 24px !important;
                  padding-top: 72px !important;    /* space.huge */
                  padding-bottom: 72px !important;
                }
                [data-footer-bar] { flex-direction: row !important; }
                /* react-native-web writes "flex: 1" as this triple, and a View
                   with no flex as "flex-shrink: 0" — so restoring the wide
                   variant means setting all three, not just grow. */
                [data-footer-rights], [data-footer-links] {
                  flex-grow: 1 !important;
                  flex-shrink: 1 !important;
                  flex-basis: 0% !important;
                }
                [data-footer-rights] { align-items: flex-start !important; }
                [data-footer-links] { justify-content: flex-end !important; }
              }

              /* The deck at /pitch: a 16:9 slide instead of a fixed portrait
                 strip at >= 720px, matching PITCH_WIDE in app/pitch.tsx. The
                 frame is the tallest box on that page, so its height changing
                 moves everything under it. */
              @media (min-width: 720px) {
                [data-pitch-fallback-row] {
                  flex-direction: row !important;
                  align-items: center !important;
                }
                [data-pitch-embed] {
                  height: auto !important;
                  aspect-ratio: 1.7777777777777777 !important;
                }
              }

              /* The app bar: one line at >= 900px, with the screen toggle
                 centred between the wordmark and the language switch, matching
                 APPBAR_WIDE in components/app/app-shell.tsx. All three are in
                 one wrapping row; below the breakpoint the toggle takes a full
                 basis and drops to its own line, which is the arrangement the
                 inline styles already produce. This only reorders them. */
              @media (min-width: 900px) {
                [data-appbar-left] {
                  order: 1;
                  flex-grow: 1 !important;
                  flex-shrink: 1 !important;
                  flex-basis: 0% !important;
                }
                [data-appbar-nav] {
                  order: 2;
                  flex-grow: 0 !important;
                  flex-shrink: 0 !important;
                  flex-basis: auto !important;
                }
                [data-appbar-right] { order: 3; }
              }

              /* Hero headline: the large variant at >= 900px of the hero's own
                 width, matching HERO_WIDE in components/landing/hero.tsx. */
              [data-hero-root] {
                container-type: inline-size;
                container-name: wshero;
              }
              @container wshero (min-width: 900px) {
                [data-hero-headline] {
                  font-size: 56px !important;
                  line-height: 60px !important;
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
