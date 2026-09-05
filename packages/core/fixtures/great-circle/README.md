# The great-circle distance — cross-language golden vectors

These files are **data, and they are the contract**. Two implementations read
them and each asserts *its own* output against `expected_km`, never against the
other:

| Side | Implementation | Test |
|---|---|---|
| TypeScript | `haversineKm` in `apps/api/src/features/capacity-weights.ts` | `apps/api/test/great-circle-vectors.test.ts` |
| SQL | `great_circle_km(lat_a, lon_a, lat_b, lon_b)` in `apps/api/drizzle/0038_one_great_circle.sql` | `apps/ml/tests/test_great_circle_vectors.py`, against a real Postgres |

Same shape and the same properties as the siblings
[`../gate-instant/`](../gate-instant/README.md),
[`../canonical-contract/`](../canonical-contract/README.md) and
[`../published-constants/`](../published-constants/README.md), which this
directory extends rather than duplicates. Both suites additionally fail when
the directory holds a file they did not enumerate, and fail when it is empty, so
**adding a vector here is sufficient** — neither side can quietly skip one, and
deleting the directory is a failure rather than a silence.

**The expected values are not produced by either implementation.** They are
written by
[`../../scripts/build-great-circle-vectors.py`](../../scripts/build-great-circle-vectors.py),
which reaches the same quantity a third way: **Vincenty's formula specialised to
a sphere**, in `atan2` rather than `asin`, with no clamp. Both implementations
use the haversine. Two formulas that lose precision in different places agreeing
to twelve significant figures is evidence; two spellings of one formula agreeing
is not.

## Why there are two implementations at all

There is one formula and there are two places that must evaluate it, and the
boundary between them is not crossable in either direction:

- `apps/api/src/features/capacity-weights.ts` computes weights for **geometry
  that is handed to it** — a candidate centroid set that does not exist in the
  database yet. `ingest/weather/centroid-generator.ts` calls it while *deciding*
  where the frozen points go, so it cannot read `centroid_point`; there are no
  rows to read.
- `canonical_capacity_weight` computes weights for the **frozen set as stored**,
  inside the feature layer, where the caller is a plpgsql feature function that
  cannot call TypeScript, and `centroid_point` is on the forbidden-ingest-table
  list for everything above it.

So neither side can become the authority for the other. Data-platform ticket 18
considered both branches — make the SQL authoritative and have TypeScript read
the view, or accept the duplication — and this directory is the second one,
taken deliberately:

> the duplication is accepted and the parity binding them is made explicit and
> hard to delete

What was there before ticket 18 was an ordinary assertion at the bottom of a
long database suite (`apps/api/test/database-features.test.ts`, "agrees with the
capacity weights TypeScript computes for the same fleet"). That assertion is
still there and is still the right test — it compares the *whole weighting*, not
just the distance — but it compares the two implementations **against each
other**, so it is silent about a formula both sides get wrong the same way, and
it is one `it(...)` a hurried author can delete without noticing what it was
holding together.

This directory holds the half that can be pinned independently. It also gives
the SQL a **name**: before ticket 18 the formula was an anonymous expression
spelled out inline inside `canonical_capacity_weight`, so a second SQL copy
would have had nothing to be a copy *of*.

## What the vectors are chosen for

Not for coverage of the globe — for the inputs where a great-circle formula can
be wrong in a way that still looks like a distance:

- **Coincident points** (`01`), where `sqrt` of a value that rounds to zero and
  `asin(0)` are the difference between `0` and `NaN`, and where the SQL's
  `least(1, …)` clamp is load-bearing.
- **Sub-kilometre separation** (`04`, `03`), where the spherical law of cosines
  — the obvious third implementation somebody will eventually write — loses most
  of its significant figures.
- **Near-antipodal** (`09`), the other end, where the haversine's arcsine
  argument approaches one.
- **A pure latitude degree beside a pure longitude degree at a real fleet
  latitude** (`05`, `06`), which is what catches a transposed argument: an
  implementation that swapped the two passes one and fails the other.
- **Across the antimeridian** (`07`), where a formula that subtracts longitudes
  without letting the trigonometry wrap reports most of the planet.

## Regenerating

    python3 packages/core/scripts/build-great-circle-vectors.py

The script rewrites every file from its own table of cases. Editing an
`expected_km` by hand is always wrong: if a vector's number is disputed, the
thing to change is the script, and then all three ways of reaching it have to
agree again.
