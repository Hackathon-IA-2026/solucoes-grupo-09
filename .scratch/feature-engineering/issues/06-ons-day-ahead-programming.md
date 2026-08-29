# 06 — ONS day-ahead programming, the DESSEM-free set's spine

**What to build:** the feature row carries ONS's own day-ahead load programme for
the subsystem-hour and the shape features derived from it — the ramp inside the
programmed profile, the centred window, the day's minimum and the hour's rank in
the day.

This is class **`P`**, and it is the quiet find of the whole spec. The A/B was
framed as "DESSEM or nothing", and the DESSEM-free set looked like it would have
to survive on weather and lags alone. It does not: ONS has published a day-ahead
load programme covering the entire training window, and it agrees with DESSEM
demand to 0.03% where both exist. That single series is what makes a rebuilt
residual load possible over the long window instead of the short one, and it is
what makes `dessem_free_v1` a real contender rather than a control arm.

The series is already ingested as a `Forecast` with its own table, downsampled
to hourly and re-labelled to interval start, addressed with `SECO` rather than
`SE`. What is **not** settled is its publication timing, and this ticket must
settle it, because it is the single largest risk in the spec.

The endpoint returns **no row-level update stamp at all**: every row's
`published_at` is the fetch instant and its precision is response-grained. Over
the backfill window that means `published_at ≤ gate` drops every programmed row
for every historical target date, and the DESSEM-free set's spine is a column of
NULLs for its whole window. The as-of machinery makes this a visible hole rather
than a leak, which is the design working — but a hole covering 100% of training
rows is not a shippable outcome, so the honest `published_at` for a backfilled
programmed row has to be decided here and written down, and the real publication
lag has to be measured before either feature set is trusted (see 12).

**Blocked by:** 01 — the gate, end to end.

**Status:** ready-for-agent

- [ ] Programmed load for the subsystem-hour is a feature, cut on `published_at ≤ gate`
- [ ] The ramp inside the programmed profile, the centred three-hour mean, the day's minimum and the hour's rank within the day are derived from the same profile
- [ ] Centred windows are legal here and the reason is recorded: a D−1 programme publishes the whole of day D at once
- [ ] The `published_at` a backfilled programmed row carries is decided explicitly, written down at the adapter, and defensible as a publication instant rather than a fetch instant
- [ ] A row whose `published_at` falls after the gate produces NULL, and the failure is a visible hole rather than a silently substituted value
- [ ] The feature is proven non-null across the full DESSEM-free window, or the ticket does not close
- [ ] Seams 1 and 2 still pass with these features present
