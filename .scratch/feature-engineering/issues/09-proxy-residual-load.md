# 09 — Residual load, rebuilt for the DESSEM-free set

**What to build:** the DESSEM-free feature row carries a residual load — the
single most physically meaningful quantity in this domain, because it is what
curtailment *is* — reconstructed entirely from inputs that genuinely exist at
D−1, together with the ratios, the surplus, the ramp, the day minimum and the
in-day rank derived from it.

The original feature list asked for load minus solar minus wind at the target
hour. Every term is a day-D actual, and the product forecasts at D−1. The
correct move is neither to leak it nor to drop it: it is rebuilt from ONS's own
day-ahead programme minus the deterministic conversion of the pinned weather run
scaled by installed capacity at the gate's vintage. Class **`P`+`W`+`T`** — no
term in it is an actual, and no term in it is a model.

This is worth stating plainly because it changes what the feature *means*: a
residual load built from a day-ahead programme and a pinned run is a **forecast**
of the oversupply condition, where the original is a **description** of it after
the fact. A day-ahead product should be conditioning on the former.

It is the most important feature in the DESSEM-free set and the reason that set
is worth training at all.

Nothing here introduces a model inside a model. Both conversions are
deterministic and already fixed by 08, so the reconstruction is identical in
training and in serving by construction rather than by care.

**Blocked by:** 06 — ONS day-ahead programming. 08 — the weather block.

**Status:** done

- [ ] Proxy residual load is programmed load minus expected wind minus expected solar, all at the gate
- [ ] The residual-load ratio, the renewable load ratio and the VRE surplus are derived from the same three terms
- [ ] The ramp within the day-D proxy profile, the day's minimum and the hour's rank in the day are derived from the reconstructed profile
- [ ] No term is a day-D actual, and no term is a model output; the classification of every input is recorded at the feature
- [ ] The features are non-null across the full DESSEM-free window
- [ ] Where the augmented set has both, the proxy family and the DESSEM family are both retained, so the two views of residual load are comparable
- [ ] Seams 1 and 2 still pass with these features present
