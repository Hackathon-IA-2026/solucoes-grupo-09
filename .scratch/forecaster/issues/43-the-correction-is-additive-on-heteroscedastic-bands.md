# 43 — the correction is additive, and the bands are not homoscedastic

**What to build:** a conformal correction that survives the fleet moving between
the calibration window and the test period.

**Status:** made. The lower residual is normalised, the units moved everywhere
together, and the sweep below is a test with the additive arm as its control.
The retrain's verdict is the last open box.

## What happened

The first artifact this deployment ever minted was refused by the gate, in both
served lanes, on the same rail and for the same reason.

| | `gate_early` | `gate_late` |
|---|---|---|
| `delta_lo` | **−140.93** MWh | **−210.79** MWh |
| `coverage_p10_where_stated` | **0.8311** | **0.8114** |
| `coverage_p10` (marginal) | 0.9353 | 0.9100 |
| `p10_calibration_excess` | −0.1446 ± 0.0457 | −0.1609 ± 0.0373 |
| `bootstrap_p` | **1.000** | **1.000** |
| `conformal_lower_calibration_rows` / `rank` | 1240 / 1117 | 1310 / 1180 |

**The model is not the problem.** `bootstrap_p = 1.000` in both lanes: the
candidate beat `same_hour_7d` on every one of 2,000 resampled days. What failed
is the band's floor, and only the floor.

**The correction is not miscomputed either.** `⌈(1240+1) × 0.9⌉ = 1117` and
`⌈(1310+1) × 0.9⌉ = 1180` — both ranks are exactly right, the population is the
stated-lower one forecaster 35 established, and `conformal_method` reads
`one_sided_split_cqr_stated_lower` as it should. Every internal invariant holds.

## The defect

`TailShift` carries **two MWh scalars per artifact**, and its own docstring is
explicit that this is deliberate: *"It also does not make the correction
conditional. Two scalars per artifact, global, fitted independently per tail;
this class holds the two and knows nothing about `p`, an hour or a subsystem."*

That is sound when the rows are homoscedastic. These are not. One subsystem's
band runs P10 1,691 → P90 12,700 MWh in the same fold where another's is 0 →
3,029. A flat −141 MWh is a rounding error on the first row and most of the
interval on the second, so what the correction actually delivers depends on the
*magnitude mix* of the period it lands on — and the fleet grows, and the seasons
turn. The card says as much in `conformal_guarantee`: *"split conformal assumes
exchangeability between the calibration window and the test period, and a time
series with a growing fleet and a seasonal cycle is not exchangeable."*

## Measured, not argued

A simulation of exactly this pathology — log-normal magnitudes spanning orders
of magnitude, a fitted `q10` that over-covers on calibration (so `delta_lo` comes
out large and negative, as both lanes show), and a magnitude shift between the
1,240-row calibration block and the 1,314-row test block. 30 seeds per cell;
"in band" is the gate's own `[0.85, 0.97]`.

| fleet magnitude ratio, test ÷ calibration | additive (today) | normalised |
|---|---|---|
| 0.4 | 0.8023 — **0/30 in band** | 0.9165 — **30/30** |
| 0.6 | 0.8629 — 22/30 | 0.9165 — 30/30 |
| 0.8 | 0.8954 — 30/30 | 0.9165 — 30/30 |
| 1.0 | 0.9155 — 30/30 | 0.9165 — 30/30 |
| 1.3 | 0.9339 — 30/30 | 0.9165 — 30/30 |
| 1.8 | 0.9504 — 30/30 | 0.9165 — 30/30 |

The additive correction's delivered coverage swings **0.80 → 0.95 on the shift
alone**, with the model unchanged. The normalised one is flat at 0.9165 across
the whole sweep. That is the whole argument: a correction whose realised
coverage depends on next quarter's fleet size is not a 90% guarantee, it is a
90% guarantee *at one fleet size*.

## The two repairs, and why the obvious one is wrong

**Clamp `delta_lo` at zero** — never let the correction narrow the floor. It is
the first thing anyone reaches for and it is wrong twice over. `TailShift`
already answers it: *"Negative when the boosters over-covered, in which case the
correction narrows the band and is allowed to: conformal makes coverage equal
nominal, not at least it."* And arithmetically, `delta_lo` is large and negative
precisely **because** the fitted `q10` over-covers; removing the correction
sends coverage back up through the window's 0.97 ceiling. Same rail, other side.

**Normalise the residual by the band's own width** — rank
`E_lo / (Q_Y(0.90) − Q_Y(0.10))` instead of `E_lo`, and apply `δ` scaled by that
same width per row. The correction becomes dimensionless and proportional.

## What normalising costs, stated plainly

1. **It makes the correction conditional**, which `TailShift` deliberately is
   not. That is the design change, and it should be argued on the evidence above
   rather than slipped in. The counter-argument is that the current
   unconditionality is what makes the guarantee fleet-dependent.
2. **`delta_lo` and `delta_hi` stop being MWh.** The card publishes both as MWh,
   `docs/specs/forecaster.md` writes the formula in MWh, `model-card.ts` and
   `types.generated.ts` carry the units, and `TailShift.__post_init__` refuses a
   non-MWh value by name. All of that moves together or not at all.
3. **The q-space interpolation must survive.** Forecaster 21 put the shift on
   the composed quantile at every `q` so the ensemble and the served band cannot
   disagree about hour 14. A per-row scale must enter *there*, not at the two
   served quantiles, or that invariant breaks silently.
4. **Every existing artifact's `delta` becomes unreadable** in the new units. A
   version marker on `conformal_method` is not optional.

## Boxes

- [x] `E_lo` is ranked normalised. **The scale is the positive branch's spread,
      `Q_pos(0.90) − Q_pos(0.10)`, not the composed band width this ticket
      first specified.** The composed width depends on `p` through the point
      mass, so two rows with identical magnitude shapes and different `p` would
      be scaled differently and the residual would stop being a property of the
      fit. Floored at 1 MWh, because `MagnitudeQuantiles` permits a degenerate
      branch and a multiple of nothing is nothing.
- [x] `δ` is applied per row through the same q-space path. `TailShift.at(q, *,
      spread_mwh)` takes the row's scale and applies it *inside* the
      interpolation, so forecaster 21's rule is unchanged and the ensemble still
      inverts one object. Asserted by
      `test_the_ensemble_inverts_the_corrected_mixture_and_not_a_second_one`,
      which fails if the shift stops reaching every `q`.
- [x] `conformal_method` reads `one_sided_split_cqr_stated_lower_spread_normalised`.
- [x] The card, `forecaster.md`, `model-card.schema.json` and
      `types.generated.ts` agree: `delta_lo` dimensionless, `delta_hi` MWh.
      `TailShift.lower_spread_multiple` carries the units in its name, so a
      caller cannot pass MWh by habit.
- [x] The sweep is
      `test_the_normalised_floor_survives_the_fleet_moving_and_the_additive_one_does_not`,
      12 seeds × 6 ratios, rail `[0.85, 0.97]`. Reproduced (see below). The
      additive arm is reconstructed in the test file — not in
      `training/conformal.py`, which must have one rule in it — and the test
      fails if that arm ever holds the rail at ratio 0.4, *and* if it fails the
      rail at ratio 1.0, so a merely-broken reconstruction cannot pass for a
      control.
- [ ] A retrain, and the gate's verdict recorded either way

### The sweep, as this repository now runs it

| fleet ratio | additive | normalised |
|---|---|---|
| 0.4 | 0.8016 — **0/12 in band** | 0.9349 — 12/12 |
| 0.6 | 0.8543 — 9/12 | 0.9232 — 12/12 |
| 0.8 | 0.8826 — 12/12 | 0.9153 — 12/12 |
| 1.0 | 0.9021 — 12/12 | 0.9122 — 12/12 |
| 1.3 | 0.9215 — 12/12 | 0.9074 — 12/12 |
| 1.8 | 0.9407 — 12/12 | 0.9008 — 12/12 |

**One claim above is weaker than the ticket first made.** The normalised arm is
*not* flat — it drifts 0.9349 → 0.9008 across the ratios, because dividing by
the positive spread removes the scale but not the shape and a log-normal whose
location moves is not a pure rescaling. It holds the rail everywhere, which is
what the gate asks; "scale-free" is more than the measurement supports and the
test says so.

### One test lost an arm, and that is a result

`test_the_floor_reaches_nominal_where_it_states_one_and_did_not_before` was
parametrised on the contaminated rule missing in **both** directions, so that a
one-sided fixture could not license calling forecaster 35's defect
"conservative". Under normalised residuals the over-covering direction is gone:
swept across 144 settings of `lower_scale`, `sigma`, `stated_share` and both
classifier regimes, the contaminated `before` never exceeded nominal — maximum
0.8996, minimum 0.4643. The over-coverage was itself a magnitude-scale
artefact, which is the quantity this ticket divides out. Both arms remain, both
now assert under-coverage, and the one-sidedness is asserted rather than
assumed.

## What this does not claim

That normalising promotes the artifact. The measurement says it removes the
fleet-dependence; whether the model then clears `[0.85, 0.97]` on a real fold is
the retrain's answer and nobody else's. `ensemble.peak_coverage` is **0.6633**
against a 0.80 target and is a separate miss that this does not touch.
