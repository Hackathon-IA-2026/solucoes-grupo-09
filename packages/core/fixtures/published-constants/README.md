# The published constants — cross-language golden vector

`constants.json` is **data, and it is the contract**. Two implementations are
asserted against it, and neither is asserted against the other:

| Side | Implementation | Test |
|---|---|---|
| TypeScript | `packages/core/src/constants.ts`, `src/domain.ts` | `packages/core/test/published-constants.test.ts` |
| Python | `apps/ml/src/wattsteer_ml/constants.py` | `apps/ml/tests/test_published_constants.py` |

Same shape and same four properties as the sibling
[`../canonical-contract/`](../canonical-contract/README.md), which this extends
rather than duplicates: one shared table, each side asserted against `expected`
so a shared misunderstanding cannot cancel out, and deliberate asymmetries kept
in their own block.

**Why a vector at all, for six numbers.** `packages/core` is TypeScript and the
optimizer is Python. `docs/specs/flex-optimizer.md` calls the R$/MWh assumption
"the single place it is written down", and it was — in a package one of the two
languages that quote it could not read. Every value here is quoted by both. A
vector is the only form of "one definition" that survives a language boundary,
short of code generation.

## What is pinned

- `defaults` — the two `curtailment_threshold_mw` defaults (5 MW at subsystem
  grain, 1 MW at reporting-entity grain), `max_gap_hours` (0, so one
  sub-threshold hour ends an episode) and `brl_per_mwh` (180, a labelled
  scenario input and never a market price). These are the same four figures
  `GET /v1/meta` echoes under `defaults`.
- `subsystems` — the four members with ONS's display names, **in display
  order**. The order is pinned because it is the order the screens render and
  the order `/v1/meta` reports; a reshuffle should be a decision, not a diff.
- `technologies` — the members **and their casing**. `WIND` / `SOLAR`, uppercase
  on the wire and in the `technology` query parameter, case-sensitively; see the
  `Technology` doc comment in `packages/core/src/domain.ts` for why, and note
  that this file is what stops one language relaxing it alone.
- `reference_fleet` — the one published battery and the one published flexible
  load, in the wire's `snake_case`. Every side additionally asserts the two
  validity rules the fleet must satisfy (`max_shift_mw ≤ max_power_mw` and
  `max_shift_mw ≤ daily_energy_mwh / 24`), because a fleet that fails the
  optimizer's own validation is not a publishable default.

`SIN` appears nowhere here and must not: it is ONS's national aggregate, not a
fifth subsystem.
