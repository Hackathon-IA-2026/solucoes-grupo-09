# Execution-rule vectors

The execution rule has **one implementation**, in one language:

| Language | Site |
|---|---|
| Python | `apps/ml/src/wattsteer_ml/optimizer/simulator.py` |

`test/one-execution-rule.test.ts` walks the whole repository — both languages —
in the default `bun run test`, and fails if a second appears anywhere.

**This directory is no longer a parity set, and that is the point.** It was one:
`apps/web/src/lib/fixtures/optimize.ts` held a TypeScript port that these vectors
proved identical, on the argument that a port is not a second implementation
*provided the two are proved identical*. `docs/specs/api-surface.md` decision 6
withdrew the argument and deleted the port — a proved-identical copy is still a
copy, and this one was known wrong (it clipped absorption but not the state of
charge, so on a low realisation it reported a battery filled with energy it
never received). Mitigate calls `POST /v1/optimize` instead.

What the vectors pin now is **regression, not parity**: six cases, each fully
recomputed by `apps/ml/tests/test_execution_rule_vectors.py` on every run, so a
change to the rule that was not meant to move these numbers fails there. The
suite globs this directory and fails if it is empty, so adding a case here is
sufficient.

## Why this matters more than a normal parity check

`docs/specs/flex-optimizer.md` calls the shared code path "the single most
important line" in the spec: a backtest number and a forecast number are the
same kind of number because the same function produced both. Two functions that
agree on every case here *are* one function for that purpose. Two that do not,
are not — and the difference would show up as a Time Machine number that cannot
be compared with a Mitigate number, which nothing else in the suite would catch.

## The cases

| Vector | What it pins |
|---|---|
| `planned-and-realised-alike` | The reference day executed against its own planning basis — the one realisation where the MILP and the simulator must agree exactly. |
| `the-day-that-never-came` | A P50 plan against an all-zero realisation: absorbs exactly zero, imports exactly nothing. The negative case the whole uncertainty posture rests on. |
| `a-day-below-the-planning-basis` | 40 % of the basis. The state of charge is recomputed from the executed dispatch, so the battery cannot fill up on energy it never received. |
| `discharge-clipped-to-the-store` | Discharge bounded by what the battery actually holds, not by what the schedule asked for. |
| `a-shiftable-load-in-the-sum` | The `up`/`down` terms of `Δ[t]`. Energy-conserving, not clipped by the realisation; absorption is. |
| `noise-below-the-threshold` | `avoidability` is `null`, never a triumphant 100 % off 0.3 MWh. The threshold gates whether the ratio is defined and never enters it. |

## Shape

```jsonc
{
  "name": "…",
  "why": "…",                  // prose, asserted by neither side
  "thresholdMw": 5,
  "battery": { "maxPowerMw": …, "energyCapacityMwh": …,
               "roundTripEfficiency": …, "initialStateOfCharge": … },
  "plan": { "batteryChargeMw": [24], "batteryDischargeMw": [24],
            "loadShiftUpMw": [24], "loadShiftDownMw": [24] },
  "realisationMwh": [24],
  "expected": {
    "baselineCurtailmentMwh": …, "avoidedEnergyMwh": …,
    "optimizedCurtailmentMwh": …, "avoidability": … /* or null */,
    "storedAtHorizonEndMwh": …, "roundTripLossMwh": …,
    "dispatch": [ { "hourLocal": 0, "batteryChargeMw": …,
                    "batteryDischargeMw": …, "stateOfChargeMwh": …,
                    "absorbedMwh": … } ]
  }
}
```

The battery carries a single round-trip efficiency, as a datasheet prints it;
both sides split it `√RTE` into the charge and discharge halves the state-of-
charge balance needs. `initialStateOfCharge` is inside the 5–95 % bounds in
every vector, because an out-of-bounds initial state is a `422` at validation
(flex-optimizer ticket 04) and not something the simulator is asked to absorb.

**Comparison is to 1e-9 MWh, not to the bit.** The tolerance dates from the
two-language era, where the same arithmetic ran in a different association order
on each side; it is kept because a fleet's charge is still clipped through a
shared scaling factor whose association order is an implementation detail. 1e-9
MWh against figures in the hundreds is eleven significant digits; a real
divergence in the rule is many orders of magnitude larger than that.

**Regenerating.** The expected values were emitted by the Python implementation.
There is no committed generator, and none is needed: the suite recomputes every
field on every run and asserts it against the file, so a change to the rule that
was not meant to change these numbers fails there first.
