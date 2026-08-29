# 12 — Publication-lag conformance, on a schedule

**What to build:** an operator finds out when ONS gets slower, changes what a
column means, or restates history in bulk — as an alert, rather than weeks later
as unexplained live degradation.

Every conservative default in this spec is a guess standing in for a
measurement, and the guesses are load-bearing in both directions. If the
configured 40-hour lag is too tight, the platform is throwing away a full day of
usable actuals and several dropped features could return. If it is too loose,
the system is quietly serving a leak. Neither is discoverable without measuring.

This is the scheduled, network-gated suite — the same footing as the data
platform's live conformance job, not part of the default test run.

What it measures:

- **The real publication lag of each observation dataset**, against the
  configured constant, failing when the real lag exceeds it. A configured lag
  can only ever be loosened by this measurement, and loosening it is a retrain
  trigger.
- **The day-ahead programme's publication timing** — the open question that
  carries the most risk of any decision in the spec — and that it still returns
  rows for the subsystem code it addresses them with. If it does not publish
  before the late gate, the DESSEM-free set's spine is not real and the A/B
  changes shape.
- **Day-ahead balance demand against programmed load** for the same
  subsystem-day. The research measured 0.03% agreement, so a divergence is
  evidence that one of the two changed meaning.
- **Bulk label restatements.** ONS's restatements are not guaranteed neutral: a
  re-publication campaign that changed the *definition* of the curtailment
  quantity rather than correcting it would teach the model a methodology break
  as a change in the grid.
- **The first appearance of the `PAR` reason code**, which has been observed zero
  times and is a monitoring signal rather than a class.
- **A deactivation date becoming non-null for any VRE unit**, since
  decommissioning is asserted rather than modelled.

**Blocked by:** 05 — the configured lag table it measures against. 06 — the
day-ahead programme whose timing is the open question.

**Status:** done

- [ ] A scheduled job measures the real publication lag per observation dataset and fails when it exceeds the configured constant
- [ ] Loosening a lag after measurement is recorded as a retrain trigger, with the feature-distribution change acknowledged
- [ ] The day-ahead programme's real publication time relative to the late gate is measured and published
- [ ] The programme still returns rows for the subsystem code the adapter addresses
- [ ] Balance demand and programmed load are cross-checked per subsystem-day, and a material divergence fails
- [ ] A bulk restatement of past labels is surfaced rather than silently absorbed
- [ ] The first `PAR` observation raises a signal
- [ ] A non-null VRE deactivation date raises an alert
- [ ] The suite is gated by environment and does not run in the default test pass
