---
id: "016"
title: i18n architecture — PT-BR and EN with a switch
type: wayfinder:grilling
status: closed
assignee: i18n-agent
blocked_by: ["004"]
---

## Question

How does bilingual work in an Expo Router app that static-exports for SEO?

- Which i18n library, given Expo + React Native + static web export.
- **The SEO question is the hard one.** Static export plus two languages means
  either locale-prefixed routes (`/pt/app`, `/en/app`) with duplicated static
  output, or client-side switching that leaves one language invisible to
  crawlers. These are materially different builds. Decide before any copy is
  written.
- Locale detection and persistence, and whether the switch changes the URL.
- Where the strings live, and how a session adding a screen is stopped from
  hardcoding English.
- Number, date and unit formatting per locale — MW, MWh, R$, decimal comma.
- Do domain terms translate? "Curtailment" has no clean Portuguese equivalent;
  ONS's own term is "constrained-off". Which terms stay untranslated in both
  locales, per the map's standing preference.
- Does the API return translated strings, or only codes the client renders?

Use `/grilling`.

## Resolution

**Locale-prefixed routes, not client-side switching.** Both locales are
prefixed symmetrically — `/pt/...` and `/en/...` — built with expo-router's
`generateStaticParams` on a `[locale]` dynamic segment (verified against
current Expo docs: this is exactly the mechanism the docs describe, one
static HTML file per returned param set, params cascading to nested routes).
Bare `/` becomes a thin, static, `noindex,follow` gate page with real visible
links to both locales plus a client-side redirect by persisted preference /
device locale — so even the gate degrades to something crawlable, never a
blank shell.

One real wrinkle confirmed, not just assumed: `+html.tsx` is a single global
document shell with no per-route parameterization, so `<html lang>` cannot be
set correctly per locale from React during static export — the workaround
(a post-`expo export` rewrite pass) is flagged as unverified/uninstalled, not
asserted as working.

i18n library: `i18next` + `react-i18next` (universal RN/web, survives static
export as it's pure client data), with locale **derived from the route**, not
autodetected — the built-in detector plugin is deliberately not used, to
avoid a hydration-time language flash that would undermine the whole SEO
argument. The language switch is a `Link` to the same page under the other
prefix, so switching changes the URL. Formatting uses native `Intl` with
`pt-BR` / `en-US` tags; MW/MWh are appended as literal suffixes rather than
relying on `Intl` unit formatting (unverified whether ECMA-402 sanctions those
units); currency is always `BRL`; timestamps are always rendered in
`America/Sao_Paulo`, independent of UI locale. The API returns codes only,
with one deliberate exception: LLM narration is generated prose, not a
lookup, and the API generates it directly in the requested locale.

Untranslated in both locales: **"curtailment" / "constrained-off"** (the
ticket's own settled example — ONS's own vocabulary is already English), plus
a starting allow-list of ONS/ANEEL-native proper nouns and terms of art
(ONS, ANEEL, SIN, SIGA, DESSEM, BESS, SOC, conjunto).

Consequences worked through: `sitemap.xml` (regenerate to the six real
locale URLs, add hreflang), `robots.txt` (unchanged — explicitly do **not**
add a `Disallow` for the gate, which would hide its `noindex` tag from
Google), `manifest.webmanifest` (split into `manifest.pt.webmanifest` /
`manifest.en.webmanifest`, linked per-locale instead of from `+html.tsx`),
Dockerfile/`EXPO_PUBLIC_*` (unaffected — no new build-time locale variable
needed, only the static `public/` files need hand-updating), and the
Playwright legal suite (`apps/web/e2e/legal.spec.ts` needs its path loop
wrapped in a locale loop and its hardcoded `/privacy` /`/terms`/`/` links
made locale-aware).

Five points explicitly could not be confirmed and are flagged as open
questions rather than assumed: the exact static-export file path for a
`[locale]/index.tsx` segment; the `<html lang>` per-locale workaround;
whether `expo-router/head` dedupes or appends same-`rel` tags; whether
`+not-found.tsx` can be scoped per locale directory; and whether ECMA-402's
sanctioned unit list actually excludes "megawatt"/"megawatt-hour" (this last
one doesn't block anything either way, since the literal-suffix approach
works regardless).

Full spec: [`docs/specs/i18n.md`](../../docs/specs/i18n.md).
