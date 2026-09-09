# 27 — The private absences are invisible to the census built for them

**What to build:** the rest of the declined-figures set, which forecaster 25
discovered is roughly twice the size of the list I gave it.

Forecaster 25 put the census on `/v1/meta`, derived by walking the package so a
new reason appears with no list edited. I specified eight absences. It
implemented those and reported that **a whole parallel family is private and
therefore invisible** to the surface built to show it:

* six `_NOTHING_YET` constants — `lead_time`, `dessem_ab`,
  `transformer_benchmark`, `threshold_sweep`, `planning_arms`, `collapse_report`
* `_NO_DECIDING_FOLD`, which has its own `no_verdict_reason` wire field
* two fully anonymous inline `*_absent_reason` sentences in `training/bundle.py`
* four anonymous absence details in `replay/floor_guardrail.py`
* `NOT_ACHIEVABLE_COLUMN` — an identity-shaped sibling of `no_joint_ensemble`
* `metrics_absent_reason`, which the **gateway** mints in TypeScript rather than
  forwarding from the modelling service

Each is honest where it stands. Collectively they defeat the point of the census:
a reviewer reading `/v1/meta` sees eight refusals and concludes that is the set,
when it is about half.

**The mechanism already exists** — give each a `DeclinedFigure` and it appears,
with no list edited. `DeclinedFigure` subclasses `str`, so naming a constant
moves no call site: `block["reason"] == NAME` and `json.dumps` keep working.
That property was built for exactly this ticket, and it is worth confirming it
holds rather than assuming.

The gateway-minted `metrics_absent_reason` is the odd one and needs a decision
rather than a rename: a reason authored in TypeScript cannot be discovered by a
Python walk. Either it moves to where the withholding happens, or the gateway
half of the census gains it the way `BAND_UNAVAILABLE_DECLINES` was gained — as a
typed table where a missing entry is a compile error.

**Blocked by:** forecaster 25 (merged).

**Status:** done

- [ ] Every absence listed above is either named and on the census, or has a
      stated reason for staying private
- [ ] No call site changed behaviour — the `str` subclass property is verified,
      not assumed
- [ ] The `kind` binary still holds; anything that fits neither is reported
      rather than forced into one
- [ ] Adding one still edits no list, demonstrated
- [ ] `_NOT_A_READING` stays **out** — a published figure that means nothing is a
      caveat, not an absence (see forecaster 28)
