# Spec — WattSteer Replay Engine (the Time Machine)

> Re-running a past day honestly: a forecast that never saw the day, a plan
> built the way the live path builds it, and a number scored against what
> actually happened — with the two things that are wrong with the naive version
> named separately, because they are two different problems and only one of them
> is fixable.
>
> **Upstream specs.** [`forecaster.md`](forecaster.md) owns the fold calendar,
> the per-fold artifacts, the composed band and the persisted `Forecast` rows.
> [`flex-optimizer.md`](flex-optimizer.md) owns the MILP, the simulator and the
> KPI definitions, and it *fixes Replay's posture as a constraint rather than a
> suggestion*. Both are honoured here in full; the two places this spec extends
> them, and the one hand-back it owes ticket 009, are named in
> [Further Notes](#further-notes).
> [`feature-engineering.md`](feature-engineering.md) owns
> `gate_at(target_date, gate_profile)`, which is the single mechanism that makes
> a replay reproducible at all.
>
> **Naming authority.** [`../domain-model.md`](../domain-model.md) — `Replay`
> is a read mode and not a table, `CurtailmentEpisode` is a read-time view,
> `AsOf(t)` is the only sanctioned read, `VintageFidelity` is product-visible.
> Where it and this spec disagree, it wins.
>
> Ticket: [`012-replay-spec.md`](../../.wayfinder/tickets/012-replay-spec.md).
> Map: [`../../.wayfinder/map.md`](../../.wayfinder/map.md).

## Problem Statement

IDEA.md §34 gives five steps — restrict to D−1 information, forecast,
recommend, reveal what happened, simulate the portfolio — and every one of them
is a query against machinery that already exists. The bitemporal store makes
"what did we know then" an `AsOf`; the feature spec makes "what was knowable"
a `gate_at`; the optimizer makes "what should the fleet have done" a 3 ms
solve. On the data-model's own account, *a Replay is a Scenario whose
`target_date` is in the past, plus a UI*. That is the easy 90 %.

The hard 10 % is that the resulting number is the one the whole pitch rests on
— **"612 MWh curtailed, 281 MWh recoverable, ↓45.9 %"** — and there are three
independent ways for it to be quietly wrong, in the flattering direction, with
nothing on screen to show it.

**1. The model has seen the day.** The artifact on serving duty was trained on
2024-04 → the last retrain. Ask it for a "D−1 forecast" of a day inside that
window and it returns an in-sample fit. The recovered energy computed from an
in-sample fit is an upper bound on what the live system would have achieved,
and it is an upper bound of unknown size. This is not a caveat on a
counterfactual; it means **there is no counterfactual**. The current screen
labels this and shows the number anyway, which is the option the ticket lists
third, and it is not enough — a label above a 45.9 % does not stop the 45.9 %
from being quoted.

**2. The past has been rewritten.** ONS restates history in place, under the
same filenames, with no version marker; all of 2025 was rewritten in 2026 and
prior vintages are unrecoverable. For any date before ingestion go-live there is
no true point-in-time view, so the "actual" a replay scores against is ONS's
*current* restatement of that day. Unlike (1), **this can never be repaired**,
by any amount of engineering, ever. Treating the two as one "confidence"
indicator hides that asymmetry.

**3. The arithmetic has a direction.** The optimizer plans against a *forecast*
and the avoided energy must be measured against the *actual*. Those differ, and
the difference is not symmetric. When the forecast over-estimates, the execution
rule clips and the number falls — safe. When the forecast **under**-estimates,
there is real curtailment sitting in the hour that the plan never asked for, and
the tempting move — let the battery take it, it was physically there — is
hindsight, applied at exactly the hours where the model was worst. It would
inflate recovered energy precisely on the days that should embarrass the
forecast. Nothing in the MILP or the simulator prevents it; only a written-down
rule does.

Underneath all three is one property: **a replay is the product grading its own
homework**, and every defect in it produces a better mark. Everything below is
arranged so that the grading is done by machinery that could not have been tuned
to pass.

## Solution

**A replay never runs a model.** It is a query for a forecast that was computed
by an artifact which had not seen the day, a plan built by the same MILP the
live path builds, and a score produced by the same simulator function — the one
imported, not reimplemented, per `flex-optimizer.md`'s non-negotiable rule.

Four decisions carry it.

**Integrity is a precondition, not a label.** Every replayable day resolves to a
`Forecast` row produced by an artifact whose training and calibration windows
both exclude that day. Two provenances satisfy that, and nothing else is
offered:

| Provenance | Days | Where the forecast comes from |
|---|---|---|
| `served` | post-go-live, post-first-promotion | The `Forecast` rows the live path already persists. Nothing is recomputed — this is literally what WattSteer said. |
| `fold_holdout` | inside a walk-forward test fold F1–F5 | The out-of-fold predictions the backtest **already computes and currently throws away**, persisted as `Forecast` rows carrying the fold artifact's id. Out of sample by construction. |

Days in the pre-F1 training block (2024-04-01 → 2025-03-31) are **not
replayable**. They are viewable — the observed profile, the episodes, the
perfect-foresight bound — with no forecast, no plan and no recovery number,
because no honest one exists. The ticket's third option (label it) is
deliberately rejected for this case, and the ticket's first option (train a
fold-specific model excluding the replayed period) turns out to be the same
mechanism as the second at a finer granularity: the fold calendar already fixes
the granularity, and choosing it means **no training happens at replay time**.

**The two honesty axes stay separate, because today they coincide and in two
months they will not.** In-sample-ness is about the *model's* information set
and is fixed by construction above. Vintage is about the *data's* information
set and is permanent. In v1 every `fold_holdout` day is also
`revision_optimistic` and every `served` day is also `point_in_time`, so a
single merged badge would be indistinguishable from the right answer right now —
and wrong the moment F7 opens on a post-go-live quarter.

**The forecast is precomputed; the dispatch is computed on demand.** The
expensive, non-reproducible half (load an artifact, build features at
`gate_at`) is materialised into `Forecast` rows at backtest time. The cheap,
interactive half (MILP + simulator, 3.15 ms) runs per request, so a slider
moves the chart and changing the fleet re-plans without ever re-running a model.

**Observed is the fourth realisation, and the denominator.** The plan is built
on the pinned D−1 P50 and simulated against P10, P50, P90 *and* the observed
profile by one function. The headline numbers are the observed ones; the P10
score is what was promised at D−1; whether the observed score cleared it is
`floor_met`, and its share over many days is **floor coverage**, the Backtest
metric `flex-optimizer.md` requires and the map's open gate item needs.

## User Stories

**Integrity**

1. As a sceptic, I want every replay to be produced by a model that had not seen
   the replayed day, so that "counterfactual" is a property of the machinery
   rather than a word on a screen.
2. As a sceptic, I want a day no honest model exists for to be **refused**
   rather than labelled, so that a number I should not quote is not rendered
   where I can quote it.
3. As a user, I want the screen to name *which* artifact produced the forecast
   and *what window it was trained on*, so that the claim is checkable rather
   than asserted.
4. As a developer, I want the held-out property asserted at read time against
   the artifact's own recorded windows, so that a mislabelled artifact fails
   loudly instead of producing a flattering replay.
5. As a product owner, I want a replay never to consult the currently promoted
   serving artifact for a historical day, so that a retrain can never turn an
   honest replay into an in-sample one.
6. As a user, I want a replay of the same day and scenario to return the same
   numbers next month, so that a link I shared does not silently re-mean itself
   after a retrain.

**Vintage**

7. As a user, I want a day predating ingestion go-live marked
   `revision_optimistic` and told what that costs, so that the "actual" is not
   read as what was published at the time.
8. As a user, I want the vintage caveat to name *which parts of the replay it
   touches* — the settled actuals and the lagged-actual features, never the
   weather run — so that the caveat is proportionate rather than a general
   shrug.
9. As an analyst, I want the size of the vintage caveat **measured** in the
   product's own unit rather than asserted, so that "how much should I discount
   the 2025 replays" has a number.
10. As a reader, I want the in-sample question and the vintage question shown as
    two separate statements, so that fixing one is not read as fixing both.

**Which days**

11. As a user, I want to replay any held-out date in the window by URL, so that
    the tool is not limited to days someone chose for me.
12. As a user, I want a curated shortlist on the screen, so that I do not have
    to know which dates were interesting.
13. As a sceptic, I want the shortlist chosen by a **published deterministic
    rule** that is obliged to include a day the forecast got wrong, so that the
    featured days are not a highlight reel.
14. As a user, I want an unreplayable date to explain *why* it is unreplayable,
    so that the boundary is legible rather than arbitrary.

**The arithmetic**

15. As a user, I want the plan built against the P50 of the D−1 vintage of the
    pinned run — not P10, not the revised forecast, not the actuals — so that a
    backtest number and a forecast number are the same kind of number.
16. As a user, I want avoided energy measured against what actually happened,
    so that the headline is a claim about the day rather than about the
    forecast.
17. As an engineer, I want the assets to absorb only what the plan scheduled,
    capped by what was actually curtailed, so that a day that came in bigger
    than forecast cannot be scored with hindsight.
18. As a user, I want a day that came in bigger than forecast to show a *lower*
    `avoidability` ratio, so that the fixed-fleet arithmetic is visible rather
    than surprising.
19. As an engineer, I want the state of charge recomputed from the executed
    dispatch, so that on a small day the battery does not report filling up on
    energy it never received.
20. As a user, I want the floor that was promised at D−1 shown beside what the
    plan actually achieved, so that the promise is a claim the product checks.
21. As a product owner, I want floor coverage over many days as a first-class
    Backtest metric, so that "the floor is a floor" is measured and not argued.
22. As a user, I want the perfect-foresight solve present but visually and
    semantically separated as an upper bound, so that hindsight never leaks into
    a recovery claim.
23. As an analyst, I want the gap between perfect foresight and what the plan
    achieved published as its own number, so that the value of a better forecast
    is quantified rather than implied.
24. As a user, I want avoidability to read "—" on a day with nothing to avoid,
    because zero means "nothing could be avoided".
25. As a user, I want the day-total forecast band to come from the path
    ensemble, so that no number on this screen is a sum of quantiles.

**The screen**

26. As a user, I want the honesty block above the headline figures and not
    collapsible, because it changes what the numbers mean.
27. As a user, I want one number for absorbed / recovered / avoided energy,
    because they are one quantity and three boxes would imply three facts.
28. As a user, I want the denominator to be the whole local day, not the
    episode, so that two screens cannot disagree about what "612 MWh" counts.
29. As a user, I want the episode's threshold and gap tolerance carried on the
    result, so that the run of hours I am shown is traceable to the parameters
    that produced it.
30. As a user, I want the scheduled dispatch and the executed dispatch drawn as
    two series, so that "planned against P50" is visibly not "assumed P50 came
    true".
31. As a user, I want no carbon claim anywhere on this screen, because none is
    derivable from recovered renewable energy without a marginal-emissions
    model.

**Backtest, the aggregate**

32. As an analyst, I want a Backtest to be many replays scored by the same code
    as one replay, so that the aggregate cannot drift from the thing it
    aggregates.
33. As an analyst, I want every Backtest metric stamped with its
    `VintageFidelity` and **never averaged across values**, so that a
    revision-optimistic number cannot be smuggled into a point-in-time one.
34. As an operator, I want floor coverage to enter the hot-swap gate as a
    comparative guardrail rather than an absolute bar, so that it is decidable
    before anyone knows what good looks like.
35. As an analyst, I want the reference fleet used for every aggregate to be one
    published constant in one place, so that floor coverage and the forecaster's
    `Δ recovered_floor_mwh` are computed against the same battery.

**The endpoint**

36. As a client, I want a replay to answer inside one HTTP request, because the
    fleet controls on this screen are the same what-if controls as Mitigate's.
37. As a developer, I want a replay's forecast to be a pinned row rather than a
    live model call, so that the request path contains no joblib load and no
    feature build.
38. As a developer, I want a `fold_holdout` forecast row to be structurally
    unable to leave the day-ahead endpoint, so that a backfilled reconstruction
    can never be served as a live forecast.
39. As an operator, I want the same rate limit and the same scenario validation
    as `/v1/optimize`, because it is the same solver behind the same public
    surface.
40. As a developer, I want every refusal to be a typed code, never a translated
    string, per the i18n spec.

## Implementation Decisions

### The integrity question — decided

**Decision: every replay is served by an artifact that did not see the replayed
day. Days for which no such artifact exists are refused, not labelled.**

The ticket's three options are not three points on a spectrum. Options 1 and 2
are the *same mechanism at two granularities*: "train a fold-specific model
excluding the replayed period" is what a walk-forward fold artifact already is,
and doing it per-day rather than per-fold would mean training a model inside an
HTTP request, gating nothing, reproducing nothing, and producing a number that
depends on when it was asked for. The fold calendar in `forecaster.md` already
fixes the granularity at a quarter, and those artifacts are already trained,
already scored, and already on the volume. Choosing fold granularity therefore
costs nothing and buys reproducibility.

Option 3 — label it — survives as a *supplement*, never as a substitute. It
supplies the vintage statement, which no mechanism can fix.

**The three-way split of the window.** Two dates that already exist as
constants — the first walk-forward test fold's start and ingestion go-live —
partition every date in range:

| Range | Replayable | Provenance | `VintageFidelity` |
|---|---|---|---|
| 2024-04-01 → 2025-03-31 | **no** — observed-only | — (every artifact's training block) | `revision_optimistic` |
| 2025-04-01 → 2026-06-30 (F1–F5) | yes | `fold_holdout` | `revision_optimistic` |
| 2026-07-01 → yesterday (F6+, post-go-live) | yes | `served` | `point_in_time` |

**This table is derived, and deliberately not asserted.** It is what falls out
of the two constants *at today's values* — nothing in the code reproduces it,
and no test pins it. The third column comes from `canonical_read_go_live` for
the reads a replayed day's actuals depend on, combined by the weakest-link rule,
so if a second such read goes live later the boundary moves and the third row
above starts a day later than it says. That is the intended posture, and it
matches `forecaster.md`, which treats `T_go` and the fold calendar as
independent and specifies the straddling fold precisely because they may not
coincide. A conformance test against this table would have to name 2026-07-01
somewhere, which would turn a deployment fact into a modelling constant and
would fail on the change — a read joining the list — that ought to be data. The
cost is accepted and stated here rather than left for a reader to discover: when
the boundary moves, **this table goes stale silently and the product does not**.

The pre-F1 year is a real loss — it is a third of the window and it contains
notable events — and the loss is accepted rather than papered over. What is
offered for those days is an **observed-only view**: the settled profile, the
episodes at the threshold in force, and the perfect-foresight upper bound
(which needs no forecast at all). No plan, no recovery number, no avoidability
percentage, and the screen says why in one sentence.

**Why the current screen's test is the wrong test.** The prototype computes
`inTrainingWindow = date <= MODEL_TRAINED_THROUGH`, comparing the replayed date
against the *serving* artifact's training cut. That is the right question asked
of the wrong artifact. Under this spec the serving artifact is never consulted
for a historical day, so the predicate is false by construction for every
replayable day, and the badge stops being a warning and becomes a **provenance
statement**: `SERVED` or `FOLD-HOLDOUT`, each with the artifact that produced
it. This is a required change to `apps/web`; see
[Further Notes](#further-notes).

**Assertion, not trust.** The held-out property is re-checked at read time
against the artifact card's own recorded windows:

```
assert target_date ∉ [artifact.train_start, artifact.train_end]
assert target_date ∉ [artifact.calibration_start, artifact.calibration_end]
```

Both, because the calibration window is where isotonic and the two conformal
scalars were fitted — a day inside it has shaped the interval the replay
promises a floor from, which is a subtler leak than the base fit and is the one
a future session is most likely to forget. A violation is a `500`, not a badge.

**Where the `fold_holdout` forecasts come from.** The backtest already computes
a composed band for every test row in every fold — that is what `qloss_mwh` is
computed from. It then discards them. Replay's entire storage requirement is to
stop discarding them:

> At the end of a backtest run, every fold's out-of-fold predictions are
> persisted as `Forecast` rows at (`subsystem`, `valid_time`) grain, with a
> `ForecastOrigin` whose `producer` is `wattsteer`, whose `run_label` is the
> fold artifact's `artifact_id`, whose `published_at` is
> `gate_at(target_date, gate_profile)` — the instant that forecast would have
> been published — and whose new field `origin_kind` is
> **`backfilled_holdout`**.

Roughly 6 folds × 90 days × 24 hours × 4 subsystems ≈ 52,000 rows per backtest
run, which is nothing. `ingested_at` is the real one — when the backtest ran —
so `AsOf` handles supersession for free: a later backtest writes a newer vintage
and an older replay remains reconstructible at its own as-of.

**`origin_kind` is the field that keeps the two apart**, and it is load-bearing.
`published_at` for a backfilled row is a *counterfactual* publication instant —
the forecast was never actually published then. Storing it without a
discriminator would make a reconstruction indistinguishable from a record, which
is the exact class of error this project keeps ruling out. So:
`origin_kind ∈ {served, backfilled_holdout}`, it travels on every surface that
carries a `ForecastOrigin`, and **`/v1/forecast/day-ahead` filters
`origin_kind = 'served'` unconditionally**, asserted by a test.

### The vintage question — decided, and it is *not* the same problem twice

They are different in kind, and the difference is worth one paragraph on the
screen rather than a shared badge:

| | In-sample | Vintage |
|---|---|---|
| About | the **model's** information set | the **data's** information set |
| Cause | training window overlaps the day | ONS rewrote history before we were watching |
| Fixable | **yes** — by choosing the artifact (done above) | **never**, for any day before go-live |
| Remedy | a precondition | a label, plus a measurement |
| Direction of error | recovery overstated by an unknown amount | actual restated by an unknown amount, in either direction |

**What `revision_optimistic` actually touches on a replay** — this is where the
feature spec's distinctions pay off, and it makes the caveat proportionate:

- **The weather is genuinely point-in-time on both sides of go-live.** A weather
  row carries the run initialisation as `published_at`, so `published_at ≤ gate`
  is a real filter even in backfill. The D−1 12Z run the replay planned against
  *is* the D−1 12Z run. Unaffected.
- **DESSEM and the ONS programming: likewise.** Forecast-sourced, cut on
  `published_at`. Unaffected.
- **Lagged-actual features are the right hours with possibly the wrong values.**
  They are cut on `valid_time ≤ actuals_cutoff(gate, dataset)`, which enforces
  *availability* correctly, but the values in them are today's restatement.
  Affected.
- **The label — the "actual" the replay is scored against — is today's
  restatement.** Affected, and it is the denominator of the headline percentage.
  Note this is not special to pre-go-live days in kind: labels are read
  `AsOf(now)` everywhere by design, in training and evaluation alike. What is
  special is that for a pre-go-live day there was never an alternative.

So the screen's vintage sentence names those two, and explicitly exempts the
weather. A blanket "this day is unreliable" would be both vaguer and less true.

**The caveat gets measured, in Replay's own currency.** `forecaster.md`
publishes `revision_premium_qloss` — the first fold that exists in both vintages,
scored both ways. Replay owes the same construct in MWh:

```
revision_premium_recovered_mwh
  = mean over post-go-live days d of
      recovered(plan_d, a_d @ AsOf(published_at_d + 48h))
    − recovered(plan_d, a_d @ AsOf(now))
```

That is computable only after go-live, only once ONS has actually restated days
we hold both vintages of, and it is exactly the number a reader wants when
asking how much to discount a `revision_optimistic` replay. Until it exists the
screen says the caveat is **unmeasured**, in those words, rather than implying
it is small.

**They coincide today and that is the argument for keeping them apart.** Every
`fold_holdout` day is `revision_optimistic`; every `served` day is
`point_in_time`. Three of the four combinations are reachable and only two are
populated: `served` + `revision_optimistic` is impossible by definition, and
`fold_holdout` + `point_in_time` becomes populated the moment F6 freezes and F7
opens on a post-go-live quarter. A merged indicator would be observationally
correct now and wrong then, which is the worst available failure mode — it would
be discovered by a user.

### Which days are replayable — decided

**Any held-out day is addressable; a published rule chooses what the screen puts
in front of you.** The two are not in tension and shipping only one would be a
mistake in either direction: a curated-only set makes the tool a slideshow, and
an any-date-only set makes the first-run experience a blank date picker over
17 months.

**The replayable predicate**, evaluated server-side and exposed as a calendar:

```
replayable(d) ⟺  d ≥ F1.test_start
             ∧  d ≤ yesterday (America/Sao_Paulo)
             ∧  ∃ Forecast rows for (subsystem, d) with origin_kind ∈
                  {served, backfilled_holdout}
             ∧  the held-out assertion passes for that origin's artifact
             ∧  observed rows exist for all 24 hours of d
```

A date failing it returns a typed refusal naming which clause failed —
`REPLAY_DATE_BEFORE_HOLDOUT_WINDOW`, `REPLAY_FORECAST_UNAVAILABLE`,
`REPLAY_OBSERVATION_INCOMPLETE`, `REPLAY_DATE_OUT_OF_RANGE` — never a computed
answer with a caveat.

**The shortlist is a query, not a list.** Hand-picking the featured days is
selecting on the outcome, which is the same failure the shuffled-label control
exists to catch one layer down. The rule, published on the screen in one
sentence and evaluated on the replayable set:

> The **eight** featured days are: the three days with the largest observed
> `total_mwh`; the day with the largest **absolute forecast error** on the day
> total; the day with the largest observed total in **each** `VintageFidelity`
> class; the day with the largest observed total in **each** provenance class;
> and — mandatorily — **the day with the largest shortfall against its own
> promised floor**, i.e. `min(scored.observed.recovered − recovered_floor)`.
> Duplicates collapse and the list is padded from the top of the first
> criterion. Ties break on date, ascending.

The last clause is the one that matters: **the featured set is obliged to
contain a day WattSteer got wrong**, and if no day missed its floor, the slot is
filled by the smallest margin and labelled as the closest call. A test asserts
the clause is present and non-empty. The list is recomputed nightly against the
reference fleet and cached; it is deterministic given the data.

### Precomputed or on demand — decided, split at the seam that matters

**The forecast is precomputed. The plan and every KPI are computed on demand.**

The split follows from what is expensive and what must be reproducible, and they
are the same half:

- *Precomputed:* resolving the artifact, building features at
  `gate_at(d, gate_late)`, composing the mixture, drawing the path ensemble.
  This is a joblib load plus a feature query plus 500 ensemble members, it is
  far outside an interactive budget, and — decisively — its answer would depend
  on which artifacts happened to be on the volume when the request arrived. As
  `Forecast` rows it is a lookup, and the same rows serve the Backtest.
- *On demand:* the MILP (3.15 ms measured) and four simulator passes. These are
  a pure function of (pinned forecast rows, observed rows, scenario), so
  caching is an optimisation and never a correctness requirement.

Two consequences worth stating because they are the product behaviours this buys:

1. **Changing the fleet re-plans and never re-forecasts.** The screen's asset
   controls behave exactly like Mitigate's, and no interaction can change what
   the model said at D−1 — which is the property that makes the replay a
   replay.
2. **A replay contains no model in the request path.** No joblib, no feature
   build, no ML-service call for the forecast. The ml service is still called
   for the solve.

**Cache**, reusing the optimizer's discipline verbatim rather than inventing a
second one: Redis, TTL 24 h, key

```
replay:v1:<sha256(canonical scenario)>:<target_date>:<forecast_origin>:<optimizer_build>
```

Evictable at any time with no user-visible loss. The forecast origin is in the
key because a later backtest run supersedes the `backfilled_holdout` rows;
`optimizer_build` is in the key because a formulation change must not serve
yesterday's plan under today's code.

**Nothing about a replay is persisted as a result.** A `Replay` remains a read
mode and not a table, per the domain model. What is persisted is the forecast
rows, which were going to be persisted anyway.

### The arithmetic — exactly

This is the section the ticket exists for. Notation: hours `t = 0…23` indexed by
local hour in `America/Sao_Paulo` on `target_date`, per the optimizer's horizon
rule. `f10[t], f50[t], f90[t]` are the composed hour-wise quantiles from the
pinned forecast rows. `a[t]` is the observed `constrained_off_mwh` read
`AsOf(now)`. `S` is the validated scenario.

**Step 1 — plan.** One MILP, the live builder, unchanged:

```
plan = optimize(curt = f50, S)          planning_basis = "p50"
```

Not P10 (`flex-optimizer.md`'s posture, and the forecaster has since confirmed
by construction that P10 is exactly zero unless `p > 0.90`). Not the revised
forecast. Not the actuals — that is the perfect-foresight bound below and it is
never the plan.

**Step 2 — score four realisations with one function.** The simulator from
`flex-optimizer.md`, *imported*, executed once per realisation
`r ∈ {f10, f50, f90, a}`:

```
for t in 0…23:
    executed_charge[t]    = min(plan.ch[t],  headroom(soc),  r[t])
    executed_discharge[t] = min(plan.dis[t], available(soc))
    Δ[t]       = executed_charge[t] − executed_discharge[t]
                 + plan.up[t] − plan.down[t]
    absorb[t]  = max(0, min(Δ[t], r[t]))
    soc       += ηc·executed_charge[t] − executed_discharge[t]/ηd
```

**Step 3 — the headline, on the observed realisation:**

```
actual_mwh     = Σ_t a[t]                    ← the denominator, always
recovered_mwh  = Σ_t absorb_obs[t]
remaining_mwh  = actual_mwh − recovered_mwh
avoided_mwh    ≡ recovered_mwh ≡ absorbed_mwh        (one quantity, one name)
avoidability   = recovered_mwh / actual_mwh
                 null unless ∃t: a[t] ≥ threshold_mw
```

**Step 4 — the promise, checked:**

```
recovered_floor_mwh = Σ_t absorb_p10[t]      ← what was promised at D−1
floor_met           = recovered_mwh ≥ recovered_floor_mwh
```

#### The two directions of forecast error, and why they are not symmetric

The clause that does the work is `executed_charge[t] ≤ r[t]` — the execution
rule — combined with the fact that the MILP's (C2) already capped
`Δ[t] ≤ curt[t] = f50[t]` at build time. Together they give:

**When the forecast over-estimates (`f50[t] > a[t]`).** The plan scheduled
charging sized for `f50[t]`; the execution rule clips it to `a[t]`. The asset
absorbs only what was really there. **Nothing is imported and nothing is
overstated** — the failure mode is a real, reported shortfall. Second-order and
easy to miss: the battery is now emptier than the plan assumed, so a later
scheduled discharge may itself be clipped by available SOC. This is exactly why
the simulator must **recompute SOC from the executed dispatch** rather than
carrying the planned trajectory; the prototype's `evaluatePlan` does not, and on
a small day it reports a battery filled with energy it never received.

**When the forecast under-estimates (`f50[t] < a[t]`).** There is real
curtailment in the hour that the plan never asked for, because the MILP was
built against a smaller `curt[t]`. The simulator **must not take it**:

> `absorb[t]` is bounded by `Δ[t]`, which derives from the **scheduled**
> dispatch. Absorbing up to `min(headroom, a[t])` would be an intraday
> re-optimisation against information the plan did not have. It is hindsight,
> and it would inflate recovered energy on exactly the days the forecast was
> worst.

The unabsorbed excess `a[t] − absorb[t]` flows straight into `remaining_mwh`.
The visible consequence — and the answer the ticket asks for — is:

> **Under-forecasting shows up as a lower `avoidability`, never as a
> smaller actual.** The denominator is the observed total whatever the forecast
> said. A day that came in twice as large as forecast, met by a fixed fleet,
> earns roughly half the percentage — which is the same arithmetic
> `flex-optimizer.md` story 13 already exposes at P90, applied to a realisation
> that actually happened.

So a bad forecast cannot flatter a replay through the percentage. It can only
hurt it. That is a property, and it has a test.

#### A worked example

Three hours, threshold 5 MWh. One 80 MW battery, energy-unconstrained,
`ηc = ηd = 1` (set to 1 only so the table can be checked by eye; the real
builder uses `√RTE`).

| | t₁ | t₂ | t₃ | Σ |
|---|---|---|---|---|
| Forecast P50 `f50` | 40 | 100 | 60 | 200 |
| Forecast P10 `f10` | 0 | 60 | 0 | 60 |
| **Observed `a`** | **20** | **160** | **60** | **240** |
| Scheduled charge (MILP on `f50`, ≤ 80 MW) | 40 | 80 | 60 | 180 |
| Executed vs `a` = `min(sched, headroom, a)` | 20 | 80 | 60 | **160** |
| Absorbed vs `f10` | 0 | 60 | 0 | **60** |

- On its own planning basis the plan absorbs 180 of 200 → 90 %.
- **Scored on the observed day: 160 of 240 → 66.7 %.** t₁ over-forecast, so
  20 MWh of scheduled charge simply did not happen; t₂ under-forecast, so
  80 MWh of real curtailment sat there and was correctly left alone.
- `recovered_floor_mwh` = 60 (the P10 hurdle zeros in t₁ and t₃ are the
  forecaster's arithmetic, not a modelling choice). `floor_met` = true, with
  100 MWh of margin.
- Recovered fell in absolute terms too (160 < 180) even though one hour had
  spare energy — clipping in one hour is not compensated by surplus in another,
  because the plan is a schedule and not a controller.

Perfect foresight on this toy recovers 160 as well: an energy-unconstrained
fleet with hourly power to spare gains nothing from knowing the answer. **The
gap opens exactly when the fleet is energy-limited** — cap the same battery at
140 MWh usable and the P50 plan recovers 120 while perfect foresight recovers
140, a `forecast_value_gap_mwh` of 20. That is the honest shape of the claim:
better forecasting is worth something only where the fleet has to choose which
hours to spend itself on.

#### Perfect foresight, fenced

```
plan_pf     = optimize(curt = a, S)
scored_pf   = simulate(plan_pf, a)
forecast_value_gap_mwh = scored_pf.recovered_mwh − recovered_mwh
```

Rules, all enforced rather than agreed:

- It lives under `upper_bound`, never in `avoided_energy_mwh`, never in
  `scored`, and a test asserts no headline field can be populated from it.
- It is labelled **"the best any plan could have done knowing the answer"**, in
  those terms, and rendered in a visually separate block.
- `scored_pf.recovered_mwh ≥ recovered_mwh` holds up to the throughput
  penalty's tie-breaking tolerance, and is asserted. A violation means the plan
  and the simulator disagree, which is the one bug this whole architecture is
  arranged to surface.
- It is the **only** thing offered for an observed-only (pre-F1) day, because it
  needs no forecast and therefore no model — and on such a day it is presented
  as a property of the day and the fleet, with no WattSteer number beside it to
  compare against.

#### Floor coverage, and the map's open gate item

```
floor_coverage = share of replayed days in the set where floor_met
```

Reported per fold, per subsystem, and per `VintageFidelity` — **never averaged
across fidelities**, per the forecaster's rule.

The floor is *not* a per-day theorem. The simulator's monotonicity property
guarantees `recovered(plan, r) ≥ recovered(plan, f10)` only when `r ≥ f10`
pointwise, and an observed day is not obliged to dominate the P10 envelope in
every hour. So floor coverage is an **empirical claim the product checks**,
which is precisely why `flex-optimizer.md` requires the metric.

**The gate threshold, which the map has open and which two specs have now
deferred to this one, is decided here — and it carries no absolute constant**,
in the same shape as the forecaster's hot-swap gate:

> Floor coverage is a **comparative guardrail** in the weekly hot-swap: a
> candidate artifact is vetoed if its floor coverage on the shared newest fold,
> computed against the published reference fleet, is more than **5 percentage
> points** below the incumbent's. It is a veto and never the decision, so a
> wrong constant blocks a swap rather than choosing one. No absolute floor is
> set, because an hour-wise P10 envelope has no day-level nominal level to
> compare against — the joint probability that all 24 hours land at or above
> their own P10 is not 90 %, is not computed, and is not claimed.

**The reference fleet is one constant in one place.** Floor coverage and the
forecaster's `Δ recovered_floor_mwh` must be computed against the same battery
or neither number means what it says. It is the fleet **`forecaster.md`** names
for the DESSEM comparison — not `flex-optimizer.md`, which never mentions DESSEM
— and it is `packages/core`'s single published `REFERENCE_FLEET`, stamped on
every aggregate.

**Its flexible load is 1,700 MWh/day with 50 MW of shift**, and the reference
fleet moves with the Mitigate fixture rather than separately. The prototype's
default (70 MW against 1,200 MWh/day) is invalid under `SHIFT_EXCEEDS_BASELINE`,
which requires `max_shift_mw ≤ daily_energy_mwh / 24`. `flex-optimizer.md`
offered two repairs and picked neither, and **both of them sit on the validity
boundary**: 70 MW against 1,700 MWh/day is 98.8 % of the cap, and 50 MW against
1,200 MWh/day is exactly 100 % of it. A published constant that many numbers are
compared against must not be one rounding away from a `422`, and a load that is
shiftable in its entirety is not a plausible industrial load either. Taking the
energy from one repair and the shift from the other puts it at 71 % of the cap,
with headroom, and invents nothing.

### The output contract

One object, feeding the §45/§47 screens. `planning_basis` and `scored_on`
together determine every number in it, which is the point of both fields
existing.

```jsonc
{
  "target_date": "2025-09-14",
  "subsystem": "NE",
  "threshold_mw": 5,
  "max_gap_hours": 0,
  "scenario_hash": "sha256:…",

  "integrity": {
    "provenance": "fold_holdout",          // | "served"
    "model_saw_this_day": false,           // asserted at read time, never computed hopefully
    "held_out_by": {
      "fold": "F3",
      "artifact_id": "dessem_free_v1__gate_late__thr5/2025-10-01T…Z",
      "train_window": ["2024-04-01", "2025-06-30"],
      "calibration_window": ["2025-07-02", "2025-09-30"]
    },
    // Beside `provenance`, and derived from neither it nor the fold calendar:
    // the day's position relative to the go-live of the reads its actuals
    // depend on. Repeated at the top level, where the name is shared with
    // `OptimizationResult`; one value, one source, two places a reader looks.
    "vintage_fidelity": "revision_optimistic",
    "vintage_affects": ["settled_actuals", "lagged_actual_features"],
    "vintage_exempt": ["weather_run", "dessem", "ons_programming"],
    "revision_premium_recovered_mwh": null   // null ⇒ unmeasured, and said so
  },

  // Top level, exactly as in `OptimizationResult`. A field whose whole purpose
  // is that shared names do not shift meaning must not shift position either;
  // the vintage *detail* above is replay-only, the verdict is not.
  "vintage_fidelity": "revision_optimistic",

  "forecast_origin": {
    "producer": "wattsteer",
    "run_label": "…artifact_id…",
    "published_at": "2025-09-13T22:00:00Z",   // = gate_at(d, gate_late)
    "origin_kind": "backfilled_holdout",      // | "served"
    "gate_profile": "gate_late"
  },

  "actual":   { "total_mwh": 612.0, "peak_mw": 138.0, "hours": [ /* 24 × mwh */ ] },
  "forecast": {
    "hours": [ /* 24 × { p10, p50, p90, expected_mwh, occurrence_probability } */ ],
    "day_total": { "p10": 402.0, "p50": 548.0, "p90": 731.0 },   // path ensemble, NOT a sum
    "peak_power": { "p10": …, "p50": …, "p90": … },
    "day_occurrence_probability": 0.93
  },

  "planning_basis": "p50",
  "execution_rule": "follow_curtailment",
  "scored_on": "observed",                    // ← top-level scalars are on the ACTUAL

  "baseline_curtailment_mwh": 612.0,          // ≡ actual.total_mwh
  "optimized_curtailment_mwh": 331.0,         // remaining
  "avoided_energy_mwh": 281.0,                // ≡ absorbed ≡ recovered. One quantity.
  "avoidability": 0.459,                      // or null

  "recovered_floor_mwh": 84.1,                // = scored.p10.recovered_mwh, promised at D−1
  "floor_met": true,
  "floor_margin_mwh": 196.9,

  "scored": {
    "p10":      { "baseline_mwh": …, "remaining_mwh": …, "recovered_mwh": 84.1,  "avoidability": … },
    "p50":      { … },
    "p90":      { … },
    "observed": { "baseline_mwh": 612.0, "remaining_mwh": 331.0, "recovered_mwh": 281.0, "avoidability": 0.459 }
  },

  "upper_bound": {
    "label": "perfect_foresight",
    "recovered_mwh": 402.0,
    "avoidability": 0.657,
    "forecast_value_gap_mwh": 121.0
  },

  "dispatch": [ /* scheduled, on the P50 envelope — the plan */ ],
  "executed": [ /* what the execution rule did against the observed — the reality */ ],
  "stored_at_horizon_end_mwh": 96.3,
  "round_trip_loss_mwh": 11.4,
  "economic_scenario": { "brl_per_mwh": 180, "brl": 50580 },

  "episodes": [ { "started_at": …, "ended_at": …, "duration_hours": 9,
                  "total_mwh": 598.0, "peak_mw": 138.0,
                  "threshold_mw": 5, "max_gap_hours": 0 } ],

  "solver": { "backend": "SCIP", "status": "OPTIMAL", "wall_time_ms": 3.4, … }
}
```

Six decisions inside that shape:

1. **`scored_on` exists because the top-level scalars mean something different
   here than in a live result.** `flex-optimizer.md` evaluates its §6 scalars on
   the *planning envelope*; a Replay evaluates them on the *observed*
   realisation, because scoring against what happened is the entire point. Same
   field names, different realisation — so the realisation is named on the
   object and no reader has to infer it. Without this field the two results are
   a trap.
2. **Absorbed, recovered and avoided are one number.** The ticket's output list
   names three; they are one quantity with three names, exactly as
   `flex-optimizer.md` settles. The contract carries `recovered_mwh` inside
   `scored` and `avoided_energy_mwh` at the top level, identical by
   construction, and the screen renders **one** headline for it.
3. **The denominator is the whole local day, not the episode.** Episodes are a
   read-time view for narration and are carried for that; the plan is a 24-hour
   dispatch whose SOC crosses episode boundaries, so scoring on episode hours
   would make the number depend on the threshold. `threshold_mw` gates *whether*
   `avoidability` is defined and never enters the ratio — the optimizer's rule,
   inherited unchanged.
4. **`day_total` comes from the path ensemble and is never a sum of the hourly
   band.** The forecaster's 500-member ensemble computes it correctly, and
   ticket 014 already made "nothing in the UI sums two bands" a test. The
   prototype currently sums the 24 hourly quantiles for this row; that must
   come out. It requires day-grain figures to be persisted alongside the hourly
   `Forecast` rows — the one hand-back this spec owes ticket 009.
5. **`dispatch` and `executed` are two series, not one.** They are equal only
   when the realisation equals the planning basis. Drawing one is what makes
   "planned against P50" get read as "assumed P50 came true".
6. **No carbon field, and none derivable.** MWh recovered and % avoided are the
   only claims.

### The Backtest — the aggregate, for humans

`Backtest` is the distinct noun for many days. It is the *same code path* — one
replay per day, the same simulator, the same reference fleet — aggregated, so it
cannot drift from the thing it aggregates.

| Metric | Grain | Note |
|---|---|---|
| `days_replayed` | fold, subsystem, fidelity | |
| `floor_coverage` | fold, subsystem, fidelity | the guardrail above |
| `mean_avoidability`, `p25`, `p75` | fold, fidelity | distribution, not a single number |
| `total_recovered_mwh` | fold, fidelity | |
| `mean_forecast_value_gap_mwh` | fold | what better forecasting is worth |
| `days_forecast_underestimated` | fold | share where `Σf50 < Σa` |
| `revision_premium_recovered_mwh` | once available | the measured vintage caveat |
| `vintage_fidelity` | every row | **never averaged across values** |

Two rules carried over verbatim because they are what stop an aggregate from
laundering a caveat: a `revision_optimistic` row is never averaged into a
`point_in_time` one, and a fold straddling go-live is split at go-live and
reported as two rows.

### The endpoint

```
GET /v1/replay/days                    → replayable calendar + the featured shortlist
GET /v1/replay?d=<date>&s=<blob>       → one replay
POST /v1/replay                        → same, scenario in the body
GET /v1/backtest?fold=…                → the aggregate
```

Ticket 013 may re-path these; the contract above is fixed. The scenario blob is
the optimizer's, byte-for-byte — same canonical JCS encoding, same `v: 1`, same
4096-byte cap, same validation table, same per-IP rate limit, same failure
posture. **A replay is a Scenario with a past `target_date`**, so inventing a
second transport would be inventing a second scenario format.

Replay-specific refusals, added to the optimizer's table:

| Code | Status | Rule |
|---|---|---|
| `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` | `422` | date precedes the first walk-forward test fold — observed-only |
| `REPLAY_DATE_OUT_OF_RANGE` | `422` | before the data window opens, or ≥ today |
| `REPLAY_FORECAST_UNAVAILABLE` | `404` | no held-out `Forecast` rows for that subsystem/date |
| `REPLAY_OBSERVATION_INCOMPLETE` | `404` | fewer than 24 settled hours |
| `REPLAY_INTEGRITY_VIOLATION` | `500` | the held-out assertion failed — a WattSteer bug, logged with the artifact id |

A shared replay URL echoes back a **pinned** `forecast_origin`, so a link
survives a later backtest run writing a newer holdout vintage.

## Testing Decisions

**What makes a good test here.** Every defect in a replay produces a *better*
number, so the tests assert the things that would have to be true for the number
to be honest — provenance, direction of error, and the identity of the code
being run — rather than that a function returns a float.

**Seam 1 — the held-out property, as a property.** Over every replayable date in
the window: the resolved artifact's train window and calibration window both
exclude the date. A date in the pre-F1 block resolves to no artifact and the
endpoint refuses with `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW`. A fabricated artifact
card whose windows overlap the date produces `REPLAY_INTEGRITY_VIOLATION`, not a
badge. **And the negative that matters most:** a test asserts the replay path
never resolves the *promoted serving* artifact for a historical date — including
after a simulated retrain that extends the serving training window over a day
already replayed. That is the exact regression this spec exists to prevent.

**Seam 2 — the arithmetic, both directions, on fixtures.**

- *Under-forecast:* `a = 2·f50`. Assert absorption is unchanged from the
  `f50` scoring (the plan does not opportunistically grow), the entire excess
  lands in `remaining_mwh`, `actual_mwh` is the observed total, and
  `avoidability` falls by roughly half. This is the hindsight test.
- *Over-forecast:* `a = 0.5·f50`. Assert every hour's absorption is clipped to
  `a[t]`, the SOC trajectory is recomputed from the executed dispatch and never
  exceeds what was actually charged, and no hour imports.
- *All-zero actual:* recovered is exactly 0, nothing is imported, `avoidability`
  is `null` (no hour reaches `threshold_mw`), and the screen renders "—".
- *The worked example above* ships as a fixture with its numbers asserted:
  160/240 = 66.7 %, floor 60, floor met.

**Seam 3 — one simulator, imported.** The load-bearing test of the whole spec,
per `flex-optimizer.md`'s "single most important line". A structural test
asserts Replay's scoring path calls the optimizer package's `simulate` and that
exactly one implementation of the execution rule exists in the repository — a
grep/AST-level check, in the same spirit as the UI's no-summed-bands test,
because a second copy is the failure that no unit test sees and that quietly
breaks the product's central proof.

**Seam 4 — MILP and simulator agree.** For any realisation `r`,
`simulate(optimize(r, S), r).recovered_mwh` equals the MILP's own absorbed
quantity within 1e-6. This is the cross-check that makes "the KPIs come from the
simulator, never the objective" a checkable claim rather than a convention, and
it is exercised on the perfect-foresight solve for free.

**Seam 5 — perfect foresight is fenced.** `scored_pf.recovered_mwh ≥
recovered_mwh` on random scenarios and realisations, within the throughput
tolerance. A test asserts no headline field is populated from `upper_bound`, and
that an observed-only day returns `upper_bound` with `scored`, `avoided_energy_mwh`
and `recovered_floor_mwh` all absent — not zero, absent.

**Seam 6 — the two origins cannot be confused.** A `backfilled_holdout` row is
never returned by `/v1/forecast/day-ahead` under any query. `origin_kind`
round-trips through persistence and through the API. A backfilled row's
`published_at` equals `gate_at(target_date, gate_profile)` exactly. A second
backtest run writes a new vintage rather than overwriting, and a replay pinned
to the older origin still reproduces its original numbers.

**Seam 7 — reproducibility across a retrain.** Compute a replay; run a full
retrain and a fresh backtest; recompute the replay at the **pinned** origin and
assert byte-identical output. At the unpinned origin, assert the numbers may
differ and that the response's `forecast_origin` shows why. This is the test
that makes a shared link honest.

**Seam 8 — the shortlist is not a highlight reel.** The featured-days query is
deterministic given the data; it contains at least one day from each populated
`VintageFidelity` and each populated provenance; and it contains the
worst-floor-shortfall day. A synthetic dataset in which one day badly missed its
floor must produce that day in the list — the test fails if a future change makes
the shortlist selectable on outcome.

**Seam 9 — vintage discipline.** A pre-go-live date is stamped
`revision_optimistic` with `vintage_affects` naming the actuals and the lagged
features and `vintage_exempt` naming the weather. A Backtest aggregate never
averages across `VintageFidelity` values — asserted structurally, by making the
aggregation function take fidelity as a group key rather than filtering on it.
A fold straddling go-live emits two rows.

**Seam 10 — the endpoint.** One case per refusal code, each asserting rejection
rather than a caveated answer. Scenario validation parity with `/v1/optimize`
**minus its date clause** — the two endpoints cannot agree there, since a
2024-06 target is valid at `/v1/optimize` (the window opens 2024-04) and refused
here as pre-F1 — and identical everywhere else. Stating parity without that
carve-out asserts something no implementation can satisfy. Otherwise, parity
(the same blob rejected by both). Cache hit returns byte-identical output; a
changed `forecast_origin` or `optimizer_build` misses. Rate limit applies.

**Acceptance gate.** Default `bun test` and `pytest` pass with no network for
seams 2–5 and 8 (fixture-driven). Seams 1, 6, 7, 9, 10 pass against real
Postgres under the existing env-var gating. The worked example reproduces
exactly. The single-simulator structural test is in the default path, because it
is the one that cannot be recovered by review.

## Out of Scope

- **Training anything at replay time.** No per-day fold-specific models. The
  fold calendar fixes the granularity, the artifacts already exist, and a model
  trained inside an HTTP request is reproducible by nobody.
- **Replaying the pre-F1 year against the WattSteer model.** Refused, not
  labelled. The observed-only view is what those days get.
- **Baseline-only replay** — replaying a pre-F1 day against rung 1, the 7-day
  same-hour baseline, which needs no training and is therefore honest at any
  date. Genuinely buildable (the feature function already computes it and the
  ladder composes it through the same mixture inversion) and deliberately not
  in v1: it introduces a second forecast path into Replay for a number nobody
  asked for. **Reopening trigger:** a product need for pre-2025-04 days that
  survives being told the model number is unavailable.
- **Opportunistic absorption / intraday re-optimisation.** Named here rather
  than omitted, because it is the tempting change: letting the fleet take
  curtailment the plan did not schedule. It is hindsight and it is forbidden.
- **Replaying against a revised forecast**, or against any origin other than the
  pinned D−1 one. That would score a plan against information it did not have.
- **A stored `Replay` row.** A Replay is a read mode; the domain model settles
  it and nothing here needs otherwise.
- **Multi-subsystem replay.** One subsystem per scenario, per the optimizer.
- **Aggregating "what if WattSteer had run all year"** into a single annual
  figure. The Backtest reports distributions per fold and per fidelity; a single
  headline over mixed fidelities is the exact averaging this spec forbids.
- **Carbon.** Nothing in the contract supports a CO₂ claim and none is offered.
- **Exposing the path ensemble across the API.** Replay consumes the ensemble's
  *quantiles*; the 500 paths stay internal, per ticket 009.
- **The hot-swap gate's mechanics.** Owned by ticket 009. This spec supplies
  floor coverage and its comparative guardrail; the gate that consumes it is
  the forecaster's.
- **Diagnosis and narration of a replayed day.** Ticket 010. A replay shows what
  happened and what the fleet would have done; why it happened belongs to the
  Explain surface.
- **API paths, envelopes and caching policy.** Ticket 013 may re-path; the
  contract's content is fixed here.

## Further Notes

**The honest headline is that the ticket offered three options and two of them
are the same one.** "Train a fold-specific model excluding the replayed period"
and "restrict replay to the walk-forward test folds" differ only in granularity,
and the fold calendar has already chosen the granularity. Once that collapses,
the real choice is binary: **replay only where a held-out artifact exists, or
show an in-sample number with a label on it.** This spec takes the first, and
pays a full year of the window for it. The reason is the prototype's own
reasoning, followed to its conclusion: the honesty block sits above the numbers
because a reader who only sees the numbers has been misled by omission — and a
reader who sees a 45.9 % computed from an in-sample fit has been misled by
omission whatever sits above it.

**Where this spec disagrees with the ticket, explicitly.** The ticket's option 3
("label the result honestly") is treated as necessary and insufficient. It ships
— for the vintage question, where nothing else is possible — and it is refused
for the in-sample question, where something else is. If the product decides a
year of unreplayable history is too expensive, the specified escape hatch is the
baseline-only replay above, not an in-sample WattSteer replay.

**Where this spec extends `flex-optimizer.md` rather than diverging from it.**
All five of its Replay constraints are honoured verbatim: same posture (P50 of
the pinned D−1 vintage), the same simulator function imported rather than
reimplemented, observed as a fourth realisation, floor coverage as a first-class
Backtest metric, perfect foresight as a labelled upper bound only, and the
vintage travelling with the number. Two additions:

1. **`forecast_value_gap_mwh`** — perfect foresight minus achieved. The
   optimizer permits the PF solve; this makes it mandatory and gives the gap a
   name, because the gap is the only honest use of a hindsight number.
2. **The floor-coverage gate threshold is closed here** as a comparative
   guardrail (−5 points vs the incumbent on the shared fold) rather than an
   absolute bar, in the same constant-free shape as the forecaster's hot-swap
   gate. The map's "backtest gate threshold" item can be struck.

**The one hand-back this spec owed ticket 009 — both halves have since
landed.** Forecaster story 35 persists served forecasts at hour grain. Replay
needed two more things and neither was free:

- **Day-grain ensemble quantiles persisted** (day total P10/P50/P90, peak band,
  day occurrence). Without them the screen cannot draw a day band without
  summing quantiles, which both specs forbid. Adding them is a few columns on a
  companion row, not a contract change. *Landed* in migration
  `0034_the_published_forecast.sql` as `curtailment_forecast_day`
  (`day_total_p10/p50/p90_mwh`, `peak_power_p10/p50/p90_mw`,
  `day_occurrence_probability`).
- **Out-of-fold predictions persisted from the backtest**, with
  `origin_kind = 'backfilled_holdout'`. The backtest computes them already.
  *Landed* with forecaster 23 — the holdout writer,
  `apps/ml/src/wattsteer_ml/holdout_backfill.py` and the gateway's
  `apps/api/src/forecast/backfill.ts` — writing rows under the
  `forecast_origin_kind` value the same migration introduced.

Both were small; both were load-bearing; both now exist. The record is kept
because the *shape* of the hand-back is what the screens depend on: a day band
read from a companion row rather than summed, and a fold day answered from a
persisted holdout rather than an in-sample fit.

**Contradictions with the prototype that must be resolved in code, not
smoothed over.** Four, and they are all in the same two files:

1. `apps/web/src/lib/fixtures/replay.ts` computes
   `inTrainingWindow = date <= MODEL_TRAINED_THROUGH` — the right question asked
   of the wrong artifact. Under this spec no replayable day is in-sample, and
   `apps/web/src/app/app/replay.tsx`'s `IN-SAMPLE` warning branch becomes
   unreachable. The field becomes `provenance: "served" | "fold_holdout"` plus
   `heldOutBy`, and the badge becomes a provenance statement.
2. `replay.tsx` builds `forecastBand` by summing `p10`, `p50` and `p90` across
   24 hours, with a note conceding a joint day-total would be narrower. That
   concession has expired: the forecaster's path ensemble computes the joint
   day total, and ticket 014 made summed bands a UI invariant violation. The row
   must read `forecast.day_total` from the contract.
3. `replay.tsx` uses `day.episode.totalMwh` as the actual. The denominator is
   the **day** total. They coincide in the fixture and will not in general, and
   a percentage whose denominator moves with `threshold_mw` is the failure the
   optimizer spec already ruled out.
4. The reference scenario in the fixture ("100 MW / 300 MWh battery + 70 MW
   flexible load") inherits the Mitigate default that
   `flex-optimizer.md` invalidates under `SHIFT_EXCEEDS_BASELINE`. Since the
   same fleet is the basis of floor coverage and of the forecaster's DESSEM
   `Δ recovered_floor_mwh`, it must become one published constant and move once.

**Where this spec is weakest.** Three places, ranked:

1. **A year of the window is unreplayable, and the days people most want to see
   may be in it.** The decision is defensible and it is still a real product
   cost. The baseline-only escape hatch is specified with a trigger precisely so
   that reversing course is a decision rather than a rediscovery.
2. **Floor coverage's guardrail constant (−5 points) is judgement**, like the
   forecaster's. It is placed where a wrong value blocks a swap rather than
   choosing one, and the first two point-in-time folds should be used to check
   it is not so tight that nothing promotes.
3. **`revision_premium_recovered_mwh` cannot be computed until ONS has restated
   days we hold both vintages of**, which may be months. Until then the largest
   caveat on the largest part of the replayable window is honestly labelled and
   dishonestly unquantified — the screen says "unmeasured", which is true and
   unsatisfying.

**If exactly one thing from this spec survives into the built system**, it
should be the structural test that exactly one implementation of the execution
rule exists in the repository. Every other decision here — the fold provenance,
the vintage labelling, the shortlist rule — protects a number from being wrong.
That one protects the *comparability* of a backtest number and a forecast
number, which is the property the entire pitch rests on and the only one that
would fail silently, in both directions, forever.

### Calls the dev should review

1. **Pre-F1 days are refused rather than labelled**, costing a year of the
   window (2024-04 → 2025-03). This is the spec's central decision and its
   largest product cost. The alternative — an in-sample number under a warning —
   is the option the current screen implements.
2. **The screen's `IN-SAMPLE` / `OUT-OF-SAMPLE` badge is replaced by a
   provenance badge**, because under this spec no replayable day is in-sample.
   This removes the loudest honesty note currently on the screen and replaces it
   with a quieter, stronger one; that trade should be looked at by a human.
3. **`origin_kind` is added to `ForecastOrigin`** and backfilled holdout
   predictions are persisted as `Forecast` rows with a counterfactual
   `published_at`. This puts rows that were never published into the forecast
   table, defended only by a discriminator and a filter. The alternative — a
   separate table — is cleaner and would duplicate the as-of machinery.
4. **The floor-coverage guardrail (−5 points vs incumbent, no absolute bar)**
   closes an item the map has held open and that two specs deferred here.
5. **Top-level scalars in a Replay are scored on the observed realisation**,
   while the same field names in an `OptimizationResult` are on the planning
   envelope. `scored_on` disambiguates. Distinct field names would be safer and
   would fork the contract.
6. **The featured-days rule is obliged to include a day the forecast got
   wrong.** Deliberate, and it means the demo screen can open on a bad day.
