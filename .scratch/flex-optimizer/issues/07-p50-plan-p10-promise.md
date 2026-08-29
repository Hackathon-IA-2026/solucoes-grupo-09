# 07 — Plan on P50, promise the P10 edge, never ask the user

**What to build:** WattSteer takes a real P10/P50/P90 curtailment profile for a
subsystem and date, builds **one** plan, scores it against all three envelopes with
the simulator, and returns a single conservative headline — `recovered_floor_mwh`,
the P10-simulated recovery — with the median and high realisations beside it.

The posture is decided and this ticket implements it rather than re-opening it:
**the optimizer plans against P50, the product promises the P10 edge, and the user
is never asked.** The Mitigate prototype's basis toggle comes out. The three
envelopes are used for **scoring, not planning**.

The mechanism that makes that coherent is ticket 02's execution rule, which is why
this ticket cannot precede it. Under it, the failure mode of planning on P50 —
plan big, day comes in small, battery charges from energy that was never curtailed
and the reported recovery is fiction — **cannot occur**. The asset absorbs less,
the reported number falls, nothing is imported and nothing is overstated. So the
conservatism belongs in the claim and not in the plan. Planning on P10 instead
collapses: the forecaster is a hurdle model, so the hour-wise P10 is legitimately
zero unless the occurrence probability exceeds 0.90, and (C5) then forbids charging
in exactly the hours the day turns out to be about.

The floor is an **hour-wise** statement. The plan is feasible against the hour-wise
P10 envelope; the joint probability that all 24 hours land at or above their own
P10 is not 90 %, is not computed, and is not claimed. That sentence is a contract
obligation, not a nicety.

The result contract is fixed here; ticket 013 may re-path the endpoints.

```jsonc
{
  "scenario_hash": "sha256:…", "forecast_origin": "…", "vintage_fidelity": "point_in_time",
  "threshold_mw": 5, "planning_basis": "p50", "execution_rule": "follow_curtailment",
  "baseline_curtailment_mwh": 397.0, "optimized_curtailment_mwh": 245.2,
  "avoided_energy_mwh": 151.8, "avoidability": 0.382,
  "recovered_floor_mwh": 84.1,                     // = scored.p10.recovered_mwh
  "scored": { "p10": {…}, "p50": {…}, "p90": {…} },
  "dispatch": [ … ], "stored_at_horizon_end_mwh": 96.3, "round_trip_loss_mwh": 11.4,
  "economic_scenario": { "brl_per_mwh": 180, "brl": 27324 }, "solver": { … }
}
```

`dispatch` and the state of charge are the **scheduled** plan on the planning
envelope. The domain-model scalars at the top level are evaluated on that same
planning envelope — which is the thing a `Replay` deliberately does differently,
and why its contract names the realisation explicitly.

R$ enters exactly once, *after* the solve, as a labelled display multiplier on
`avoided_energy_mwh`. `economic_assumptions.brl_per_mwh` (default 180, written
down in one place) never enters the model. Changing it changes the money and
nothing else.

**Blocked by:** 02, 04, 06. **Cross-spec, external: Forecaster 14** — a served and
persisted hour-wise P10/P50/P90 profile per (`Subsystem`, `valid_time`), resolvable at a
pinned `ForecastOrigin`. That profile is a contract this ticket
consumes and does not specify — its hurdle model, its quantiles and its calibration
are owned there. Until it exists, this ticket runs against a fixture profile of the
same shape and the wiring is the last step.

**Status:** ready-for-agent

- [ ] One MILP built on P50; three simulator passes; the result carries all three under `scored`
- [ ] `recovered_floor_mwh == scored.p10.recovered_mwh` always, asserted as a property
- [ ] The result carries `planning_basis: "p50"` and `execution_rule: "follow_curtailment"` as data, not as documentation
- [ ] `avoided_energy_mwh` at the top level and `recovered_mwh` inside `scored` are identical by construction — one quantity, one name
- [ ] `scored.p10.avoidability` may legitimately be `null` beside a real number at P50, and the contract permits it
- [ ] Changing `brl_per_mwh` changes `economic_scenario.brl` and **nothing else** in the response — asserted by a test
- [ ] `FORECAST_UNAVAILABLE` is returned when no forecast exists for that subsystem/date/origin
- [ ] `forecast_origin` and `vintage_fidelity` travel on every result
- [ ] No API field, query parameter or request body key can select the planning quantile
