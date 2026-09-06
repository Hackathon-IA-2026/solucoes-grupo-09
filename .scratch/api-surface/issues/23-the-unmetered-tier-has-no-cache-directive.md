# 23 — Four more routes let an intermediary invent their freshness

**What to build:** the rest of the hole the caching pass closed half of.

api-surface 20 found `/v1/canonical/*` and `/ingest/health` shipping with no
`Cache-Control`; those are fixed. The agent that fixed them reported, and left,
four more in the spec's **Unmetered** tier: `/`, `/health`, `/ready` and `/docs`.
It was right not to widen its own footprint, and right that fixing one of the four
without the others would be arbitrary.

**`/ready` is the one that matters.** It reports whether the database is reachable
and answers 503 when it is not — which is `/ingest/health`'s argument almost
verbatim: a cached 200 during an outage is a monitor being told everything is
fine, with the cache doing the silencing. A readiness probe is the last endpoint
that should be allowed a lifetime it did not choose.

`/` and `/docs` are a different question and may honestly want a short `max-age`
with a validator; `/health` is a liveness probe. **Decide each on its own reason
and write the reason down** — the caching table's whole discipline is that a
directive is an argument, not a default. Note that pass rejected `no-cache` for
the canonical reads specifically because there was no validator to build; check
whether that applies here before reaching for it.

**Blocked by:** api-surface 20 (merged).

**Status:** done

- [ ] All four routes carry a directive chosen for a stated reason
- [ ] `/ready` and `/health` cannot be served stale from a shared cache
- [ ] Whatever `/` and `/docs` get, the argument is in the spec beside the others
- [ ] No key gained a duration or a clock — the existing scan still passes
- [ ] The row count claimed in the table, the module header and the test header
      agree with reality (they have drifted twice already)
