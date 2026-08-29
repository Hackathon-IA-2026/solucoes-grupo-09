# 20 — A cache key is a provenance, never a duration

**What to build:** the caching policy across the whole surface, applied as one
rule with one reason.

Every entity in this domain already carries the thing that should invalidate it —
a forecast origin, a data version, an artifact identity, a scenario hash — and a
key built from those has **no manual invalidation path to forget to call**. A
cache keyed on a duration is a guess about how fast the world changes; a cache
keyed on a provenance is a statement that this response *is* that version.

| Surface | Shared-cache directive | Key |
|---|---|---|
| meta | `no-store` | — |
| outlook, day-ahead | `public, max-age=300, stale-while-revalidate=3600` | artifact id + publication instant + max data version |
| now | `public, max-age=60` | latest ingestion instant |
| observed, settled past range | `public, max-age=3600, stale-while-revalidate=86400` | max data version in range |
| observed, touching the last 48 h | `public, max-age=300` | same |
| diagnosis | `public, max-age=300`, `Vary: Accept-Language` | the attribution row's version plus the narration key |
| model card | `public, max-age=3600` | artifact id |
| optimize (query form) | `public, max-age=300` | scenario hash + origin + optimizer build |
| optimize (body form) | `no-store` | the same Redis key |
| replay | `public, max-age=600` | scenario hash + date + origin + optimizer build + **observed data version** |
| replay days, backtest | `public, max-age=3600` | featured-days computation id |
| plants | `public, max-age=86400` | registry snapshot ingestion instant |

**Two premises corrected**, and both matter:

- **A forecast changes twice daily, not once.** A duration tuned to "daily" would
  serve the morning view for ten hours after the evening view existed. Hence the
  five-minute freshness and an ETag carrying the origin: revalidation is cheap and
  correctness does not depend on the clock.
- **A replay is reproducible, not immutable.** The forecast half reproduces
  byte-identically at a pinned origin; the observed half is read as-of now, and
  ONS restates history in place — a whole year, under the same filenames, with no
  version marker. So the observed data version is in the key, and **nothing on
  this surface carries `immutable`**. A cache that froze a replay against a
  restatement would hide precisely the thing the project's vintage vocabulary
  exists to surface.

There are no accounts, no cookies and no authorization header, so every read is
shared-cacheable and there is no variation beyond the language header on the one
route that generates prose. The stale-while-revalidate directives are what turn a
publication failure into a slightly older number instead of a spinner.

**Blocked by:** 11, 13, 14, 15, 17 — this ticket applies a policy to routes that
must exist first.

**Status:** ready-for-agent

- [ ] Every read carries an ETag and revalidates to a 304 rather than re-querying
- [ ] A superseding late-gate publication changes the forecast ETag by construction
- [ ] A re-ingest that writes no new data version does not change the ETag
- [ ] A replay's key changes when the observed data version changes and not otherwise
- [ ] A scenario re-encoded with a trailing zero hits the same key
- [ ] A grep-level assertion over the header middleware proves no response carries `immutable`
- [ ] The diagnosis has exactly two caches and no third key exists over its composed response
