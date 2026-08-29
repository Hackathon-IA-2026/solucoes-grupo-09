# 07 — DESSEM features, and the feature-set argument that gates them

**What to build:** at the late gate, the feature row carries ONS's own day-ahead
balance for the subsystem — demand, generation by technology, and the quantities
derived from them, including the residual load and the implied net export — and
a caller asking for the DESSEM-augmented set at the early gate is refused by
construction.

Class **`D`**. The balance is already ingested as a `Forecast` at 30-minute ×
subsystem grain with the file creation as its `published_at`, resampled to
hourly, with coverage beginning 2025-05-23. Its `published_at` is genuine, so
`published_at ≤ gate` is a real point-in-time filter even in backfill, and the
whole day-D profile is known at D−1 — which makes ramps, day minima and
in-day ranks legal here, exactly as they are on the weather and programming
sides and nowhere on the actuals side.

**DESSEM's exclusion from the early gate is structural, not a rule.** The file
for reference day D is created mid-afternoon on D−1. At 09:00 on D−1 the newest
DESSEM file describes D−1 itself. So the A/B is not only a shorter window; it is
also **eleven hours less notice**, and that cost belongs in the comparison
wherever the result is stated.

**DESSEM publishes no exchange column, and this is worked around by identity,
not by omission.** For a subsystem, generation minus demand minus pumping is net
export, up to losses. The feature is named *implied* because losses are not
modelled, and it is a strong day-ahead signal for exactly the mechanism ONS's
own prospective-curtailment tool cites — the northern export limits.

One feature encodes a physical asymmetry rather than a statistic: the absorbing
subsystem's residual load carried onto the northern subsystems' rows, because N
and NE curtail when SE has no headroom to absorb them.

The export utilisation ratio is **not** in this ticket — it needs a denominator
that does not exist yet. See 10.

**Blocked by:** 01 — the gate, end to end. 04 — installed capacity, for the
DESSEM-derived capacity factors.

**Status:** ready-for-agent

- [ ] Demand, wind, solar, MMGD, hydro, thermal and pumping enter the feature row from the day-ahead balance, cut on `published_at ≤ gate`
- [ ] Residual load, renewable load ratio, VRE surplus and inflexible share are derived from the balance's own quantities
- [ ] Implied net export is derived from the energy identity, named *implied*, and its unmodelled losses are stated at the feature
- [ ] Demand, residual-load and VRE ramps, the day's residual-load minimum and the hour's rank in the day are derived within day D's profile
- [ ] Wind and solar capacity factors use installed capacity read at the gate's vintage
- [ ] The system-wide residual load and the absorbing subsystem's residual load carried onto the northern subsystems' rows are present
- [ ] `feature_set` is enforced: the DESSEM-augmented set at `gate_early` is refused by the function rather than returning NULLs
- [ ] The DESSEM-free set never contains a DESSEM-sourced column, at either gate
- [ ] The eleven hours of lost operator notice are recorded as the augmented set's second cost, alongside the shorter window
- [ ] Seams 1 and 2 still pass with these features present
