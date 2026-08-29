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

**Status:** ready-for-agent

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
