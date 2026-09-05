# Spec — WattSteer Diagnosis Engine

> From two fitted models to five bars and one paragraph, without any step in
> between that a grid engineer could call a lie.
>
> **Upstream spec.** [`forecaster.md`](forecaster.md) owns the two estimators,
> the mixture inversion, the artifact and the gate. This spec attributes *one*
> of that spec's published quantities and adds two things to its artifact
> bundle; both additions are named explicitly below and are the only changes it
> asks for.
>
> **Feature authority.** [`feature-engineering.md`](feature-engineering.md) owns
> the feature names, their D−1 availability classes and the ordered feature
> list. This spec groups those names and never invents one.
>
> **Naming authority.** [`../domain-model.md`](../domain-model.md); where it and
> this spec disagree, it wins.
>
> **Sibling specs.** [`flex-optimizer.md`](flex-optimizer.md) — the diagnosis
> never recommends a dispatch and the optimizer never reads an attribution.
> [`i18n.md`](i18n.md) — the API returns codes, not translated strings, with LLM
> narration as the single settled exception.
>
> Ticket: [`010-diagnosis-spec.md`](../../.wayfinder/tickets/010-diagnosis-spec.md).
> Map: [`.wayfinder/map.md`](../../.wayfinder/map.md).

## Problem Statement

IDEA.md §25 asks for `model prediction + SHAP + domain rules`, never an LLM
alone, and draws the output as five signed numbers over a risk percentage.
IDEA.md §26 then draws the line the product must not cross: this is
**Diagnosis**, not Causal AI; SHAP explains *why the model moved its forecast*,
not *why the grid curtailed*.

Both are right, and neither survives contact with the model that was actually
specified. Five problems, ordered by how quietly they produce a plausible wrong
answer:

1. **There is no "the model".** `forecaster.md` ships a hurdle: an occurrence
   classifier `p(x)` and three magnitude quantile boosters `Q_pos`, plus a
   conditional-mean booster and a technology-share booster. SHAP explains a
   *scalar output of one function*. There are at least five candidate scalars
   here and they rank drivers differently. Worse, the two headline stages have
   opposite units — a probability and MWh — so no arithmetic exists that adds
   an attribution from one to an attribution from the other. Anyone who runs
   `shap.TreeExplainer` twice and adds the results has produced a chart, not an
   explanation.
2. **A group's members can disagree in direction, and a single bar cannot say
   so.** The screen's `Driver` carries exactly one `direction`. Group
   `export_stress` might hold one feature pushing the forecast up by 40 MWh and
   another pushing it down by 35 MWh. Summing gives `+5, raises`, which is
   arithmetically defensible and is a lie about what the model read. The naive
   fix — show the members instead — produces a list of two hundred rows and
   defeats the screen.
3. **SHAP is per-instance; the screen is per-day.** There are 24 feature rows
   behind one Explain screen. Ranking the mean of 24 attributions, ranking the
   peak hour, and ranking the sum are three different orderings, and the
   forecaster has already established that the wrong aggregation of an
   hour-grain quantity is the project's characteristic failure — *quantiles do
   not add*.
4. **The domain rules are fog and the map says so.** "Which rules, and how they
   arbitrate against SHAP when they disagree, can't be written until real driver
   rankings exist." That is true of the rules' *content*. It is not true of
   their *mechanism*, and a mechanism written after the rules exist will be
   written to fit them.
5. **The §26 boundary is a wording rule, and the one surface that generates
   wording is a language model writing a fresh sentence per request.** A copy
   review cannot review a sentence that does not exist until a user asks for it.

Underneath all five is the failure class this whole effort keeps meeting: **a
number that is wrong in a direction nobody can see.** A leaky feature flatters
the backtest; a mis-composed quantile flatters the promise; a mis-composed
attribution flatters the *story*, and a story is the one output nobody can check
against an observation.

## Solution

**One target, one attribution, one player set — and a renderer that may not
compute.**

- **Attribute the composed expectation `E[Y | x]`, and nothing else.** It is the
  only published quantity that is a genuine function of both hurdle stages, and
  the only one whose composition is a legitimate product:
  `E[Y|x] = p(x)·Ê[Y|Y>τ, x] + (1 − p(x))·μ_sub(s, h)`. The forecaster's
  prohibition on multiplying is a prohibition about *quantiles*; the expectation
  is where the two stages genuinely multiply, which is exactly why it is the
  attributable one.
- **Do not attribute the two stages separately and glue them.** There is no
  honest glue: the product's cross term does not decompose per feature, and the
  candidate allocation rules for it are all invented. Instead the composed
  scalar `g(x) = E[Y|x]` is treated as **one function of one feature vector**,
  and Shapley values are computed on `g` directly. Composition happens before
  attribution, not after.
- **Group first, then attribute.** The players in the game are **eight feature
  groups**, not two hundred features. A group's contribution is therefore a
  Shapley value of the group *as a player*, not a sum over members — which is
  the exact answer to "aggregate without lying about sign": there is no
  aggregation step in which a sign could be lost. It also collapses the
  attribution to `2⁸ = 256` coalitions, which makes **exact** Shapley values
  affordable and removes sampling from the ranking entirely.
- **Sum over the 24 hours.** Expectations add. `Σ_t φ_{j,t}` is exact, needs no
  invented rule, and equals the attribution of the day's expected MWh against a
  typical day's — the quantity the screen's bars can honestly be shares of. The
  peak hour is computed too, and returned beside the day, not instead of it.
- **The background is matched, so "typical" is a stated reference.** Each
  `(subsystem, local_hour)` cell has a frozen 128-row background sample drawn
  from the artifact's base-fit block. `v(∅)` is therefore "a typical hour *h* in
  this subsystem", and the sum over hours is "a typical day". This is what the
  `typical` column on the screen has always been implying without defining.
- **Domain rules are a one-way valve.** A rule may `annotate`, `demote` or
  `withhold`. **No rule may change a number** — not `p`, not the band, not a
  `φ`, not a rank's underlying value. When a rule and SHAP disagree, both are
  published and the narration is *required* to state both. A rule that could
  overwrite an attribution would make the published attribution not the model's,
  and then the reliability curve and the shuffled-label control describe a
  different object than the screen does.
- **The §26 boundary is two automated enforcers plus one sentence.** A
  build-time forbidden-vocabulary test over user-facing copy and message
  catalogues, and a runtime validator on every generated narration. Copy review
  is retained as a courtesy and is load-bearing for nothing.
- **The renderer renders.** Its input is a closed JSON document; it may state no
  number that is not literally in that document, it may perform no arithmetic
  (every derived figure the copy wants is pre-computed into the input), and its
  output is validated against a numeric whitelist and a banned-lemma list before
  it reaches a user. Two failures fall back to a deterministic template.

## User Stories

**The target**

1. As a modeller, I want the attribution computed on the composed expectation
   `E[Y|x]`, so that the explanation describes the thing the screen shows a
   number for rather than one stage of a two-stage model.
2. As a modeller, I want the composed scalar attributed as a single function,
   so that no per-feature allocation of a product's cross term has to be
   invented.
3. As a sceptic, I want it published that the attribution explains the
   *expectation* and not the P10/P50/P90 band, so that nobody reads a driver
   bar as an explanation of the interval.
4. As a product owner, I want one attribution per subsystem-day and not one per
   technology, so that the screen does not imply a per-technology model that
   `forecaster.md` explicitly refuses to build.
5. As a developer, I want `E[Y|x]` computed by importing the forecaster's single
   composition function, so that the explained quantity and the served quantity
   cannot drift apart.

**The players**

6. As a user, I want at most a handful of named drivers in words I recognise, so
   that the screen is readable by someone who does not know the feature list.
7. As a modeller, I want the group map to be a **total partition** of the
   artifact's ordered feature list, checked by a test, so that adding a feature
   upstream fails the build until someone decides where it belongs.
8. As a modeller, I want each group's contribution to be a Shapley value of the
   group as a player rather than a sum of its members' values, so that a group
   whose members disagree still has one honest sign.
9. As a reviewer, I want the group map versioned and hashed onto the model card,
   so that a change to the grouping is a product-visible event and not a silent
   re-ranking.
10. As a user, I want a residual group that is a real player rather than an
    arithmetic leftover, so that "everything else" carries a genuine
    contribution and a genuine sign.
11. As a user, I want each group's `observed` / `typical` pair to name the
    feature it comes from, so that a value pair is never presented as if the
    whole group had one reading.

**The day**

12. As a user, I want the drivers to describe the whole target date, so that the
    bars and the day-total figure beside them are about the same thing.
13. As a modeller, I want the day attribution to be the exact hour-wise sum, so
    that the aggregation introduces no rule that could be chosen differently.
14. As a sceptic, I want a published measure of how much a group's hours
    disagree with each other, so that a driver that dominates at noon and
    reverses at dawn cannot hide inside its own total.
15. As a user, I want the peak hour's own attribution available beside the day's,
    so that "when" is answerable without changing what the headline ranking
    means.

**Domain rules**

16. As a product owner, I want domain rules that can annotate, demote or
    withhold but never rewrite, so that the published attribution is always the
    model's own.
17. As a user, I want a rule and the attribution to be shown together when they
    disagree, so that the disagreement is information rather than a bug someone
    resolved off-screen.
18. As an operator, I want every fired rule recorded with the payload, so that a
    strange narration can be traced to the rule that shaped it.
19. As a user, I want the screen to refuse to rank drivers on a day whose
    attribution is smaller than its own numerical error, so that noise is never
    presented as a ranking.
20. As a user, I want to be told when the model was reading a stale weather run
    or an incomplete centroid set, so that a confident-looking explanation is
    not built on a quiet degradation.
21. As a reviewer, I want the rules that need measured constants deferred with a
    named reopening trigger, so that the fog is bounded rather than filled with
    guesses.

**The §26 boundary**

22. As a product owner, I want "Diagnosis, never Causal AI" enforced by a test
    over the copy and the message catalogues, so that it survives the sessions
    that never read this spec.
23. As a product owner, I want the same boundary enforced at generation time,
    so that a sentence written fresh per request cannot cross a line a copy
    review has already passed.
24. As a reviewer, I want each permitted use of a banned word to be listed in an
    allowlist with a reason, so that the exceptions are enumerable.

**The renderer**

25. As a user, I want the narration in my own language, generated in it rather
    than translated into it.
26. As a sceptic, I want the narration to contain no number that is absent from
    its input, enforced by a validator rather than by a prompt.
27. As a developer, I want every derived figure the copy might want pre-computed
    into the renderer's input, so that "the renderer may not compute" is a rule
    it can actually obey.
28. As a user, I want a sentence even when the language model is down, so that
    the panel is never empty.
29. As an operator, I want the narration cached on the exact content that
    produced it, so that a new artifact or a superseding weather run invalidates
    it automatically and nothing else does.
30. As a product owner, I want the API to state whether a narration came from
    the model or the template, so that the panel's own footnote can be true.
31. As a reviewer, I want the renderer to have no tools, no retrieval and no
    access to the database, so that "it renders, it never decides" is a
    property of the call and not of the prompt.

## Implementation Decisions

### Which model SHAP explains — the composed expectation, attributed once

**Decision: the target is `g(x) = E[Y | x]`, the composed expected
`constrained_off_mwh` for one `(subsystem, valid_time)`, in MWh.**

`forecaster.md` publishes five scalars per hour. Only one is attributable
without inventing arithmetic:

| Candidate | Why not |
|---|---|
| `p(x)` — occurrence | Matches IDEA §25's mock exactly, and explains *half the model*. A day whose risk is driven by the classifier and whose magnitude is driven by the weather would show only the first half, and the screen's biggest number is an MWh figure the attribution would not describe at all. |
| `Q_pos^0.5` — magnitude | The mirror failure. Also conditional on an event whose probability is the other stage's output, so its drivers answer "given curtailment, how much" — a question the screen never asks. |
| `Q_Y(0.1 or 0.5)` — a composed quantile | Not a smooth function of the features. `Q_Y` is a **piecewise** function whose branch is selected by `q ≤ 1 − p(x)`; a feature that moves `p` across that boundary produces a discontinuous jump from `0` to `> τ`, and Shapley values of a step function attribute the entire day to whichever feature happened to cross it. This is the sharpest reason the band is not the attribution target. |
| Two attributions, combined | See below. |
| **`E[Y|x]` — the expectation** | **Chosen.** A genuine function of both stages, continuous in every feature, denominated in the product's own unit, and additive across hours. |

**Why the two-attribution route is refused, stated as arithmetic rather than as
taste.** Write `g = μ + p·(m − μ)` with `m = Ê[Y|Y>τ, x]` and `μ = μ_sub(s,h)`
constant given the cell. Let `a = p`, `b = m − μ`, with SHAP baselines `a₀`,
`b₀`. Then

```
g − g₀ = b₀·(a − a₀) + a₀·(b − b₀) + (a − a₀)·(b − b₀)
       = b₀·Σⱼ φ^p_j  +  a₀·Σⱼ φ^m_j  +  (Σⱼ φ^p_j)(Σⱼ φ^m_j)
```

The first two terms decompose per feature. **The third does not.** It is a
scalar product of two sums, and every way of splitting it across features —
proportional to `|φ^p|`, to `|φ^m|`, to their geometric mean, to the composed
first-order term — is a choice with no principle behind it, and the choices
disagree about the ranking whenever the cross term is large. The cross term is
*largest* precisely on the interesting days: those where a feature raises both
the chance and the size. So the double-counting question is not "how do we
avoid it"; it is "why are we creating it". Attributing `g` directly creates no
cross term to allocate, because `g` is one function.

**How `g` is attributed: exact Shapley values over eight group players,
interventional, against a matched background.**

For a target row `x` at `(subsystem s, local hour h)` and the artifact's frozen
background set `B(s,h)` of 128 rows:

```
v(S) = (1/|B|) · Σ_{b ∈ B(s,h)}  g( x[S] ⊕ b[S̄] )        for S ⊆ {1..8}
φ_j  = Σ_{S ⊆ N\{j}}  (|S|! · (8−|S|−1)! / 8!) · [ v(S ∪ {j}) − v(S) ]
```

- **Interventional (marginal), not conditional/path-dependent.** The
  path-dependent TreeSHAP estimator attributes credit to features the model does
  not read, through correlation with features it does — and this feature vector
  is saturated with correlation by construction (`proxy_residual_load_mwh` is a
  function of three other columns). The interventional value function answers
  "what does the model do when this group is replaced by a typical one", which
  is the only version of the question the screen's `observed vs typical` framing
  is already asking.
- **Exact, not sampled.** Eight players is 256 coalitions; the whole enumeration
  is affordable, so the *ranking* carries no Monte-Carlo noise. The only
  residual error is background sampling, and it is quantified (below) rather
  than assumed away.
- **`g` is evaluated through the forecaster's own composition function.** The
  ML service imports it; it does not re-implement `p·m + (1−p)·μ_sub`. Story 5
  of `forecaster.md` already requires one implementation with four callers.
  This is the fifth.
- **Local accuracy holds exactly**: `Σⱼ φ_j = g(x) − v(∅)`. This is asserted,
  not hoped for, and it is what makes the shares mean something.

**Cost.** 256 coalitions × 128 background rows = 32,768 constructed rows per
instance, two boosters each; 24 hours × 4 subsystems = 96 instances ≈ 3.1 M row
evaluations per lane per publication. Seconds, batched, offline, once per
publication — never in an HTTP request.

**Grouped Shapley is not the sum of member Shapley values, and that is the
point.** For a general `g` the two coincide only where `g` is additive across
the group boundary. Treating the group as an atomic player defines its own
cooperative game over eight players, and the answer to "what if members
disagree" is that there are no members in the game being solved. A group whose
features pull opposite ways gets whatever net effect *replacing the whole
group with a typical one* has — one number, one sign, no cancellation performed
by us.

**What this does not explain, said on the screen and not only here.** The
attribution explains the **expected MWh**. It does not explain the P10, the
P90, the width of the band, or the day-level occurrence probability — the last
of which comes from the path ensemble and is not a per-hour model output at all.
The risk chip and the driver bars are adjacent panels describing related but
distinct quantities, and the screen must say so once.

### Feature grouping — eight players, one total partition

**The map is data.** `apps/ml/src/wattsteer_ml/diagnosis/driver_groups.yaml`,
loaded at train time, hashed (`driver_group_hash`, sha256 over the sorted
`feature → group` pairs) and stamped on the model card together with
`driver_group_version`.

| # | `code` | `label_code` | Mechanism | Members |
|---|---|---|---|---|
| 1 | `renewable_resource` | `driver.renewable_resource` | How much wind and sun there is to spill | `weather_wind_*`, `weather_shortwave_radiation`, `weather_direct_normal_irradiance`, `weather_diffuse_radiation`, `weather_cloud_cover`, `weather_clearness_index`, `weather_wind_power_curve_cf`, `weather_expected_wind_mwh`, `weather_expected_solar_mwh`, `weather_temperature_2m`, `weather_surface_pressure`, `weather_relative_humidity_2m`, `weather_precipitation`, `dessem_wind_mwh`, `dessem_solar_mwh`, `dessem_mmgd_mwh`, `dessem_*_capacity_factor`, `capacity_*`, `observed_*_capacity_factor_mean_7d`, `observed_wind_generation_lag_168h`, `observed_solar_generation_lag_168h` |
| 2 | `demand_level` | `driver.demand_level` | How much load there is to absorb it | `programmed_load_mwh`, `programmed_load_mean_3h`, `programmed_load_daily_min_mwh`, `programmed_load_rank_in_day`, `dessem_demand_mwh`, `dessem_pumping_mwh`, `observed_load_lag_168h` |
| 3 | `net_surplus` | `driver.net_surplus` | The balance itself — IDEA's "renewable / load ratio" and "low residual load" | `proxy_residual_load_*`, `proxy_renewable_load_ratio`, `proxy_vre_surplus_mwh`, `dessem_residual_load_mwh`, `dessem_residual_load_min_of_day`, `dessem_residual_load_rank_in_day`, `dessem_renewable_load_ratio`, `dessem_vre_surplus_mwh`, `dessem_inflexible_share`, `dessem_hydro_mwh`, `dessem_thermal_mwh`, `dessem_sin_residual_load_mwh` |
| 4 | `export_stress` | `driver.export_stress` | Whether the surplus can leave | `dessem_implied_net_export_mwh`, `dessem_export_utilisation`, `dessem_absorber_residual_load_mwh`, `observed_net_exchange_*`, `observed_corridor_flow_*`, `observed_export_utilisation_mean_24h_to_cutoff`, `observed_corridor_utilisation_ne_se_max_7d` |
| 5 | `ramp_shape` | `driver.ramp_shape` | Intraday shape and steepness — IDEA's "solar ramp" | every `*_ramp_1h`, `weather_wind_speed_120m_mean_3h`, `weather_wind_speed_120m_std_6h`, `weather_shortwave_radiation_mean_3h` |
| 6 | `calendar_season` | `driver.calendar_season` | Weekend, holiday, season, sun angle — IDEA's "Sunday" | `calendar_*`, `solar_zenith_cos`, `solar_extraterrestrial_ghi` |
| 7 | `recent_history` | `driver.recent_history` | What has been happening lately | `observed_constrained_off_*`, `observed_reason_share_*`, `observed_actual_lag_hours` |
| 8 | `data_conditions` | `driver.data_conditions` | The state of the pipeline, and the residual | `weather_run_age_hours`, `weather_centroid_coverage`, `subsystem`, **and every feature not named by 1–7** |

All five drivers IDEA §25 names by hand land somewhere: high wind → 1, low
residual load → 3, high NE export → 4, solar ramp → 5, Sunday → 6.

**Four rules that make the map a decision rather than a taxonomy:**

- **Total and disjoint.** Every name in the artifact's ordered feature list
  belongs to exactly one group. Group 8 is the declared catch-all, so
  totality is achievable, but a new feature silently landing in
  `data_conditions` is a bad outcome — hence the test: a feature added upstream
  that matches no explicit rule fails the group-map test, and the fix is a line
  in the YAML, not a fallback.
- **`calendar_local_hour` and `subsystem` are neutralised by construction**,
  because the background is matched on both, so neither can move the composed
  expectation relative to its own background. They stay in the map for totality.
  Note they have no `φ` of their own to inspect — they are members, and the game
  is played by groups — so the property is asserted on the sampler instead: every
  background row shares its target's subsystem and local hour. See seam 5.
- **`data_conditions` is a player, not a leftover.** Its `φ` is a Shapley value
  like any other, so the "everything else" row on the screen has a real
  contribution and a real sign — unlike the fixture's `other`, which is
  currently a rounding remainder.
- **The grouping is a product decision and is frozen against retrains.** The map
  changes only by editing the YAML, which bumps `driver_group_version`, which
  invalidates every cached narration. The retrain never touches it.

**`observed` and `typical`, and what a group can honestly show.** A group has no
single value, so each group **declares a headline feature** in the YAML, and the
payload carries two numbers and a `unit` code for it. At retrain the card
records whether the declared headline is in fact the largest mean-`|φ|` member
on the newest fold; a mismatch is a **card warning, never an automatic
relabel** — a driver whose subtitle changes weekly is worse than one that is
second-best.

**The reading is taken at the grain of the bar it sits beside**, which is the
one thing an earlier draft of this paragraph got wrong: it specified the
group's peak-`|φ|` hour for both grains. So, settled:

| Grain | `observed` | `typical` |
|---|---|---|
| `day` | the headline feature's **mean over the day's 24 rows** | its **mean over the 24 matched background cells**, the same 24 local hours |
| `peak_hour` | that hour's own value | the mean over that one `(subsystem, local_hour)` cell |

A day bar is `Φ_j = Σ_t φ_{j,t}`, the whole day's contribution. Quoting one
hour's reading beside it would put a single-hour figure under a 24-hour number
on the same row — the reconciliation problem this spec refuses everywhere else,
and the reason the peak hour is *returned beside* the day rather than instead of
it. The peak-hour rows already carry the hour-grain reading, so nothing is lost
by the day's being the day's.

The day's `typical` is exactly the sample `v(∅)` was averaged over, read one
column at a time, which is what makes the pair comparable rather than merely
adjacent. The cells all hold the same number of rows, so the mean over the
pooled rows and the mean of the cell means are the same number and there is no
weighting decision hidden in it. The mean rather than the median: `v(∅)` is a
mean, and a `typical` that was a median would be a different reference from the
baseline the bar is measured against.

**Display, and the only place a sign can still be lost.** The API returns all
eight groups, ranked by `|share|`. The screen renders groups with
`share ≥ 0.03`, capped at six rows, merging the remainder into one `other` row
whose `phi` is the signed sum of what it absorbed. That merge is the one summing
step in the whole design, so it carries the sign rule explicitly:

> An `other` row reports `direction: "mixed"` when
> `Σ|φ_members| > 1.5 · |Σ φ_members|`, and `raises` / `lowers` otherwise.

`"mixed"` is a **new third member of `Driver.direction`** and is a required
change to `apps/web/src/lib/domain.ts` — flagged below rather than assumed.

**The selection predicate is shared; the merge is not.** The narration is
assembled server-side and has to know which groups it is allowed to name, so the
`share ≥ 0.03` / top-six cut is computed on the server too — it is one predicate
over a published number and duplicating it is not a second definition of
anything. What stays client-only is the *merge*: collapsing the remainder into
one `other` row, summing its `φ` and deciding whether that row reads `"mixed"`.
The API still returns all eight groups, ranked, whatever the cut selects.

**Shares.** `share_j = |φ_j| / Σ_k |φ_k|` **over all eight groups** — not over
the displayed rows, which was circular, since the display cut is itself applied
to `share`. See `api-surface.md`, "`share_j` is computed over all eight groups".
Shares therefore sum
to 1 and a day whose drivers cancel still produces a full bar chart. This makes
the shares **shares of the total attributed movement**, not of the curtailment
and not of "the attributed magnitude" — which is what the current UI footnote
and the `Driver.share` doc comment say. Both are copy changes and are flagged.

### Aggregation across the day — sum, exactly, and publish the disagreement

**Decision: the day attribution is `Φ_j = Σ_{t ∈ D} φ_{j,t}`, the exact
hour-wise sum over the 24 hours of the target date in `America/Sao_Paulo`.**

The reason is one line: **expectations add and quantiles do not.** The day's
expected MWh really is `Σ_t E[Y_t]`, the baseline really is `Σ_t v_t(∅)`, and
Shapley values are linear in the value function, so the sum of the hourly
attributions *is* the attribution of the day's expected total against a typical
day's — with no averaging rule, no weighting scheme and no choice to defend.
This is the same argument that forbids summing the band, running in the one
direction where it is valid, and it is why the target had to be the expectation
before this question could be answered at all.

The rejected alternatives, and what they would have cost:

- **Peak hour only.** Answers "why is 13:00 the worst hour", which is a good
  question and a different one. It would also sit beside a day-total figure it
  does not explain, on the same screen, which is the reconciliation problem the
  forecaster's path ensemble exists to avoid one layer down.
- **Mean of hourly ranks, or mean of shares.** Both are averages of
  normalisations, which is an operation with no interpretation: an hour whose
  total attribution is 0.2 MWh would carry the same weight in the ranking as one
  carrying 90 MWh.
- **Attribute a day-grain model instead.** There is no day-grain model. Building
  one would create a second thing to reconcile with the hourly one.

**The cost of summing, measured rather than waved at.** A group can dominate at
noon and reverse at dawn, and the sum hides it. So the payload carries, per
group:

```
hour_disagreement_j = Σ_t |φ_{j,t}|  /  max(|Σ_t φ_{j,t}|, ε)
```

`1.0` means every hour pulled the same way. A displayed group with
`hour_disagreement ≥ 2.0` is flagged, and the narration is **required** to say
that the driver acted in both directions across the day. This is cheap, exact,
and it turns the aggregation's known weakness into a published number.

**The peak hour is returned beside the day, never instead of it.**
`peak_hour_drivers` carries the same eight groups computed for the single hour
with the largest `E[Y_t]`, plus that hour's local time. The screen may render it
as a secondary view; the headline ranking is always the day.

### Domain rules — the arbitration mechanism now, most of the content later

The map records the rules' content as fog and this spec does not pretend
otherwise. What it does refuse to defer is the **mechanism**, because a
mechanism designed after the rules exist will be designed to fit them.

**A rule is a predicate over `(feature_row, composed_forecast, attribution,
recent_observations)` with exactly one of three actions:**

| Action | What it may do | What it may never do |
|---|---|---|
| `annotate` | Attach a typed fact to `rule_flags[]`, which the renderer is **required** to state | Touch any number |
| `demote` | Force a driver group below the fold regardless of its `|share|` | Change its `φ`, its sign or its share |
| `withhold` | Suppress the model narration; the template renders instead. **The drivers are returned untouched** — withholding acts on the narration, never on the attribution | Change any number, or delete a driver |

**No rule may change a number, and no rule may create a driver.** This is the
whole design. An attribution that a rule could overwrite would no longer be the
model's attribution, and every property the rest of the system establishes about
the model — the reliability curve, the coverage report, the shuffled-label
control — would stop describing what is on the screen. A rule's power is
strictly over *what gets said*, never over *what is true of the model*.

**Arbitration when a rule and SHAP disagree: both are published, neither wins.**
The payload carries `drivers` untouched and `rule_flags` alongside, the renderer
receives both and is required to state both, and the screen shows the
annotation adjacent to the bars. This is the only outcome consistent with §26:
a rule asserting a fact about the *grid* and a `φ` asserting a fact about the
*model* are not the same kind of claim, so "resolving" them would mean silently
converting one into the other.

Ordering, so two rules cannot both claim the last word: rules are evaluated in
declared order; every fired rule is recorded with its inputs; the **strictest**
action taken by any fired rule governs (`withhold` > `demote` > `annotate`).

**The four rules that ship in v1**, chosen because none of them needs a
constant that does not already exist as data:

| `code` | Action | Fires when | Constant source |
|---|---|---|---|
| `nothing_to_explain` | `withhold` | The day's occurrence probability is below the lowest `risk_bins` edge **and** no hour's `P50` is non-zero | `risk_bins`, from the artifact |
| `attribution_is_noise` | `withhold` | `Σ_j |Φ_j| ≤ 2 × attribution_stderr_mwh` — the ranking is smaller than its own background-sampling error | Computed per day (below), not invented |
| `stale_inputs` | `annotate` | `weather_run_age_hours > 0`, or `weather_centroid_coverage < 1`, or any displayed group's headline feature is NULL at serve time | Feature values |
| `unmodelled_outage_regime` | `annotate` | On the most recent settled day for this subsystem, `REL` accounts for the largest share of constrained-off MWh | Observed `RestrictionCause`, already ingested |

A rule's `facts` are the values it fired on, keyed by name, and one of them is
a **list of strings**: `stale_inputs` names every displayed group whose headline
feature was NULL at serve time. The wire contract carries the list rather than a
joined string, for the reason everything else here is a code — a server that
flattened it would be assembling prose.

`unmodelled_outage_regime` is the sharpest honest rule available today and it
exists because `forecaster.md` already ruled the reason-code model out on the
ground that **no ingested dataset carries transmission availability**. When
yesterday's curtailment was mostly external unavailability, the model is
explaining a mechanism it structurally cannot see, and the screen should say so
next to the bars rather than in a footnote nobody reads.

`attribution_stderr_mwh` is a bootstrap over the background sample: resample
`B(s,h)` with replacement 200 times, recompute `v(∅)` and `Σ_j|φ_j|`, take the
standard deviation of the day total. It is the one number that makes
"this ranking is noise" a measurement rather than a taste.

**What is deferred, and the trigger that reopens it.** Every rule that would
encode grid *physics* — "NE export saturated at the corridor limit ⇒ export
stress must be named"; "hydro reservoirs above X ⇒ inflexibility dominates" —
needs a threshold nobody can set today, and the map is right that they cannot be
written before real rankings exist. The reopening trigger, so this is a bounded
deferral and not a shrug:

> Reopen when **three point-in-time folds exist** and the driver-stability
> report has been produced. A candidate rule is admitted only if (a) it fires on
> at least 20 days in the report, (b) every quantity in its predicate is an
> ingested column or an artifact field, and (c) its action is `annotate` or
> `demote` — a new `withhold` rule needs a separate review, because withholding
> is the only action a user can notice as an absence.

### The §26 boundary — a documented rule with two enforcers

**Decision: a documented rule, enforced twice automatically. Copy review is
retained and is load-bearing for nothing.**

The rule, stated once so it can be cited:

> WattSteer says the model **raised** or **lowered** its forecast. It never says
> a condition **caused** curtailment. The product name for this engine is
> **Diagnosis**; the phrase "Causal AI" does not appear anywhere, including in
> marketing copy, and no surface claims to explain why an event physically
> occurred.

**Enforcer 1 — a build-time forbidden-vocabulary test**, in the same spirit as
the repo-hygiene test that already fails when the old product name returns.
Scope: `apps/web/src/**`, `packages/ui/**`, every i18n message catalogue, and
the narration system prompt. Banned, case-insensitive, both locales:

```
causal, causality, causal ai, root cause, caused by, causes the,
because the grid, why it happened, driver of the event,
causa, causal, causou, causado por, causada por, causa raiz, porque ocorreu

> **`causada por` is listed beside `causado por` and is not a duplicate.**
> `restrição` is feminine, so "a restrição foi *causada* por…" is the natural
> sentence and the masculine agreement is the unusual one — and the matcher is
> word-boundary anchored, so one does not cover the other. Diagnosis 10 hit it
> while writing a fixture, which is the only reason it was noticed: the
> build-time scan had nothing to catch, because no catalogue string happened to
> use the feminine form.
```

Exceptions live in `apps/web/src/lib/copy/causality-allowlist.ts`, one entry per
permitted occurrence, each carrying the string, its location and a reason. The
only expected entries are the disclaimers that *use* the word to deny the claim
— the driver-bars footnote is one.

**The hardcoded-copy guard reaches the server too.** `test/i18n-hardcoded-copy.test.ts`
scoped itself honestly to `apps/web/src/app/**` and `apps/web/src/components/**`,
and the API-surface ticket graph recorded the gap that left: *"copy assembled in
a library module would evade it, which is a live risk for the template
narration"*. The narration **is** assembled server-side, so the guard now also
scans `apps/api/src/**` by the same file-name rule the boundary scan uses —
anything named for the narration — with one distinction it turns on: a string
handed to `throw new …Error(…)` or to an error class's `super(…)` is a
**diagnostic, not copy**. That is true rather than convenient — the error
envelope's only branchable field is a code and the client renders
`copy.error[code]`, never the message — and everything else in those modules has
to come out of the dictionaries.

The payload itself is guarded twice over, at run time: the document it hands the
renderer may carry **no string with a space in it** except
`subsystem_display_name`, which is compared against `SUBSYSTEMS[].onsDisplayName`
rather than merely permitted. A preformatted `"310 MW left"` cannot reach a
renderer, in either locale.

**Enforcer 2 — a runtime validator on every generated narration.** The lexical
half of the output validator (below) rejects the same lemma set. A narration
that trips it is retried once with the complaint appended, then falls back to
the template. Nothing that trips it ever reaches a user.

**Why a review is not enough.** Copy review works on strings that exist at
review time. The narration panel produces a sentence per request, per locale,
per day. The only place to review it is the moment it is generated, which is
what enforcer 2 is.

### The LLM renderer — the contract

**It renders. It never decides.** No tools, no retrieval, no database access, no
web access, no arithmetic. Its whole world is one JSON document.

**Where it runs.** `apps/api` (Elysia/TypeScript), per the map's stack decision,
using `@anthropic-ai/sdk`. `apps/ml` computes and persists the attribution;
the API assembles the payload, checks the cache, calls the model, validates and
returns.

**Model and call parameters.**

| | |
|---|---|
| Model | `claude-opus-5` |
| Effort | `output_config: { effort: "low" }` — the task is restatement under constraint, not reasoning |
| Thinking | left at the model's default (adaptive). **Not disabled** — disabling it on this model risks leaked reasoning tags and tool-call text in the visible response, and low effort already buys the cost back |
| `max_tokens` | `700`, non-streaming; the output is one short paragraph |
| Output shape | structured outputs, `output_config.format` with a one-field schema `{ narration: string }`, so no preamble can appear |
| Caching | `cache_control: { type: "ephemeral" }` on the system block, which is byte-identical across every request; the volatile payload goes last |
| Tools | none, declared as none |

Volume is 4 subsystems × 2 locales × 2 gate profiles ≈ 16 calls per day, at
roughly 2 k input tokens (mostly cache reads) and 300 output tokens — cents per
day. There is no cost argument for a weaker model here, and a weaker model on
this task fails in the one direction that matters: it invents a number.

**The input JSON — the renderer's entire world.**

```jsonc
{
  "schema_version": "diagnosis.narration.v1",
  "prompt_version": "2026-08-28.1",
  "locale": "pt-BR",                       // or "en-US"
  "subsystem": "NE",
  "subsystem_display_name": "NORDESTE",    // ONS's proper noun, untranslated
  "target_date": "2026-08-28",
  "threshold_mw": 5,
  "forecast_origin": {
    "run_label": "dessem_free_v1__gate_late__thr5/2026-08-27T22:11:07Z",
    "gate_profile": "gate_late",
    "published_at": "2026-08-27T22:11:07Z"
  },
  "vintage_fidelity": "point_in_time",
  "risk": {
    "day_occurrence_probability": 0.87,
    "risk_class": "high",                  // a code; the client translates it
    "hours_p50_nonzero": 9
  },
  "magnitude": {
    "day_expected_mwh": 412.0,
    "baseline_expected_mwh": 96.0,
    "day_energy_p10_mwh": 0.0,
    "day_energy_p50_mwh": 370.0,
    "day_energy_p90_mwh": 980.0,
    "peak_power_p50_mw": 118.0,
    "peak_hour_local": 13
  },
  "attribution": {
    "target": "expected_mwh_day",
    "total_attributed_mwh": 316.0,         // = day_expected − baseline
    "sum_abs_attributed_mwh": 402.0,
    "stderr_mwh": 4.1,
    "top_two_share": 0.56,                 // pre-computed: the renderer may not add
    "groups": [
      {
        "code": "net_surplus",
        "label_code": "driver.net_surplus",
        "phi_mwh": 128.0,
        "share": 0.31,
        "direction": "raises",
        "headline_feature": "proxy_renewable_load_ratio",
        "observed": 1.42,
        "typical": 0.96,
        "unit": "ratio",
        "hour_disagreement": 1.1,
        "demoted": false
      }
      // ... eight entries, ranked by |share|
    ]
  },
  "rule_flags": [
    { "code": "stale_inputs", "severity": "annotate",
      "facts": { "weather_run_age_hours": 12 } }
  ],
  "observed_reasons_latest": {
    "date": "2026-08-27", "top_reason": "ENE", "top_reason_share": 0.62
  }
}
```

Every field the copy could want is present *as a number*. `top_two_share` looks
redundant and is not: the prototype's own fixture narration adds two shares
together, and the rule "the renderer may not compute" is only enforceable if
nothing it needs requires computing.

**The system prompt's load-bearing constraints** (abbreviated; the file is the
authority):

- Write one paragraph, 45–90 words, in `{locale}`, in the second half of the
  register the rest of the product uses.
- State only facts present in the input. **Introduce no number, name, place,
  date or quantity that does not appear in the input document.**
- Say that the *model* raised or lowered its forecast. Never say a condition
  caused, drove or explains the curtailment itself.
- State every `rule_flags` entry.
- If any displayed group has `hour_disagreement ≥ 2.0`, say that it acted in
  both directions during the day.
- Never give advice, never mention batteries, dispatch or the optimizer, never
  speculate about tomorrow beyond the target date, never characterise the band's
  meaning (that caveat is static UI copy).
- Round nothing. Use the numbers as given.

**The output validator — three gates, all of them mechanical.**

1. **Numeric whitelist.** Extract every numeric token from the narration
   (locale-aware: `1.42` / `1,42`, `412` / `412,0`, `87%`, `1.900`). Each must
   match a value present in the input document, rendered at one of the permitted
   precisions for its field, in the requested locale. **A number that is
   arithmetically correct but absent from the input fails**, which is the whole
   point — that is what a derived-and-wrong figure looks like from the outside.
2. **Lexical.** The §26 banned-lemma set, plus banned advice verbs
   (`should`, `recommend`, `deve`, `recomenda`) and banned certainty adverbs
   (`certainly`, `definitely`, `certamente`).
3. **Structural.** Word count within `[35, 110]`; single paragraph; no markup;
   no URL; locale of the output matches the request (a cheap script/stopword
   check is sufficient — the failure mode is a whole paragraph in the wrong
   language, not a stray word).

A failure appends the validator's complaint to a second and final attempt. A
second failure logs the rejected text with its payload hash and falls back to
the template. **The rejected text is never shown.**

`apps/api/src/diagnosis/narration-validator.ts` is all three gates and the one
retry. Three things it deliberately does not re-derive:

- The **numbers** are read off `canonicalNarrationJson`'s output — the same
  bytes the cache key is a hash of, already rounded through the one rounder and
  the one precision table, which has no default. So "the number is in the
  payload" means "it is one of the numbers that was hashed", and a field added
  without a decided precision fails in the digest and in the whitelist together.
  Both locales' notation is admissible, grouped or not, and a shorter spelling
  only where it loses nothing: `412.0` may be written `412`, and `1.42` may not
  be written `1.4`.
- The **lemmas** go through `packages/core`'s `findLemmaHits`, which is the
  matcher the build-time scan uses. The advice verbs and certainty adverbs are a
  second *list*, not a second regex.
- The **notation** is spelled by `Intl`, which is what the client formats with.

The two tables keyed by field name — the server's precision table and the
client's formatter table — are tied by `test/narration-precision-tie.test.ts`,
on **decimals** rather than on membership: neither is a subset of the other and
neither should be, so the relation asserted is that for a field in both, the
digits the client displays are the precision the server hashed at. It found one
disagreement on arrival (`threshold_mw`, priced at one decimal and printed at
zero).

**The template fallback.** A deterministic sentence assembled from the same
payload through `t()` keys with interpolation, one key per locale, living in the
message catalogue. It names the risk class, the day's expected MWh against the
baseline, the top two groups with their directions and their `observed`/`typical`
pair, and every `rule_flags` entry. It is the one narration surface that *is* a
translated string, and that is consistent: a template is a fixed string
catalogue, which is exactly what `i18n.md` says the API returns everywhere
except generated prose.

**So `narration` is two shapes, not one with an optional field.** The model's
carries `text`; the template's carries `clauses` — an ordered list of
`{ key, values }`, where `key` is one of a closed set of `t()` keys and every
value is a number or a code, keyed by the payload field it was read from. It
carries no `text` at all, because a template rendered on the server would have
already chosen between `412,0` and `412.0`, which is the reader's convention and
not the server's. `apps/api/src/diagnosis/narration-template.ts` plans the
paragraph from the closed payload; `apps/web/src/i18n/narration.ts` looks each
key up in the active catalogue and formats each value through `Intl`. A rule
that fires with no clause fails there rather than going unsaid, because the
narration is required to state every `rule_flags` entry.

The response carries `narration.source: "model" | "template"`, so the panel
footnote can be true in both cases, and it now is: the screen used to assert
unconditionally that a language model wrote the paragraph and reads
`narrationNoteModel` / `narrationNoteTemplate` instead.

**The caching key.**

```
narration:v1:{prompt_version}:{model_id}:{locale}:{sha256(canonical(input_json))}
```

- `canonical()` sorts keys and rounds every float to its field's display
  precision **before** hashing, so a 1e-12 jitter in a re-computed `φ` does not
  miss the cache. Sorting is RFC 8785 (JCS) through `packages/core`'s existing
  `canonicalJson` — the scenario hash's serialiser, already mirrored in
  `apps/ml` and pinned by shared golden vectors — rather than a second sorter
  written next to the first.
- **The precision table is keyed by field *name*, and has no default.** By name
  because one quantity appears in more than one place — `sum_abs_attributed_mwh`
  sits both on the attribution and inside `attribution_is_noise`'s facts — and
  rounding the two differently would offer the renderer two spellings of one
  number, which the numeric whitelist would then have to accept. A numeric field
  with no entry is a **failure**, not a default: a field arriving with no
  decided precision is exactly the accidental addition that silently invalidates
  every cached narration, and the moment to notice it is the one where somebody
  has to write down how it is printed. `apps/api/src/diagnosis/narration-canonical.ts`
  holds the table.
- The payload already contains `forecast_origin.run_label` (which contains the
  `artifact_id`), so a retrain, a promotion, a superseding 12Z run, or a changed
  `driver_group_version` all invalidate the key by construction. Nothing else
  does, and there is no manual invalidation path to forget to call.
- `prompt_version` and `model_id` are in the key because a prompt edit or a model
  change produces different prose from identical facts.
- Redis, TTL 26 h. A template fallback is cached under the same key with a 5 min
  TTL, so an outage does not turn into a call per request, and recovery is fast.

**The API surface.** `GET /v1/diagnosis/day-ahead?subsystem=&date=&run=&locale=`,
returning the attribution as codes plus the narration as prose. Two consequences
for the client contract, both departures from the prototype's fixture:

- **`observed` and `typical` are numbers with a `unit` code**, not preformatted
  strings like `"310 MW left"` or `"+1.4 GW YoY"`. The client formats them
  through `Intl`, per `i18n.md`. Preformatted values in the API would be
  translated strings by another name.
- **The endpoint takes no `technology` parameter.** There is one attribution per
  subsystem-day, because there is one model per subsystem-day.

**Persistence, so Replay can read it.** Every published attribution is written
to `diagnosis_attribution` at `(artifact_id, subsystem, target_date,
published_at)` grain, carrying the eight `Φ_j`, the baseline, the stderr, the
peak-hour attribution, the fired rules and the `driver_group_hash`. This mirrors
`forecaster.md`'s rule that every served forecast is persisted as a `Forecast`
row, and for the same reason: "what did we say at D−1" must be a query, not a
re-run against a model that has since been retrained. Whether and how Time
Machine renders it is ticket 012's call, not this spec's.

### Two additions to the forecaster's artifact

This spec asks `forecaster.md` for exactly two things, and they are called out
rather than assumed:

1. **The matched background sample** — `B(s, h)`, 128 rows per
   `(subsystem, local_hour)` cell (12,288 rows), drawn once from the base-fit
   block with a stamped seed, added to the joblib bundle beside `μ_sub` and the
   PIT matrix `U`. Without it "typical" has no definition and the attribution
   is not reproducible from the artifact alone.
2. **Three card fields** — `driver_group_version`, `driver_group_hash`, and the
   `headline_feature_check` block recording, per group, whether the declared
   headline feature was the largest mean-`|φ|` member on the newest fold.

Neither changes what the forecaster predicts. Both belong to the artifact
because the alternative is an explanation that cannot be regenerated from the
model that produced it.

## Testing Decisions

**What makes a good test here.** An attribution has no ground truth, so almost
every test in this spec asserts an **invariant of the construction** rather than
a value. Two of them are generic detectors in the same family as the feature
spec's gate ablation and the forecaster's shuffled-label control: they catch a
whole class of wrongness without knowing what right looks like.

**Seam 1 — local accuracy, as arithmetic.** On fixture models with no training
involved: `Σⱼ φ_j == g(x) − v(∅)` to floating-point tolerance, for random
feature vectors, for `p = 0`, for `p = 1`, and at the isotonic clip endpoints.
This is the property that makes shares meaningful, and it is exact, so the
tolerance is machine epsilon and not a judgement.

**Seam 2 — the additive cross-check, which is where grouping is validated.** On
a synthetic model that is additive across the group boundary
(`g = Σ_j f_j(x_group_j)`), grouped Shapley **must equal** the sum of the
member features' interventional Shapley values. On a model with a deliberate
cross-group interaction it **must not**, and the gap must be exactly the
interaction term. Together these pin down that the implementation solves the
game it claims to solve, and they are what a future session that wants to
"simplify" grouping into summation has to confront.

> **This does not contradict seam 3.** Seam 2 computes member-level
> interventional Shapley values *in the test*, on a synthetic model, in order to
> prove that grouped Shapley is not their sum in general. Seam 3 forbids any
> **production** code path from summing member values into a group value. The
> test needs the forbidden quantity precisely so it can demonstrate the
> forbidden shortcut is wrong; seam 3's grep is scoped to the diagnosis module,
> not to its test fixtures.

**Seam 3 — the sign-honesty property, stated as a test.** Construct a group
whose two members have `φ` of `+40` and `−35` under a per-feature attribution.
Assert the group's own `φ` is computed from the coalition and is *not* `+5`
unless the model happens to be additive there. Assert that no code path in the
diagnosis module sums member-level values into a group value — a grep-level
test, in the same spirit as the UI's "nothing sums two bands", because this is
the invariant most likely to be broken by a well-meaning optimisation.

**Seam 4 — the group map is a total partition.** Every name in the artifact's
ordered feature list matches exactly one explicit rule; no name matches two; the
`data_conditions` catch-all is reached by zero features that were not explicitly
placed there. A feature added to `feature-engineering.md` fails this test until
it is grouped, which is the point. Also: `driver_group_hash` changes when and
only when the YAML changes.

**Seam 5 — the matched background, asserted on the sampler.** Every background
row drawn for a target shares that target's `subsystem` and its
`calendar_local_hour`. A row that does not means the sampler leaked across cells
and every "typical" on the screen is wrong. This test is cheap and catches the
single most likely implementation bug.

> **It is stated on the sampler, not on a `φ`, because the `φ` does not exist.**
> An earlier draft asserted that `φ` for `subsystem` and for
> `calendar_local_hour` is numerically zero on every instance. The game is
> group-first: the players are the eight groups, `calendar_local_hour` sits
> inside `calendar_season` and `subsystem` inside `data_conditions`, and neither
> member has a Shapley value of its own — seam 3 forbids any code path from
> producing one. The test the spec calls its most valuable had no quantity to
> assert on. Asserting the matching directly is strictly stronger anyway: it
> catches a leak on the row that leaked, rather than inferring one from an
> attribution that came out near zero for some other reason.

**Seam 6 — the day sum.** For a seeded fixture, `Φ_j == Σ_t φ_{j,t}` exactly;
`Σ_j Φ_j == day_expected_mwh − baseline_expected_mwh` exactly;
`hour_disagreement ≥ 1` always, and `== 1` exactly when every hour shares a
sign. Assert 24 hours were consumed (the feature spec's DST canary, one layer
up).

**Seam 7 — the shuffled-feature control, the generic detector.** Permute one
group's columns across rows *within a fold* and re-run the attribution. That
group's `|Φ|` must collapse toward zero and the other groups' rankings must be
materially unchanged. **If permuting a group's inputs leaves its contribution
intact, the attribution is not reading the model** — and this test does not need
to know which group or which model. It is the diagnosis-layer twin of the
forecaster's shuffled-label control and it is the most valuable test in this
spec.

> **"Within a fold" means within the cell, and the background is redrawn from
> the permuted fold.** Permuting inside `(subsystem, calendar_local_hour)` makes
> the permuted target's value a draw from the same cell every background row is
> drawn from, so the two are exchangeable and `φ_j → 0` follows from the
> construction rather than from an average. A shuffle pooled across the whole
> fold instead hands a 14:00 row a 03:00 row's values, which leaves it atypical
> *of its cell* — and an attribution taken against a matched background is
> obliged to report that as a contribution, so part of what the pooled control
> measures is the mismatch it introduced. Measured on a fitted bundle: pooled
> leaves 183–390 MWh of a 1689 MWh baseline and flips the sign, cell-wise leaves
> 5–180 MWh and keeps it. Redrawing the background from the permuted fold is the
> other half: a permutation that left the background alone would compare a
> shuffled target against an unshuffled typical.
>
> **The control needs a day the model read as unusual.** A permutation replaces
> the group's values with another row's from the same cell, so a target whose
> values were typical anyway has a `Φ` drawn from the same distribution before
> and after, and nothing collapses. This is a statement about what the control
> can measure, not a licence to pick the day that flatters it: the test asserts
> the collapse on a group the *baseline ranking* named, and refuses to report a
> collapse for a group whose `|Φ|` was already zero.

**Seam 8 — the rules cannot write.** Property test: for every rule, for randomly
generated payloads, the post-rule payload's `p`, band, `E[Y]`, every `φ`, every
share and every rank-underlying value are **byte-identical** to the pre-rule
payload. Only `rule_flags`, `demoted` and the narration-source decision may
differ. This is the one-way valve, asserted rather than reviewed.
Additionally: two rules with conflicting actions resolve to the strictest; a
fired rule always appears in `rule_flags`; a `withhold` rule means the LLM is
never called (assert the client is not invoked, not merely that its output is
discarded).

**Seam 9 — the numeric whitelist validator, adversarially.** A narration that
states a number correctly derived from the input but absent from it (e.g. the
sum of two shares, when `top_two_share` has been removed from the payload)
**must be rejected**. A narration stating a number present in the input in the
other locale's formatting must pass. A narration stating a plausible-looking
number that appears nowhere must be rejected. Fixture-driven, no API calls.

**Seam 10 — the §26 enforcers.** The forbidden-vocabulary test fails on a
deliberately planted `"causal"` in a message catalogue and passes when it is
moved to the allowlist with a reason; an allowlist entry whose string no longer
appears in the codebase also fails, so the allowlist cannot rot. The runtime
lexical validator rejects a fixture narration containing each banned lemma, in
both locales.

**Seam 11 — the renderer contract, without calling the API.** The assembled
request carries no tools, the system block is byte-identical across two
different payloads (so caching can work), the payload block is last, the model
id and effort match this spec, and the locale in the prompt matches the request.
A snapshot test on the canonicalised payload catches an accidental field
addition, which would silently invalidate every cached narration.

**Seam 12 — caching.** Identical payloads hit; a changed `φ` beyond display
precision misses; a changed `φ` below display precision hits; a changed
`artifact_id`, `prompt_version`, `model_id`, `driver_group_version` or locale
misses. A template fallback is cached with the short TTL and does not survive
into the next publication.

**Seam 13 — live, scheduled.** One real call per locale per deployment against
the real model, asserting only that the response passes all three validators.
This is the test that catches a prompt regression, and it is the only test in
this spec that spends money.

**Acceptance gate.** Default `bun test` / `pytest` pass with no network, no
database and no model artifact (seams 1–6 and 8–12 are fixture- and
synthetic-data-driven). Seam 7 runs against a real artifact under the existing
env-var gating. Seam 13 runs on its schedule. The attribution for all four
subsystems completes inside the publication budget with wall-clock recorded.

## Out of Scope

- **The two estimators, the mixture inversion, the band, the ensemble and the
  gate.** [`forecaster.md`](forecaster.md). This spec attributes one of its
  outputs and asks for two additions to its artifact; it decides nothing about
  the model.
- **The feature list, the availability classes and the gate arithmetic.**
  [`feature-engineering.md`](feature-engineering.md). This spec groups names; it
  never adds, drops or redefines one.
- **The reason-code model.** Ruled out in `forecaster.md` on an absent-predictor
  argument, with a three-part reopening trigger. Nothing here forecasts a
  reason; `unmodelled_outage_regime` reads *observed* reasons only, and only
  upward-aggregated ones.
- **Per-technology drivers.** There is no per-technology model. The technology
  split is a point split of a band's centre, and attributing a split would
  explain the share regressor rather than the forecast.
- **Per-hour driver bars on the Explain screen.** The day is the headline and
  the peak hour is returned beside it. A 24 × 8 attribution heatmap is a real
  screen and it is not this one.
- **Counterfactual and causal claims of every kind** — "if the corridor had 500
  MW more headroom, curtailment would have been X". That is causal inference,
  §26 forbids the claim, and the model cannot support it. Note the boundary
  precisely: the optimizer's *what-if* is a simulation of a dispatch under a
  fixed forecast, which is a different and legitimate object.
- **Attribution of the optimizer's plan.** `flex-optimizer.md` explains a
  dispatch through its own dispatch stack and SOC profile. The two engines
  never share an explanation surface.
- **SHAP interaction values, and any second-order decomposition.** Eight players
  gives 28 pairs, which is a matrix nobody asked for and a screen nobody
  designed.
- **Global feature importance on the Explain screen.** The card carries mean-`|φ|`
  per group per fold for the headline check and for the driver-stability report;
  it is model metadata, not a day's explanation, and mixing the two on one
  screen is how "why today" becomes "why in general".
- **Grid-physics domain rules.** Deferred with an explicit reopening trigger
  above. This is the ticket's stated acceptable outcome and it is taken.
- **Translating the narration.** It is generated in the requested locale, per
  the map's settled exception. No translation layer, no `t()` key, no
  round-trip.
- **Letting the renderer see anything but its payload.** No database, no tools,
  no retrieval, no conversation history.

## Further Notes

**The headline is that the composition question answers the grouping question
and the aggregation question at the same time.** Once the target is the
expectation — the one composed scalar that is continuous, additive across hours
and denominated in MWh — the day aggregation is forced (sum, exactly) and the
grouping becomes affordable enough to do *before* attribution rather than after.
Every hard problem in this ticket dissolves into the same choice, and the choice
is forced by the forecaster's own arithmetic: the band is piecewise and the
probability is unitless, so neither can be summed over a day, and only the
expectation can.

**"Group first, then attribute" is the load-bearing sentence.** The usual
pipeline is attribute-then-group, and every version of it has to decide what to
do with a group whose members disagree — and every answer is a lie of some size.
Making the group a *player* removes the question rather than answering it. It
costs one thing: the group's value is no longer the sum of its members' values,
so a reader who computes both will find they differ. Seam 2 pins the difference
to the cross-group interaction, which is the honest name for it.

**The one-way valve is what makes the domain rules safe to ship half-written.**
The map is right that the rules' content cannot be decided today. But a rule
that can only annotate, demote or withhold cannot corrupt anything, so shipping
four rules today and eight more in three months carries no risk of quietly
invalidating the model's published properties. Had the mechanism allowed a rule
to adjust a `φ` — which is what "arbitration" usually means — deferring the
content would have been reckless rather than prudent.

**The renderer's real constraint is the validator, not the prompt.** Prompts ask;
validators enforce. The numeric whitelist is deliberately strict enough to
reject a *correct* derived number, because from the outside a correct
computation and a lucky hallucination are indistinguishable, and the only
tractable rule is "no computation at all". The cost is a handful of
pre-computed fields in the payload, which is the cheapest safety mechanism in
this document.

**Where this spec is weakest.** Four places, ranked:

1. **The eight groups are a judgement and the first real ranking may embarrass
   them.** `net_surplus`, `demand_level` and `renewable_resource` are
   mechanically distinct and statistically entangled — `proxy_residual_load_mwh`
   is literally programmed load minus expected wind minus expected solar. The
   interventional value function handles the correlation correctly, but if the
   ranking turns out to put `net_surplus` first on every single day, the group
   set is carrying no information and should be re-cut. The driver-stability
   report is where that becomes visible, and it is the same report the deferred
   rules wait on.
2. **The matched background makes "typical" hour-specific, which is right for
   the bars and slightly odd for the day.** Summing 24 hour-matched baselines
   gives "a typical day" only in the sense of "the sum of typical hours", which
   is not any particular day that occurred. This is the same class of statement
   as the forecaster's hour-wise P10 envelope not being a realisable day, and it
   is stated on the same grounds.
3. **`hour_disagreement` is published but its threshold is invented.** `2.0` is
   a judgement placed where being wrong is conservative: too low and the
   narration says "acted in both directions" on days where it barely did; too
   high and it stays silent. It errs toward saying more, which is the right
   direction for a caveat, but it is a constant and it is named as one.
4. **Nothing validates that a narration is *good*, only that it is not wrong.**
   The three gates catch invented numbers, banned claims and structural
   nonsense. A dull, unhelpful, technically-correct paragraph passes every one
   of them. That is the right trade for v1 — the failure mode this product
   cannot survive is a confident false claim, not a boring true one — but it
   means the narration's quality rests on the prompt and on seam 13's single
   live call, which is thin.

**Calls the dev should review.** Four in this spec, plus the cross-spec ones
recorded in the ticket:

- **The expectation as the sole attribution target** means the Explain screen's
  bars do not explain its band. Two adjacent panels now describe two related
  quantities, and the screen needs one sentence saying so. If that is
  unacceptable to the product, the alternative is to attribute `p(x)` and accept
  that the MWh figure goes unexplained — which is IDEA §25's own mock, and is
  half an answer.
- **One attribution per subsystem-day, with no technology dimension**, which
  contradicts the prototype's `buildExplain(subsystem, technology)`. The
  prototype invented a per-technology explanation for a model that has no
  per-technology head.
- **Three UI contract changes**: `Driver.direction` gains `"mixed"`;
  `observed` / `typical` become numbers plus a `unit` code; the share is a share
  of *attributed movement*, which changes both the doc comment and the
  driver-bars footnote.
- **`claude-opus-5` at low effort for sixteen calls a day.** The cost argument
  for a smaller model is worth cents and the failure mode it buys is an invented
  number on a page whose entire premise is that nothing on it is invented.
