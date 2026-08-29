# 01 — The national headline has no engine behind it

**What to build:** a national figure the forecaster can actually produce.

The landing hero's headline — the most prominent number on the site — is the
componentwise sum of four subsystem P50s. Its own note concedes that "nothing
else sums", and it is right about everything except itself: **medians do not
add either.** The P50 of a sum is not the sum of the P50s unless the four
subsystems move together, which is exactly the assumption the rest of the page
refuses to make.

`docs/specs/api-surface.md` found this and specified the fix, which is cheap
because the machinery already exists: the forecaster draws a 500-member path
ensemble per subsystem, so **sharing the drawn day-row index across all four**
makes the national joint band fall out of the existing draws. No copula, no new
parameter, no second model. Until that lands, the honest headline is **expected
MWh**, which does add exactly, with `national.band = null`.

Two smaller errors on the same panel:

- The forecast origin is stamped `producer: "open_meteo"`. That names the
  *weather run*, not the forecast — the producer of a curtailment forecast is
  WattSteer.
- The panel says the national figure is "the sum of the four subsystems" and
  contrasts it with ONS's `SIN` row. The contrast is right and the arithmetic
  it describes is the thing being fixed.

**Blocked by:** the i18n route-tree work, which owns `components/landing/`
until it merges. Not blocked by the forecaster — the expected-MWh fallback is
correct today and stays correct after.

**Status:** ready-for-agent

- [ ] The national headline is a quantity that survives aggregation
- [ ] `national.band` is null until a joint band exists, and the UI says why
- [ ] The forecast origin names WattSteer, not the weather provider
- [ ] A test asserts the national figure is not a componentwise sum of medians
- [ ] Hand-back recorded on ticket 009: share the ensemble draw index across subsystems
