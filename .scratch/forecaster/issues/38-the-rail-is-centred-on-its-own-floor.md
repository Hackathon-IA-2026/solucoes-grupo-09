# 38 — `p50_unbiasedness` is centred on its own floor, so it refuses a correct model half the time

**What to decide:** whether a rail whose statistic is distributed *around* its
threshold is a gate or a coin toss. This is the one thing standing between this
repository and a reliable promotion that a weather key does not buy.

## The evidence, which is now three real fits rather than an argument

Forecaster 33 measured `p50_unbiasedness`'s day-block standard error at **0.021**
and warned that a correct model clears the 0.45 floor by 0.008 against it — so
the rail "will refuse correct candidates about half the time on this data". That
was a prediction from one run. There are now three, across two days, at
byte-identical thresholds:

| fit | gate_early | gate_late | |
|---|---|---|---|
| forecaster 34 | 0.4439 | 0.4464 | veto / veto |
| forecaster 36 | 0.4536 | 0.4599 | **pass / pass** |
| forecaster 37 | 0.4390 | 0.4504 | veto / **pass** |

```
mean                = 0.44887
floor               = 0.45
mean − floor        = −0.00113
observed pass rate  = 3 of 6
```

**The distribution is centred below the floor**, by about a tenth of the
run-to-run spread. That is the whole finding, and it is robust to which
dispersion you believe: the run-to-run sd across these six is 0.0074 and
forecaster 33's day-block SE is 0.021, and they measure different things — one
is what changed when the data window moved, the other is the sampling
variability of the statistic on a fixed window — but a threshold sitting inside
either interval, on the wrong side of the centre, refuses about half the time.

Forecaster 36 passing twelve rails for twelve was reported as the system having
arrived. It had not. It was a draw, and forecaster 37 drew the other way one day
later on strictly better data.

## Why this is not "move the floor"

The rail is sound in intent: a P50 that is not a median is a broken band, and
0.45–0.55 is a defensible window around 0.50. Three separate agents declined to
move it and were right to — `p50_unbiasedness` is also the rail the
shuffled-label control fails at 0.2575, so it carries real discriminating power.

The defect is that the *candidate's* statistic sits at 0.4489, not that the
floor sits at 0.45. Two honest readings, and they call for different work:

1. **The model is mildly biased low and the rail is correctly complaining.**
   Then the fix is in the composition or the hurdle, not the gate, and every
   promotion until then is a coin toss the gate happens to lose half the time.
2. **The statistic is under-powered at this fold size.** Forecaster 33 measured
   the effective n at 587–612 day-blocks against 3,201 rows. Then the fix is
   more effective sample — a longer test window, or pooling folds — so the
   estimate tightens around whatever the truth is, rather than moving the
   boundary to admit the noise.

**Do not resolve it by widening the window to `[0.44, 0.56]`.** That admits the
noise in both directions and costs the shuffled-label control, which is the only
evidence the rail discriminates at all.

## What this does not block

Nothing here is a reason to delay a weather key. Check 7 (`serving_smoke`) and
check 6 (guardrails) are independent failures with independent causes: the
serving day has no weather because only the `history` tier of `planRefresh` had
ever run, and the rail is centred on its floor because of the above. Fixing
either does not fix the other, and forecaster 37 hit check 6 before check 7 was
even reached.

**Blocked by:** None for the measurement. The decision needs a human.

**Status:** measured, nothing changed

- [ ] Which of the two readings is true — decided on evidence, not preference
- [ ] If the model is biased, the bias is located and the rail left alone
- [ ] If the statistic is under-powered, effective n is raised rather than the
      window widened
- [ ] The shuffled-label control still fails the rail afterwards, asserted
