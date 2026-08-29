# 03 — One hour, eight signed numbers, and they add up exactly

**What to build:** the tracer bullet of the whole engine. For one subsystem and
one valid hour, produce eight signed contributions in MWh that say how far this
hour's **expected `constrained_off_mwh`** sits from a typical hour's, and why —
and prove they add up.

Three decisions are load-bearing and each is the failure mode this ticket exists
to prevent:

**The attributed quantity is the composed expectation and nothing else.**

```
g(x) = E[Y | x] = p(x)·Ê[Y | Y>τ, x] + (1 − p(x))·μ_sub(s, h)
```

It is the only published quantity that is a genuine function of both hurdle
stages, continuous in every feature, denominated in the product's own unit and
additive across hours. The occurrence probability explains half the model; the
magnitude booster answers a question the screen never asks; a composed quantile
is **piecewise** — a feature that moves the probability across the branch
boundary produces a jump from zero, and Shapley values of a step function hand
the whole day to whichever feature crossed it.

**Composition happens before attribution, never after.** Attributing the two
stages separately and gluing them is refused as arithmetic, not as taste: with
`a = p`, `b = m − μ`,

```
g − g₀ = b₀·Σⱼ φ^p_j + a₀·Σⱼ φ^m_j + (Σⱼ φ^p_j)(Σⱼ φ^m_j)
```

The third term is a scalar product of two sums and **does not decompose per
feature**. Every rule for splitting it is invented, the rules disagree about the
ranking, and they disagree most on exactly the interesting days — those where
one condition raises both the chance and the size. Attributing `g` as one
function creates no cross term to allocate.

**The players are the eight groups, not the two hundred features.** A group's
contribution is a Shapley value of the group *as a player*, so there is no
aggregation step in which a sign could be lost. Eight players is 256 coalitions,
so the values are **exact** and the ranking carries no sampling noise.

```
v(S) = (1/|B|) · Σ_{b ∈ B(s,h)} g( x[S] ⊕ b[S̄] )        for S ⊆ {1..8}
φ_j  = Σ_{S ⊆ N\{j}} (|S|!·(8−|S|−1)!/8!)·[ v(S∪{j}) − v(S) ]
```

The value function is **interventional (marginal), not path-dependent**: this
feature vector is saturated with correlation by construction, and the
path-dependent estimator credits features the model does not read. The
interventional form answers "what does the model do when this group is replaced
by a typical one", which is the question the screen's observed-versus-typical
framing already asks.

`g` is evaluated by **importing the forecaster's own composition function**, not
by re-implementing the product. The explained quantity and the served quantity
cannot be allowed to drift apart.

This runs offline, batched, once per publication — never in an HTTP request.

**Blocked by:** 02. Also **forecaster** (cross-spec, external): this ticket
needs the forecaster's single composition function and the **matched background
sample** `B(s, h)` — 128 rows per `(subsystem, local_hour)` cell, drawn once
from the base-fit block with a stamped seed and shipped in the artifact bundle.
That sample is one of exactly two additions this spec asks the forecaster for
and it is a hand-back, not work to be done here. Until it lands, build against a
seeded fixture background of the same shape.

**Status:** ready-for-agent

- [ ] Eight signed contributions in MWh are produced for one `(subsystem, valid_time)`
- [ ] The attributed scalar is the composed expectation, evaluated through the forecaster's composition function rather than a local copy
- [ ] The Shapley enumeration is exact over 256 coalitions, with no sampling in the ranking
- [ ] The value function is interventional against the matched background, and the background is the artifact's, not one drawn at attribution time
- [ ] Local accuracy holds exactly: the eight contributions sum to `g(x) − v(∅)`, asserted to floating-point tolerance
- [ ] The property holds for random feature vectors, for `p = 0`, for `p = 1` and at the isotonic clip endpoints
- [ ] Nothing in the module sums member-level values into a group value, and a structural test says so
- [ ] It is published — in the payload and in the docs — that the attribution explains the expectation and not the band
- [ ] The wall-clock cost for one instance is recorded, so the publication budget can be argued about with a number
