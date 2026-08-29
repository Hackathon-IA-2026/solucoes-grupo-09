# The canonical scenario transport — cross-language golden vectors

These files are **data, and they are the contract**. Two implementations read
them and each asserts *its own* output against the expected value:

| Side | Implementation | Test |
|---|---|---|
| TypeScript | `packages/core/src/scenario.ts` | `packages/core/test/scenario-canonical.test.ts` |
| Python | `apps/ml/src/wattsteer_ml/scenario.py` | `apps/ml/tests/test_scenario_canonical.py` |

Same shape and the same four properties as the sibling
[`../canonical-contract/`](../canonical-contract/README.md) and
[`../published-constants/`](../published-constants/README.md), which this
directory extends rather than duplicates. Both suites additionally fail when the
directory contains a case they did not enumerate, so **adding a vector here is
sufficient** — neither language can quietly skip one.

**The expected values are not produced by either implementation.** They are
written by `../../scripts/build-scenario-vectors.py`, which reaches the same
answers a third way — `json.dumps(sort_keys=True, separators=(",", ":"))`,
`hashlib.sha256`, `base64.urlsafe_b64encode` — so a shared misunderstanding
between the two shipped serialisers has nothing to cancel out against. That
route cannot express ECMAScript's number rule, which is why the scenario vectors
use only numbers whose Python `repr` and ECMAScript `String()` already agree and
why the number rule has a file of its own.

## Why this exists at all

`docs/specs/flex-optimizer.md`: *"The URL is the storage; there is nothing to
persist and no identity to invent."* A scenario travels as base64url of its
canonical bytes, and the sha256 of those bytes is simultaneously

- the Redis cache key, `opt:v1:<hash>:<origin>:<build>`, and
- the `scenario_hash` stamped on every answer as a reproducibility claim.

Both meanings fail the same way and silently. Two spellings of one scenario that
hash differently are a cache that never hits and a "reproduce this" that cannot.
Two different scenarios that hash alike are a wrong plan under a right-looking
receipt. The gateway is TypeScript and the optimizer is Python, so "the same
bytes" is a claim across a language boundary, which is exactly what a vector
directory is for.

## What is pinned

- **`numbers.json`** — RFC 8785 §3.2.2.3, which is ECMAScript's
  `Number::toString`. This is the file that earns the directory. Python's `repr`
  is *also* shortest-round-tripping and is *not* the same function: it writes
  `100.0` where ECMAScript writes `100`, `1e-06` where ECMAScript writes
  `0.000001`, and `1e+20` where ECMAScript writes the twenty-one digits out. The
  spec's own worked example — `0.92` against `0.920` — is the easy case; every
  other case here is one a plausible implementation gets wrong. Expected strings
  were read off a real ECMAScript engine, which is the authority RFC 8785 defers
  to.
- **`scenarios/*.json`** — a whole scenario, its canonical text, its base64url
  blob and its hash. Four of them: the published `REFERENCE_FLEET`; the smallest
  scenario the schema admits; a label carrying every character the escape rule
  owns; and one with an explicit `null`, which is carried rather than dropped
  because `recovery_time_hours: null` is a stated member of the contract and a
  different scenario from its absence.
- **`equivalences/*.json`** — several JSON documents that are *one* scenario, and
  the single hash they must all produce. Key reordering, and the float spellings
  the spec names. `variants[0]` is the document the canonical text is written
  from; every other variant must reach the same bytes.
- **`refusals/*.json`** — the blobs that must be refused, each with the
  `ErrorCode` from the closed enum in `packages/core/src/errors.ts`. `v: 2`, a
  missing `v`, a battery carrying `max_shift_mw`, an `asset_type` no variant
  claims, a blob over the 4096-byte cap, a blob outside the base64url alphabet,
  and a blob that decodes to text but not to JSON.

## Deliberate asymmetries

1. **TypeScript checks one thing Python cannot.** A battery literal carrying
   `max_shift_mw` is a *compile* error on the TypeScript side, because
   `additionalProperties: false` on each variant generates an interface the
   excess property is not on. Python has no equivalent; there,
   `refusals/03` is a runtime refusal only. Both sides assert the runtime
   refusal; only `packages/core/test/scenario-canonical.test.ts` asserts the
   compile one, with a `@ts-expect-error` that fails the typecheck if the error
   ever stops happening.

2. **Only the TypeScript side translates casing.** The canonical bytes are the
   wire's `snake_case`. `apps/ml` speaks `snake_case` natively and reads the
   `scenario` field of a vector directly; `packages/core` holds the app's
   `camelCase` view and goes through `src/wire.ts` first. The vectors are
   written in the wire's spelling, which is the one both languages can read.

3. **The blob cap is asserted at different moments.** TypeScript checks the
   length of the `?s=` parameter *before* decoding it, so an oversized query
   string is refused without allocating a buffer or running a parser over
   attacker-controlled bytes. Python re-asserts it after encoding, because the
   ml service receives a decoded body rather than a query string and its job is
   to trust nothing it did not check itself.

## What is *not* here

The eighteen-rule validation table — `SHIFT_EXCEEDS_BASELINE`,
`SOC_BOUNDS_INVALID`, the magnitude caps — is flex-optimizer ticket 04 and gets
its own `scenario-validation/` directory beside this one. The four refusals here
are the ones that make the *bytes* unreadable rather than the *scenario*
nonsensical, and they have to happen in the transport because nothing
downstream can read a field until they have.
