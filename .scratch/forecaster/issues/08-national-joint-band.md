# 08 — A national band that is not a sum of medians

**What to build:** a national day figure with a real band behind it, produced by
sharing one drawn day-row index across all four subsystems' path ensembles.

This is the hand-back recorded on the product-fixes work. The landing hero
currently shows the componentwise sum of four subsystem P50s, and medians do not
add either: the P50 of a sum is the sum of the P50s only if the four subsystems
move together, which is exactly the assumption the rest of the product refuses
to make. Until a joint band exists the honest headline is expected MWh, which
does add exactly, with the national band null.

The fix is cheap because the machinery from ticket 07 already exists: draw
**the same 500 day-row indices for every subsystem**, so each ensemble member is
one nationally coherent day, and take national quantiles across members. No
copula, no new parameter, no second model. The dependence across subsystems is
whatever the calibration window actually had, on the same footing as the
within-day dependence already accepted.

`SIN` is not a subsystem: the national figure is a derived sum over the four,
computed inside each ensemble member, and is never an ONS aggregate row.

**Blocked by:** 07.

**Status:** done

> **Hand-back, recorded by api-surface 13.** The computation landed here and is
> correct — `training/national.py` shares the draw index, takes peak-of-sum and
> counts occurrence over draws — but it is **not persisted**: ticket 14 found
> that `NationalDayGrain.as_row()` has no table, because `SIN` is not a
> `Subsystem` and the national grain cannot borrow `curtailment_forecast_day`'s
> key. So `/v1/grid/outlook` serves `national.expected_mwh` with `band: null`
> and `band_unavailable_reason: "no_joint_ensemble"` — the honest headline this
> ticket's own text names — and the row grain is **ticket 22**. Until 22 lands
> nothing may synthesise a national band by summing the four subsystems'
> quantiles; that is the defect the thread exists to remove, and the gateway has
> no arithmetic that could produce one.

- [ ] One draw of day-row indices is shared across all four subsystems, so
      ensemble member *k* is the same calendar day everywhere
- [ ] National day energy, peak power and occurrence probability are quantiles
      across members of the four-subsystem sum, never of four separate bands
- [ ] A test asserts the national band is strictly narrower than the
      componentwise sum of the four subsystem bands, and that it is not a
      componentwise sum of medians
- [ ] National expected MWh remains exactly the sum of the four expectations
- [ ] The national figure is a derived sum over the four subsystems; nothing
      reads an ONS national aggregate row
- [ ] The national result names its `ForecastOrigin`, whose producer is
      WattSteer and whose run label is the artifact id
