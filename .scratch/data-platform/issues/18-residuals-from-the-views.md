# 18 — Close the residuals the canonical views left behind

**What to build:** three small inconsistencies that landed deliberately, each
because closing it at the time would have collided with a concurrent agent.
Each is currently harmless and each is a place where one fact has two shapes.

**1. `subsystem` is on the view but not in the contract's vocabulary.**
Ticket feature-engineering 01 added `subsystem` to
`canonical_curtailment_by_reporting_entity`, taken from the `reporting_entity`
join the view already makes — the label is defined at subsystem grain and the
alternative was a second path to the base tables. But it was deliberately *not*
added to `CurtailmentObservation`, to `contract/reads.ts`'s mapping, or to
Python's `FILTERABLE`. So the column exists, is correct, and is invisible to
both consumers.

**2. `readPlantCapacityAsOf` is still a third path to the base tables.**
Ticket 16 moved the eight canonical reads and the nine ingest `readXAsOf`
functions onto the views, but per-plant capacity is not in the manifest, so it
keeps its own `DISTINCT ON` over `generating_unit` in `registry-repository.ts`.
That is the pattern the views exist to eliminate, surviving in one place because
the manifest does not name it. Either the manifest should name it, or the
exception should be documented where a reader of `registry-repository.ts` will
see it — not left as an unexplained second implementation.

**3. `apps/ml` has no database test harness.** `canonical_reads.py` was verified
by hand against a live container and its SQL is not covered by any automated
test; the same is true of the Python feature caller. `database-contract.test.ts`
is the shape to mirror. Until this exists, every Python read is one refactor away
from silently breaking with a green suite.

**4. There are now two haversines, and the second is in SQL.**
Feature-engineering 08 needed capacity weighting inside a plpgsql feature
function. It could not call `apps/api/src/features/capacity-weights.ts`, and
`centroid_point` is on the forbidden-ingest-table list, so the alternatives were
a second implementation or no weighting in the feature layer at all. It wrote
the SQL one, bound it to the TypeScript authority with a parity test, and
refused to describe it as reuse — which is the right disclosure and still leaves
two implementations of one formula.

The parity test is what makes this tolerable rather than fine. Worth deciding:
either the SQL becomes the authority and `capacity-weights.ts` calls the view,
or the duplication is accepted and the parity test is made a named,
hard-to-delete fixture rather than an ordinary assertion.

**Blocked by:** 16 (merged), feature-engineering 01 (merged).

**Status:** ready-for-agent

- [ ] `subsystem` is either exposed through the contract's types and filters in both languages, or removed from the view with the reason recorded
- [ ] Per-plant capacity either joins the manifest or carries a written exception at its definition
- [ ] `apps/ml` has a gated Postgres suite covering the canonical reads and the feature caller, mirroring `database-contract.test.ts`
- [ ] The gated Python suite runs in the same throwaway-container flow the TypeScript one uses
- [ ] The two haversines are either reduced to one, or the parity binding them is made explicit and hard to delete
