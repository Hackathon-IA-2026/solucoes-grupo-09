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

# by store URL (Apple or Google) — the storefront country in the URL is honored
# (Apple's /gb/ path segment, Google's gl= param), unless you pass --country
bun run scrape https://apps.apple.com/gb/app/instagram/id389801252 --sort mostHelpful
bun run scrape "https://play.google.com/store/apps/details?id=com.spotify.music&gl=br"

# only reviews since a date (works with the default mostRecent sort)
bun run scrape com.spotify.music --since 2025-01-01
```

The CLI streams **CSV** to `./output/<store>-<appId>-<country>.csv`, writing rows
as reviews arrive (constant memory, any size). For JSON, use the library
(`getReviews` + `writeJson`).


| Option               | Default      | Notes                                                 |
| -------------------- | ------------ | ----------------------------------------------------- |
| `--store <name>`     | inferred     | `apple` / `google`                                    |
| `--country <cc>`     | `us`         | Storefront country code (overrides a country in the URL) |
| `--lang <tag>`       | per store    | Apple `en-US`, Google `en`                            |
| `--sort <order>`     | `mostRecent` | `mostRecent` / `mostHelpful` / `rating` (Google only) |
| `--limit <n>`        | all          | stop after n reviews                                  |
| `--since <date>`     | —            | stop at reviews older than this (mostRecent only)     |
| `--stealth <preset>` | `max`        | `max` / `balanced` / `fast`                           |
| `--headed`           | off          | show the browser window                               |
| `--proxy <url>`      | —            | `http://user:pass@host:8080`                          |
| `--geoip`            | off          | align browser geo/locale to proxy exit IP             |
| `--profile-dir <p>`  | —            | reuse a persistent profile across runs                |
| `--out <dir>`        | `output`     | output directory (CSV is written here)                |


## Library

```ts
import {
  streamReviews,    // unified, store auto-detected
  getReviews,
  getAppInfo,       // app metadata only (no reviews)
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

// Just the app's metadata (one landing-page visit, no review pagination):
const app = await getAppInfo({ appId: "284882215" });
console.log(app?.name, app?.developer, app?.averageRating, app?.ratingCount);

// Or capture metadata alongside a stream via the onAppInfo callback:
for await (const review of streamReviews({
  appId: "com.spotify.music",
  onAppInfo: (info) => console.log("app:", info?.name),
})) { /* … */ }
```

### Stealth presets


| Preset          | humanize | page delay | warm-up scroll | use when                    |
| --------------- | -------- | ---------- | -------------- | --------------------------- |
| `max` (default) | yes      | 1.4–3.2 s  | yes            | large pulls, low block risk |
| `balanced`      | yes      | 0.6–1.4 s  | no             | everyday scraping           |
| `fast`          | no       | 0.15–0.4 s | no             | quick small pulls           |


## HTTP API (Elysia)

An [Elysia](https://elysiajs.com) server exposes the scraper over HTTP, with
Swagger/OpenAPI docs. It follows Elysia's structure conventions — the Elysia
instance *is* the controller, business logic lives in a stateless service, and
DTOs are `t.Object` models registered with `.model()`.

```bash
bun run api          # start on :3000  (PORT env to override)
bun run api:dev      # same, with --watch
```


| Route                  | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `GET /`                | API info                                          |
| `GET /health`          | liveness + live scrape concurrency stats          |
| `GET /ready`           | readiness — Chromium binary available (503 if not)|
| `GET /reviews`         | scrape reviews (synchronous) — query params below |
| `GET /app`             | app metadata only (no reviews) — fast, one page   |
| `POST /reviews/jobs`   | submit an async scrape job → `202 {id}`           |
| `GET /reviews/jobs/:id`| async job status / result                         |
| `GET /reviews/stored`  | query persisted reviews (Postgres; no browser)    |
| `GET /apps/stored`     | query persisted app metadata (Postgres; no browser)|
| `GET /docs`            | Swagger UI (OpenAPI JSON at `/docs/json`)         |
| `GET /jobs`            | BullMQ dashboard (opt-in; `NOVIQ_DASHBOARD=true`) |


`GET /reviews` query: `appId` (required), `store`, `country` (2 letters), `lang`,
`sort`, `limit` (1–500, default 50), `since` (date), `stealth`. The store is
auto-detected from `appId` unless given. Returns
`{ store, appId, country, count, partial, reviews[], appInfo }` — where `appInfo`
is the app's metadata (see [App metadata](#app-metadata) below) captured in the
same session, or `null` if the page exposed none.

```bash
curl "http://localhost:3000/reviews?appId=com.spotify.music&limit=20&stealth=fast"
curl "http://localhost:3000/reviews?appId=284882215&sort=mostHelpful&limit=50"
```

> Each request drives a real browser session, so larger `limit`s take longer.

### App metadata

Beyond individual reviews, noviq captures **app-level metadata** — name,
developer, category, aggregate rating + count, price, version, content rating —
read from the schema.org `SoftwareApplication` JSON-LD that both stores embed in
their landing page. It's a stable, standard format (not reverse-engineered
internals) and free to read, since the session already loads that page. It rides
along on every `GET /reviews` (in `appInfo`), or fetch it alone — no review
pagination, so it's fast:

```bash
# metadata only → { store, appId, country, appInfo }
curl "http://localhost:3000/app?appId=com.spotify.music"
curl "http://localhost:3000/app?appId=284882215&country=gb"
```

`appInfo` is best-effort: any field the page omits is `null`, and the whole
object is `null` if no structured data is found — it never blocks a scrape.

### Async jobs (for large pulls)

A big scrape can outlive a safe HTTP request. Submit it as a **job** instead —
the work runs in the background and you poll for the result:

```bash
# submit → 202 { "id": "...", "status": "waiting" }
curl -X POST http://localhost:3000/reviews/jobs \
  -H 'content-type: application/json' \
  -d '{"appId":"com.spotify.music","store":"google","limit":2000}'

# poll → { "id", "status": "waiting|active|completed|failed", "result"? }
curl http://localhost:3000/reviews/jobs/<id>
```

The backend is a **pluggable `JobRunner` (Strategy)**: set **`REDIS_URL`** to run
jobs on a durable **BullMQ** queue (survives restarts, scales to N workers);
leave it unset for a zero-dependency in-process runner (dev/single box). The API
is identical either way.

- **Cleanup:** finished jobs auto-remove from Redis after a retention window
  (`NOVIQ_JOB_RETENTION_SEC`, default 1 h for completed; 24 h for failed) with a
  count cap as a backstop — so results stay poll-able for a while, then Redis is
  cleaned automatically. (We can't delete on completion: the *result lives in the
  job*, so `GET /reviews/jobs/:id` must be able to read it first.)
- **Scaling:** by default the API process also runs an embedded worker
  (`NOVIQ_ROLE=all`). To scale scraping separately, set `NOVIQ_ROLE=api` and run
  dedicated workers: `bun run worker` (each caps at `NOVIQ_MAX_CONCURRENCY`).
- **Dashboard:** `NOVIQ_DASHBOARD=true` mounts BullMQ **Workbench** at `/jobs`
  (protect it — it exposes queue controls).
- **Retries:** failed jobs retry with exponential backoff (`NOVIQ_JOB_ATTEMPTS`,
  default 3). Safe because the handler is **idempotent** — scraping is read-only,
  so a retry (or BullMQ's at-least-once redelivery after a crash) just re-scrapes,
  nothing to corrupt. Only *total* failures retry; partial results complete.
- **Resilience:** failed jobs store only a client-safe message; queue ops are
  time-bounded so a Redis stall returns an error instead of hanging; `close()`
  drains in-flight work on shutdown.

### Persistence (Postgres + Drizzle)

Set **`DATABASE_URL`** and every scrape's reviews **and the app's metadata** are
saved durably (best-effort — a DB blip never fails the scrape). Query them later
with no browser:

```bash
curl "http://localhost:3000/reviews/stored?appId=com.spotify.music&store=google&limit=50"
curl "http://localhost:3000/apps/stored?appId=com.spotify.music&store=google"
```

- **Drizzle + drizzle-typebox**: the `reviews` / `apps` / `scrape_runs` tables
  (`src/database/schema.ts`) are the single source of truth — the `/reviews/stored`
  and `/apps/stored` response models are derived from the tables via
  `createSelectSchema`.
- **Dedup**: reviews upsert on `(store, id)`; app metadata upserts on
  `(store, appId, country)` (the same app differs per storefront — price, rating,
  localized name), so re-scraping refreshes rows instead of duplicating.
- **Schema**: `bun run db:push` applies `schema.ts` straight to the database
  (the workflow used here). Migration files (`bun run db:generate` /
  `db:migrate`) remain available but aren't the source of truth.

#### What lives where — Redis vs Postgres

They're **complementary layers, not either/or**:

| | Redis (BullMQ) | Postgres (Drizzle) |
| --- | --- | --- |
| Role | the **queue** + ephemeral coordination | **durable data** |
| Holds | pending/active jobs, retries, backoff, locks, worker distribution, and the *transient* job result (TTL'd so you can poll it) | the **reviews** + **app metadata** (both deduped, queryable forever) + a `scrape_runs` audit log |
| Lifetime | minutes–hours (auto-cleaned) | permanent until you delete |
| Required | only for the async job API | only to persist/query reviews |

So it's **not** "only data in the DB": Redis *must* keep the queue (it's the queue
engine), and Postgres keeps the durable reviews + run history that outlive Redis's
retention. A scrape flows: enqueue (Redis) → worker scrapes → **save reviews
(Postgres)** → result cached briefly (Redis) for polling.

**Hardening** (global Elysia plugins): security headers (CSP relaxed only for
`/docs`, `X-Frame-Options: DENY`, `nosniff`, `X-XSS-Protection`, `Referrer-Policy`,
HSTS in prod); 10 MB body limit (413); CORS; `Server-Timing`.

### Error resistance

Every request is guaranteed to terminate cleanly with a correct status, and the
browser is always released:

- **Timeouts** — 30 s per in-page fetch + a hard per-scrape budget; on timeout the
  scrape aborts and the browser is closed (no leaks).
- **Concurrency cap** — a semaphore bounds simultaneous scrapes; excess **queues**,
  then **503** when the queue is full (protects host RAM).
- **Typed errors → correct codes** — bad input **400**, upstream/store failure
  **502**, timeout **504**, capacity **503**, unknown **500** — never leaking
  internal messages or stacks.
- **Bounded retries** — transient navigation (5xx/network) and mid-stream blips
  (429 + transient throws) retry with backoff, then give up gracefully.
- **Partial results** — a timeout / mid-stream failure returns what was collected
  with `partial: true` instead of all-or-nothing.
- **No silent truncation** — if a store returns a `200` whose body doesn't carry
  the expected reviews payload (format change or a soft-block behind a `200`), the
  parse **fails loudly** (→ retry, then **502**/`partial`) rather than being
  mistaken for "no more reviews" and quietly cutting the pull short.
- **Survives stray rejections** — an `unhandledRejection` is logged, not fatal;
  only `uncaughtException` triggers a graceful shutdown.
- **Correlation** — `x-request-id` on every response and in structured logs.
- **Readiness** — `/ready` so orchestrators don't route traffic to a broken node.

## Configuration (`.env`)

Bun auto-loads `.env` (copy `.env.example`). All env reads live in `src/config.ts`.


| Var                | Default       | Purpose                                                 |
| ------------------ | ------------- | ------------------------------------------------------- |
| `PORT`             | `3000`        | API port                                                |
| `NODE_ENV`         | `development` | `production` enables HSTS + same-origin CORS            |
| `NOVIQ_PROXY`      | —             | upstream proxy applied to scrapes (not client-settable) |
| `NOVIQ_GEOIP`      | `false`       | match browser geo/locale to the proxy exit IP           |
| `NOVIQ_STEALTH`    | `max`         | default stealth preset                                  |
| `NOVIQ_NO_SANDBOX` | `false`       | Chromium `--no-sandbox` (set automatically in Docker)   |
| `NOVIQ_MAX_CONCURRENCY` | `2`      | max simultaneous scrapes (tune to host RAM)             |
| `NOVIQ_MAX_QUEUE`  | `20`          | queued scrapes before 503                               |
| `NOVIQ_SCRAPE_TIMEOUT_MS` | `120000` | per-scrape budget (→ partial or 504)                  |
| `NOVIQ_NAV_TIMEOUT_MS` | `60000`   | page navigation timeout                                 |
| `NOVIQ_FETCH_TIMEOUT_MS` | `30000` | per in-page fetch timeout                               |
| `NOVIQ_NAV_RETRIES` | `2`          | bounded retries on transient navigation failures        |
| `REDIS_URL`        | —             | enable durable BullMQ job queue (else in-process)       |
| `DATABASE_URL`     | —             | Postgres URL — persist + query reviews (else off)       |
| `NOVIQ_DASHBOARD`  | `false`       | mount BullMQ Workbench dashboard at `/jobs` (protect it) |


## Docker

The runtime needs a real Chromium, so the image is built `**FROM cloakhq/cloakbrowser`**
— CloakHQ's official image (Debian 13 + the patched stealth Chromium + all OS
libraries, fonts and Python, preinstalled and verified) — with Bun added on top.

> A slim/compiled runtime (e.g. `debian:bookworm-slim` + `bun build --compile`)
> **cannot run the browser** — no Chromium, no system libs — so we don't use that
> pattern here. `bun build --compile` is also risky with cloakbrowser/playwright,
> which spawn an external Chromium process.

```bash
bun run docker:build           # docker build -t noviq:latest .
bun run docker:run             # single container on :3000 (1 GB shm)
bun run docker:up              # full stack: Redis + API + worker
```

`docker compose` runs the **production topology** — three services sharing one
image: `redis` (durable queue), `api` (`NOVIQ_ROLE=api`, enqueues async jobs +
serves sync `/reviews`), and `worker` (`NOVIQ_ROLE=worker`, pulls jobs and
scrapes). Compose points `REDIS_URL` at the in-compose Redis (overriding any
`.env`). Scale scraping out independently:

```bash
docker compose up --build --scale worker=3
```

Verified end-to-end: a job POSTed to the API is enqueued to Redis and processed
by the separate worker container (`waiting → active → completed`).

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
  types.ts     unified Review + AppInfo + ScrapeOptions + ScrapeResult
  config.ts    single .env reader (port, proxy, stealth, limits, redis, …)
  errors.ts    domain errors (Bad/Upstream/Timeout/Busy) + toHttpError
  concurrency.ts  Semaphore (resource ceiling, queue → 503)
  resolve.ts   Chain of Responsibility: id/package/URL → { store, appId, country? }
  pipeline.ts  Pipeline + CoR: dedupe → notOlderThan → limit review stages
  pagination.ts State Machine: Paginator owns the cursor + keep-going decision
  appinfo.ts   pure JSON-LD (schema.org) → unified AppInfo parser  (shared)
  browser.ts   cloakbrowser session, stealth, retrying nav, in-page fetch, JSON-LD read  (shared)
  engine.ts    StoreAdapter (Strategy) + runScraper() + fetchAppInfo()   (shared)
  apple.ts     Apple adapter  (amp-api same-origin proxy, offset paging)
  google.ts    Google adapter (batchexecute RPC, token paging)
  scrape.ts    store dispatcher + convenience wrappers + getAppInfo
  output.ts    JSON / CSV / streaming CSV sink
  cli.ts       command-line entry point (CSV reviews + app.json sidecar)
  jobs/        JobRunner (Strategy): in-process + BullMQ/Redis backends
    types.ts · inprocess.ts · bullmq.ts · index.ts (factory)
  worker.ts    dedicated BullMQ worker entrypoint (`bun run worker`)
  database/    Postgres + Drizzle (durable reviews + app metadata)
    schema.ts (reviews/apps/scrape_runs + drizzle-typebox) · connection.ts · repository.ts
    plugin.ts (decorate repo) · index.ts (barrel)
  api/
    index.ts             Elysia app: plugins + swagger + module composition
    jobs-dashboard.ts    opt-in BullMQ Workbench mount (/jobs)
    plugins/
      security.ts        security headers (CSP, HSTS, …) — global
      request-context.ts x-request-id + structured request logging — global
      body-limit.ts      reject oversized bodies (413) — global
      errors.ts          maps domain errors → safe HTTP responses — global
    reviews/
      model.ts           t.Object DTOs (reviews + appInfo), registered via .model()
      service.ts         ReviewService — validate + gated scrape + appInfo
      controller.ts      reviewsRoutes(runner) — sync, async job, /app, stored routes
      runner.ts          process-wide JobRunner singleton (from config)
```

See `[DIAGRAM.md](./DIAGRAM.md)` for mermaid charts of the architecture, API
request lifecycle, and the scraping engine loop.

Adding a third store is just another `StoreAdapter`: give it a `landingUrl`, an
`initialCursor`, and a `fetchBatch()` that returns normalized `Review`s plus the
next cursor. App metadata comes for free — the engine reads the landing page's
schema.org JSON-LD generically (`appinfo.ts`), so a new store needs no
metadata-specific code as long as its page embeds the standard structured data.

### Design patterns

The engine is composed from four classic patterns, each isolated in its own
module and unit-tested without a browser (`test/patterns.test.ts`):

| Pattern | Where | Why |
| --- | --- | --- |
| **Strategy** | `StoreAdapter` + `appleAdapter`/`googleAdapter` | swap store-specific fetch/paginate logic behind one interface |
| **Chain of Responsibility** | `resolve.ts` (`RESOLVERS`) | id / package / store-URL → `{store, appId}`; first link that recognizes the input wins |
| **Pipeline + Chain of Responsibility** | `pipeline.ts` (`ReviewPipeline`) | each review flows `dedupe → notOlderThan → limit`; first `drop`/`stop` short-circuits |
| **State Machine** | `pagination.ts` (`Paginator`) | owns the cursor and the keep-going / dry-page / stop transitions |

`runScraper` just wires them together, so its loop stays a flat
`while (paginator.state === "fetch")`.

## Unified shapes

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

App-level metadata, unified across stores (every field is best-effort — `null`
when the store's landing page doesn't expose it):

```ts
interface AppInfo {
  store: "apple" | "google";
  appId: string;
  country: string;
  name: string | null;
  developer: string | null;
  category: string | null;
  description: string | null;
  averageRating: number | null;  // aggregate stars, e.g. 4.7
  ratingCount: number | null;
  price: number | null;          // 0 = free, null = unknown
  currency: string | null;       // ISO-4217, e.g. "USD"
  version: string | null;
  contentRating: string | null;  // age rating, e.g. "4+"
  operatingSystem: string | null;
  icon: string | null;           // image URL
  url: string | null;            // canonical store URL
}
```

## Testing

```bash
bun test          # unit + pipeline + api (fast, offline) — 119 tests
bun run test:db   # repository against a real Postgres (push schema first)
bun run test:redis # BullMQ runner against a real Redis
bun run test:live # end-to-end against the real stores (slower, network)
```

- **Unit** (`test/unit.test.ts`) — pure logic: store inference, URL/`f.req`
building, `batchexecute` parsing, field normalization, CSV quoting.
- **App metadata** (`test/appinfo.test.ts`) — the pure `parseAppInfo` JSON-LD
parser: App Store / Google Play shapes, `@graph` and multi-node arrays, `@type`
arrays, structural fallback, number/price coercion, malformed-script tolerance,
and the "no usable fields → null" guard.
- **Pipeline** (`test/pipeline.test.ts`) — mocks `cloakbrowser` so the whole
engine + adapters run **with no network**: de-dup, `limit`, `since`, offset &
token pagination, dry-page guard, 429 retry, streaming & `onReview`, plus app
metadata (extraction opt-in via `onAppInfo`, best-effort failure, `getAppInfo`).
- **API** (`test/api.test.ts`) — Elysia routes via **Eden Treaty** (Elysia's
type-safe test client): health, info, model validation (422s) for `/reviews`,
`/app` and the stored endpoints, Swagger/OpenAPI schema, security headers (incl.
relaxed CSP for `/docs` and header coverage on errors), and the body-size limit
(413). Mostly in-process; the 413 case boots an ephemeral server so a real
`Content-Length` is present.
- **Database** (`test/database.test.ts`) — the repository against a real
Postgres: review + app-metadata upsert/dedup and filtering. Schema is applied by
`db push` (the `test:db` script does this first). Skipped without a test DB.
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

```

