# The validation table — cross-language golden vectors

These files are **data, and they are the contract**. Three implementations read
them and each asserts *its own* behaviour against the expected code:

| Side | Implementation | Test |
|---|---|---|
| TypeScript | `packages/core/src/scenario-validation.ts` | `packages/core/test/scenario-validation.test.ts` |
| Python | `apps/ml/src/wattsteer_ml/scenario_validation.py` | `apps/ml/tests/test_scenario_validation.py` |
| The gateway | `apps/api/src/api/scenario-gate.ts` | `apps/api/test/scenario-gate.test.ts` |

Same shape and the same properties as the sibling
[`../scenario-canonical/`](../scenario-canonical/README.md), which this
directory is the promised other half of: that one holds the refusals that make
the *bytes* unreadable, this one holds the table that decides whether the bytes
describe a fleet. Every suite additionally fails when the directory contains a
file it did not enumerate, so **adding a vector here is sufficient** — no
language can quietly skip one.

## The property, which is not "validation works"

`docs/specs/flex-optimizer.md`: **nothing is coerced.** An initial state of
charge outside its own bounds is a `422` and *not* a clamp; half an efficiency
pair is a `422` and *not* a symmetric guess. The reason is that a repaired
scenario produces a plan for an asset the caller did not describe, and **nothing
in the response says so** — the plan looks right, the hash looks right, and the
battery in it is not theirs.

So every refusal vector is asserted twice: that it *is* refused with the code
the table names, and that **the scenario object is unchanged afterwards**. The
second assertion is the one that can see a clamp. A validator that quietly
repaired its input would pass every status-code test ever written, because it
would never reach the status code.

## What is pinned

- **`refusals/*.json`** — one case per code in the spec's table, each with the
  `now` its date rules are read against, the scenario, the `ErrorCode` from the
  closed enum in `packages/core/src/errors.ts`, and the `details.field` the
  envelope carries. Three codes carry more than one case, because
  the rule has halves worth separating: `EFFICIENCY_PAIR_INCOMPLETE` (one half
  alone, and a round trip beside a pair), `AVAILABILITY_INVALID` (off the hour,
  and a window covering no hours) and `TARGET_DATE_OUT_OF_RANGE` (before the
  window, beyond tomorrow, and beyond tomorrow at 23:00 Brasília — where a
  validator reading the UTC day would answer differently).
- **`admissions/*.json`** — the scenarios that must **not** be refused. Half the
  value of a refusal suite is the boundary from the other side: a cap read as
  `>=` rather than `>` refuses a legal fleet and no refusal vector can see it.
  The published `REFERENCE_FLEET` is the first of them, because floor coverage,
  the forecaster's `Δ recovered_floor_mwh`, the featured-days list and the
  hot-swap guardrail are all measured against that fleet — if it is ever a
  `422`, every one of those numbers is being measured against a refusal.

`FORECAST_UNAVAILABLE` has **no vector here**, and that is deliberate. It is the
only row of the spec's table that is not a fact about the scenario: the scenario
is well formed and the fleet is real, and there is simply no forecast for that
subsystem, date and origin. Answering it needs the query flex-optimizer ticket
07 owns. The code and its `details` shape are defined on both sides —
`forecastUnavailable` / `forecast_unavailable` — and asserted there; what cannot
be exercised until 07 lands is the condition itself.

## Deliberate asymmetries

1. **Four codes are settled in the transport, not the table.**
   `SCENARIO_VERSION_UNSUPPORTED`, `SCENARIO_TOO_LARGE`, `ASSET_TYPE_UNKNOWN`
   and `FIELD_NOT_ON_VARIANT` make the *bytes* unreadable — an unknown `v`
   decides which grammar the bytes are in, and a battery carrying
   `max_shift_mw` has no canonical form because no variant's key set contains
   it. The validators re-assert all four anyway, because each side has to be
   correct standing alone; at the gateway, whichever half catches it first, the
   caller is told the same code.

2. **The two halves of `SCENARIO_TOO_LARGE` do not bite in the order the table
   lists them.** Nineteen minimal batteries already exceed the 4 096-byte blob
   cap, so the twenty-asset limit is a second bound on a request no transport
   can carry. `refusals/02` therefore pins a second `gateway_field`, and both
   bounds are kept: the byte cap is a property of the encoding and the asset cap
   a property of the model, and a future variant with shorter fields would move
   which one bites first.

   The same asymmetry runs the other way through `admissions/06`, which the
   table admits and no gateway can receive. That is carried as data rather than
   as a filename in a test: the vector holds `gateway_refuses` and
   `gateway_refuses_why`, the two in-process suites ignore both fields and
   assert the table's answer, and `apps/api/test/scenario-gate.test.ts` asserts
   that code instead of a reach. Every *other* admission is put through the
   gateway and must reach the ML service — a cap read as `>=` rather than `>`
   refuses a legal fleet, and no refusal vector can see that.

3. **A structurally malformed request is `REQUEST_INVALID`, not a table code.**
   A missing `max_power_mw` is not a claim about a battery that the table can
   answer — it is a request that never described one. Telling a caller their
   number is out of range when they sent no number would be worse than useless.

## What is *not* here

The canonical encoding, the blob, the hash and the equivalences: those are
[`../scenario-canonical/`](../scenario-canonical/README.md). The solver's own
refusals — `SOLVER_GAP_UNCLOSED`, `SOLVER_TIMEOUT`, `SOLVER_BUG` — are the
solve, not the scenario, and belong to the tickets that own it.
