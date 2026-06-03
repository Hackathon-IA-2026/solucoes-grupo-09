# noviq

Humanized **Apple App Store review scraper** for Node.js / TypeScript, powered by
[cloakbrowser](https://github.com/CloakHQ/cloakbrowser).

Instead of hitting Apple's API with a bare HTTP client, noviq drives a stealth
Chromium browser to the app's real storefront page, then issues the review calls
**from inside that browser context** against Apple's own same-origin API proxy
(`apps.apple.com/api/...`). Because the calls share the page's session, every
request carries a real fingerprint, cookies, `Origin` and `Referer` — and no
bearer token ever has to be scraped (the proxy injects auth server-side). With
`humanize` on, mouse/scroll/timing all look human.

> Google Play support is planned — this first cut is Apple-only.

## Install

```bash
npm install
# cloakbrowser ships its own patched Chromium; first run downloads it.
```

## CLI

```bash
# by numeric app id
npx tsx src/cli.ts 284882215 --country us --limit 500

# by App Store URL, sorted by most helpful, CSV only, visible browser
npx tsx src/cli.ts https://apps.apple.com/us/app/instagram/id389801252 \
  --sort mostHelpful --format csv --headed

# only reviews since a date (works with the default mostRecent sort)
npx tsx src/cli.ts 284882215 --since 2025-01-01
```

Output lands in `./output/apple-<appId>-<country>.{json,csv}`.

| Option | Default | Notes |
| --- | --- | --- |
| `--country <cc>` | `us` | Storefront country code |
| `--lang <tag>` | `en-US` | BCP-47 review language |
| `--sort <order>` | `mostRecent` | or `mostHelpful` |
| `--limit <n>` | all | stop after n reviews |
| `--since <date>` | — | stop at reviews older than this (mostRecent only) |
| `--stealth <preset>` | `max` | `max` / `balanced` / `fast` |
| `--headed` | off | show the browser window |
| `--proxy <url>` | — | `http://user:pass@host:8080` |
| `--geoip` | off | align browser geo/locale to proxy exit IP |
| `--profile-dir <p>` | — | reuse a persistent profile across runs |
| `--out <dir>` | `output` | output directory |
| `--format <fmt>` | `both` | `json` / `csv` / `both` |

## Library

```ts
import { getAppleReviews, streamAppleReviews, writeJson } from "noviq";

// Buffer everything into an array:
const reviews = await getAppleReviews({ appId: "284882215", limit: 200 });
await writeJson("out.json", reviews);

// Or stream (no buffering — pipe straight into a DB/queue):
for await (const review of streamAppleReviews({ appId: "284882215" })) {
  await db.insert(review);
}
```

### Stealth presets

| Preset | humanize | page delay | warm-up scroll | use when |
| --- | --- | --- | --- | --- |
| `max` (default) | yes | 1.4–3.2 s | yes | large pulls, low block risk |
| `balanced` | yes | 0.6–1.4 s | no | everyday scraping |
| `fast` | no | 0.15–0.4 s | no | quick small pulls |

## How it works

1. **Launch** cloakbrowser (optionally headed, proxied, geoip-matched, or with a
   persistent profile).
2. **Navigate** to `apps.apple.com/<cc>/app/id<appId>` and (max stealth) scroll a
   bit like a real visitor.
3. **Capture** the `bearer` token from the first `amp-api.apps.apple.com` request
   the page makes; fall back to parsing the embedded config if needed.
4. **Paginate** `…/v1/catalog/<cc>/apps/<appId>/reviews` 20 at a time via in-page
   `fetch`, following amp-api's `next` offsets, with 429 backoff and jittered
   delays, until exhausted (HTTP 404) or your `limit`/`since` is hit.

## Review shape

```ts
interface AppleReview {
  id: string;
  userName: string;
  title: string;
  body: string;
  rating: number;        // 1–5
  date: string;          // ISO-8601
  isEdited: boolean;
  developerResponse: { body: string; modified: string } | null;
  appId: string;
  country: string;
}
```

## Notes & limits

- **No token needed** — calls go through Apple's same-origin `/api/...` proxy
  from inside the browser session, which injects auth server-side.
- **Reviews are de-duplicated by id** in the core stream. Offset pagination can
  return the same review twice (e.g. when new reviews arrive mid-scrape and
  shift later offsets), so every review is emitted at most once.
- **No practical record cap.** For popular apps the feed paginates into the tens
  of thousands (verified past offset 20,000); the real ceiling is the app's
  actual review count. Use `--limit` to bound a run.
- **Rate limiting is the real constraint.** Large pulls eventually hit HTTP 429;
  the `max` preset's jittered delays + exponential backoff are built for this.
  If you get throttled, slow down or add a `--proxy`.
- Respect Apple's Terms of Service and applicable laws; scrape responsibly.
