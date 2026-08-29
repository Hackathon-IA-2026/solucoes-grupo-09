# 05 — A stated 80% means 80%, and the risk classes come from the curve

**What to build:** the occurrence probability the product shows is calibrated,
the reliability curve behind it is a property of the model rather than a
self-portrait, and the named risk classes rest on measured bins instead of two
invented percentages.

Calibration is **isotonic**, fitted on the 90-day calibration window. The
calibration set is large enough that isotonic does not overfit its steps, and
the distortion a boosted classifier on an imbalanced target produces — well
calibrated low, increasingly over-confident in the top bins — is a shape a
two-parameter sigmoid cannot flatten without bending the bottom. The resolution
isotonic costs is resolution nothing consumes: the overview renders wide named
bins, and `p` enters the mixture only as a breakpoint at `1 − p`.

Output is **clipped to `[1/(2n), 1 − 1/(2n)]`** where `n` is the calibration
window's row count — so the clip is a function of evidence, not a magic epsilon.
Zero is forbidden twice over: it makes the composed quantile undefined at
`q = 1`, and it puts "0%" on a screen as a claim about tomorrow.

The reliability curve is computed on **pooled out-of-fold predictions across
every walk-forward test fold** — never on the window it was fitted to, never on
training data. Ten equal-width bins; a bin below 100 hours merges upward and the
merge is recorded. Stored in the card with its sample hours, window and
`VintageFidelity`, alongside ECE, MCE and the top-bin gap on its own, because
that is where a curtailment classifier fails.

The risk-class edges become artifact metadata by this rule: choose edges from
the calibrated curve such that (a) within each bin the mean predicted and the
observed frequency differ by at most 0.05, and (b) adjacent bins' observed
frequencies differ by more than the sum of their 95% binomial CI half-widths;
among candidates satisfying both, take the one whose bins are most nearly equal
in hour count; round to the nearest 5 points. Edges are held stable across
retrains unless a retrain violates (a) or (b) — a named class that moves weekly
is worse than one three points off, and a change is a product-visible event.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] Isotonic is fitted on the calibration window only, and the base learners
      are not refit afterwards
- [ ] A calibrated probability is never exactly 0 or 1, and the clip bounds are
      derived from the calibration window's row count and stored in the bundle
- [ ] The reliability curve is computed from pooled out-of-fold predictions, and
      a test asserts the row set it consumes is disjoint from the calibration
      window
- [ ] Bins below 100 hours merge upward and the merge is recorded in the card
- [ ] ECE, MCE and the top-bin gap are stored as scalars beside the curve, with
      sample hours, window and `VintageFidelity`
- [ ] Risk-class edges are derived by the stated rule, written to the card, and
      held stable across retrains unless the rule is violated
- [ ] On synthetic over-confident probabilities, isotonic reduces ECE, preserves
      monotonicity, and beats a Platt fit in the top bin — the test that records
      why isotonic was chosen
