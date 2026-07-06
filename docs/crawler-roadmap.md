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

## What we can still extract (priority order)

1. **Store-wide ratings histogram** (both stores, high value / low effort).
   Both product pages embed per-star counts (Apple: `ratingCountList` in the
   page's embedded JSON; Google: histogram in the page payload). Lets the
   Rating-breakdown panel show *scraped sample vs entire store* — a killer
   comparison. → extend `appinfo.ts` extraction + `AppInfo.histogram?: number[5]`.
2. **Apple version history** (medium effort). `apps.apple.com` exposes the
   version history (version + release date + notes) on the product page.
   Correlating review dates with release windows gives "ratings by version"
   for Apple (approximate, label it as such).
3. **Richer app metadata** (low effort, page-embedded): Google `installs`,
   `lastUpdated`, `releasedDate`, ads/IAP flags; Apple size, languages,
   subtitle, whatsNew. Feeds the identity card and new stat tiles.
4. **Real sentiment scoring** (app/API-side, not crawler): lexicon-based
   scoring (AFINN/VADER-style) over review bodies as a second signal next to
   the rating proxy. No store dependency; could run client-side.
5. **Reviewer avatars** (Google only, trivial): avatar URL is in the
   batchexecute payload → real images in the feed instead of initials.
6. **Multi-storefront runs** (bigger feature): fan one job out across N
   countries to power a real "reviews by country" panel (the reference's
   unused `countries` data) and per-country ratings.

## Hard limits (don't chase)

- Apple: helpful-vote counts, reviewer avatars, per-review app version — not
  exposed by any public surface.
- Google: review titles don't exist (Play has no titles) — already modeled.
- "Installs over time", revenue, retention — store-private; only vendors with
  panel data (Sensor Tower etc.) estimate these.
