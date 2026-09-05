# 05 — Vintage is a second, different honesty axis — and it gets measured

**What to build:** a replayed day states, separately from its provenance, whether the
"actual" it was scored against is what ONS published at the time or what ONS says
today — and it names exactly which parts of the replay that touches, rather than
shrugging at the whole screen.

**The two axes stay separate because today they coincide and in two months they will
not.** In-sample-ness is about the *model's* information set and is fixed by
construction in ticket 02. Vintage is about the *data's* information set and is
permanent — ONS restates history in place, under the same filenames, with no version
marker, so for any day before ingestion go-live there is no true point-in-time view
and no amount of engineering will ever create one.

| | In-sample | Vintage |
|---|---|---|
| About | the **model's** information set | the **data's** information set |
| Cause | training window overlaps the day | ONS rewrote history before we were watching |
| Fixable | **yes** — by choosing the artifact | **never**, for any day before go-live |
| Remedy | a precondition | a label, plus a measurement |

In v1 every `fold_holdout` day is also `revision_optimistic` and every `served` day is
also `point_in_time`, so a single merged badge would be indistinguishable from the
right answer *right now* — and wrong the moment F7 opens on a post-go-live quarter.
`served` + `revision_optimistic` is impossible by definition;
`fold_holdout` + `point_in_time` becomes populated as soon as it does. A merged
indicator would be observationally correct now and wrong later, which is the worst
available failure mode, because it would be discovered by a user.

**What `revision_optimistic` actually touches**, so the caveat is proportionate:

- **Weather is genuinely point-in-time on both sides of go-live** — a weather row
  carries the run initialisation as `published_at`, so the D−1 12Z run the replay
  planned against *is* the D−1 12Z run. Exempt.
- **DESSEM and the ONS programming: likewise.** Forecast-sourced, cut on
  `published_at`. Exempt.
- **Lagged-actual features are the right hours with possibly the wrong values.**
  Affected.
- **The label — the "actual" the replay is scored against — is today's restatement.**
  Affected, and it is the denominator of the headline percentage.

**The caveat gets measured, in Replay's own currency**, mirroring the forecaster's
`revision_premium_qloss`:

```
revision_premium_recovered_mwh
  = mean over post-go-live days d of
      recovered(plan_d, a_d @ AsOf(published_at_d + 48h))
    − recovered(plan_d, a_d @ AsOf(now))
```

It is computable only after go-live, only once ONS has actually restated days we hold
both vintages of. Until then the field is `null` and the screen says the caveat is
**unmeasured**, in that word, rather than implying it is small.

**Blocked by:** 03. **Cross-spec, external: Forecaster 03** (each fold carries a
`VintageFidelity`, and a fold straddling go-live is split at that date).

**Status:** done

- [ ] `integrity.vintage_fidelity` is stamped from the day's position relative to ingestion go-live, independently of `provenance`
- [ ] `vintage_affects` names `settled_actuals` and `lagged_actual_features`; `vintage_exempt` names `weather_run`, `dessem` and `ons_programming`
- [ ] A pre-go-live date is stamped `revision_optimistic` with exactly those lists — asserted, not hand-written on the screen
- [ ] Provenance and fidelity are two fields and no code path derives one from the other
- [ ] `revision_premium_recovered_mwh` is `null` until it is computable, and `null` renders as "unmeasured", never as zero or as a small number
- [ ] The computation exists and is exercised against a fixture holding two vintages of the same day, so it works the day real data allows it
