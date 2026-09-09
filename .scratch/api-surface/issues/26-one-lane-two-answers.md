# 26 — Two endpoints answer differently about one lane, and it may be correct

**What to build:** an answer to whether this is a divergence or two vocabularies,
and legibility either way.

Forecaster 26 reported: `/v1/model/card` returns `lane_state: "unresolvable"` for
a contract-faulted card, while `artifacts.inspect()` reports the same lane
`promoted`. It declined to pick a side because `LANE_STATES` is
spec-authoritative, and added serviceability facts *beside* the state instead.

**Before treating this as a bug, read both definitions — I did, and they may both
be right.** `packages/core`'s `LANE_STATES` has **three** members and `promoted`
is deliberately not among them, with the reasoning written out: it "is absent
here because it is not an absence — a lane with a promoted artifact has something
to serve and never reaches this envelope", and the other three "are all reasons a
request found nothing". Meanwhile `artifacts.py`'s `LaneState` has **four**,
saying "the first three are the spec's three; see the module docstring for why
there is a fourth".

So one is an **error-envelope** vocabulary and the other an **inspection**
vocabulary, each documented. On that reading `/v1/model/card` — a 503 envelope —
has no word but `unresolvable` available, and inspection is right that the
promotion line exists. Two questions, two answers, both true.

If that reading holds, the defect is **legibility, not correctness**: nothing
tells a reader the two vocabularies are different, and the same field name
`lane_state` carries both. Say so where both are defined, and consider whether
the inspection vocabulary should stop sharing the name.

If it does **not** hold — if a caller can be misled in a way the serviceability
fields do not already cover — fix it, and say what the misleading case is.

Also here, small and pre-existing: `MetaLane` declares `trained_through` and
`vintage_fidelity`, and `apps/api/src/api/meta.ts`'s `toLane` populates neither.
Either populate them or remove them; a declared field nothing fills is a promise
the schema makes and the code breaks.

**Blocked by:** forecaster 26 (merged).

**Status:** ready-for-agent

- [ ] Whether the two answers are a divergence or two vocabularies is settled
      with both definitions quoted
- [ ] If two vocabularies: both definitions say so, and the shared field name is
      reconsidered
- [ ] If a divergence: fixed, with the misleading case named
- [ ] `MetaLane`'s two dead fields are populated or removed
- [ ] `LANE_STATES` keeps its three members unless a spec change is argued
