# ADR-0010 — coverage is measured per suite, and reads low

**Status:** accepted · 2026-09-16

## Context

Every coverage number this repo can produce by default understates it, in two
different ways, and both were chased before they were understood.

### Shared code reads as uncovered from a suite that does not import it

`packages/core` is imported by `apps/api`, `apps/web` and its own tests. Each
suite reports 0% for the modules it happens not to touch:

| module | from `core` | from `api` | from `web` | truth |
| --- | --- | --- | --- | --- |
| `casing.ts` | 100 / 100 | 0 / 0 | 0 / 0 | covered |
| `causality.ts` | 100 / 100 | 85.7 / 97.9 | 0 / 53.2 | covered |
| `driver-display.ts` | **0 / 0** | 100 / 100 | 100 / 100 | covered |
| `format.ts` | 100 / 97.1 | 0 / 2.8 | 0 / 2.8 | covered |

`driver-display.ts` is the one worth staring at: **0% in its own package** and
100% in both consumers. It is the selection predicate the server and the client
share, so the module most load-bearing across the boundary is the one its own
suite never loads.

Three of these were investigated as gaps before turning out to be artefacts.
Finding that out is what surfaced the one real gap beside them — `domain.ts`,
which read 50% everywhere because it genuinely was.

### The database suite is gated, and it is most of the API's coverage

`apps/api` has 101 test files and about a third of its assertions need a real
Postgres. `bun test` skips those, so the default number is not a measurement of
the code, it is a measurement of how much of it needs a database:

There are **two** gates, not one. `WATTSTEER_TEST_DATABASE_URL` opens the
database half; `WATTSTEER_TEST_REDIS_URL` opens the queue and the Redis-backed
rate limiter.

| run | tests | functions | lines |
| --- | ---: | ---: | ---: |
| `bun test` | 1,395 pass, 600 skip | 67.55% | 64.72% |
| `bun run test:db` | 1,852 pass, 50 skip | 93.24% | 91.55% |
| both gates open | **1,872 pass, 33 skip** | **93.70%** | **92.19%** |

Twenty-six points of functions and twenty-seven of lines, from the same code on
the same day. Read without the database, `src/contract/*`, `src/database/*`,
`src/diagnosis/reads.ts` and `src/features/*` all look abandoned; every one of
them is exercised. `src/jobs/bullmq.ts` reads 30.77% without Redis and 85.71%
with it, and the rate limiter — the API's only defence against abuse — is not
exercised against a real store at all until that second variable is set.

### `apps/ml` is gated the same way, and nobody had run it either

The Python suite reads `WATTSTEER_TEST_DATABASE_URL` through
`tests/database_harness.py` and skips 94 tests without it:

| run | tests | statements covered |
| --- | ---: | ---: |
| `uv run pytest` | 1,821 pass, 94 skip | 90% |
| with the database | **1,908 pass, 7 skip** | **93%** |

`weather_reads.py` reads **41%** without it and **95%** with it — and weather is
a model input, so the module that looked least tested is one of the ones a
forecast depends on most. `canonical_reads.py`, `database.py`, `replay/inputs.py`
and `replay/reads.py` all move the same way. Every module that looked abandoned
was a module that reads Postgres.

Note that `pytest-cov` is **not** a dependency of this project and does not need
to be: `uv run --with pytest-cov pytest --cov=src/wattsteer_ml` installs it for
the one run and leaves `pyproject.toml` alone.

## Decision

**Quote the gated number, and say which run produced it.** A coverage figure in
this repo is meaningless without its run:

- `packages/core` — run all three suites; the truth is the union, and no single
  one of them is it.
- `apps/api` — `bun run test:db`, with the compose Postgres on 5434, and
  `WATTSTEER_TEST_REDIS_URL` set at a Redis of its own (`docker run -d -p
  6380:6379 redis:7-alpine`; 6379 is often another project's). `bun test` alone
  is a lower bound and a misleading one.
- `apps/web` — `bun test test`; it has no gated half.
- `apps/ml` — `WATTSTEER_TEST_DATABASE_URL` at the same Postgres, and
  `--with pytest-cov` for the measurement.

What remains genuinely low after that is small and explicable: `src/api/index.ts`
is application wiring reached through HTTP rather than called, and
`src/jobs/bullmq.ts` needs a Redis the test run does not start.

**Do not write a test to raise a number that a different run already covers.**
That is the cost this ADR exists to prevent — the work looks like coverage and
is duplication, and it lands on the modules most shared, because those are
exactly the ones that read 0.

## Consequences

`test/database-gated-suite.test.ts` already holds that every gated file says how
to run it. This is the other half: how to read what comes back when you do.

Before quoting coverage anywhere — a README, a ticket, a commit message — state
the command. "89% of functions in `packages/core`, from its own suite" is a
fact. "89% of functions" is not.

And check the command ran as written. Measuring the row above, a collapsed
`env $VARS bun test` reported 60.38% because the variables never reached the
process — a number low enough to look like a finding and high enough not to look
like an error.
