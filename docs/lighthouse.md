# Lighthouse, page by page

**Measured 2026-09-16** against a local `bun run --cwd apps/web export` served by
`apps/web/server.ts` — the same server the deployment runs, so the caching and
compression headers are the real ones. Mobile emulation, Lighthouse 13.4.1.

| page | perf | a11y | best-practices | SEO | CLS |
|---|---:|---:|---:|---:|---:|
| `/pt` | 87 | **100** | **100** | **100** | **0** |
| `/en` | 87 | **100** | **100** | **100** | **0** |
| `/pitch` | 88 | **100** | **100** | 66¹ | **0** |
| `/app` | 85 | **100** | 96² | 54¹ | **0** |
| `/app/explain` | 88 | **100** | 96² | 54¹ | **0** |
| `/app/mitigate` | 89 | **100** | 96² | 54¹ | **0** |
| `/app/replay` | 89 | **100** | 96² | 54¹ | **0** |
| `/pt/privacy` | 89 | **100** | **100** | **100** | **0** |
| `/pt/terms` | 89 | **100** | **100** | **100** | **0** |

Production, measured the same day before these changes shipped, scores `/pt` at
**97** and `/en` at **99**. Local numbers run lower on performance and should
not be read as a prediction: there is no CDN in front of this server and no
edge. What *is* comparable is everything else in the table, because it does not
depend on the network.

## The three numbers that are not 100, and why each one stays

**¹ SEO 54 and 66 — the `noindex` pages.** `/app` and `/pitch` send
`noindex,follow`, and Lighthouse's SEO category is largely a check that a page
*can* be indexed. A product screen behind a login has nothing to rank and the
pitch deck is a document, not a landing page. The `follow` half is deliberate
and documented at the `Head` in `app/app/index.tsx`: the footer links to the
landing and legal pages, and a bare `noindex` eventually has Google treat those
links as `nofollow` too.

The pages that *are* indexed score **100**.

**² Best practices 96 — two audits, both correct behaviour.**

`errors-in-console` counts failed network requests. On `/app` those are the
forecast reads refusing: `FORECAST_NOT_YET_PUBLISHED` in production, a 503 for
an unreachable gateway locally. This product asks and then renders the refusal
honestly — a forecast panel is **absent** and names the clause that refused
rather than drawing a zero. Scoring 100 here would mean not asking, and the
screen would have nothing true to say. The refusals are typed, rendered in the
reader's language, and covered by tests.

`valid-source-maps` wants a `.map` beside the bundle. Shipping one publishes the
whole source of a product to anyone who opens devtools. Not shipping it is the
decision; the audit is measuring something this repo does on purpose.

**Performance is the one with room in it.** ADR-0007 has the attribution:
framework is 49% of a single 1.9 MB chunk, app code 39%, and the indexed pages
carry 330 KB of `/app`-only code they never execute. Splitting that is an
architectural call with a hydration cost, recorded there rather than taken
unilaterally.

## CLS is 0 on every page, and was not

`/app` measured **0.215** in production on 2026-09-16 — one reflow, four seconds
in, when the no-model badge arrived into a `flexWrap` header and pushed
`PT / EN` and the voice trigger onto a second line. Every pixel below moved 42px
at the moment a reader had started reading. The badge now reserves its width
and `opacity` carries the fact; ADR-0008's sibling commit has the reasoning.

Worth 11 points of performance on its own: Lighthouse weights CLS at 25%, and
the sub-score goes 0.58 → 1.00.

## Re-running this

```
bun run --cwd apps/web export
PORT=8099 bun apps/web/server.ts &
npx lighthouse@13.4.1 http://localhost:8099/pt --only-categories=performance,accessibility,best-practices,seo
```

`server.ts` takes **no directory argument** — `ROOT` is `join(import.meta.dir,
"dist")`, always. Passing one is silently ignored, which is how a stale bundle
gets measured and a fix gets reported as a regression. Check the hash in the
served HTML matches `apps/web/dist/_expo/static/js/web/` before believing a
number.
