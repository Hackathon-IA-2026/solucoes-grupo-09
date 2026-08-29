# 06 — One request tells you what this deployment can actually do

**What to build:** the precondition every screen reads first, and the endpoint
that makes a misconfigured deployment diagnosable in a single request.

It is the **gateway's own answer**, not a proxy of the modelling service's
equivalent. It merges what only the gateway knows — ingestion freshness, the
published forecast origins, the window bounds, the constants, the licence
attribution — with what only the modelling service knows: the artifact lanes and
the artifact volume. And it **degrades**: if the modelling service is
unreachable, the model block says `unreachable` and the rest of the body is
still correct.

Five things it carries and why each is load-bearing:

- **`model.lanes[].state` reproduces the forecaster's three states verbatim** —
  `no_artifact`, `present_unpromoted`, `promoted` — because "a stale forecast and
  an unmounted volume do not look alike" is a requirement, and the volume state
  is reported separately for the same reason.
- **`forecast.latest_published` and `next_publication_at`**, which is what makes
  a failed publication a visible event rather than something discovered when
  somebody loads a page.
- **The gate table** — profile, local publish time, timezone, weather run — so
  that the Overview's "tomorrow's view publishes at 19:00 BRT" sentence is
  **data**, not a hardcoded string.
- **`data.freshness` per source**, with the latest valid time, the latest
  ingestion and the lag.
- **The attribution block as data**, not copy: source name, licence identifier
  and URL for each upstream, with the plant registry's machine-readable location
  named. A bilingual notice assembled from translated strings around
  untranslated licence identifiers is exactly the shape the i18n rule asks for.

It is `no-store`. It is what you read to discover that something is broken, and a
cached answer to that question is worse than none.

A noted weakness, carried deliberately: this document does five jobs — capability
discovery, freshness, constants, licensing and artifact state — and it will grow.
The argument for one document is that a client needs all five before it renders
anything, and five round trips before first paint is worse.

**Blocked by:** 03, 04.

**Status:** ready-for-agent

- [ ] One request returns the window bounds, the defaults, the gate table, the model lanes, the forecast publication state, the ingestion freshness, the reference fleet and the attribution block
- [ ] With the modelling service unreachable, the response is a 200 and only the model block degrades
- [ ] The three artifact states are reported verbatim, and the volume state is reported separately from them
- [ ] The gate instants are data, so no screen hardcodes a publication time
- [ ] The response is `no-store` and carries no ETag
- [ ] The attribution block names each source's licence identifier untranslated
- [ ] The reference fleet is echoed, and a test asserts nothing fetches it in order to use it
