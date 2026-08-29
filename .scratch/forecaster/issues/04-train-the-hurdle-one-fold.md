# 04 — Train the hurdle on one fold and get a band out

**What to build:** the tracer bullet — from the feature vector to a composed
P10/P50/P90 band and an expected MWh for every subsystem-hour of one test fold,
written to the volume as a loadable bundle with a card that says what it is.

Six estimators, all LightGBM, all fitted on the base-fit block only: the
occurrence classifier on every feature row; three pinball boosters at 0.1 / 0.5
/ 0.9 on the rows above threshold; a fourth, cheap squared-error booster for the
conditional mean, because the conditional mean of a right-skewed magnitude
distribution sits above its median and reusing the median booster would
understate the expectation systematically; and the wind-share regressor. Plus
`μ_sub` — the base-fit empirical mean over sub-threshold rows by subsystem and
local hour, 96 numbers.

**One model across subsystems**, with subsystem as a categorical feature: four
per-subsystem models would starve S and N, and the physics is shared. **No
imputation anywhere on the served path** — a feature that is NULL is NULL
because it was not knowable, and imputing it destroys the one signal the gate
encodes. Hyperparameters are fixed, published and never searched during a
retrain; the configuration is small and conservative and lives in the card under
a `model_config_version`.

The bundle is one frozen dataclass so a partial load fails loudly. The card
carries identity, lane, contract — including the **feature hash over the ordered
feature names and the feature function's definition** — data windows and
environment versions; the metric and experiment blocks accrete later.

**Blocked by:** 01 (the composition), 03 (the fold calendar). **External
blocker:** the feature function, sliced in parallel in the feature-engineering
issue set.

**Status:** ready-for-agent

- [ ] One fold trains all six estimators plus `μ_sub` on the base-fit block
      alone, and produces a complete 24-hour band and expectation for every
      subsystem in the test period
- [ ] The band is produced by the composition function from ticket 01 — training
      does not reimplement the mixture
- [ ] Subsystem is a categorical feature of one shared model, and nothing on the
      served path imputes a NULL
- [ ] Hyperparameters come from a named `model_config_version` and no search
      runs inside training
- [ ] The bundle loads as a single frozen object; a bundle missing any estimator
      fails to load rather than serving a partial mixture
- [ ] The card records identity, lane, feature hash, feature-set version,
      training / base-fit / calibration windows, row and positive counts, and
      environment versions
- [ ] A card whose feature hash disagrees with its bundle's stored feature list
      fails to load
- [ ] Same inputs and same seed reproduce identical predictions and an identical
      feature hash
