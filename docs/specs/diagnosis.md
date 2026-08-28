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
