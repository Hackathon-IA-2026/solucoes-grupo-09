# 10 — The interchange utilisation proxy, and its missing denominator

**What to build:** WattSteer can express how hard a directed corridor is being
pushed, as an explicit **estimate** — published per corridor with its sample size
— rather than as a ratio that quietly pretends a published limit exists.

**The answer to the open question is no.** The ONS open-data catalogue was
enumerated in full and contains no transfer-limit dataset at any grain. The
interchange series publishes realised flow, and programmed flow only from 2026.
There is no denominator to divide by. Whether limits exist behind ONS's
authenticated portal was not investigated and stays an open question; even if
they do, they would be study-horizon values rather than hourly operational
limits.

So the denominator is estimated, and the estimator is itself point-in-time so
the proxy cannot leak:

```
export_capability_estimate(corridor, gate)
  = P99.5 of directed flow over the 365 days ending at actuals_cutoff(gate)
```

Each choice in that line is load-bearing:

- **A high quantile, not a maximum.** A maximum is one outlier hour defining a
  year of denominators. At hourly grain P99.5 is roughly 44 hours a year —
  plausibly the binding regime, and robust.
- **Trailing and gate-bounded**, so the denominator cannot see the future. This
  matters more than it looks: a naive whole-history maximum leaks a 2026 record
  flow into a 2024 feature.
- **A minimum sample.** Fewer than 300 non-null hours in the trailing year
  yields NULL rather than a denominator computed from noise.

**The proxy works because of the tautology, not despite it.** When a corridor
binds, observed flow *is* the limit — which is why historical maxima approximate
it, and equally why it is only meaningful for corridors that actually bind. For
a corridor that never binds the ratio is a scaled flow, and the model should be
allowed to discover it is uninformative.

**Named limitation.** This is a *capability* proxy. It cannot see a temporary
derate from a line outage — which is exactly the condition the external-grid
reason code names. So it is published per directed corridor with its sample
size, and a screen can show it as an estimate rather than as a limit.

The DESSEM export utilisation ratio lands here too, because it divides by this
same denominator and would otherwise be the one place a second, disagreeing
estimate could appear.

**Blocked by:** 05 — lagged actuals, for `actuals_cutoff`. 07 — DESSEM, for the
implied net export that the augmented set's utilisation ratio divides.

**Status:** ready-for-agent

- [ ] `export_capability_estimate(corridor, gate)` is a P99.5 of directed flow over the trailing 365 days ending at `actuals_cutoff(gate)`
- [ ] Fewer than 300 non-null hours in the trailing year yields NULL rather than a denominator
- [ ] The estimate is published per directed corridor with its sample size, and is labelled an estimate everywhere it surfaces
- [ ] The absence of any published transfer limit is stated at the feature rather than worked around silently
- [ ] Observed export utilisation over the last 24 available hours and the corridor's trailing seven-day maximum utilisation are features
- [ ] The DESSEM export utilisation ratio divides the implied net export by this same estimate, and no second estimate exists anywhere
- [ ] A whole-history maximum would change the value, and a test demonstrates the trailing gate-bounded estimate differs
- [ ] Seams 1 and 2 still pass with these features present
