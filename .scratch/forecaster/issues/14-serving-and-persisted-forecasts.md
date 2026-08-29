# 14 — Serve the real band, refuse when there is none, and keep what was said

**What to build:** the day-ahead endpoint returns a real forecast from the
promoted artifact — hour bands, expected MWh, the technology split, day energy,
peak power and day-level occurrence — or refuses; and every forecast it serves
is persisted, so "what did we say at D−1" becomes a query rather than a re-run.

The service **refuses rather than invents** when no promoted artifact exists for
the lane, keeping the stub's stated rule intact and returning a typed body
rather than an empty band. The response names its `artifact_id` and its
`ForecastOrigin` — whose producer is `wattsteer`, whose run label is the
artifact id, and whose `published_at` is the gate instant — and stamps the
`threshold_mw` and gate profile that produced it, because every surface showing
a forecast must name its origin and every number must carry the threshold that
made it.

The per-technology figure is typed as a **scalar**, not a band: it is a point
split of the band's centre and of the expectation, labelled as a split, so no
screen can render it as an interval.

Persistence is at (`Subsystem`, `valid_time`) grain as `Forecast` rows carrying
`p`, the three quantiles, the expectation and the technology split. A `Forecast`
always has `published_at < valid_time`; it is a different table family from an
`Observation` and cannot be read as one. Replay then reads through
`AsOf(published_at)` instead of re-running a model that has since been
retrained.

**Blocked by:** 02, 07.

**Status:** ready-for-agent

- [ ] The endpoint serves from `current(lane)` and refuses with a typed body
      when no artifact is promoted
- [ ] Every response is monotone in every hour and names `artifact_id`,
      `ForecastOrigin`, `threshold_mw` and gate profile
- [ ] Day energy, peak power and day-level occurrence come from the path
      ensemble, never from the hour bands
- [ ] The per-technology field is typed as a scalar in the contract
- [ ] Every served forecast is persisted as `Forecast` rows with a `wattsteer`
      `ForecastOrigin`, and the rows round-trip through `AsOf` returning exactly
      the numbers served
- [ ] **The day-grain figures are persisted too, not only served.** `replay.md`
      requires `forecast.day_total` from the path ensemble and forbids
      reconstructing it by summing quantiles — so if only hour rows are stored,
      a replay can either re-run the ensemble or commit the arithmetic the spec
      bans. Ticket 07 computes them and nothing else persists them; this ticket
      owns it. A test asserts a replayed day reads its day total from storage
      and that no code path sums hour-grain quantiles to obtain one.
- [ ] An unmounted volume, a mounted volume with no artifact, and an artifact
      that is present but unpromoted are three distinguishable states on the
      meta endpoint and produce three distinguishable refusals
