# Canonical read contract — cross-language golden vectors

These files are **data, and they are the contract**. Two implementations read
them and each asserts *its own* output against `expected`:

| Side | Implementation | Test |
|---|---|---|
| TypeScript | `apps/api/src/contract/` | `packages/core/test/canonical-contract.test.ts` |
| Python | `apps/ml/src/wattsteer_ml/canonical.py` | `apps/ml/tests/test_canonical_contract.py` |

The shape is recovered from the template's deleted resolver-parity suite
(`packages/core/test/resolve.test.ts`, before commit `9b8a1fc`), which is the
prior art `.scratch/data-platform/issues/13-canonical-read-contract.md` points
at. Four properties made that suite work; three of them survive the move across
a language boundary and are the reason this directory exists rather than a
shared test file:

1. **One shared fixture table is the contract**, and it is data.
2. ~~A cross-workspace import exercises both implementations in one process.~~
   Lost — `bun test` cannot import a Python function. Replaced by this
   directory, which both test runners enumerate.
3. **Each side is asserted against `expected`, not against the other**, so a
   shared bug cannot cancel out. This is the property most easily lost in a
   rewrite and the one that matters.
4. **Deliberate asymmetries get their own block**, so "this side is more liberal
   here" is documented rather than discovered as drift.

Both suites additionally fail when the directory contains a case they did not
enumerate, so **adding a vector here is sufficient** — neither language can
quietly skip one.

## What is pinned

- `manifest.json` — the vocabulary: every canonical read, its grain, its
  business key, whether it is an observation or a forecast, and whether a
  restriction cause is reachable from it. This is the file that stops ONS's
  conventions being reimplemented on the Python side.
- `vintage-fidelity/*.json` — the `VintageFidelity` rule, case by case. It is
  arithmetic over two instants and it decides whether a backtest number is
  honest, which is exactly the kind of one-line rule two languages get subtly
  different.

`summary` is deliberately **not** pinned. It is documentation, it will be
reworded, and pinning prose would make the parity suite fail for a typo fix.

## The sibling directory

[`../published-constants/`](../published-constants/README.md) applies the same
harness to the numbers and enums both languages quote — the two curtailment
thresholds, `max_gap_hours`, the R$/MWh scenario assumption, the four
subsystems with their ONS display names, the technology casing and the
published `REFERENCE_FLEET`. Same four properties, same "each side against
`expected`" rule; a different family of values, so a different directory.
