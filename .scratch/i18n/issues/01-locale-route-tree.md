# 01 — Locale-prefixed route tree

**What to build:** every real page exists at `/pt/…` and `/en/…`, generated at
export time, with the URL as the single source of truth for which locale a page
is in.

Today the site is bilingual but only *client-side*: one set of unprefixed
routes, a switch that swaps dictionaries in the browser, and a static export
that therefore contains Portuguese only. English is invisible to a crawler.
That is the trade `docs/specs/i18n.md` explicitly declined, taken as an interim
step, and this ticket is the one that repays it.

The landing page, privacy and terms move under a `[locale]` segment whose layout
validates the param, provides the i18n context, and declares
`generateStaticParams` so the export emits one static file per locale. The
provider must take the locale **from the route** and never re-derive it from the
browser inside that subtree — browser preference decides only where a first-time
visitor is sent, which is the next ticket's job.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `/pt/`, `/en/`, and the legal pages exist under both locales in the export
- [ ] `generateStaticParams` emits one static file per locale per route
- [ ] The `[locale]` layout rejects an unknown locale rather than rendering it
- [ ] The provider takes its locale from the route param, never from the browser
- [ ] The language switch navigates between locale roots instead of swapping state
- [ ] A stored preference still survives navigation
- [ ] Existing tests pass; the Playwright legal suite is updated for the new paths
