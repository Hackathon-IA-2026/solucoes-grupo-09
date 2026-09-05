# `schema/` — the cross-language authority

These files are **the contract**. Not the TypeScript, not the Elysia route
models, not the Python dataclasses: these.

The reason is one sentence long. The framework's own end-to-end type treaty
(Elysia's Eden over `type App`) gives TypeScript-to-TypeScript parity between
the gateway and the web app for free, and gives **Python nothing** — and the
modelling service is Python. So JSON Schema is the authority and the type treaty
is a convenience. Where the two disagree the schema wins, and
`apps/api/test/schema-treaty.test.ts` asserts it against real values rather than
asserting that two type systems agree.

| | |
|---|---|
| The generator | `../scripts/generate-types.ts` |
| The generated types | `../src/types.generated.ts` — checked in; a test regenerates and diffs |
| The one translator | `../src/wire.ts` — `snake_case` ↔ `camelCase`, in one place, from a generated table |
| The typed client | `../src/client.ts` |
| The loader and validator | `../src/schema.ts` |

## The rules these files exist to make structural

`docs/specs/api-surface.md` writes nine vocabulary rules and says of each that
it exists "because something has already got it wrong once". Seven of the nine
are enforced by the shapes here; every one has a failing case in
`../test/vocabulary-rules.test.ts`.

1. **A band is one shared reference.** `common.schema.json#/$defs/band`,
   `$ref`'d everywhere, so a grep finds every band on the surface. A test walks
   every schema and fails on an inlined `{p10, p50, p90}` of numbers.
2. **An expectation is never inside a band.** `band` is
   `additionalProperties: false`, so `expected_mwh` cannot get in, and the day
   expectation is declared as a sibling.
3. **A technology split is two scalars.** `technology_split` is closed and both
   members are `number`, so `{ "wind_mwh": { "p50": … } }` fails.
4. **`avoidability` is `number | null`** and is `required`, so the null cannot
   be replaced by a zero *or* by an absence.
5. **`lead_time` is absent.** A test greps every schema for a property of that
   name.
6. **`SIN` is not a subsystem.** The enum has four members; a national figure
   lives under a `national` key that names its own derivation
   (`sum_of_four` for the observed total; `band: null` with
   `band_unavailable_reason` for the forecast, which has no joint ensemble).
7. **Reason codes travel; the gloss does not.** `reason_code` is the ONS
   identifier, and a test fails any schema that adds an English label beside a
   code.
8. **`threshold_mw` is required** on the outlook, the forecast, the diagnosis,
   every optimization result, every replay and every episode.
9. **`vintage_fidelity` is required** on every object carrying a metric, and
   there is no third member to average two into.

## The one thing JSON Schema cannot say

`p10 <= p50 <= p90` is not expressible: there is no way to compare two sibling
values. It is also the single most important thing about a band — a band with
`p10 > p50` is not a wide forecast, it is a bug. So `x-quantile-ordering` is a
custom keyword registered on the one validator in `../src/schema.ts`, which
every side of the contract goes through.

## What is not here yet

The route schemas land with their routes. `/v1/replay/days` and `/v1/backtest`
belong to API ticket 17, and this directory is where they go.
`curtailment.schema.json` is here ahead of API 14 because vocabulary rules 7 and
8 needed a real home for an `ObservedReason` and an episode list.

`model-card.schema.json` landed with API 16 and types the **product-facing
subset** of the artifact card, not the card. The card is the forecaster's
document and this schema decides nothing about what is in it: every field
forwarded from it keeps the card's own spelling, and `card_url` points at the
whole thing. Two shapes there are load-bearing rather than tidy. `coverage` is
split into a `lower` and an `upper` object because the two tails have different
statuses — the conformal lower correction reaches the served band in full at
every occurrence probability and the upper one does not — so `coverage_p90`
sits in the same object as the `upper_correction_realised` that makes it
readable, and the schema requires them together. And `metrics` is
`null` with a required `metrics_absent_reason` rather than `[]`, because an
empty table reads as "measured as nothing" and the truth is "not measured yet".

## Conventions

- Every `$id` is `https://wattsteer.com/schema/<file>`, so a cross-file `$ref`
  is written as the bare file name and resolves relative to it.
- Every `$defs` entry carries a `title`; the generator turns it into the
  TypeScript name, so a rename here is a rename in the web app's compile.
- Every object is `additionalProperties: false`. A wire that accepts unknown
  fields is a wire nobody can reason about.
- `description` is written for a reader of the generated types: the generator
  copies it into the doc comment.
