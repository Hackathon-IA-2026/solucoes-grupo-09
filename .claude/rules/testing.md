# Testing

Governing principle: **a test asserts a property, not a snapshot of today's
code.** This repository's suites are unusually opinionated — several exist
because a guard that looked green was blind — so read what a suite is *for*
before adding to it.

## The suites

| Suite | Command | What it guards |
|---|---|---|
| Hygiene | `bun run test:hygiene` (`test/`) | repository-wide invariants: the specs' claims, the endpoint list, the causality boundary, hard-coded copy, the migration ledger, phantom schedules, reachability |
| Core | `bun run test:core` | the wire contract: schemas, generated types, the client's request keys, the specs' own JSON examples |
| Gateway | `bun run test:api` | routes, refusals, shaping, cache policy, the ML boundary. Most of it runs with `db: undefined` |
| Gateway + Postgres | `bun run --cwd apps/api test:db` | the round trip through the views and the axes |
| Web | `bun run test:web` | derivations, copy rules, the observed/forecast separation |
| End to end | `bun run test:e2e` | a **real export** in Chromium |
| Modelling | `bun run check:ml` | ruff, mypy, pytest |

`bun run check` runs typecheck + lint + the TS suites. `check:all` adds `:ml`.

**`test:hygiene` is green, and so is everything else.** Do not fix a red guard
by weakening it — but do not leave it red either. When one fires, the first
question is whether it has caught something: of the five failures that stood
here for weeks as a "baseline", one was a real finding (copy outside the
dictionaries), two were a guard scanning its own explanatory comments, and two
were mutation proofs that had gone vacuous when a union grew under them.

## Do not test a fixture

`apps/web/test/optimization.test.ts` says it outright: the physics belongs to
the MILP and is asserted in `apps/ml`, so the web fixtures are deliberately
**not** physical — every field a different number, because the failure that test
exists to catch is a field read into the wrong slot, and a plausible-looking
fixture is exactly the one that hides it.

## A guard must be able to fail

Several suites test their own guards: `spec-claims.test.ts` mutates a spec and
asserts the check goes red; `ml-boundary.test.ts` synthesises a crossing;
`cache-policy.test.ts` enumerates the route files it found so a route that stops
building a validator is a failure rather than a silence.

When you add a repository-wide check, add the mutation that proves it is not
vacuous. An exemption written before the tree is consulted made every reference
"resolve" against an empty listing — and *that* was caught by the vacuity guard
already in the file.

## Source-level guards are legitimate here

Where a rule lives in *how* something is called rather than in a value, assert
it against the module's own source — the two reads and the `apply_axes` that
arms them inside one transaction, the promoted lane read rather than a constant.
Say in the test why the property is not reachable any other way.

Scope them to the thing they govern. A guard that read the whole of
`api/grid.ts` for "takes no subsystem parameter" failed the day a sibling route
in the same file legitimately took one; it reads that route's own slice now.

## What to add, by change

- **New route** → a row in the endpoint list, a no-database test of its
  refusals and shaping, a client-key row.
- **New schema field** → the fixture in `packages/core/fixtures/spec-examples/`
  *and* the spec's fenced example, together.
- **New copy key** → both dictionaries; add an observed label to the vocabulary
  list in `observed-overview.test.ts`.
- **New absence** → the branch that renders it, and the schema case that makes
  a null-without-a-reason unrepresentable.
- **Fixing a bug** → the failing test first, named after the defect, quoting the
  error production actually printed where there was one.

## Before claiming green

Run it. Read the tail. A truncated pass line has been misread as success in this
repository before, and the correction cost more than the run would have.
