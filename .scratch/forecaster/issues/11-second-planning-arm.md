# 11 — Score two planning arms, publish both

**What to build:** the backtest builds a plan against P50 *and* a plan against
`E[Y]`, runs both through the optimizer's simulator on the same days with the
same reference fleet, and publishes both arms' `recovered_floor_mwh`.

This is decided work, not an open question. v1 still ships the P50 plan. The
second arm exists so that the number deciding the posture and the evidence for
its replacement arrive together: `E[Y] > P50` exactly when `p < 0.5`, which is
to say the expectation is non-zero in precisely the hours where the P50 plan
goes blind. If ticket 10's collapse figure comes in large, the replacement is
already evidenced instead of starting a fresh argument.

It costs almost nothing: the expectation is already a served field and the
scoring path is already shared. The objection that killed scenario-weighting
does not apply — that failed because the hour-wise quantile envelope is not a
physically realisable day, whereas `E[Y]` is a genuine expectation and adds
across hours legitimately.

The simulator is **imported, not reimplemented** — the same function that scores
a live plan. Both arms are scored against P10, P50 and P90 the way the optimizer
spec specifies, and the floor stays an hour-wise statement: the P10 envelope is
not a member of the path ensemble and is not a realisable day.

**Blocked by:** 09. **External blocker:** the optimizer's simulator and its
execution rule, owned by the flex-optimizer work.

**Status:** done for the machinery and **wired**: `retrain_lane` now calls
`measure_planning_arms` and `record_planning_arms` on every lane of every run.
**No card carrying a measured block has been observed yet** — the wiring is
covered by tests and has not been run against an ingested database from this
branch. See "30 — Corrected" and "30 — Wired" below. The status line read
`done` without qualification before api-surface 30 and "the comparison is never
produced by a running process" after it.

- [ ] Both arms are built on the same days, from the same served artifact, with
      the same fixed published reference fleet
- [ ] Both are scored by the imported simulator; the forecaster contains no
      second copy of the execution rule
- [ ] Both arms' `recovered_floor_mwh` are published per fold in the card, side
      by side, with neither presented as the shipped posture
- [ ] The card states that v1 serves the P50 plan
- [ ] A test asserts the `E[Y]` arm's plan is non-zero in at least the hours
      where `p < 0.5` and the P50 arm's is zero there
- [ ] The reference fleet is stamped on the comparison so the numbers are
      reproducible

---

## 30 — Corrected: the arms are scored by tests and by nothing else

**Status of this correction:** the ticket's status line is amended; no code is
changed here. Found by api-surface 30's reachability sweep, which is
data-platform 03's failure mode asked of every `done` ticket.

`apps/ml/src/wattsteer_ml/evaluation/planning_arms.py` is merged, complete and
covered — `apps/ml/tests/test_second_planning_arm.py` exercises
`score_planning_arms`, `measure_planning_arms` and `record_planning_arms` at
length. **No production path calls any of them.** Checked directly:

```
grep -rn "planning_arms" apps/ml/src/wattsteer_ml/retrain.py \
    apps/ml/src/wattsteer_ml/app.py apps/ml/src/wattsteer_ml/__main__.py
→ no matches
```

The only non-test reference anywhere is a docstring cross-reference in
`dessem_ab_run.py`. So the third box — "published per fold in the card, side by
side" — cannot be true through any run: `retrain_lane` never reaches the
module, and nothing writes a `planning_arm_comparison` block.

**The system itself is honest about this; the ticket was not.**
`NO_HELDOUT_BAND_FOR_ARMS` is a `DeclinedFigure` declared in that module, and
`declined_figures()` (`declined.py:225`) finds it by walking the package rather
than by a list, so `/v1/meta` already publishes "the comparison is unmade
rather than made and found uninteresting". A reader of the API is told the
truth. A reader of this ticket was told the arms were published.

**What it would take to wire it.** One call. `retrain_lane` already holds the
connection, the lane and the `as_of` that `measure_planning_arms(connection,
segments=…, lane=…, as_of=…)` wants, and `record_planning_arms` already writes
the block; the missing line sits beside `run_ladder` at `retrain.py:603`. The
cost is a second simulator pass over the held-out days, which the ticket's own
"it costs almost nothing" argument already priced. **Done on branch
`wire-the-orphans`; see "30 — Wired" at the foot of this file.** Out of scope for this
correction because `apps/ml/**` is owned by a sibling branch this wave.

---

## 30 — Wired: `retrain_lane` calls the module, on branch `wire-the-orphans`

**Status of this wiring:** code changed. The correction above is left standing
rather than rewritten, because deleting the record of what was found is the
thing api-surface 30 exists to stop.

`apps/ml/src/wattsteer_ml/retrain.py` now has the one call the correction asked
for, and two helpers around it:

- `_measure_arms(request, lane=…, segments=…)` — one read-only asyncpg
  connection, `measure_planning_arms(conn, segments=list(inputs.segments),
  lane=lane, as_of=request.as_of)`, closed before anything is written. The
  shape `_lane_inputs` already uses, because a retrain that opened a second
  kind of connection would be a second read path.
- `_record_planning_arms(…)` — writes the block through `record_planning_arms`,
  and turns the two *data* failures into an `UnmeasuredPlanningArms` carrying
  the reason rather than losing the card edit: `PlanningArmError` (a segment
  whose held-out bands come from more than one backtest run) and
  `asyncpg.PostgresError` (a database that cannot answer). Anything else
  propagates, which is `dessem_ab_run.py`'s rule and this repository's: a run
  that raised something nobody predicted has not been understood. The empty
  case is deliberately *not* caught — `measure_planning_arms` raises on an
  empty segment list, which is a caller mistake and not an empty table.
- The call sits in `retrain_lane` after `save_artifact`, because
  `record_planning_arms` edits a card on the volume and never mints one, and
  before `run_gate`, because the arms are read out of Postgres rather than out
  of this candidate — so a refused candidate's card, which is the one an
  operator goes and looks at, carries the block too. Nothing in the gate reads
  it: v1 still ships the P50 plan and the block says so in its own `serves`
  field.

### What happened to the honest refusal

`NO_HELDOUT_BAND_FOR_ARMS` is **still published on `/v1/meta`**, and that is
right rather than a leftover. What changed is not its text but its reachability:

- Before, it was a `DeclinedFigure` that `declined_figures()` found by walking
  the package and published on `/v1/meta` while **no code path could emit it** —
  the module it lives in had no production caller at all.
- After, it is the `reads` field of the block `retrain_lane` writes whenever a
  lane's fold segments carry no complete held-out subsystem-day. Its own words
  — "the measurement ran and found nothing to build an arm on … no held-out
  band exists for this lane yet" — become true of a real run the first time the
  weekly retrain fires before the holdout backfill has filled that lane.

So it stopped being unreachable because the measurement now exists. It will stop
being *emitted* the first time a lane has held-out bands, and not before, which
is the only honest way for it to go away.

### What has not been done

No retrain has been run against an ingested database from this branch, so no
`planning_arm_comparison` block with `measured: true` has been observed. The
third box stays unticked for exactly that reason: `bun run ml:test`'s passing
suite is a statement about the code and not about a card.

