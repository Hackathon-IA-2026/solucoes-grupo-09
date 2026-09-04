# 22 — The national day grain has nowhere to be written

**What to build:** a persisted row grain for the national day figure, and the
publication path that writes it, so `/v1/grid/outlook` can serve a national band
instead of `null`.

This is the second half of the hand-back api-surface 13 was blocked on, and it
is recorded here because the first half is already done and the second half is
what still stands between a correct computation and a screen.

**What exists.** Ticket 08 built the joint band and it is right:
`apps/ml/src/wattsteer_ml/training/national.py` adds the four subsystems' day
totals **on the same draw**, takes peak-of-sum rather than sum-of-peaks, and
counts occurrence over draws. Measured, it comes out roughly half the width of
the componentwise sum — which is the whole point, and is what a real joint
distribution buys over an assumption of comonotonicity.

**What does not exist.** A table. Ticket 14 said so directly:
`NationalDayGrain.as_row()` has no destination, because `SIN` is not a
`Subsystem` and the national grain therefore cannot borrow
`curtailment_forecast_day`'s key. Making it a fifth row of that table is exactly
the shape `docs/domain-model.md`'s vocabulary rule 6 forbids, and it is the
reason the national figure lives under its own key on the wire rather than as a
fifth array member.

**What the gateway does until then.** `/v1/grid/outlook` serves
`national.expected_mwh` — the sum of the four expectations, which adds *exactly*
— with `band: null` and `band_unavailable_reason: "no_joint_ensemble"`.
`apps/api/src/api/grid.ts` has no arithmetic that could produce a national band,
and `apps/api/test/grid-outlook.test.ts` asserts that the national figure is not
a componentwise sum of the four medians. Synthesising a national band by summing
quantiles is the defect this whole thread exists to remove; it must not be the
fix for this ticket either.

**The shape of the work:**

1. A `curtailment_forecast_national_day` grain, keyed on
   `(target_date, gate_profile, origin_kind, threshold_mw)` with the same
   append-only `data_version` vintage discipline the subsystem grain has, and
   the same `published_at < valid_time` and monotone-band constraints.
2. `NationalDayGrain.as_row()` writes into it, and the publication payload
   carries a `national` block beside `days` and `hours`.
3. `parsePublication` refuses a national block whose `derivation` is not the
   shared-draw ensemble — the same refusal `days` already gets for
   `sum_of_hourly_band`.
4. `readGridOutlook` reads the national row at the same `AsOf` as the four
   subsystem rows, and `toGridOutlook` publishes the band with
   `band_unavailable_reason: null` when it is there. The `null` branch stays:
   an artifact trained before the shared draw index landed has no national row,
   and that is still an absence with a stated reason rather than a zero.

**Blocked by:** 08, 14.

**Status:** ready-for-agent

- [ ] The national day grain has its own table, and `SIN` is not a value of
      `subsystem_code` anywhere in it
- [ ] The national row is append-only and readable through `AsOf`, returning
      exactly the numbers that were served
- [ ] The publication writes the national row in the same transaction as the
      four subsystem rows, so a partial write is not a state
- [ ] `parsePublication` refuses a national figure that was not drawn from the
      shared-index ensemble
- [ ] `/v1/grid/outlook` serves `national.band` with
      `band_unavailable_reason: null` when the row exists, and keeps the
      `null` + `no_joint_ensemble` branch for artifacts that have no national row
- [ ] A test asserts the served national band is strictly narrower than the
      componentwise sum of the four subsystem bands
- [ ] No route, read or view synthesises a national band by summing quantiles
