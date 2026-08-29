# 12 — The shuffled-label control

**What to build:** a run of the entire pipeline — feature build, both stages,
calibration, conformal, folds, metrics — with the labels randomly permuted
within each fold's date range, which must score at chance.

This is the single most valuable test in the spec and the load-bearing artifact
of the whole ticket set. The models will be replaced; the property that a
pipeline trained on permuted labels must score at chance is what makes every
other number in the model card believable, and it catches the class of harness
bug that no review finds. It is the model-layer twin of the feature spec's
gate-ablation test one layer down, and like it, **it does not need to know how
the leak happened**.

Permutation is within each fold's date range, not global, so that a seasonal
signal cannot be mistaken for a leak.

**Blocked by:** 09.

**Status:** ready-for-agent

- [ ] The control runs the same code path as a real run — no branch that skips
      calibration, conformal or the composition
- [ ] Labels are permuted within each fold's date range, and the permutation is
      seeded and recorded
- [ ] The run asserts PR-AUC is within a bootstrap confidence interval of
      prevalence
- [ ] The run asserts `qloss_mwh` is no better than the prevalence rung
- [ ] A failure names the fold and the metric that scored too well, so a leak is
      localised rather than merely announced
- [ ] The control is cheap enough to run in the default suite on a reduced fold
      set, and runs in full on the schedule
