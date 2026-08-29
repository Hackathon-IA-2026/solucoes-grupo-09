# 08 — The weather block, complete

**What to build:** the twelve pinned weather variables become the subsystem's
weather feature vector — capacity-weighted over the frozen centroids, with the
ramps and centred windows the forecast profile legitimately supports, the
deterministic power-curve and irradiance conversions, and honest metadata about
which run was actually used and how much of the fleet it covered.

Ticket 01 carried one weather feature through the gate to prove the cut. This
completes the block.

**The variable list is settled at twelve**, pinned to a single named model on
the Single Runs API: wind speed at 100 m and 120 m, wind direction at 120 m,
gusts at 10 m, air temperature, surface pressure, relative humidity,
precipitation, shortwave radiation, direct normal irradiance, diffuse radiation
and cloud cover. Twelve is chosen against the call-weighting cliff and matches
the request shape the lead-time research measured. Variables that are documented
but **null under the pinned model are not requested at all**, so no run can write
a column of NULLs. Every other exclusion has a stated reason and none is
"forgot".

Wind variables are weighted by the wind capacity vector, solar variables by the
solar vector, shared variables by combined VRE capacity — the two fleets sit in
different places, so one shared vector would put solar weight on wind's coast.
Weights are `CapacityWeight(centroid, technology, t)`, recomputed per target
date; the points stay frozen.

**Ramps and centred windows are legal here and nowhere on the actuals side.** A
D−1 run publishes all 24 hours of day D at once, so a difference inside that
profile is computed from data that exists at the gate. This is the single
largest recovery of the originally proposed feature set.

Two conversions are deterministic and identical on both sides of the gate, so
they introduce no skew, and both are argued rather than magic:

- **Wind**: a generic IEC-class power curve at 120 m — cut-in 3 m/s, rated
  12 m/s, cut-out 25 m/s, no air-density correction — applied per centroid and
  then capacity-weighted. The resulting capacity factor is a **proxy** and is
  named as one; it is not the Brazilian fleet's curve.
- **Solar**: STC-referenced irradiance over installed capacity, with **no
  temperature derate**. Adding one would bake a coefficient into a feature; air
  temperature is in the vector, so the model learns the interaction from data
  instead.

Two metadata features are load-bearing. **Run age** is the distance from the
scheduled run to the run actually used — zero in roughly 95% of rows, twelve or
twenty-four when a run was missing, which is how a 4.5% missing-run rate
degrades the forecast rather than corrupting it. **Centroid coverage is the
share of capacity weight mass that reported, not the fraction of centroids that
reported**: losing a 426 MW point and losing a 4,172 MW point are the same
fraction of points and are not remotely the same event. The weighted reading
still gives 1 when everything arrived.

Lead time is **deliberately absent**: within a fixed run cycle it is perfectly
collinear with local hour and carries nothing the vector does not already hold.
Run age captures the only informative part.

At serve time the completeness contract is asserted and a failure **refuses to
serve** rather than imputing.

**Blocked by:** 01 — the gate, end to end. 03 — for the extraterrestrial
irradiance the clearness index divides by. 04 — for the installed capacity the
expected-generation conversions scale.

**Status:** done

- [ ] The twelve variables are pinned and requested as a set; variables that are null under the pinned model are never requested
- [ ] Every exclusion from the list carries its stated reason
- [ ] Weather features are capacity-weighted over the frozen centroids with separate wind, solar and VRE weight vectors, recomputed per target date
- [ ] Wind direction enters as a circular encoding of the weighted vector mean, and a fixture test covers averaging across 350°→10°
- [ ] Ramps and centred windows are computed within the forecast profile, and the reason they are legal here is recorded
- [ ] The clearness index divides shortwave radiation by extraterrestrial irradiance, guarded at night against a zero denominator
- [ ] The wind power curve's parameters are written down at the feature, and fixture tests pin it at cut-in, rated and cut-out
- [ ] Expected wind and solar generation scale by installed capacity read at the gate's vintage; the solar conversion carries no temperature derate, and the reason is recorded
- [ ] Run age is a feature and is non-zero exactly when a scheduled run was missing and an older cycle was used
- [ ] Centroid coverage is the share of capacity weight mass, not a count, and equals 1 when every point reported
- [ ] Lead time is absent, and the collinearity argument is recorded
- [ ] The serve path asserts the completeness contract across variables, hours and centroids, and refuses on failure rather than imputing
- [ ] The run-fallback path is exercised against a recorded missing-run response and sets run age rather than failing open
- [ ] Seams 1 and 2 still pass with the full block present
