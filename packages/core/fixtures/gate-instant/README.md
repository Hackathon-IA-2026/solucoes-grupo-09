# The gate instant — cross-language golden vectors

These files are **data, and they are the contract**. Three implementations read
them and each asserts *its own* output against `expected_gate_at`, never against
another side:

| Side | Implementation | Test |
|---|---|---|
| TypeScript | `packages/core/src/schedule.ts` (`GATES`, `localWallClock`) and `apps/api/src/forecast/gate.ts` (`gateAt`) | `packages/core/test/gate-instant.test.ts` |
| Python | `apps/ml/tests/feature_row_fixtures.py` (`gate_at`) | `apps/ml/tests/test_gate_instant_vectors.py` |
| SQL | `gate_at(target_date, gate_profile)` in `apps/api/drizzle/0016_the_feature_gate.sql` | `apps/ml/tests/test_gate_instant_vectors.py`, against a real Postgres |

Same shape and the same four properties as the siblings
[`../canonical-contract/`](../canonical-contract/README.md),
[`../published-constants/`](../published-constants/README.md),
[`../scenario-canonical/`](../scenario-canonical/README.md) and
[`../scenario-validation/`](../scenario-validation/README.md), which this
directory extends rather than duplicates. Every suite additionally fails when
the directory holds a file it did not enumerate, so **adding a vector here is
sufficient** — no language can quietly skip one.

**The expected values are not produced by any of the three.** They are written
by [`../../scripts/build-gate-vectors.py`](../../scripts/build-gate-vectors.py),
which reaches the same answers a fourth way — `datetime.combine` and `zoneinfo`
from the standard library.

## Why this exists at all

`docs/specs/api-surface.md` §"Why the worker publishes": *"A `Forecast` row's
`published_at` is, by the domain model, the instant the producer asserted the
value, and by `feature-engineering.md` that instant is `gate_at(target_date,
gate_profile)`."* So this one function decides

- every feature row's `gate_at`, and therefore every published `published_at`,
- whether `FORECAST_NOT_YET_PUBLISHED` or `FORECAST_UNAVAILABLE` is the honest
  answer — "come back at seven" against "something broke", and
- the `ForecastOrigin` stamped on every number a screen renders.

It is written in three places because it has to be: the feature layer resolves
it *inside Postgres* so that no caller can pass a cutoff in, the gateway
resolves it in TypeScript to answer a question about time rather than to store
a value, and the ML suite mints it to fabricate feature rows. Before this
directory, the only thing holding the three together was
`packages/core/test/schedule.test.ts` asserting that the migration's **text**
contains the integers `9` and `19` — which is a check on two spellings of an
hour, not on the instant either of them resolves to. A zone read as a fixed
`-03:00` passes that check and is wrong.

## What is pinned

Ten flat vectors, each a target date and a gate profile with the instant they
resolve to:

```jsonc
{
  "name": "…",
  "why": "…",                         // prose, asserted by no side
  "target_date": "2026-08-29",
  "gate_profile": "gate_late",
  "expected_local_date": "2026-08-28", // D−1, which is the half a calendar bug hits
  "expected_local_time": "19:00",      // the gate table, which is the half a table bug hits
  "expected_utc_offset_minutes": -180,
  "expected_gate_at": "2026-08-28T22:00:00.000Z"
}
```

The local date, the local time and the offset are pinned beside the instant on
purpose: when a vector fails, those three say *which* of the three ways to get
this wrong happened — the D−1 arithmetic, the profile-to-hour table, or the
zone — rather than leaving a reader with two timestamps that differ.

The cases are in two families:

- **Calendar** — `01`–`05`. The two profiles of one target date; the first date
  the window covers, whose gate falls in the previous month; a gate in the
  previous year; a gate on a leap day.
- **The zone** — `06`–`10`. Brazil observed summer time until February 2019, so
  these gates are `UTC-02:00` and land at `21:00Z` rather than `22:00Z`. `07`
  and `08` straddle the 2018 spring-forward: two neighbouring gates thirteen
  hours apart rather than fourteen. `09` and `10` straddle the fall-back.

  **The data window contains no DST transition.** These dates are all before
  `DATA_WINDOW_OPENS_ON` and no feature row will ever be built for them. They
  are here anyway, because "the code must not assume it": an implementation
  that subtracts a fixed three hours is indistinguishable from a correct one on
  every date the product actually serves, and would stay that way until Brazil
  reinstated summer time — at which point every `published_at` in the system
  would move by an hour with nothing failing.

## Deliberate asymmetries

1. **Only Postgres is asked whether the wall clock exists.** The migration
   round-trips the instant back into local time and raises `22023` if a
   spring-forward swallowed the hour, because it is the side that writes a
   stored value and a silently-moved gate would be persisted. The TypeScript
   `localWallClock` resolves the offset in two passes and returns an instant
   without that check, which is correct for its job — answering "has the gate
   passed yet?" is a comparison, and a question about a nonexistent instant has
   no better answer than the one the zone gives. No vector pins a nonexistent
   wall-clock time: Brazil's transitions happen at midnight, so `09:00` and
   `19:00` have always existed, and pinning a case neither side can reach would
   be pinning whichever way each happened to resolve it.

2. **The SQL side runs only against a real database.** `gate_at` is a
   `plpgsql` function; there is nothing to import. Its vectors are asserted by
   `test_gate_instant_vectors.py` under the same `WATTSTEER_TEST_DATABASE_URL`
   gate as every other database suite in this repository, so the default
   `pytest` run **skips** them. The two in-process sides are not skippable and
   run everywhere.

3. **The Python side under test is a test fixture, not shipped code — and that
   is the point.** `apps/ml/src/wattsteer_ml` deliberately holds no `gate_at`:
   `publication.py` reads the column off the feature rows and never computes
   it, which is the right design and is why a fourth *shipped* spelling would
   be a regression rather than a fix. But `apps/ml/tests/feature_row_fixtures.py`
   does compute one, to mint the `gate_at` column on every fabricated row — and
   an ML suite whose fixtures disagreed with the database would be training and
   evaluating against a gate the product does not use. That spelling is what
   these vectors bind.

4. **The generator shares a time-zone library with one of the three sides.**
   `zoneinfo` writes the vectors and `zoneinfo` is also what the Python fixture
   resolves with, so for *that* side the offsets are not independently
   witnessed — the vectors catch a wrong hour or wrong-day arithmetic there,
   not a tzdata disagreement. There is none to catch: all three sides read the
   same IANA database (ICU on the TypeScript side, `pg_timezone_names` on the
   SQL side), which is the authority each of them defers to, exactly as
   `../scenario-canonical/numbers.json` defers to a real ECMAScript engine for
   the rule its stdlib route could not express.

## What is *not* here

`nextPublication` — "when does this change next?" — is a different question
asked of the same table, and it is pinned by
`packages/core/test/schedule.test.ts` rather than here, because it takes an
instant rather than a target date and no other language asks it.
