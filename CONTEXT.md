# CONTEXT — where this repository keeps its reasoning

This file is an **index, not a glossary**. The domain's nouns are defined once,
in `docs/domain-model.md`, and restating them here would be a second definition
free to drift from the first. What was missing was not the reasoning — this
codebase records *why* unusually well — but a way to find it without already
knowing where to look.

## The domain

| you want | it is in |
|---|---|
| What a `Subsystem`, `ReportingEntity`, `Conjunto` or `Plant` is | `docs/domain-model.md` §2–3 |
| Vintage, `as_of`, and the three time axes | §1 |
| `Observation` vs `Forecast`, and why they never share a component | §4 |
| `CurtailmentHour`, `CurtailmentEpisode`, the threshold | §5 |
| `Scenario`, flexibility assets, the optimizer | §6 |
| Words this product deliberately does **not** say | §9, §10 |

Two rules from that document govern most arguments in the code, and are worth
stating here because they are the ones newcomers re-litigate:

- **No quantile adds.** A P50 of a sum is not the sum of P50s. Expectations add
  exactly; measurements add exactly; bands never do. Any code that appears to
  add a band is a bug or is computing something else.
- **An absence is a claim.** A missing figure is rendered as a stated absence
  with a typed reason, never as a zero, a blank, or a skeleton. `null` with a
  `*_unavailable_reason` beside it is the shape.

## The contracts

- `docs/specs/api-surface.md` — every route, its refusals, its cache policy.
- `packages/core/src/types.generated.ts` — the wire types, generated from the
  schema. Hand-editing it is always wrong.
- `apps/api/src/database/canonical-views.ts` — the canonical reads. Product code
  reads these; it never touches an ingest table. See ADR-0005.

## The decisions

Architectural reasoning lives in three places, in this order of authority:

1. **`docs/adr/`** — decisions that kept being re-derived. Start here.
2. **File headers.** Most modules open with the argument for their own shape,
   and those arguments are usually the best available documentation of a
   subsystem. `use-app-params.ts`, `canonical-views.ts` and
   `docs/plans/voice-copilot.md` §10 are worth reading in full.
3. **Commit messages.** This repository writes them as the record of *why*, and
   `git log -S` over a symbol is often faster than a search of the code.

## The plans

`docs/plans/*.md` are design documents. Each carries a `**Status:**` line and
**that line is the authority** — not the checkboxes, not the tense of the prose.
A plan whose status says it is built has an audit section at the bottom saying
what diverged.
