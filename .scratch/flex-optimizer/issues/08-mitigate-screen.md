# 08 — The Mitigate screen: one plan, one promise, and the rule that makes it honest

**What to build:** an operator opens Mitigate, describes a fleet, and sees an
hour-by-hour plan with the battery's state of charge drawn alongside it, a floor
they can quote to someone else, and one sentence explaining why planning against a
median is not the same as assuming the median comes true. The URL is the scenario;
the back button and a bookmark work.

The basis toggle comes out. It was the right question asked in the wrong place —
the screen was refusing to hide a modelling choice from the user, but the choice it
exposed was not a preference, it was a defect in the framing. What replaces it is
the execution-rule sentence: **the assets absorb what is actually curtailed, never
more.** Without that sentence "planned against P50" gets read as "assumes P50 comes
true", which is exactly the misreading ticket 07's posture depends on not happening.

What the screen must get right:

- **The floor is what the prose says; the band is what the chart draws.**
  `recovered_floor_mwh` is the number in the sentence, with the median and high
  realisations shown next to it so a conservative promise does not hide the upside.
- **The avoidability band's *worst* value sits at P90**, because a fixed fleet
  covering a bigger event covers a smaller share of it. That arithmetic should be
  visible rather than surprising.
- **`—`, never `0 %`**, on a day with nothing to avoid, with the "undefined, not
  zero" explanation — a zero reads as "nothing could be avoided".
- **An hour-wise P10 profile is not a 90 % confidence statement about the day**, and
  the screen says so. Quantiles do not add.
- **R$ is a labelled scenario with its assumed R$/MWh on screen**, and moving it
  moves only the money.
- **`stored_at_horizon_end_mwh` and `round_trip_loss_mwh` are shown**, because
  "recovered" is not "delivered": absorbed energy is metered at the grid boundary,
  and what the asset later delivers is smaller by the round-trip loss with some of
  it still in the battery when the horizon ends.
- **No carbon claim.** Nothing in `OptimizationResult` supports one and none is
  offered.

Every error code from ticket 04 renders bilingually at this layer, per the i18n
spec; the API returns codes and the screen owns the strings.

**Blocked by:** 03, 07.

**Status:** done

- [ ] The basis toggle is removed and the execution-rule sentence is on screen
- [ ] Hour-by-hour dispatch per asset, with the battery's state of charge drawn alongside, labelled as the **scheduled** plan on the planning envelope
- [ ] The floor is the number in the prose; P50 and P90 are shown beside it and are not the headline
- [ ] Avoidability renders `—` with its explanation when the ratio is undefined
- [ ] The screen states that the hour-wise P10 floor is not a day-level confidence statement
- [ ] Changing the assumed R$/MWh changes only the money on screen
- [ ] `stored_at_horizon_end_mwh` and `round_trip_loss_mwh` are visible, not buried
- [ ] A scenario URL survives a round trip through the browser and returns a byte-identical plan; the back button and a bookmark work
- [ ] A slider drag is debounced client-side and hits the cache
- [ ] The Mitigate default fleet is `REFERENCE_FLEET` from `packages/core`, in its corrected form, and is not restated locally
- [ ] Every validation code renders in both locales; no translated string arrives from the API
