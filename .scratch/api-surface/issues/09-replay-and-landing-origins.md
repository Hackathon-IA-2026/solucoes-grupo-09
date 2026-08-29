# 09 — A replay day says how it was held out, and the landing hero names the right producer

**What to build:** contract changes 6 and 7 — the two that live outside the
Explain screen and that no upstream ticket claimed as contract work.

**The replay day.** `inTrainingWindow` and `modelTrainedThrough` become
`provenance: "served" | "fold_holdout"` plus the identity of what held it out.
The in-sample branch on the Time Machine screen becomes **unreachable and is
deleted** rather than left as dead code, and the day band stops being the sum of
the hourly quantiles and reads the day total from the contract — quantiles do
not add, and this is the last place in the web app that adds them.

**The landing hero's forecast origin.** The landing fixtures stamp a curtailment
forecast with `producer: "open_meteo"`. That names the **weather** run, not the
forecast: a WattSteer curtailment forecast has producer `wattsteer` and a run
label that is the artifact version. Both facts belong on the screen, which is
why the outlook endpoint returns a **separate weather run label** beside the
WattSteer origin rather than making the screen choose one.

The national headline on the same panel is **not** this ticket — it is already
claimed by the product-fixes ticket set, which owns the expected-MWh headline and
the null national band. This ticket only fixes the producer identity and adds the
second field the outlook endpoint supplies.

**Blocked by:** 03. Cross-spec: the replay contract's field names are
**replay**'s, fixed there; this ticket adopts them. The landing origin fix
touches the same panel as **product-fixes 01** and should land after it or with
it, to avoid two edits fighting over one component.

**Status:** ready-for-agent

- [ ] A replay day carries its provenance and what held it out, and carries neither of the two replaced fields
- [ ] The in-sample branch is deleted, not disabled
- [ ] The replay day band is read from the contract and is not a sum of hourly quantiles
- [ ] A test asserts no web code path sums two bands componentwise
- [ ] The landing hero's forecast origin names WattSteer as the producer
- [ ] The weather run label is a separate field and is rendered as one
- [ ] Both facts are visible on the panel; neither replaces the other
