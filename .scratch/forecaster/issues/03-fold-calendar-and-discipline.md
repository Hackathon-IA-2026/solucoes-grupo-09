# 03 — The fold calendar as data, and fold discipline that is asserted

**What to build:** every run in the experiment matrix is scored on identical
test rows, and it is impossible to score one on rows it should not have seen.

The backtest is expanding-origin walk-forward with **fixed calendar test folds
shared by every run** — quarterly, the first starting twelve months in so a
training block can contain the season it is asked to predict, the live-edge fold
growing until it reaches a full quarter and then freezing. The calendar is
*data*, not code, and changing it invalidates cached fold results.

Two carve-outs the rest of the spec depends on: the **calibration window is the
90 days immediately preceding the train end, carved out of the training block
rather than shared with it**, and base learners are never refit after the
calibration layer is fitted — refitting would put calibration data in-sample and
shrink the conformal correction toward zero. There is no purge beyond that
split: trailing feature windows cross the boundary forward, which is information
the serving path also has.

Each fold carries a `VintageFidelity`. A fold whose test period straddles
ingestion go-live is split at that date and reported as two rows, never
averaged — averaging is precisely how a caveat disappears.

**Blocked by:** None — can start immediately. **External blocker** for the
row-identity assertions only: the feature function, sliced in parallel in the
feature-engineering issue set.

**Status:** done

- [ ] The fold calendar is a stored, versioned data artifact — test period,
      test day count, train end, calibration window — and a change to it
      invalidates cached fold results
- [ ] Base-fit block, calibration window and test period are produced together
      for any fold, and the first two are disjoint
- [ ] A test asserts, per fold, that the latest train target date precedes the
      earliest test target date, and that folds are never shuffled
- [ ] A test asserts every run in the matrix is scored on an identical test-row
      set by comparing row hashes, not row counts
- [ ] Every fold is stamped with a `VintageFidelity`; a fold straddling
      ingestion go-live yields two rows and no averaged one
- [ ] The live-edge fold grows to a full quarter and then freezes, opening the
      next fold, without a manual edit
