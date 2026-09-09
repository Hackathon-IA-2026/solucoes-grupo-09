# 26 — The retrain debt is real, and nothing makes it loud

**What to build:** proof that a stale artifact cannot serve, and a statement of
the debt that a human will actually see.

Migration `0039` repaired the feature gate's `as_of`, so historical feature rows
carry weather for the first time. That moved `feature_rows`' definition and
therefore `feature_hash`, which means **every existing artifact is bound to a
vector that no longer exists** and both lanes owe a retrain.

Feature-engineering 15 said the hot-swap gate now refuses those artifacts, and put
the conjunct inside `feature_rows` deliberately so that the hash *would* move —
the reasoning being that a weatherless model must not go on serving against rows
that now carry weather. That reasoning is right. **What is missing is
verification and visibility.**

* The refusal is asserted in prose, not measured. Establish that an artifact
  carrying the pre-`0039` hash is genuinely refused, by the real gate, at the
  check that owns it — and that the refusal names the hash mismatch rather than
  failing for an incidental reason.
* Nothing tells an operator the debt exists. A lane whose only artifact is
  unusable should say so where someone looks, not fail silently at the next
  promotion attempt.

**A trap to avoid.** Do not make the gate *tolerate* a stale hash to keep the
service answering. The refusal is the correct behaviour and the whole point of
putting the conjunct where it went. This ticket makes the refusal provable and
audible, never softer.

Also worth checking: forecaster 15 made a cold start self-recovering, so an
incumbent that refuses to load is treated as a cold start and the *second* run can
promote. Confirm that path still holds after `0039`, because it is what stops the
first scheduled retrain from needing a human.

**Blocked by:** None — `0039` and forecaster 15 are merged.

**Status:** done

- [ ] An artifact bound to the pre-`0039` `feature_hash` is refused by the real
      gate, and the refusal names the mismatch
- [ ] The refusal is not softened anywhere to keep a stale artifact serving
- [ ] A lane with no usable artifact states that, somewhere a human sees
- [ ] The self-recovering cold start still reaches a promotable second run
- [ ] Retraining itself is **out of scope** — it needs ingested data no
      environment here has; say so rather than faking a run
