# noviq

Humanized **App Store & Google Play review scraper** for Node.js / TypeScript,
powered by [cloakbrowser](https://github.com/CloakHQ/cloakbrowser).

Instead of hitting the stores' APIs with a bare HTTP client, noviq drives a
stealth Chromium browser to the app's real store page, then issues the review
calls **from inside that browser context**:

- **Apple** → the same-origin API proxy `apps.apple.com/api/...` (no bearer
  token to scrape — the proxy injects auth server-side).
- **Google Play** → the `batchexecute` RPC the Play web app itself uses.

Because the calls share the page's session, every request carries a real
fingerprint, cookies, `Origin` and `Referer`. With `humanize` on, mouse/scroll/
timing all look human. Both stores return the **same unified `Review` shape**.

Runs on [Bun](https://bun.sh) — the CLI, scripts, and tests all use it.

## Install

```bash
bun install
# cloakbrowser ships its own patched Chromium; first run downloads it (~200 MB).
```

> **Why is `playwright-core` a dependency?** cloakbrowser is built on Playwright —
> it returns Playwright `Browser`/`Page` objects and lists `playwright-core` as a
> required peer. We never call raw Playwright; our code imports only cloakbrowser
> and derives the types from it. `mmdb-lib`/`socks-proxy-agent` back geoip/SOCKS
> proxies.

## CLI

The store is auto-detected from the id: numeric → Apple, package name → Google.
Override with `--store`.

```bash
# Apple, by numeric id
bun run scrape 284882215 --country us --limit 500

# Google Play, by package name
bun run scrape com.facebook.katana --limit 500

# by store URL (Apple or Google)
bun run scrape https://apps.apple.com/us/app/instagram/id389801252 --sort mostHelpful
bun run scrape "https://play.google.com/store/apps/details?id=com.spotify.music"

# only reviews since a date (works with the default mostRecent sort)
bun run scrape com.spotify.music --since 2025-01-01
```

The CLI streams **CSV** to `./output/<store>-<appId>-<country>.csv`, writing rows
as reviews arrive (constant memory, any size). For JSON, use the library
(`getReviews` + `writeJson`).

| Option | Default | Notes |
| --- | --- | --- |
| `--store <name>` | inferred | `apple` / `google` |
| `--country <cc>` | `us` | Storefront country code |
| `--lang <tag>` | per store | Apple `en-US`, Google `en` |
| `--sort <order>` | `mostRecent` | `mostRecent` / `mostHelpful` / `rating` (Google only) |
| `--limit <n>` | all | stop after n reviews |
| `--since <date>` | — | stop at reviews older than this (mostRecent only) |
| `--stealth <preset>` | `max` | `max` / `balanced` / `fast` |
| `--headed` | off | show the browser window |
| `--proxy <url>` | — | `http://user:pass@host:8080` |
| `--geoip` | off | align browser geo/locale to proxy exit IP |
| `--profile-dir <p>` | — | reuse a persistent profile across runs |
| `--out <dir>` | `output` | output directory (CSV is written here) |

## Library

```ts
import {
  streamReviews,    // unified, store auto-detected
  getReviews,
  streamGoogleReviews,
  getAppleReviews,
  writeJson,
} from "noviq";

// Buffer into an array (store inferred from the id):
const reviews = await getReviews({ appId: "284882215", limit: 200 });
await writeJson("out.json", reviews);

// Stream from Google Play — no buffering, pipe straight into a DB/queue:
for await (const review of streamGoogleReviews({ appId: "com.spotify.music" })) {
  await db.insert(review);
}
```

### Stealth presets

| Preset | humanize | page delay | warm-up scroll | use when |
| --- | --- | --- | --- | --- |
| `max` (default) | yes | 1.4–3.2 s | yes | large pulls, low block risk |
| `balanced` | yes | 0.6–1.4 s | no | everyday scraping |
| `fast` | no | 0.15–0.4 s | no | quick small pulls |

## HTTP API (Elysia)

An [Elysia](https://elysiajs.com) server exposes the scraper over HTTP, with
Swagger/OpenAPI docs. It follows Elysia's structure conventions — the Elysia
instance *is* the controller, business logic lives in a stateless service, and
DTOs are `t.Object` models registered with `.model()`.

```bash
bun run api          # start on :3000  (PORT env to override)
bun run api:dev      # same, with --watch
```

| Route | Description |
| --- | --- |
| `GET /` | API info |
| `GET /health` | health check |
| `GET /docs` | Swagger UI (OpenAPI JSON at `/docs/json`) |
| `GET /reviews` | scrape reviews — query params below |

`GET /reviews` query: `appId` (required), `store`, `country`, `lang`, `sort`,
`limit` (1–500, default 50), `since`, `stealth`. The store is auto-detected from
`appId` unless given. Returns `{ store, appId, country, count, reviews[] }`.

```bash
curl "http://localhost:3000/reviews?appId=com.spotify.music&limit=20&stealth=fast"
curl "http://localhost:3000/reviews?appId=284882215&sort=mostHelpful&limit=50"
```

> Each request drives a real browser session, so larger `limit`s take longer.

**Production hardening** (all global Elysia plugins): security headers on every
response — `Content-Security-Policy` (relaxed only for `/docs`), `X-Frame-Options:
DENY`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection`, `Referrer-Policy`,
and `Strict-Transport-Security` in production; a 10 MB request-body limit (413);
CORS; `Server-Timing`; a consistent JSON error envelope; and graceful shutdown on
`SIGTERM`/`SIGINT`.

## Configuration (`.env`)

Bun auto-loads `.env` (copy `.env.example`). All env reads live in `src/config.ts`.

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `NODE_ENV` | `development` | `production` enables HSTS + same-origin CORS |
| `NOVIQ_PROXY` | — | upstream proxy applied to scrapes (not client-settable) |
| `NOVIQ_GEOIP` | `false` | match browser geo/locale to the proxy exit IP |
| `NOVIQ_STEALTH` | `max` | default stealth preset |
| `NOVIQ_NO_SANDBOX` | `false` | Chromium `--no-sandbox` (set automatically in Docker) |

## Docker

The runtime needs a real Chromium, so the image is built **`FROM cloakhq/cloakbrowser`**
— CloakHQ's official image (Debian 13 + the patched stealth Chromium + all OS
libraries, fonts and Python, preinstalled and verified) — with Bun added on top.

> A slim/compiled runtime (e.g. `debian:bookworm-slim` + `bun build --compile`)
> **cannot run the browser** — no Chromium, no system libs — so we don't use that
> pattern here. `bun build --compile` is also risky with cloakbrowser/playwright,
> which spawn an external Chromium process.

```bash
bun run docker:build           # docker build -t noviq:latest .
bun run docker:run             # run on :3000 (1 GB shm for Chromium)
bun run docker:up              # docker compose up --build
```

`NOVIQ_NO_SANDBOX=1` is baked into the image (Chromium runs as root in the
container); locally the full sandbox + stealth stays on. To avoid shipping a
second copy of Chromium, the entrypoint points `CLOAKBROWSER_BINARY_PATH` at the
patched Chromium already in the base image (resolved at runtime, so base-image
bumps don't break it) — keeping the image at **~2.9 GB**. Verified end-to-end:
the container scrapes both stores and the `HEALTHCHECK` reports healthy.

### Cluster mode? No.

Elysia can cluster (Bun `SO_REUSEPORT`), but noviq is **browser-bound** — each
request drives a real Chromium (hundreds of MB). Forking processes multiplies
browser memory without raising throughput. Instead, **bound concurrent sessions
and scale horizontally** (more containers behind a load balancer).

## Architecture

Everything store-specific lives behind one small interface, so the humanized
session, de-duplication, `limit`/`since` cutoffs, delays and 429 backoff are
written once and shared:

```
src/
  types.ts     unified Review + ScrapeOptions
  config.ts    single .env reader (port, proxy, stealth, geoip, …)
  browser.ts   cloakbrowser session, stealth presets, in-page fetch  (shared)
  engine.ts    StoreAdapter interface + runScraper() stream engine    (shared)
  apple.ts     Apple adapter  (amp-api same-origin proxy, offset paging)
  google.ts    Google adapter (batchexecute RPC, token paging)
  scrape.ts    store dispatcher + convenience wrappers
  output.ts    JSON / CSV / streaming CSV sink
  cli.ts       command-line entry point
  api/
    index.ts             Elysia app: plugins + swagger + module composition
    plugins/
      security.ts        security headers (CSP, HSTS, …) — global
      body-limit.ts      reject oversized bodies (413) — global
      errors.ts          consistent JSON error envelope — global
    reviews/
      model.ts           t.Object DTOs, registered via .model()
      service.ts         ReviewService — request-independent logic
      controller.ts      Elysia instance (the controller) + routes
```

See [`DIAGRAM.md`](./DIAGRAM.md) for mermaid charts of the architecture, API
request lifecycle, and the scraping engine loop.

Adding a third store is just another `StoreAdapter`: give it a `landingUrl`, an
`initialCursor`, and a `fetchBatch()` that returns normalized `Review`s plus the
next cursor.

## Unified review shape

```ts
interface Review {
  store: "apple" | "google";
  id: string;
  userName: string;
  title: string;        // "" for Google (Play has no titles)
  body: string;
  rating: number;       // 1–5
  date: string;         // ISO-8601
  developerResponse: { body: string; modified: string } | null;
  // store-specific extras:
  thumbsUp?: number;    // Google
  appVersion?: string;  // Google
  isEdited?: boolean;   // Apple
  // provenance:
  appId: string;        // numeric id (Apple) or package (Google)
  country: string;
}
```

## Testing

```bash
bun test          # unit + pipeline + api (fast, offline) — 45 tests
bun run test:live # end-to-end against the real stores (slower, network)
```

- **Unit** (`test/unit.test.ts`) — pure logic: store inference, URL/`f.req`
  building, `batchexecute` parsing, field normalization, CSV quoting.
- **Pipeline** (`test/pipeline.test.ts`) — mocks `cloakbrowser` so the whole
  engine + adapters run **with no network**: de-dup, `limit`, `since`, offset &
  token pagination, dry-page guard, 429 retry, streaming & `onReview`.
- **API** (`test/api.test.ts`) — Elysia routes via **Eden Treaty** (Elysia's
  type-safe test client): health, info, model validation (422s), Swagger/OpenAPI
  schema, security headers (incl. relaxed CSP for `/docs` and header coverage on
  errors), and the body-size limit (413). Mostly in-process; the 413 case boots
  an ephemeral server so a real `Content-Length` is present.
- **Live** (`test/live.test.ts`) — real Apple + Google pulls and a CSV
  round-trip. Skipped unless `NOVIQ_LIVE=1` (set by `bun run test:live`).

Verified live: a max-stealth Google pull of **2,000 reviews** across 20
token-paginated pages came back 100% unique with strictly descending dates.

## Notes & limits

- **No token needed for Apple** — calls go through the same-origin `/api/...`
  proxy, which injects auth server-side. **Google** uses the public web app's
  `batchexecute` RPC.
- **Reviews are de-duplicated by id** in the core stream. Offset/token paging can
  return the same review twice (e.g. when new reviews arrive mid-scrape), so each
  review is emitted at most once.
- **No practical record cap.** Apple paginates into the tens of thousands
  (verified past offset 20,000); Google chains continuation tokens until the feed
  ends. The real ceiling is the app's actual review count — use `--limit`.
- **Rate limiting is the real constraint.** Large pulls eventually hit HTTP 429;
  the `max` preset's jittered delays + exponential backoff are built for this. If
  you get throttled, slow down or add a `--proxy`.
- Respect each store's Terms of Service and applicable laws; scrape responsibly.
```
