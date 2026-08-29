# 07 — Domain rules that can speak but cannot write

**What to build:** the arbitration mechanism between the model's attribution and
what a grid engineer knows, built now, with most of its content deferred. A
mechanism designed after the rules exist would be designed to fit them.

**A rule is a predicate over `(feature_row, composed_forecast, attribution,
recent_observations)` with exactly one of three actions:**

| Action | What it may do | What it may never do |
|---|---|---|
| `annotate` | Attach a typed fact to `rule_flags[]`, which the narration is **required** to state | Touch any number |
| `demote` | Force a driver group below the fold regardless of its share | Change its contribution, its sign or its share |
| `withhold` | Suppress the model narration; the template renders instead | Change any number, or delete a driver |

**No rule may change a number and no rule may create a driver.** This is the
whole design. An attribution a rule could overwrite would no longer be the
model's attribution, and every property established elsewhere about the model —
the reliability curve, the coverage report, the shuffled-label control — would
stop describing what is on the screen. A rule's power is over *what gets said*,
never over *what is true of the model*.

**When a rule and the attribution disagree, both are published and neither
wins.** The drivers go out untouched, the flags go out alongside, the narration
is required to state both, and the screen shows the annotation adjacent to the
bars. A rule asserts a fact about the *grid*; a contribution asserts a fact about
the *model*. They are not the same kind of claim, so "resolving" them would mean
silently converting one into the other.

**Ordering, so two rules cannot both claim the last word:** rules evaluate in
declared order, every fired rule is recorded with its inputs, and the strictest
action taken by any fired rule governs — `withhold` > `demote` > `annotate`.

**The four rules that ship**, chosen because none needs a constant that does not
already exist as data:

| `code` | Action | Fires when |
|---|---|---|
| `nothing_to_explain` | `withhold` | The day's occurrence probability is below the lowest risk-bin edge **and** no hour's P50 is non-zero |
| `attribution_is_noise` | `withhold` | The summed absolute attribution is at most twice the attribution standard error — the ranking is smaller than its own error |
| `stale_inputs` | `annotate` | The weather run age is above zero, or centroid coverage is below full, or a displayed group's headline feature is NULL at serve time |
| `unmodelled_outage_regime` | `annotate` | On the most recent settled day for this subsystem, `REL` accounts for the largest share of constrained-off MWh |

`unmodelled_outage_regime` is the sharpest honest rule available: the forecaster
ruled the reason-code model out because no ingested dataset carries transmission
availability, so when yesterday's curtailment was mostly external unavailability
the model is explaining a mechanism it structurally cannot see, and the screen
should say so beside the bars rather than in a footnote nobody reads.

**What is deferred, and the trigger that reopens it.** Every rule encoding grid
*physics* needs a threshold nobody can set today. Reopen when three
point-in-time folds exist and the driver-stability report has been produced. A
candidate rule is admitted only if it fires on at least 20 days in that report,
every quantity in its predicate is an ingested column or an artifact field, and
its action is `annotate` or `demote` — a new `withhold` rule needs a separate
review, because withholding is the only action a user can notice as an absence.

**Blocked by:** 04 (the attribution and its standard error), 06.

**Status:** ready-for-agent

- [ ] A rule can annotate, demote or withhold, and can do nothing else
- [ ] Property test: for randomly generated payloads and every rule, the probability, the band, the expectation, every contribution, every share and every rank-underlying value are byte-identical before and after the rules run
- [ ] Only the flags, the demotion marks and the narration-source decision may differ
- [ ] Two rules with conflicting actions resolve to the strictest
- [ ] A fired rule always appears in the flags, with the inputs that fired it
- [ ] A `withhold` rule means the language model is never called — asserted on the client not being invoked, not on its output being discarded
- [ ] The four shipping rules each read only artifact fields or ingested columns; no invented constant appears
- [ ] The reopening trigger for the deferred physics rules is recorded where the next session will read it
