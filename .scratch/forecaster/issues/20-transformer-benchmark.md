# 20 — The transformer benchmark, run once and never promoted

**What to build:** an honest comparison against a covariate-aware sequence
model, scored by the same metric through the same composition arithmetic, whose
non-promotion is enforced by the gate rather than by agreement.

**Temporal Fusion Transformer, not PatchTST.** PatchTST's strength is a long
look-back over the target series itself, and this problem's look-back is
deliberately crippled by the publication gate — the nearest usable same-hour
actual is 48 hours back and most of the vector is exogenous. TFT is the
covariate-aware architecture and is therefore the honest comparison: it is being
asked the same question LightGBM is asked.

Run once, offline, on the free feature set at the late gate profile, on the same
folds. A model that produces quantiles directly still feeds the mixture
inversion, with its own occurrence head — the ladder compares models, not model
families' conventions. Reported with training time and explainability columns
filled in honestly.

It is never served. The card carries the estimator family and the gate refuses
any candidate whose family is not on the served allow-list; changing that list
is a code change with a review, which is what "we agreed it stays a benchmark"
should mean six months from now. This ticket does not add the enforcement —
ticket 13 owns it — it is the run that proves the enforcement bites.

**Blocked by:** 09, 13.

**Status:** ready-for-agent

- [ ] The benchmark trains on the shared fold calendar and is scored on
      identical test rows by `qloss_mwh` through the composition function
- [ ] Its occurrence head feeds the same mixture inversion; no bespoke band is
      published for it
- [ ] Training time and an explainability note are recorded beside the metrics
- [ ] Its card carries an estimator family outside the served allow-list, and a
      test confirms the gate refuses it
- [ ] The run happens once, offline, and is not wired into the weekly retrain
