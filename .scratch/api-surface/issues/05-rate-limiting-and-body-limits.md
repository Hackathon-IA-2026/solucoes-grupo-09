# 05 — The published budget is the real budget

**What to build:** the surface is public, unauthenticated and account-free, and
behind it sit a branch-and-bound solver and a language model. One budget cannot
protect both, and neither is protected by counting page views.

**Three tiers.** The unmetered probes stay as built. Reads get **120/min/IP** as
a fixed window — almost every hit is a shared-cache hit anyway. The solve tier —
the optimize and replay routes — gets **30/min/IP with a burst of 10** as a
**token bucket**, because a fixed window lets 60 requests through across a window
boundary and the optimizer spec asked for a bucket.

**Four defects in the limiter, each a correctness issue rather than a
preference:**

1. **It is in-memory and per-process.** The comment is honest that there is
   exactly one API process today, and the platform can scale that service with a
   checkbox, at which point the published budget silently multiplies by the
   replica count. Redis is already a dependency; the counter moves there, with
   the in-memory map as the no-Redis fallback.
2. **The client key trusts the first forwarded-for hop unconditionally**, which
   is correct behind a trusted proxy that overwrites the header and is a free
   budget reset for anyone who can reach the port directly. Take the *n*-th
   hop from the end, where *n* is a configured trusted-proxy depth defaulting
   to 1.
3. **It is a fixed window** where the solve tier needs a bucket.
4. **Its 429 body is a bare string**, not the envelope from ticket 02. It keeps
   `Retry-After` and gains the envelope.

**Body limits become per-route.** The global 10 MB limit is right for an
ingestion endpoint and wrong for a solver: the scenario is capped at 4096 bytes
by the optimizer spec, so the two POST routes take **16 KB**, rejected on
`Content-Length` before anything is allocated. The limit function already takes
the parameter; it needs mounting per route rather than only globally.

The narration's language-model call is **not** protected here — it is protected
by a single-flight lock and a daily cap in ticket 15, because the scarce resource
is the call and not the request.

**Blocked by:** 02 (the 429 envelope). Independent of every model and every
endpoint — it can run alongside 03 and 04.

**Status:** ready-for-agent

- [ ] Three tiers with three budgets, each asserted
- [ ] The solve tier is a token bucket that permits a burst of ten and then throttles
- [ ] With Redis configured, two API instances share one budget
- [ ] Without Redis, the in-memory fallback works and says so
- [ ] The client key ignores forwarded-for hops beyond the configured trusted depth
- [ ] A 429 carries the error envelope and `Retry-After`
- [ ] A 16 KB body on a solve route is rejected before any handler runs
- [ ] The rejection is a 413 with the envelope's payload-too-large code
