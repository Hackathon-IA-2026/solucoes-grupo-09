# 06 — Every published attribution becomes a row, so Replay can read it

**What to build:** "what did we say at D−1" is a query, not a re-run. Every
attribution the product publishes is written once, at publication time, at
`(artifact_id, subsystem, target_date, published_at)` grain, carrying the eight
day contributions, the baseline, the day expectation, the standard error, the
peak hour and its attribution, the fired rules and the driver-group hash.

This mirrors the forecaster's rule that every served forecast is persisted as a
`Forecast` row, and for the same reason: a model that has since been retrained
cannot be asked what it used to think. It is also what makes the public
diagnosis endpoint a row read rather than an inference, which is the boundary
decision the API-surface spec rests on.

The write path is **worker → Postgres**. The modelling service is read-only
against the database; it computes and returns rows, and the worker writes them,
so the read-only guarantee stays intact and every write lives with the schema
authority. A publication is one transaction under the append-only discipline —
nothing is updated in place, so a half-written publication is not representable.

**Blocked by:** 04. Also, cross-spec: **api-surface 10** owns the scheduled
publication jobs and the worker's private call into the modelling service; this
ticket owns the row's content, its grain and its write. Whether and how Time
Machine renders it belongs to the replay ticket set, not here.

**Status:** ready-for-agent

- [ ] The attribution table exists at the stated grain, append-only, with the project's four time columns
- [ ] A published attribution carries the eight day contributions, the baseline, the day expectation, the standard error and the driver-group hash
- [ ] The peak hour and its own eight contributions are stored beside the day's
- [ ] Fired rules are stored with their payload, so a strange narration can be traced to the rule that shaped it
- [ ] The modelling service writes nothing; the worker performs the write
- [ ] The publication is one transaction and a partial write is impossible
- [ ] Re-publishing the same lane and target date appends a vintage rather than overwriting
- [ ] A stored attribution can be read back for a past date without loading a model artifact
