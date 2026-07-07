# Crawler roadmap — feeding the analytics dashboard

What the dashboard consumes today, what each store can still give us, and the
priority order. Current per-review fields: rating, title, body, ISO timestamp,
developer response (+date), userName, country; Google adds `thumbsUp` +
`appVersion`; Apple adds `isEdited`. App-level (`appInfo`, from page JSON-LD):
name, developer, category, description, averageRating, ratingCount, price,
currency, version, contentRating, OS, icon, url.

## Dashboard coverage today

| Panel | Data source | Status |
| --- | --- | --- |
| Timeline / heatmap | review timestamps | ✅ full (both stores return full timestamps) |
| Rating breakdown | scraped ratings | ✅ (scraped set only — see #1) |
| Sentiment split | rating proxy | ✅ honest proxy (see #4 for real NLP) |
| Ratings by version | `appVersion` | ⚠️ Google only — Apple's review API omits version (see #2) |
| Helpful votes | `thumbsUp` | ⚠️ Google only — Apple doesn't expose votes on the web API (hard limit) |
| Response rate | developerResponse | ✅ both |
| Identity card / store rating | appInfo | ✅ both |

## Status (2026-07-06): items 1–5 SHIPPED, live-verified

1. ✅ **Store-wide ratings histogram** — Apple: same-origin catalog API
   (`/api/apps/v1/catalog/{cc}/apps/{id}?extend=userRating`,
   `ratingCountList` index 0 = 1★); Google: ds:5 blob `[1][2][51][1]`.
   → `AppInfo.histogram`, rendered as store-wide markers in Rating breakdown.
2. ✅ **Apple version history** — same catalog API with
   `extend=versionHistory&additionalPlatforms=ipad` (the platforms param is
   required or `platformAttributes.ios` is empty). → `AppInfo.versionHistory`;
   the web app buckets Apple reviews into release windows (labeled
   "approximated from App Store release dates").
3. ✅ **Richer metadata** — Google installs (`[13][2]` real count +
   `[13][0]` display bucket), lastUpdated (`[145][0][1][0]`), released
   (`[10][1][0]`); Apple releaseDate. → identity line + AppInfo fields.
4. ✅ **Sentiment scoring** — lexicon scorer in `@noviq/core`
   (`sentiment.ts`): negation + intensifier aware, blended with the star
   rating (`classifySentiment`); UI labeled "ratings + text analysis".
5. ✅ **Reviewer avatars** — Google `r[1][1][3][2]` → `Review.avatar`,
   real images in the feed with initials fallback.

All extraction paths verified live (fixtures in `apps/api/test/fixtures/`,
live suite `test/live.test.ts · metadata extras`). New fields are API-response
only — the Postgres store keeps its original schema (extend + migrate when
stored analytics are needed).

## Next

6. **Multi-storefront runs** (product epic): fan one job out across N
   countries to power a real "reviews by country" panel and per-country
   ratings. Touches job orchestration, API shape and dashboard — spec first.

## Hard limits (don't chase)

- Apple: helpful-vote counts, reviewer avatars, per-review app version — not
  exposed by any public surface.
- Google: review titles don't exist (Play has no titles) — already modeled.
- "Installs over time", revenue, retention — store-private; only vendors with
  panel data (Sensor Tower etc.) estimate these.
