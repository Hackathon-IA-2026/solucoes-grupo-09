# Execution-rule vectors

The execution rule has **one implementation**, and it runs in two languages
because the prototype scores a plan in a browser with no Python in the room:

| Language | Site |
|---|---|
| Python | `apps/ml/src/wattsteer_ml/optimizer/simulator.py` |
| TypeScript | `apps/web/src/lib/fixtures/optimize.ts` (`evaluatePlan`) |

`apps/ml/tests/test_one_simulator.py` walks the repository and fails if a third
appears anywhere, in either language. These vectors are the other half of that
edge: a port is not a second implementation *provided the two are proved
identical*, and this is where that is proved.

- `apps/ml/tests/test_execution_rule_vectors.py` runs the Python one.
- `apps/web/test/execution-rule.test.ts` runs the TypeScript one.

**Neither side compares against the other — only against the vectors** — so a
shared misunderstanding cannot cancel out. Both suites glob this directory and
fail if it is empty, so adding a case here is sufficient and neither language
can quietly skip one.

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

**Comparison is to 1e-9 MWh, not to the bit.** Both languages are IEEE-754
doubles doing the same arithmetic, but not in an identical association order —
the Python side clips a fleet's charge through a shared scaling factor, which is
a multiply where the single-battery TypeScript path is a `Math.min`. 1e-9 MWh
against figures in the hundreds is eleven significant digits of agreement; a
real divergence in the rule is many orders of magnitude larger than that.

**Regenerating.** The expected values were emitted by the Python implementation.
There is no committed generator, and none is needed: the Python suite recomputes
every field on every run and asserts it against the file, so a change to the rule
that was not meant to change these numbers fails there first — and one that *was*
meant to fails in both languages, which is the point.
