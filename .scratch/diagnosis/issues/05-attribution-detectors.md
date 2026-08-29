# 05 — Prove the attribution is reading the model

**What to build:** an attribution has no ground truth, so this ticket builds the
detectors that catch a whole class of wrongness without knowing what right looks
like. These are the tests a future session that wants to "simplify" the design
has to confront, and they are the reason the design can be trusted at all.

**The additive cross-check — where grouping is validated.** On a synthetic model
that is additive across the group boundary, the grouped Shapley value **must
equal** the sum of the member features' interventional Shapley values. On a
model with a deliberate cross-group interaction it **must not**, and the gap must
be exactly the interaction term. Together these pin down that the implementation
solves the game it claims to solve, and they name the honest difference between
group-first and attribute-then-group.

**The sign-honesty property.** Construct a group whose two members have
per-feature contributions of `+40` and `−35`. The group's own value is computed
from the coalition and is **not** `+5` unless the model happens to be additive
there. A structural test asserts that no code path sums member-level values into
a group value — this is the invariant most likely to be broken by a well-meaning
optimisation.

**The matched background, asserted.** The subsystem and the local hour contribute
numerically zero on every instance, because the background is matched on both. A
non-zero value means the sampler leaked across cells, which would make every
"typical" on the screen wrong. This test is cheap and catches the single most
likely implementation bug.

**The shuffled-feature control — the generic detector, and the most valuable test
in this spec.** Permute one group's columns across rows within a fold and re-run
the attribution. That group's absolute day contribution must collapse toward
zero and the other groups' rankings must be materially unchanged. **If permuting
a group's inputs leaves its contribution intact, the attribution is not reading
the model** — and the test needs to know neither which group nor which model.

**Blocked by:** 03, 04.

**Status:** ready-for-agent

- [ ] The additive-model cross-check passes and the interaction-model cross-check fails, with the gap equal to the interaction term
- [ ] A group with members of opposing sign is asserted not to report their arithmetic sum
- [ ] A structural test forbids any code path that sums member values into a group value
- [ ] The subsystem's and the local hour's contributions are numerically zero on every instance
- [ ] The shuffled-feature control collapses the permuted group and leaves the others' ranking materially unchanged
- [ ] All of these except the shuffled-feature control run with no network, no database and no model artifact
- [ ] The shuffled-feature control runs against a real artifact under the existing environment-variable gating
