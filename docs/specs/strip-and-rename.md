# Spec — Strip Zalytix and rename to WattSteer

> Resolves wayfinder ticket **Strip Zalytix and rename to WattSteer**
> (`.wayfinder/tickets/004-strip-and-rename.md`). Map: `.wayfinder/map.md`.
> Status: **ready-for-agent**.

## Problem Statement

The repository is Zalytix — an App Store and Google Play review-scraping SaaS.
The team is building WattSteer, a renewable-curtailment decision engine for the
Brazilian grid. These share nothing but their scaffolding.

Every session that opens this repo has to hold two products in its head at once:
the one the code says it is, and the one it is becoming. Agents reading
`apps/api/src/index.ts` — deleted by this ticket, and named here as it was
then — see a scraper library. Anyone reading `README.md` learns
about humanized Chromium. The design system's own header comment describes a
review-scraping product. Thirteen downstream decision tickets — the domain
model, the schema, the screens — all want to add WattSteer code to a repo that
still insists it is Zalytix, and every one of them will pay a comprehension tax
and risk copying the wrong pattern.

Meanwhile the parts actually worth keeping are entangled with the parts that
must go. The design system, the Elysia plugin stack, the job layer, the Drizzle
plumbing and the Expo shell are all sound and all carry the old name.

## Solution

One deliberate, self-contained change: delete the Zalytix domain outright and
rename what remains to WattSteer, leaving a repo that builds, tests and deploys
but does nothing yet.

Afterwards the repo is an honest empty vessel. The design system is intact and
correctly named. The API serves its health and readiness surface through the
same plugin stack, under the new name. The web app still renders its shell,
its footer and its legal pages, and still static-exports. Nothing scrape-shaped
survives anywhere outside `reference/` and git history.

Deletion is outright — no commented-out husks, no `.old` files, no
half-migrated types. Anything genuinely needed later is recoverable from git
history in the new repository.

`reference/` is deliberately preserved. It is the Next.js application the design
tokens were ported from, and it remains the visual source of truth for chart and
panel components not yet ported. It is exempt from the rename: it is a
historical artifact, not project code.

## User Stories

1. As a developer opening the repository, I want the README to describe
   WattSteer, so that I understand what I am working on within one screen.
2. As a developer, I want no file to mention App Store, Google Play, reviews or
   scraping, so that I never mistake dead domain code for a live pattern.
3. As an agent session picking up a downstream ticket, I want the repo to
   contain only WattSteer-relevant code, so that my codebase exploration returns
   signal rather than a scraper.
4. As an agent session, I want a repo-hygiene test to fail loudly if I reintroduce
   the old name, so that the rename does not rot as thirteen more tickets land.
5. As a developer, I want `bun install` to succeed on a fresh clone, so that
   onboarding is one command.
6. As a developer, I want `bun run typecheck` to pass across every workspace, so
   that I know the deletion left no dangling import or orphaned type.
7. As a developer, I want `bun run lint` to pass, so that the deletion did not
   leave unused imports or unreachable code.
8. As a developer, I want `bun test` to pass, so that the surviving behaviour is
   demonstrably still working rather than merely still compiling.
9. As a developer, I want the surviving test suites to contain no skipped or
   commented-out tests, so that the passing suite means what it says.
10. As an API consumer, I want `GET /health` to still report status, so that the
    Railway healthcheck keeps working through the rename.
11. As an API consumer, I want `GET /ready` to still report readiness, so that
    deployment gating is unaffected.
12. As an API consumer, I want `GET /` to return the service name `wattsteer`,
    so that the running service identifies itself correctly.
13. As an API consumer, I want the `x-request-id` correlation header to still be
    echoed, so that request tracing survives.
14. As an operator, I want rate limiting, body limits, CORS and the security
    headers to behave exactly as before, so that the rename carries no security
    regression.
15. As an operator, I want every environment variable renamed from `ZALYTIX_*`
    to `WATTSTEER_*`, so that configuration matches the product.
16. As an operator, I want `.env.example` to list the surviving variables only,
    so that I am not asked to configure a scraper.
17. As an operator, I want no scraper-only variable to remain readable in code,
    so that stale configuration cannot silently do nothing.
18. As a deployer, I want the Dockerfiles to build successfully after the strip,
    so that the first WattSteer deploy is not blocked on packaging.
19. As a deployer, I want browser and stealth dependencies removed from the
    image, so that the container stops carrying a Chromium it will never launch.
20. As a deployer, I want `docker compose up` to bring up the surviving services,
    so that local development matches deployment.
21. As a visitor, I want the web app to still render its navigation, footer and
    legal pages, so that the shell is demonstrably intact.
22. As a visitor, I want `/privacy` and `/terms` to still load and be navigable,
    so that the legal surface is not broken by the strip.
23. As a visitor, I want the site to still static-export, so that the SEO
    architecture the template was built around survives.
24. As a visitor, I want the browser tab, manifest and splash screen to say
    WattSteer, so that the product identity is consistent.
25. As a search crawler, I want `robots.txt`, `sitemap.xml` and
    `manifest.webmanifest` to reference WattSteer, so that indexing is not
    attributed to a different product.
26. As an AI crawler reading `llms.txt`, I want it to describe WattSteer, so
    that machine readers are not told about a scraping product.
27. As a designer, I want the design tokens unchanged in value, so that lime,
    grape, charcoal, radii, spacing and motion are provably identical after the
    rename.
28. As a designer, I want the tokens file header comment to describe WattSteer,
    so that the design system's own documentation is not misleading.
29. As a designer, I want the brand component to render the WattSteer wordmark,
    so that the identity is correct wherever the brand appears.
30. As a designer, I want `reference/` preserved untouched, so that I retain the
    visual source for components not yet ported.
31. As a developer, I want packages renamed to `@wattsteer/core`,
    `@wattsteer/ui` and `@wattsteer/web`, so that imports read correctly.
32. As a developer, I want workspace cross-references updated together with the
    package names, so that `bun install` resolves without manual repair.
33. As a developer, I want the Expo `name`, `slug` and `scheme` set to
    WattSteer, so that deep links and native builds carry the right identity.
34. As a developer, I want the API's publishable library surface and its CLI
    `bin` entry removed, so that the package stops advertising a scraper API it
    no longer has.
35. As a developer, I want the reviews tables dropped from the Drizzle schema,
    so that migrations do not create tables for a deleted domain.
36. As a developer, I want the Drizzle migration history reset rather than
    accumulating a drop-everything migration, so that WattSteer's schema starts
    from a clean baseline against a brand-new database.
37. As a developer, I want the job layer, database plugin and Elysia plugins
    kept intact, so that the ingestion work in later tickets has its machinery.
38. As a developer, I want `docs/crawler-roadmap.md` deleted, so that no roadmap
    for a deleted product survives.
39. As a developer, I want `docs/lint-policy.md` retained and de-branded, so
    that the repo's lint conventions survive the rename.
40. As a developer, I want the stray `apps/web/undefined/` directory removed, so
    that an accidental misdirected write does not become permanent.
41. As a developer, I want `apps/api/DIAGRAM.md` and `apps/web/DESIGN.md`
    either deleted or rewritten, so that no architecture document describes a
    system that no longer exists.
42. As a reviewer, I want the strip to land as a reviewable change with the
    deletions separable from the renames, so that I can audit that nothing
    worth keeping was deleted by accident.
43. As the dev, I want the local checkout to stay at `~/Dev/gridflex` despite
    the rename, so that active worktrees are not disturbed.
44. As the dev, I want `IDEA.md` left exactly as written, so that the historical
    source document is preserved even though it uses the old working name.
45. As the dev, I want the `.wayfinder/` map and tickets left readable, so that
    the map can keep referring to Zalytix as the thing being removed.
46. As the dev, I want nothing pushed to `vtorres/zalytix` and no Railway
    project other than `wattsteer` touched, so that the live product is safe.

## Implementation Decisions

**Scope boundary.** This spec covers destination artifact (1) only — the strip
and rename. It builds no WattSteer feature. Afterwards the repo compiles,
serves health and readiness, renders a shell, and implements no product.

**Deletion, module by module.**

*`apps/api`* — the scraping engine, its store adapters, its HTTP domain and its
library surface are removed: browser and stealth handling, the Apple and Google
adapters, the fetch engine, the review pipeline, target resolution, the scrape
orchestration, app-info parsing, output writers, pagination, the concurrency
limiter, the CLI entry point, the reviews controller/model/runner/service, and
the package's public export surface. The `bin` entry and the library `exports`
block go with them.

*Kept in `apps/api`* — the Elysia plugin stack (body limit, error handler, rate
limit, request context, security headers), the jobs layer (BullMQ driver,
in-process driver, shared types), the worker entry, the database connection and
plugin, the config module minus scraper-only keys, and the error taxonomy minus
scraper-specific error types.

*`packages/core`* — store-URL resolution, the scrape-flow state machine, CSV
export and sentiment analysis are deleted, along with the review types. Only
generic formatting helpers survive. The package stays in the workspace as the
declared home for shared client-side domain, which later tickets will refill;
its description is rewritten to say so rather than describing a scraper.

*`packages/ui`* — **nothing is deleted.** Every token, primitive, hook and
helper survives. Three files carry the old name in comments and copy and are
renamed in place: the tokens header, the brand component, the legal primitives.

*`apps/web`* — the scraper hero, reviews feed, app-preview card, showcase,
dashboard, stat cards, breakdown, heatmap, timeline chart and hero widgets are
deleted, together with the app-preview and scrape hooks, the scrape controller,
sample data and the download helper. The landing route is reduced to a minimal
placeholder composed of surviving primitives; rebuilding it is the separate
**Landing page rewrite** ticket. Navigation, footer, legal screens, the legal
table-of-contents hook, the HTML shell, the root layout and the not-found route
all survive.

*Chart components are deleted, not adapted.* The timeline chart, heatmap and
breakdown are shaped around review distributions over time. WattSteer needs a
forecast profile with an uncertainty band, a state-of-charge trace and a
dispatch stack. Which of these to rebuild — and whether any of the deleted code
is worth resurrecting from history — is decided by **The four /app screens**.

**Dependencies.** Browser automation and stealth (`cloakbrowser`,
`playwright-core`), the SOCKS proxy agent and the GeoIP library are removed from
`apps/api`. Elysia, Drizzle, BullMQ, ioredis, postgres and the Elysia plugin
packages stay. Playwright's *test* runner stays in `apps/web` — it drives the
surviving e2e suite and is unrelated to the scraper's use of Playwright.

**Naming.** `zalytix` → `wattsteer`, `Zalytix` → `WattSteer`, `@zalytix/*` →
`@wattsteer/*`, `ZALYTIX_*` → `WATTSTEER_*`. Applied to package names and
scripts, Expo `name`/`slug`/`scheme`, Docker and compose files, the API's
self-reported service name, SEO artifacts, and all prose. `reference/`,
`IDEA.md` and `.wayfinder/` are exempt.

**Environment variables.** Renaming is mechanical, but scraper-only variables
are *deleted*, not renamed — navigation timeouts, scrape timeouts, stealth
presets, proxy configuration, max concurrency, GeoIP. Keeping them renamed
would be worse than keeping them named wrong: a variable that reads cleanly and
does nothing is a trap. Retained: role selection, public URL, CORS origins,
rate-limit window and ceiling, job retention and retry settings, dashboard
toggle, database and Redis URLs, and the test-specific database and Redis
overrides.

**Schema.** The reviews tables are dropped from the Drizzle schema and their
repository functions removed. Migration history is reset rather than extended:
WattSteer deploys against a brand-new database in a brand-new Railway project,
so there is no production data to migrate and no reason to carry a
drop-everything migration as WattSteer's first schema event. The schema is left
with whatever non-domain infrastructure the job layer requires, and the real
tables arrive with **Bitemporal schema and ingestion contract**.

**API contract after the strip.** `GET /health` (status plus liveness detail),
`GET /ready` (boolean readiness), `GET /` (service name `wattsteer`, docs link),
and the Swagger docs route. Every review endpoint is gone. The health response
currently reports scrape-concurrency statistics; that field is removed rather
than retained with a meaningless value.

**Order of work.** Delete first, then rename, then repair the build. Renaming
before deleting means carefully renaming code that is about to be removed.

**Reviewability.** The change should be structured so deletions and renames are
separable — the deletion is large and mechanical and the rename is large and
mechanical, but a reviewer auditing "was anything good deleted by mistake?" is
answering a different question from "was the rename complete?".

## Testing Decisions

**What makes a good test here.** These tests assert externally observable
behaviour: what an HTTP client receives, what a browser renders, what the
repository contains. They do not assert that a particular module exists, that a
function has a signature, or that a file was deleted — a deletion is not
behaviour, and a test that names a deleted file is a test that must be deleted
with it. The behaviour worth protecting is that *the surviving system still
works and the old identity is entirely gone*.

**Three seams, two of them already in the codebase.**

*Seam 1 — the API, in-process through Eden Treaty.* The existing suite drives
the assembled Elysia app with Elysia's own typed test client: no network, no
server, the whole plugin stack exercised from outside. It already covers health,
readiness, service info, request-id correlation, CSP headers, body limits and
rate limiting. This is the highest available seam for the API and it survives
the strip. Its review-endpoint assertions are deleted and its service-name
assertion changes from `zalytix` to `wattsteer`. No new API seam is introduced.

*Seam 2 — the web app, in a real browser against the real export.* The existing
Playwright legal suite runs against the genuinely exported static bundle across
desktop and mobile viewports, asserting the footer, its CTA and legal links, and
the `/privacy` and `/terms` pages including heading structure. It targets
design-system test IDs rather than scraper markup, so it survives essentially
unchanged and proves the shell and the static export both still work. The
landing-page suite is deleted with the scraper hero and is rebuilt by the
**Landing page rewrite** ticket.

*Seam 3 — repo hygiene (new).* One test asserting that no forbidden token —
`zalytix`, `Zalytix`, `ZALYTIX_`, `@zalytix/` — appears anywhere in the tracked
repository outside `reference/`, `IDEA.md`, `.wayfinder/` and git history. This
is the only seam added, and it sits at the highest point available: the
repository itself. It exists because this ticket's done-condition is otherwise
unverifiable, and because it is the mechanism that keeps the rename true as
thirteen further tickets add code. It should read the forbidden list from one
place, report every offending path rather than only the first, and be fast
enough to live in the default `bun test` run.

**What is deleted rather than migrated.** The scraper suites — store-adapter
parsing, app-info extraction, review pipelines, output writers, pagination,
concurrency, live scraping, and the resolver-parity suite that guaranteed the
API and core resolvers never drifted — are removed with the code they test.
Deleting them is correct: they test behaviour that no longer exists. The parity
pattern itself is worth remembering, because the same drift risk returns as soon
as WattSteer computes a value in both Elysia and the Python service; it is
recorded as prior art rather than preserved as code.

**What survives.** The rate-limit unit tests, the error-taxonomy tests, the job
and job-API tests, the BullMQ integration test, the database integration test,
the surviving portion of the Eden Treaty suite, the web analytics and
legal-table-of-contents unit tests, and the Playwright legal suite.

**Prior art for the new seam.** There is none in this repository — it is the
first test that asserts about the repository rather than about the software. The
closest existing analogue in spirit is the resolver-parity suite: a test whose
job was to prevent two things drifting apart rather than to verify a feature.

**Acceptance gate.** On a fresh clone: `bun install`, then `bun run typecheck`,
`bun run lint`, `bun test`, and `bun run web:export` followed by
`bun run test:e2e` — all passing, with no skipped tests.

## Out of Scope

- **Any WattSteer feature.** No ingestion, no schema, no model, no optimizer, no
  screens. The repo does nothing after this change, deliberately.
- **The landing page.** Reduced to a placeholder here; rebuilt by **Landing page
  rewrite**.
- **The four `/app` screens**, and the decision about which chart components to
  rebuild.
- **The i18n layer.** All surviving copy stays English; bilingual support is
  **i18n architecture**.
- **The Python service.** `apps/ml` is created by **apps/ml scaffold and service
  topology**.
- **Creating the GitHub repository and the Railway project.** That is
  **Provision vtorres/wattsteer and the Railway project**, which runs
  independently — this ticket assumes neither.
- **The real database schema.** Only removal of the reviews tables here.
- **Logo and wordmark artwork.** The brand component is renamed and its text
  updated; commissioning a mark is not part of this.
- **Renaming the local checkout** from `~/Dev/gridflex`. Recorded as a deliberate
  mismatch.
- **Rewriting `reference/`, `IDEA.md` or `.wayfinder/`.**

## Further Notes

**This is a load-bearing ticket.** Four tickets — the landing page, i18n, the
ml scaffold, and by extension everything downstream of them — are blocked on it.
It is also the cheapest large change in the effort: entirely mechanical, no
decisions left open, and verifiable by a gate that either passes or does not.

**The riskiest failure is over-deletion, not under-deletion.** Under-deletion is
caught by the hygiene test. Over-deletion — removing a plugin, a hook or a token
that later tickets assumed would be there — surfaces only much later, when a
session rebuilds something that already existed. Hence the explicit keep list,
and hence separable deletion and rename.

**`packages/core` is left almost empty and that is intentional.** The instinct
to delete an empty workspace should be resisted: it is the declared home for
domain shared between Elysia and Expo, and the **Public API surface** ticket
explicitly considers putting the typed API client back there.

**The resolver-parity pattern is worth carrying forward.** The template kept two
implementations of URL resolution in sync with a test suite importing both. The
same shape of risk arrives with WattSteer: feature definitions computed in both
SQL and Python, per the **Feature engineering spec** ticket. That ticket should
know this pattern exists in git history.

**Safety.** Nothing in this change may push to `vtorres/zalytix` or touch any
Railway project other than `wattsteer`. Zalytix stays live and untouched.
