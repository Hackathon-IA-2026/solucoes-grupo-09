# The specs' own examples, as fixtures

`docs/specs/api-surface.md` and its four upstream specs write their contracts as
fenced `jsonc` blocks. Those blocks are the closest thing the project has to a
worked example of every response — and until this directory existed, nothing
checked that they were even parseable, let alone that they matched the schema
the code validates against.

**Every JSON document in every fenced block in `docs/specs/*.md` has an entry in
`manifest.json`.** `packages/core/test/spec-examples.test.ts` enumerates the
specs and fails on a document with no entry, so an example added to a spec
cannot slip past the schema; and it fails on an entry whose document no longer
exists, so a manifest cannot outlive the prose it describes. This is the same
"neither side can quietly skip one" property the two sibling directories have,
pointed at documentation instead of at an implementation.

| | |
|---|---|
| The specs | `docs/specs/*.md` |
| The schemas | `packages/core/schema/*.json` |
| The test | `packages/core/test/spec-examples.test.ts` |
| The extractor | `packages/core/test/spec-examples.ts` |

## Why a fixture beside the block, rather than validating the block directly

Most of the blocks are **partial on purpose**. They write one subsystem and say
"… N, S, SE"; they write `"scored": { "p50": { … } }`; they write
`"assets": [ /* … */ ]`. That is right for prose and useless for validation: a
response with one subsystem is not a response.

So each block gets a fixture that **completes** it, and the test asserts three
things rather than one:

1. the fixture validates against the schema the manifest names;
2. every part of the block the spec actually wrote down — every subtree with no
   elision in it — is **reproduced exactly** in the fixture, so a fixture cannot
   quietly correct a spec instead of the spec being corrected; and
3. any path where the fixture *does* differ from a stated part of the block is
   listed in `completes` **with a note saying why**.

That third list is the interesting one. It is short, and every entry on it is a
place where a spec wrote something that reads as data and is not:

- `api-surface.md:592` writes one subsystem under `/v1/grid/now` with no
  elision marker at all. The route answers with four — that is what makes
  `national.derived: "sum_of_four"` a true statement.
- `api-surface.md:619` writes `"published_at": "…"`. It is an instant, and its
  being `gate_at(target_date, gate_profile)` is the argument the whole
  precompute boundary rests on.
- Both result contracts write `"scenario_hash": "sha256:…"`. A hash is 64 hex
  characters; a hash that is not one is a cache key that never matches, which is
  the failure `docs/specs/flex-optimizer.md` writes the canonical form to
  prevent.

## The sibling directories

[`../canonical-contract/`](../canonical-contract/README.md) and
[`../published-constants/`](../published-constants/README.md) pin values that
two *languages* compute. This one pins values that a *document* and a schema
both describe. Same discipline, different pair.
