# 07 — The featured days are a query, and one of them is a day WattSteer got wrong

**What to build:** the Time Machine opens on a shortlist of interesting days chosen by
a published deterministic rule — not by anyone's taste — and the rule is *obliged* to
put a day WattSteer got wrong in front of the user.

Shipping only one of "any date by URL" and "a curated set" would be a mistake in either
direction: a curated-only tool is a slideshow, and an any-date-only tool opens as a
blank date picker over seventeen months. Both ship. Hand-picking the featured days
would be selecting on the outcome — the same failure the shuffled-label control exists
to catch one layer down.

The rule, published on the screen in one sentence and evaluated on the replayable set:

> The **eight** featured days are: the three days with the largest observed
> `total_mwh`; the day with the largest **absolute forecast error** on the day total;
> the day with the largest observed total in **each** `VintageFidelity` class; the day
> with the largest observed total in **each** provenance class; and — mandatorily —
> **the day with the largest shortfall against its own promised floor**, i.e.
> `min(scored.observed.recovered − recovered_floor)`. Duplicates collapse and the list
> is padded from the top of the first criterion. Ties break on date, ascending.

The last clause is the one that matters, and it means the demo screen can open on a bad
day. If no day missed its floor, the slot is filled by the smallest margin and labelled
as the closest call.

The list is recomputed nightly against the published `REFERENCE_FLEET` and cached; it
is deterministic given the data.

**Blocked by:** 02, 03; **Flex-optimizer 03** (`REFERENCE_FLEET` as one published
constant — the list is not reproducible if the fleet it is computed against is
restated per surface).

**Status:** ready-for-agent

- [ ] `GET /v1/replay/days` returns the calendar and the eight featured days together
- [ ] The query is deterministic given the data, and re-running it changes nothing
- [ ] The list contains at least one day from each populated `VintageFidelity` and each populated provenance class
- [ ] The worst-floor-shortfall clause is present and non-empty, asserted by a test; on a synthetic dataset where one day badly missed its floor, that day is in the list
- [ ] With no day missing its floor, the slot holds the smallest margin and is labelled the closest call
- [ ] Duplicates collapse, padding comes from the top of the first criterion, ties break on date ascending
- [ ] It is computed against `REFERENCE_FLEET`, stamped on the response
- [ ] The rule is rendered on the screen in one sentence
