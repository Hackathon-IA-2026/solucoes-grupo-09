---
id: "010"
title: Diagnosis engine spec — SHAP, domain rules, LLM renderer
type: wayfinder:grilling
status: closed
assignee: spec-agent
blocked_by: ["009"]
---

## Question

How does WattSteer explain a prediction without overclaiming?

- SHAP over a hurdle model explains *two* models. Is the attribution shown for
  occurrence, for magnitude, or for the composed expectation?
- Raw features are many; the screen shows five drivers (§43). How are features
  grouped into human-legible drivers (renewable/load ratio, export stress, low
  demand, solar ramp, weekend) and how are contributions aggregated into groups
  without lying about sign?
- SHAP values are per-instance; the Explain screen is per-day-per-subsystem.
  Aggregate across the 24 hours, or show the peak hour?
- **Domain rules** (§25) — what are they, and what happens when a rule and SHAP
  disagree? This is the part that is currently fog; the ticket may only be able
  to define the arbitration mechanism, leaving the rule content to a later pass.
- **The §26 boundary.** The product says "Diagnosis", never "Causal AI". Where
  does that wording get enforced — copy review, or a documented rule?
- **LLM renderer contract**: exact input JSON, the constraint that it may not
  introduce any fact not present in its input, the template fallback when the
  call fails, caching key, and which model. It renders; it never decides.

Use `/grilling`.

## Resolution

Spec: [`docs/specs/diagnosis.md`](../../docs/specs/diagnosis.md).

**SHAP explains the composed expectation `E[Y|x]`, attributed once as a single
function — not two attributions glued together.** It is the only published
scalar that is a genuine function of both hurdle stages, continuous in every
feature, denominated in MWh, and additive across hours. The composed *quantiles*
are explicitly ruled out as targets: `Q_Y` is piecewise with its branch selected
by `q ≤ 1 − p(x)`, so a feature that moves `p` across the boundary produces a
step and Shapley attributes the whole day to it. The two-attribution route is
refused as arithmetic rather than as taste: `g − g₀` carries a cross term
`(Σφ^p)(Σφ^m)` that does not decompose per feature, and every allocation rule
for it is invented and re-ranks the drivers on exactly the days that matter.

**Group first, then attribute.** The players are **eight feature groups**, not
two hundred features, so a group's contribution is a Shapley value *of the group
as a player* — there is no summing step in which a sign could be lost. That is
the whole answer to "aggregate without lying about sign", and it is why grouped
values are deliberately *not* the sum of member values (they coincide only where
the model is additive across the group boundary; a test pins the gap to the
interaction term). Grouping also collapses the game to `2⁸ = 256` coalitions,
which makes **exact** Shapley affordable, so the ranking carries no sampling
noise. Interventional value function against a background **matched on
`(subsystem, local_hour)`**, 128 rows per cell, frozen into the artifact — which
is what finally gives the screen's `typical` column a definition. The group map
is versioned YAML, hashed onto the model card, and a total partition of the
feature list enforced by a test.

**Aggregation: sum over the 24 hours, exactly.** Expectations add and quantiles
do not; Shapley is linear in the value function, so `Σ_t φ_{j,t}` *is* the
attribution of the day's expected MWh against a typical day's, with no averaging
rule to defend. Peak-hour-only is rejected because it would sit beside a
day-total figure it does not explain. The known cost — cancellation across hours
— is published as `hour_disagreement_j = Σ_t|φ| / |Σ_t φ|`, and the narration is
required to disclose it above 2.0. The peak hour's own attribution is returned
beside the day, never instead of it.

**Domain rules: the mechanism is decided, most of the content is deferred, and
that is stated.** A rule may `annotate`, `demote` or `withhold`; **no rule may
change a number** — not `p`, not the band, not a `φ`. When a rule and SHAP
disagree, **both are published and the narration must state both**; neither
wins, because a rule asserts a fact about the grid and a `φ` asserts a fact
about the model, and "resolving" them would convert one into the other. Strictest
action governs; every fired rule is recorded. Four rules ship, chosen because
none needs an invented constant: `nothing_to_explain`, `attribution_is_noise`
(against a bootstrapped `attribution_stderr_mwh`), `stale_inputs`, and
`unmodelled_outage_regime` (yesterday's curtailment was mostly `REL`, which the
forecaster already established no ingested dataset can see). Grid-physics rules
are deferred with a three-part reopening trigger: three point-in-time folds plus
the driver-stability report, ≥ 20 firing days, every predicate term an ingested
column, and no new `withhold` without separate review. The one-way valve is what
makes shipping the rules half-written safe rather than reckless.

**The §26 boundary is a documented rule with two automated enforcers**, not copy
review — because copy review works on strings that exist at review time and this
product generates a fresh sentence per request, per locale, per day. Enforcer 1
is a build-time forbidden-vocabulary test over `apps/web/src/**`,
`packages/ui/**`, the message catalogues and the system prompt, with an
allowlist that names each permitted occurrence and a reason (and fails when an
entry rots). Enforcer 2 is the runtime lexical validator on every generated
narration. Copy review is retained and is load-bearing for nothing.

**The LLM renderer contract** is fully specified: exact input JSON
(`diagnosis.narration.v1`, including pre-computed derived figures such as
`top_two_share` so that "the renderer may not compute" is obeyable); a
three-gate output validator — a **numeric whitelist** that rejects even a
*correctly derived* number absent from the input, the §26 lexical gate, and a
structural/locale gate; one retry, then a deterministic `t()`-interpolated
template fallback; cache key
`narration:v1:{prompt_version}:{model_id}:{locale}:{sha256(canonical(payload))}`
in Redis at 26 h, self-invalidating through `artifact_id` /
`driver_group_version` / run label, with a 5-minute TTL on cached template
fallbacks; and `claude-opus-5` at `effort: "low"`, non-streaming, structured
output, prompt-cached system block, **no tools**. ~16 calls/day, cents. The API
returns `narration.source` so the panel footnote can be true when the template
rendered. Narration is generated directly in the requested locale (the map's
settled exception); everything else stays codes.

**Contradictions found, not smoothed:**

1. **Per-technology drivers do not exist.** `forecaster.md` trains on the total
   and produces the technology split as a point split of `ŝ`; there is no
   per-technology head. `apps/web/src/app/app/explain.tsx` calls
   `buildExplain(subsystem, technology)` and the fixture returns different
   driver sets per technology. The attribution is per subsystem-day and the
   endpoint takes no `technology` parameter. **This is a prototype (014) defect,
   not a forecaster one.**
2. **`Driver.observed` / `typical` are preformatted display strings**
   (`"310 MW left"`, `"+1.4 GW YoY"`), which are translated strings by another
   name and violate the map's codes-not-strings rule. They become numbers plus a
   `unit` code.
3. **`Driver.share` semantics.** `domain.ts` documents it as "share of the total
   attributed magnitude"; with signed Shapley values the honest denominator is
   `Σ|φ|` over displayed rows, making it a share of **attributed movement**.
   Doc comment and the driver-bars footnote both need rewording.
4. **`Driver.direction` needs a third member, `"mixed"`**, for the one merge the
   design permits (the `other` row), labelled when
   `Σ|φ_members| > 1.5·|Σφ_members|`.
5. **The fixture narration computes** (`top.share + second.share`), which the
   renderer contract forbids; hence `top_two_share` in the payload.
6. **The Narration panel footnote asserts unconditionally** that a language
   model wrote the paragraph; false on template fallback.
7. **`forecaster.md` needs two additions** — the matched background sample in
   the artifact bundle, and `driver_group_version` / `driver_group_hash` /
   `headline_feature_check` on the card. Neither changes what it predicts.
   Without the background, "typical" is undefined and the attribution is not
   reproducible from the artifact alone.

No contradiction was found with `flex-optimizer.md`: it explains a dispatch
through its own dispatch stack and the two engines never share an explanation
surface. The optimizer's what-if remains a simulation under a fixed forecast,
which is not a counterfactual claim and is explicitly distinguished from the
causal claims §26 forbids.
