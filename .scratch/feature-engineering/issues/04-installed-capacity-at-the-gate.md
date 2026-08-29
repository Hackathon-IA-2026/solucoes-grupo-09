# 04 — Installed capacity, joined across a changing fleet

**What to build:** the feature row knows how much wind and solar capacity the
subsystem actually had on the target date — as recorded at the gate — and how
much of it arrived in the last four weeks.

`InstalledCapacityAsOf(scope, technology, t)` is already a function rather than
a column. What this ticket adds is that it is a **double as-of**, and that is
the part that is easy to get wrong: the valid-time argument is the **target
date D**; the vintage is the **gate**.

- Without the valid-time as-of, today's fleet leaks into 2024 features —
  measured at 25.8% of curtailed-fleet MW not existing when the window opens.
- Without the vintage as-of, a unit whose commissioning ONS records *after* the
  gate enters a feature that could not have known about it.

The vintage as-of makes these features slightly conservative — a unit entering
service on day D is not counted at D−1. That is correct behaviour, not an error
to patch.

Capacity is **day grain, broadcast identically across the 24 hours of D**, and
the feature dictionary marks it so, because a column constant within a day must
not be read as an hourly signal.

Two honest caveats travel with it rather than being smoothed. Over the backfill
window capacity is `revision_optimistic`: registry snapshots only begin at
ingestion go-live, so a pre-go-live row reflects today's record of the past.
And **decommissioning is asserted, not modelled** — ONS records zero VRE
deactivations across the window, so an alert fires if a deactivation date
becomes non-null for any VRE unit and nothing is estimated for an error that is
currently exactly zero.

**Blocked by:** 01 — the gate, end to end.

**Status:** ready-for-agent

- [ ] Wind and solar installed capacity enter the feature row as a function of the target date read at the gate's vintage
- [ ] The 28-day capacity addition for each technology is derived from the same double as-of
- [ ] A unit commissioned on day D is absent from D−1's row, and a test says so
- [ ] A unit whose commissioning ONS recorded after the gate is absent from that row, and a test says so
- [ ] Capacity features are marked day grain in the feature dictionary
- [ ] Rows over the backfill window carry `revision_optimistic`, and the reason is stated at the feature
- [ ] An alert fires if a deactivation date becomes non-null for any VRE unit; nothing is estimated
- [ ] Seams 1 and 2 still pass with these features present
