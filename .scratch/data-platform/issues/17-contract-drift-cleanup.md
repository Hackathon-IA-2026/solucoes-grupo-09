# 17 — Close the drift the contract had to work around

**What to build:** three upstream corrections that ticket 13 papered over in the
contract layer because fixing them properly would have rewritten code that ticket
did not own. Each is currently harmless and each is a place where two definitions
agree only by luck.

**1. Two field names disagree with the domain model.** The ingest layer has
`generationMwh` and `availabilityMw` where `docs/domain-model.md` §4 says
`verified_generation_mwh` and `available_capacity_mw`. The contract renames them
on the way out, so consumers see the right vocabulary and the repositories keep
the wrong one — which means the domain model is currently enforced at the edge
rather than at the source.

**2. `vintageFidelity` is implemented eight times.** Every `*-repository.ts`
computes it identically, and `src/contract/vintage.ts` now holds the canonical
implementation with golden vectors behind it. Nothing structurally stops the
eight from diverging from the one that is actually tested.

**3. `reporting_entity.kind` is not reachable from a curtailment row.** The
domain model makes `ReportingEntity` a sum type and requires screens to name the
grain, but a consumer must call the registry separately to learn whether a code
is a conjunto or a plant. Surfacing it needs a join to the dimension, which is
querying rather than composing — so it needs a decision about where that join
belongs, not just an edit.

**Blocked by:** 13 (merged). Item 3 may be affected by 16's transport decision.

**Status:** ready-for-agent

- [ ] The two fields are renamed at the source, and the contract's compensating rename is deleted
- [ ] The eight repositories call one `vintageFidelity`, and the duplicates are gone
- [ ] A curtailment consumer can tell a conjunto row from a plant row without a second call
