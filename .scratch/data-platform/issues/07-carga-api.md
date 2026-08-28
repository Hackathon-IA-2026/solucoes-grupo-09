# 07 — Load API adapter

**What to build:** WattSteer has verified and programmed load at semi-hourly grain,
including the finer geoelectric-area breakdown, from the only ONS source that
publishes no bulk files at all.

This is a different adapter shape from everything before it: a REST API with a
per-call range limit, no downloadable files, and a specification that is not
published as a document.

It also carries the single most dangerous silent failure found in any source. The
subsystem code for the south-east differs from the code every other dataset uses,
and passing the familiar one returns HTTP success with an empty array rather than
an error. A pipeline built without knowing this reports that a quarter of the
country has no load.

It is, conversely, the only source with a genuine row-level vintage marker from
ONS itself — worth capturing precisely because nothing else has one.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Both the verified and programmed series are ingested at semi-hourly grain
- [ ] The correct subsystem code is used, and a test proves the familiar one returns no rows
- [ ] An empty response for a period known to have data is treated as a failure
- [ ] Requests are chunked to the documented range limit
- [ ] Malformed historical responses are parsed tolerantly rather than aborting a backfill
- [ ] The source's own row-level update stamp is captured and stored
- [ ] Timestamps documented as UTC are not double-converted
- [ ] End-of-interval labelling is normalised to start-of-interval
