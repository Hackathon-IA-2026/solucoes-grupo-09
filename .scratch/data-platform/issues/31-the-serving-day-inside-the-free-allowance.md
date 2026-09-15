# 31 — the serving day, inside the free allowance

**What to build:** forward progress on weather without a commercial key.

**Status:** done — `test/weather-call-budget.test.ts` and three cases in
`test/database-weather.test.ts`, the latter run against a real Postgres.

## The quota was never the serving load

Forecaster 37 read the Open-Meteo refusals as "a commercial key, and it is not
ours to buy". Half of that is right and the half that matters is not.

The free tier publishes **10,000 calls/day**. `docs/research/weather-sources.md`
measured our steady-state serving load at **~20 calls/day** — 0.2% of it. What
exhausts the allowance is the **Single-Runs backfill**: twelve variables (past
Open-Meteo's ten-variable weighting), 19 centroids, two cycles, five target days
per sweep, repeated hourly. The backfill is a *one-time* cost being paid at a
rate the day cannot carry.

So the key is needed for a **licence** reason — the free tier is
non-commercial-only and the terms exclude "integrating our service into
commercial products" — and not for a capacity one. Those are different
deadlines: the first is "before WattSteer takes money", the second was "before
tomorrow's forecast", and only the second was blocking.

## Three changes, and the first is the one that unblocks it

**1. Newest run first.** The slot order was chronological. Under a bounded
allowance that starts at the wrong end: forecaster 37 measured the sweep refused
"before it reaches a forward valid time at all", four attempts running, so the
oldest backfill target spent the quota and the serving day was never reached.
`plannedSlots` now sorts newest-first, so an exhausted allowance leaves the head
moved and the backfill behind — the recoverable direction. Yesterday's history
can be caught up tomorrow; tomorrow's forecast cannot be published late.

**2. The budget is counted, not discovered.** `callBudget` existed and computed
what a plan *would* cost, and nothing consulted it — a calculator, not a
governor. The ingestor now checks it **before** spending each slot and stops
when the next one would cross the ceiling.

The default is derived, not picked: the live sweep is hourly
(`REFRESH_CADENCE.live`), so 24 invocations share the day, and at a third of the
published allowance — margin for the other tiers' sweeps, for the retries a 429
costs before backoff gives up, and for anything else on the same IP:

    floor(10_000 / 3 / 24) = 138 weighted units per invocation

**A key lifts it entirely.** `config.openMeteoMaxWeightedUnits` is `undefined`
when `WATTSTEER_OPEN_METEO_KEY` is set, because the bound is the free tier's and
applying it to the commercial one would be inventing a limit. The whole tier
difference stays an environment change, which is what `openMeteoHost` is for.

**3. A rate limit ends the sweep instead of failing it.** A
`WeatherRateLimitError` propagated out of the invocation, so everything already
ingested was recorded as a failure — that is how `2 ok, 27 failed` appeared for
a source working exactly as well as its quota allowed. It is now caught at the
loop, and `stoppedBecause` distinguishes `complete` from `budget_exhausted` and
`rate_limited`. Both are outcomes; neither is an error.

## Non-vacuity

- **The ordering guard fails under the old order**: the same helper sorted
  chronologically puts the serving day *last*, and the test asserts both.
- **The ceiling binds**: the exact sweep forecaster 37 measured — five days,
  both cycles, 19 centroids — costs more than 138, so the bound fires rather
  than being a number that never triggers.
- **The ceiling admits at least one slot**, or the sweep could never progress.
- **The budget stop keeps its work**: the bounded run ingests one run and
  `inserted > 0`; the same payload unbounded reaches both cycles and reports
  `complete`.
- **The rate-limit stop keeps its work**: a fetch that answers once and then
  429s leaves `runsIngested: 1` and `inserted > 0` rather than throwing.
- 138 is recomputed in the test from the published allowance and the cadence,
  so moving either moves the bound instead of silently under- or over-spending.

## What this does not do

- **It does not remove the need for the key.** The licence question is
  untouched, and it arrives with the first paying user.
- **It does not make the backfill fast.** It makes it *survivable*: the head
  moves every sweep, and history fills in behind it at 138 units an hour. A
  commercial key is still what turns weeks into hours.
- **No ceiling was lowered, no window narrowed, no variable dropped.** The
  twelve variables and 19 centroids are unchanged; only the order and the
  stopping rule moved.
