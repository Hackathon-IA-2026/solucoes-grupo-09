# 04 — Perfect foresight as a fenced upper bound, and the observed-only view

**What to build:** a replay shows what the best possible plan could have achieved
*knowing the answer*, in a visually and semantically separate block, with the gap
between it and what WattSteer's plan actually achieved published as its own number.
And a pre-F1 day — one no honest forecast exists for — gets that bound and the day
itself, with no WattSteer number beside it.

```
plan_pf     = optimize(curt = a, S)
scored_pf   = simulate(plan_pf, a)
forecast_value_gap_mwh = scored_pf.recovered_mwh − recovered_mwh
```

The gap is the only honest use of a hindsight number, and it answers a real question:
what is a better forecast actually worth? Note its shape — on a fleet with power to
spare and no energy limit, perfect foresight gains nothing. **The gap opens exactly
when the fleet is energy-limited**, because that is when the plan has to choose which
hours to spend itself on.

The fencing is enforced rather than agreed. `upper_bound` never populates
`avoided_energy_mwh`, never appears inside `scored`, and is labelled **"the best any
plan could have done knowing the answer"** in those terms.

For the pre-F1 year the observed-only view is what is offered: the settled profile, the
episodes at the threshold in force, and the perfect-foresight bound — which needs no
forecast and therefore no model. No plan, no recovery number, no reduction percentage,
and the screen says why in one sentence. On such a day the bound is presented as a
property of the day and the fleet, with nothing of WattSteer's to compare it against.

**Blocked by:** 03.

**Status:** done

- [ ] `upper_bound` carries `label: "perfect_foresight"`, `recovered_mwh`, `avoidability` and `forecast_value_gap_mwh`
- [ ] A test asserts no headline field can be populated from `upper_bound`
- [ ] `scored_pf.recovered_mwh ≥ recovered_mwh` on random scenarios and realisations, within the throughput penalty's tie-breaking tolerance — a violation means the plan and the simulator disagree, which is the one bug this architecture exists to surface
- [ ] An observed-only (pre-F1) day returns `upper_bound` with `scored`, `avoided_energy_mwh` and `recovered_floor_mwh` **absent** — not zero, absent
- [ ] The observed-only day still returns the observed profile and its episodes at the threshold in force
- [ ] The energy-limited case is a fixture: the same battery capped in usable energy shows a non-zero `forecast_value_gap_mwh` where the unconstrained one shows zero
