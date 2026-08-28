---
id: "008"
title: Feature engineering spec
type: wayfinder:grilling
status: open
assignee:
blocked_by: ["002", "006", "007", "018", "019"]
---

## Question

Which features does the day-ahead model actually get, and how is each computed
under point-in-time constraints?

IDEA.md §4–§12 proposes: renewable surplus and renewable/load ratio, residual
load, ramp rates, lags (t-1, t-24, t-168), rolling means and standard
deviations, interchange flow and a utilisation proxy, cyclical calendar
encodings, holidays, regional weather, installed capacity and capacity factor.

The real questions:

- **The day-ahead constraint is the whole problem.** At D-1 you do not have
  D's actuals. Which of these features are available from DESSEM, which from
  weather forecast, and which must be replaced by their last-known value or
  dropped entirely? Every feature must be classified this way or the model
  learns on information it will never have.
- Is the interchange utilisation proxy (§9) obtainable at all — is there any
  published limit to divide by, or must it be estimated from historical maxima?
- Which curtailment threshold defines the positive class (§2: >1 / >5 / >10 MW)?
  Decide the default and whether it is configurable.
- Are features computed in SQL, in the Python service, or both? A single
  definition matters more than which side it lives on.
- Holiday calendar source for Brazil, including regional holidays.
- **Weather features carry a lead dimension now.** Training weather comes from
  the Single Runs API at a fixed D−1 lead, not the Historical Forecast archive,
  so every weather feature has a `publication_time` as well as a valid time and
  must be joined as-of that lead. The per-point train↔serve gap is an upper
  bound; recompute it on the real capacity-weighted centroids once the plant
  registry lands, because aggregation will shrink it.
- **The DESSEM A/B changes the shape of this ticket.** Two feature sets must be
  specified, not one: a DESSEM-free set over 2024-04→now and a DESSEM-augmented
  set over 2025-05→now. Say explicitly which features exist only in the second.
- **Timezone.** `din_instante` is Brasília local civil time and ONS documents
  this nowhere. Within the 2024-04→now window there are no DST transitions, but
  the ingestion contract must state the assumption rather than inherit it.
- How installed capacity is joined given it changes over time.

Use `/grilling`. Output: a feature specification document — one row per
feature, with its definition, its D-1 availability, and its source.
