# 13 — One call for the hero, and a national number that survives aggregation

**What to build:** the landing hero and the Overview's first paint make **one**
request and get all four subsystems' day-ahead outlook: the risk class and its
bins, the day band, the peak-power band, the expectation, the scalar split, the
forecast origin, and a national figure.

No hourly detail and no drivers — those are the day-ahead and diagnosis routes.

**The national figure is the largest product consequence in this spec.** The
hero today renders a national band whose P50 is the componentwise sum of four
subsystem P50s. Its own note concedes that "nothing else sums", which is the
right instinct applied one notch too late: **medians do not add either.** The
median of a sum is the sum of the medians only when the components move together,
and four subsystems' curtailment does not.

What can be published honestly with the machinery that exists:

| Quantity | Additive across subsystems? |
|---|---|
| the expectation | **Yes, exactly.** Expectations add. |
| observed constrained-off energy | Yes, exactly. |
| a national band | No — needs a joint distribution |
| a national median | No |
| a national day-occurrence probability | No |

**So the national figure is the expected MWh plus a count of subsystems per risk
class.** The band is `null` and carries the reason `no_joint_ensemble`. The four
subsystem bands stay, drawn on a shared scale, which is where a band belongs.

**The upgrade is nearly free and is handed back, not built here.** The path
ensemble already draws whole day-rows of the PIT matrix, which is what preserves
intra-day dependence. Sharing the drawn day-row index across all four subsystems
within a draw preserves cross-subsystem dependence by exactly the same argument,
and a legitimate national band falls out of the existing draws with no copula and
no new parameter. That is one line in the forecaster's draw loop and one more
persisted row grain.

**The weather run label rides beside the WattSteer origin**, because the screen
renders "D−1 12Z" from a run label while the WattSteer origin's run label is the
artifact version. Two facts, two fields, so the screen never has to choose.

**Blocked by:** 04, 10. The UI half of the national headline is owned by
**product-fixes 01**, which is already sliced; this ticket supplies the payload it
renders and must not re-specify the copy.

**Status:** ready-for-agent

- [ ] One request returns all four subsystems' outlook plus the shared origin, threshold and risk bins
- [ ] The national figure is the summed expectation plus a count of subsystems per risk class
- [ ] The national band is null and carries a machine-readable reason
- [ ] A test asserts the national figure is not a componentwise sum of medians
- [ ] The weather run label and the WattSteer run label are separate fields
- [ ] The origin-kind filter applies here exactly as on the day-ahead route
- [ ] The hand-back is recorded on the forecaster ticket set: share the ensemble draw index across subsystems, and persist a national row grain
