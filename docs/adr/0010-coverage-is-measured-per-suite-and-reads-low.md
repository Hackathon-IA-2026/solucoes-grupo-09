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

| run | tests | functions | lines |
| --- | ---: | ---: | ---: |
| `bun test` | 1,395 pass, 600 skip | 67.55% | 64.72% |
| `bun run test:db` | **1,852 pass, 50 skip** | **93.24%** | **91.55%** |

Twenty-six points of functions and twenty-seven of lines, from the same code on
the same day. Read without the database, `src/contract/*`, `src/database/*`,
`src/diagnosis/reads.ts` and `src/features/*` all look abandoned; every one of
them is exercised.

## Decision

**Quote the gated number, and say which run produced it.** A coverage figure in
this repo is meaningless without its run:

- `packages/core` — run all three suites; the truth is the union, and no single
  one of them is it.
- `apps/api` — `bun run test:db`, with the compose Postgres on 5434. `bun test`
  alone is a lower bound and a misleading one.
- `apps/web` — `bun test test`; it has no gated half.

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
