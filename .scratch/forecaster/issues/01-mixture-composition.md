# 01 — The mixture composition, as arithmetic

**What to build:** one function that turns an occurrence probability and a
magnitude quantile function into the P10/P50/P90 band the product ships, plus
the expected MWh beside it — imported by training, serving, backtesting and
Replay, so four callers cannot hold four mixtures.

This is the spine of the whole spec and it is buildable before any model
exists, because it is arithmetic on fixtures. The hurdle's two estimators are
never multiplied; they are composed by inverting the mixture CDF:

```
Q_Y(q | x) =  0                                    if q ≤ 1 − p(x)
              Q_pos( (q − (1 − p(x))) / p(x) | x ) if q >  1 − p(x)

E[Y | x] = p(x) · Ê[Y | Y > τ, x] + (1 − p(x)) · μ_sub(subsystem, local_hour)
```

Sub-threshold mass is a point at zero in the quantiles (conservative by at most
`τ`) and a fitted constant in the expectation (`μ_sub`, 96 numbers by
subsystem × local hour). The expectation is a separate field and is never the
band's centre. The per-technology figure is the share applied to the P50 and to
the expectation only, and is typed as a scalar so no caller can render it as a
band.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The composed band and the expectation come from one function, and its
      inputs are `p`, a positive-magnitude quantile function, a conditional
      mean and `μ_sub` — nothing else
- [ ] `Q_Y(q) = 0` for every `q ≤ 1 − p` and only then; `Q_Y(q) > τ` whenever
      `q > 1 − p`; `Q_Y` is non-decreasing in `q`
- [ ] `E[Y] ≥ Q_Y(0.5)` for every `p < 0.5`, and `E[Y]` equals the mixture
      formula exactly
- [ ] Boundary cases hold: `p` at its clipped lower bound (band all zeros,
      expectation `μ_sub`), `p` at its clipped upper bound (band is the
      positive quantiles unchanged)
- [ ] Independently-fitted quantile boosters that cross are sorted after
      composition, and the crossing rate is returned as a measured quantity
      rather than silently swallowed
- [ ] The technology split is typed as a scalar on the composed result
- [ ] `τ` travels with the composition as the `threshold_mw` in force, never as
      a module-level constant
