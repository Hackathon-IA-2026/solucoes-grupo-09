---
id: "004"
title: Strip Zalytix and rename to WattSteer
type: wayfinder:task
status: closed
triage: done
spec: docs/specs/strip-and-rename.md
assignee: vitor.torres@sparkshipping.com
blocked_by: []
---

## Question

Nothing to decide — the decisions are made. This is the mechanical work that
unblocks every code-shaped ticket after it.

Delete outright (no dead code, no commented husks):

- `apps/api/src`: browser.ts, apple.ts, google.ts, engine.ts, pipeline.ts,
  resolve.ts, scrape.ts, appinfo.ts, appinfo-fast.ts, output.ts, pagination.ts,
  concurrency.ts, cli.ts, api/reviews/*, and the reviews tables in
  database/schema.ts + repository.ts
- `packages/core/src`: resolve.ts, machine.ts, csv.ts, sentiment.ts, and the
  review types in types.ts
- `apps/web/src`: scraper-hero.tsx, reviews-feed.tsx, app-preview-card.tsx,
  showcase.tsx, dashboard.tsx, stat-cards.tsx, breakdown.tsx, heatmap.tsx,
  timeline-chart.tsx, hero-widgets.tsx, hooks/use-app-preview.ts,
  hooks/use-scrape.ts, lib/scrape-controller.ts, lib/sample-data.ts,
  lib/download.ts
- the scraper test suites in `apps/api/test`, `packages/core/test`,
  `apps/web/test` and `apps/web/e2e`
- Playwright/stealth-browser dependencies from `apps/api/package.json`

Keep: `packages/ui` entirely, `reference/`, the Elysia plugins (body-limit,
errors, rate-limit, request-context, security), the jobs layer (bullmq,
inprocess, types), the database connection/plugin, `+html.tsx`, `_layout.tsx`,
`+not-found.tsx`, legal screens, top-nav, site-footer, fade-in, panel, pill,
brand, icons, tokens.

Rename everywhere: `zalytix` → `wattsteer`, `Zalytix` → `WattSteer`,
`@zalytix/*` → `@wattsteer/*`. Includes package.json names and scripts,
app.json (name, slug, scheme), README.md, biome.json, docker-compose.yml,
.dockerignore, tokens.ts header comment, and the brand component.

Note the deliberate mismatch: the local checkout stays at `~/Dev/gridflex`.

**Done when** `bun install && bun run typecheck && bun run lint && bun test`
all pass on a repo with no reference to Zalytix, App Store, Google Play or
review scraping anywhere outside `reference/` and git history.

## Spec

Full specification: [`docs/specs/strip-and-rename.md`](../../docs/specs/strip-and-rename.md)

Written from the charting session's decisions — no new decisions were made.
It adds detail this ticket did not carry: `packages/ui` files that are on the
keep list but still need renaming; the ~40 `ZALYTIX_*` environment variables,
and which are renamed versus deleted outright; the SEO artifacts; migration
history reset; and the explicit test seams.

**Seams** (agreed with the dev): the existing Eden Treaty API suite, the
existing Playwright legal e2e suite, plus one new repo-hygiene test asserting no
Zalytix token survives outside `reference/`, `IDEA.md` and `.wayfinder/`.

## Resolution

Done. 76 files deleted, 55 modified. `bun install`, `bun run typecheck`,
`bun run lint` and `bun run test` all pass; the Playwright e2e suite was
deliberately not run (deferred by the dev).

Three things worth knowing that the spec did not anticipate:

- **`bun run lint` was already red at HEAD.** Eight `useConsistentArrayType`
  violations existed in `packages/ui` and `apps/web` before any change here,
  with `biome.json` unmodified. Verified against `git show HEAD:` rather than
  assumed. They are fixed, so the gate is now genuinely green rather than
  green-except-inherited-failures.
- **The job layer was generalised, not just renamed.** `Execute` and `JobRunner`
  were typed to the scrape payload. They are now generic over payload and
  result, and progress reporting moved from a callback smuggled inside the
  payload to a second argument — so the payload stays a plain serialisable
  value. BullMQ's `Queue` needed all six type parameters supplied explicitly:
  it derives its name type through a conditional type that TypeScript cannot
  evaluate while the payload is generic.
- **The database integration test and the reviews repository went together.**
  Seam 2 of the data-platform spec (as-of reads against real Postgres) has no
  code to test yet and is created by data-platform ticket 01, not here.

Also deviating from the spec, deliberately: `apps/web/src/lib/analytics.ts` was
deleted (it computes review sentiment, keyword and version statistics — pure
scraper domain, and the spec's keep list had it wrong), and the legal pages were
rewritten to short accurate versions rather than merely renamed, because a
privacy policy describing a review scraper is worse than a placeholder.

