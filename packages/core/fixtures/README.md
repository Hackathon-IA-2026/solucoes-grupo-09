# `packages/core/fixtures/` — the cross-language golden vectors

Every directory here is one value computed in more than one language, pinned as
**data**. The rules are the same in all of them, and they are the whole point:

1. **One shared fixture table is the contract**, and it is data — not a helper
   both sides import, which is how a shared misunderstanding gets in.
2. **Each side is asserted against `expected`, not against the other side.**
   This is the property most easily lost in a rewrite and the one that matters:
   two implementations compared to each other agree perfectly when both are
   wrong.
3. **Every side asserts it consumed every file**, so adding a vector is
   sufficient and no language can quietly skip one.
4. **Deliberate asymmetries get their own block**, so "this side is more liberal
   here" is documented rather than discovered as drift months later.

The shape is recovered from the template's deleted resolver-parity suite
(`packages/core/test/resolve.test.ts`, before commit `9b8a1fc`). Its fourth
property — a cross-workspace import exercising both implementations in one
process — does not survive a language boundary, because `bun test` cannot import
a Python function. These directories are the replacement: both runners enumerate
the same files.

**Where the expected values come from matters.** Wherever the answer can be
reached a third way — a route that imports neither shipped implementation — it
is, and the generator is committed beside the vectors:

| Directory | Third route |
|---|---|
| [`scenario-canonical/`](scenario-canonical/README.md) | [`../scripts/build-scenario-vectors.py`](../scripts/build-scenario-vectors.py) — `json.dumps(sort_keys=True)`, `hashlib`, `base64` from the standard library. Where that route could not express the rule (ECMAScript number formatting) the strings were read off a real engine, which is the authority RFC 8785 defers to. |
| [`gate-instant/`](gate-instant/README.md) | [`../scripts/build-gate-vectors.py`](../scripts/build-gate-vectors.py) — `datetime.combine` and `zoneinfo`, against the IANA database all three sides defer to. |
| [`great-circle/`](great-circle/README.md) | [`../scripts/build-great-circle-vectors.py`](../scripts/build-great-circle-vectors.py) — Vincenty's formula specialised to a sphere, in `atan2`. Both shipped implementations use the haversine; two formulas that lose precision in different places is what makes agreement evidence. |
| [`execution-rule/`](execution-rule/README.md) | **None.** The expected values were emitted by the Python implementation, so a bug present in it when the vectors were written would have been pinned rather than caught. See that directory's README; this is the weakest binding here and it is recorded as such. |

## The directories

| Directory | The value | Sides |
|---|---|---|
| [`canonical-contract/`](canonical-contract/README.md) | the canonical read manifest, and `VintageFidelity` over two instants | `apps/api/src/contract/` · `apps/ml/src/wattsteer_ml/canonical.py` |
| [`published-constants/`](published-constants/README.md) | the thresholds, `max_gap_hours`, the R$/MWh assumption, the subsystems, the technology casing, `REFERENCE_FLEET` | `packages/core/src/constants.ts` · `apps/ml/src/wattsteer_ml/constants.py` |
| [`gate-instant/`](gate-instant/README.md) | `gate_at(target_date, gate_profile)` — the instant every `published_at` is | `packages/core/src/schedule.ts` + `apps/api/src/forecast/gate.ts` · `apps/ml/tests/feature_row_fixtures.py` · `apps/api/drizzle/0016_the_feature_gate.sql` |
| [`great-circle/`](great-circle/README.md) | the great-circle distance between two coordinates, in km | `apps/api/src/features/capacity-weights.ts` · `great_circle_km` in `apps/api/drizzle/0038_one_great_circle.sql` |
| [`scenario-canonical/`](scenario-canonical/README.md) | the canonical scenario bytes, the base64url blob and the sha256 | `packages/core/src/scenario.ts` · `apps/ml/src/wattsteer_ml/scenario.py` |
| [`scenario-validation/`](scenario-validation/README.md) | the eighteen-rule validation table | `packages/core/src/scenario-validation.ts` · `apps/ml/src/wattsteer_ml/scenario_validation.py` · `apps/api/src/api/scenario-gate.ts` |
| [`execution-rule/`](execution-rule/README.md) | the execution rule, and `avoidability` with its null rule | `apps/ml/src/wattsteer_ml/optimizer/simulator.py` — the one implementation |

**`great-circle/` is the one directory here that binds a duplication rather than
a definition.** Everywhere else the two sides implement one spec independently;
there, the two sides are two implementations of one *formula*, kept because
neither can call the other — TypeScript weights candidate centroid geometry that
has no database rows yet, SQL weights the frozen set from inside a feature
function that cannot call TypeScript. Data-platform ticket 18 considered
collapsing them and did not; that directory's README carries the reasoning, and
the vectors are what make the decision reviewable instead of merely stated.

Two directories here are **not** parity vectors and follow none of the above:
[`spec-examples/`](spec-examples/README.md) holds the payloads
`docs/specs/api-surface.md` prints, validated against `../schema/`, and
[`calendar/`](calendar/README.md) holds a published calendar artifact.

## The four values api-surface ticket 21 names

The ticket binds four values that other specs define; it defines none of them.
Three were already bound when it was picked up, and the fourth was not:

| Value | Spec that defines it | Where it is bound |
|---|---|---|
| the gate instant for a target date and profile | `feature-engineering.md` | `gate-instant/` — **added by ticket 21.** Before it, the only cross-spelling check was `packages/core/test/schedule.test.ts` asserting the migration's *text* contains the integers `9` and `19`, which a zone read as a fixed `-03:00` passes. |
| canonical scenario JSON and its hash | `flex-optimizer.md` | `scenario-canonical/` |
| the eighteen scenario validation rules | `flex-optimizer.md` | `scenario-validation/` |
| avoidability and its null rule | `flex-optimizer.md` | `execution-rule/` |

**A fifth value was not a parity case — it was a deletion**, and it has landed.
API-surface ticket 18 deleted the web app's copy of the execution rule, which was
the TypeScript side of `execution-rule/`. Those vectors are no longer a *parity*
directory: they are what `apps/ml/tests/test_execution_rule_vectors.py` alone
asserts — still worth keeping, because that suite recomputes every field on every
run, but no longer a cross-language binding. The repository-wide count moved with
the deletion, from `apps/ml`'s pytest suite to `test/one-execution-rule.test.ts`,
so it runs in the default `bun run test` — which is where the change that would
add a second copy is made. The `avoidability` null rule lives on in TypeScript
only as a **rendering** rule, which is ticket 18's own acceptance criterion: the
screen shows an absence with its "undefined, not zero" explanation, never a
zero.
