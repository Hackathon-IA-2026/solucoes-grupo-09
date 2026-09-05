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

**Status:** done

- [x] A replay day carries its provenance and what held it out, and carries neither of the two replaced fields
- [x] The in-sample branch is deleted, not disabled
- [x] The replay day band is read from the contract and is not a sum of hourly quantiles
- [x] A test asserts no web code path sums two bands componentwise
- [x] The landing hero's forecast origin names WattSteer as the producer
- [x] The weather run label is a separate field and is rendered as one
- [x] Both facts are visible on the panel; neither replaces the other

---

## Found while implementing

**The landing half was already done, by product-fixes 01.** That ticket's own
checklist claims "The forecast origin names WattSteer, not the weather
provider", and it landed the second field with it: `FORECAST_ORIGIN` already
carried `producer: "wattsteer"` plus `weatherRunLabel`, the hero already
printed both, and `landing-band.test.ts` already asserted the producer. So the
last three boxes were ticked on arrival. This ticket says the landing origin
fix "should land after [product-fixes 01] or with it"; in fact 01 subsumed it.
What was **not** done, and is done here, is the same conflation in the *app*
fixtures: `FORECAST_ORIGINS` and the replay day both carried
`runLabel: "hurdle-v0.4 · weather 12Z"` — one string naming two artifacts —
and `ForecastStamp` had no weather-run clause to render. Contract change 6 is
a rule about `ForecastOrigin`, not about one panel, and it now holds on every
surface in the web app.

**`held_out_by` is nullable, and the checklist wording hides that.** Replay 02
says "the result carries `provenance` and `held_out_by` naming the fold, the
artifact id and both windows", but `packages/core`'s generated
`ReplayIntegrity.heldOutBy` is `ReplayIntegrityHeldOutBy | null` and
`ReplayIntegrityHeldOutBy.fold` is a non-nullable string. A `served` day has no
fold: its forecast was published before the day happened, which is a stronger
statement than being held out and has no fold id to make it. So `served` ⇒
`heldOutBy === null` here, asserted as a property, and the screen renders a
different sentence for it. If replay meant every day to name a fold, the
generated type is the thing that is wrong.

**The replay day band was still a sum, with a stale comment vouching for it.**
`jointDayBand` summed the 24 hourly P10s/P50s/P90s and shrank the interval by
a hand-picked 0.62, over a comment saying that factor was "the same one
`grid.ts` uses". `grid.ts` had already moved to a drawn path ensemble and used
no such factor, so the comment was vouching for a number that no longer existed
anywhere else. The two fixtures now share one `ensemble.ts`, and the day total
is drawn.

**`p10` is not always above the componentwise sum.** The obvious assertion —
a joint band is narrower on both ends — is false under an hourly hurdle: a
drawn day whose common level runs low switches several episode hours off
entirely, which no componentwise P10 can express. The web test therefore
asserts the *inequality* and only the P90's direction, matching the reasoning
already recorded in the Overview's equivalent test.

**Out of scope, and left alone deliberately.** `app/mitigate.tsx` prints
`previous.remaining.p50 - step.remaining.p50` as a delta between two scenarios
of the same day. That is a difference of two medians, not a constructed band,
so `test/no-summed-bands.test.ts` does not match it — the guard forbids
*summing* bands, as this ticket words it. It belongs to a ticket that owns the
Mitigate screen.
