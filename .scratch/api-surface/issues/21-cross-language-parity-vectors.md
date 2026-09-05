# 21 — Four values are computed in two languages, and neither can skip a case

**What to build:** a shared golden-vector directory that both the TypeScript
tests and the Python tests enumerate, so a value computed on both sides cannot
drift while both look right in isolation.

The pattern is recovered from a deleted resolver-parity suite in this
repository's history, and four properties made it work. Three transfer intact:
**one shared fixture table is the contract, and it is data**; **each side is
asserted against the expected value, not against the other**, so a shared bug
cannot cancel out — this is the property most likely to be lost in a rewrite and
the one that matters; and **deliberate asymmetries get their own block**, so "the
client is more liberal here" is documented rather than discovered as drift.

The fourth — a cross-workspace import exercising both implementations in one
process — does not transfer, because a TypeScript test cannot import a Python
function. So the table moves out of the test file into a fixture directory of
input/expected JSON cases, and **both** test runners enumerate the directory and
assert their own implementation. Each side additionally asserts that it consumed
**every** file, so adding a vector is sufficient and neither language can quietly
skip one.

**Four values get a vector file:**

| Value | Why it will drift |
|---|---|
| the gate instant for a target date and profile | A timezone or a DST assumption. The window contains no DST transition, but the code must not assume it. |
| canonical scenario JSON and its hash | Float formatting. `0.92` against `0.920` is a different hash and a cache that silently never hits. |
| the eighteen scenario validation rules | Two hand-written tables of eighteen rules, one at the gateway "before a model is built" and one in the service that "trusts nothing it did not validate itself". |
| avoidability and its null rule | The null-versus-zero rule is one line and it is the product's most quoted percentage. |

**A fifth value is not a parity case — it is a deletion**, and it is ticket 18.

This directory is not starting from nothing: a golden-vector directory already
exists in the shared package binding the canonical contract's vintage-fidelity
function across both languages. That is the same pattern and the same directory
should absorb these four.

**Blocked by:** 04. Cross-spec: the validation-rule table and the avoidability
definition are **flex-optimizer**'s; the gate function is
**feature-engineering**'s. This ticket binds them, it does not define them.

**Status:** done

- [ ] Four vector directories exist, one per value, as input/expected JSON
- [ ] Both test runners enumerate each directory and assert their own implementation against the expected value, never against each other
- [ ] Each side asserts it consumed every file, so a vector added for one language cannot be skipped by the other
- [ ] A deliberately broken vector — a canonical encoding with a trailing zero — fails on both sides, which is the test of the test
- [ ] Deliberate asymmetries live in their own block with a stated reason
- [ ] The existing vintage-fidelity vectors keep working under the same harness
