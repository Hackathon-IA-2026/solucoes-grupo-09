# 16 — The canonical contract becomes SQL views

**What to build:** move the canonical read contract from TypeScript into SQL
views, so that "the ML service reads Postgres directly" and "there is exactly one
definition of a canonical read" can both be true.

Ticket 13 said "compose the repositories, do not re-query". That is right — it is
what stops ONS's conventions being reimplemented on the Python side. But a
TypeScript module composing TypeScript functions is not something Python can
consume, so the contract was put behind HTTP at `/v1/canonical/*`.

That inverts the documented direction. `docs/specs/api-surface.md` has the
gateway calling the ML service, and has the ML service reading Postgres directly
on a read-only role; `docs/specs/feature-engineering.md` has it calling a SQL
feature function. Ticket 13's shape has the ML service calling the gateway
instead. All three cannot be true.

Nothing had committed to an answer when this was written:
`apps/ml/src/wattsteer_ml/canonical.py` carries the vocabulary and builds URLs
but adds no HTTP dependency. That is why it was cheap to settle.

**Decided: option 3 — the contract becomes SQL views, and Python reads Postgres
directly.** The two rejected options and why:

1. *ML calls the gateway over HTTP* — puts a ~37M-row plant-detail training read
   through JSON, and makes `ml → api → ml` a dependency cycle in Railway.
2. *ML re-queries the base tables* — puts the renames and the vintage rule in two
   languages, which is the drift the contract exists to prevent.

Option 3 is the only one where "one definition" is structural rather than
maintained, and it is the same choice `feature-engineering.md` already made one
layer up: one SQL function, living "with the schema authority", with Python
performing no windowed or joined computation of its own. A contract in TypeScript
would have that feature function reaching through a network call to read its own
inputs.

**Scope boundary — not everything becomes a view.** The views own the *row
vocabulary*: renames, grain, unit and timestamp resolution, and the vintage
columns. `vintageFidelity` stays a pure function duplicated in both languages,
because it is two timestamps and an inequality with golden vectors already
binding the two sides. Duplicating that is safe in a way duplicating row-shaping
SQL is not.

**Also in scope, because this ticket rewrites the same code** (folded in from
what was ticket 017):

- The ingest layer names `generationMwh` and `availabilityMw` where
  `docs/domain-model.md` §4 says `verified_generation_mwh` and
  `available_capacity_mw`. Ticket 013 renamed them *in the contract*, so the
  domain model is currently enforced at the edge rather than at the source. The
  views make that compensating rename unnecessary — delete it and fix the source.
- `vintageFidelity` is implemented identically in eight `*-repository.ts` files
  alongside the one that is actually tested. Collapse them onto
  `contract/vintage.ts`.
- `reporting_entity.kind` (`CONJUNTO` | `PLANT`) is not reachable from a
  curtailment row, so a consumer cannot tell the grain without a second call. A
  view is the natural place for that join — it was out of reach before only
  because `reads.ts` composes rather than queries.

**Blocked by:** 13 (merged).

**Status:** ready-for-agent

- [ ] The canonical reads are SQL views, shipped as a migration, owning the row vocabulary
- [ ] `contract/reads.ts` becomes a thin caller over the views; the composing logic and its compensating renames are gone
- [ ] `apps/ml` reads the views directly on its read-only role, and adds no HTTP client
- [ ] `/v1/canonical/*` still serves, for the web app and debugging, from the same views
- [ ] The golden vectors still bind both languages, and `vintageFidelity` stays the one duplicated-by-design piece
- [ ] The two drifted field names are corrected at the source
- [ ] The eight duplicate `vintageFidelity` implementations are gone
- [ ] A curtailment consumer can tell a conjunto row from a plant row without a second call
- [ ] `api-surface.md` and `feature-engineering.md` agree with what was built
