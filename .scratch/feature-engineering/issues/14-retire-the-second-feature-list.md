# 14 — Retire the hand-transcribed feature list

**What to build:** delete `apps/ml/src/wattsteer_ml/diagnosis/ordered_features.yaml`
and have `driver_groups.py` read the dictionary instead.

Ticket 02 transcribed the ordered feature list by hand because no dictionary
existed and the driver-group map needed something to validate totality against.
Its own header said the transcription was standing in for something that would
arrive. Ticket 11 built it: `feature_set_model_inputs(set)` is derived from
`feature_row`'s attributes and refuses to answer if the catalogue and the type
disagree.

The two agree today — **77 names for `dessem_free_v1` and 99 for
`dessem_augmented_v1`, exactly equal as sets, verified against a live database**
rather than assumed. Only the ordering differs (attribute order against the spec
table's), which matters only if the totality check is order-sensitive; it is
set-shaped.

**They agree in the wrong direction, which is the reason to act.**
`observed_constrained_off_same_hour_exceedance_7d` is in the spec's class-`K`
table and is in neither list — ticket 05 shipped 20 of the 21 class-`K` names,
and the YAML omits it too. So the hand-transcribed file currently matches the
*implementation* rather than the authority it claims to transcribe, and nothing
noticed. That is precisely how a second list fails: not by disagreeing loudly,
but by agreeing with the wrong thing.

Note this is a real change rather than a delete: `driver_groups.py` loads the
YAML, `assert_total_partition` takes the names as an argument, and the Python
side has no database connection in the default test path — so the substitution
needs a shape that works without one (a generated artifact checked in, or the
gated suite carrying the live check while the default path uses a snapshot with
a staleness test).

**Blocked by:** 11 (merged). Also feature-engineering's missing exceedance
column, recorded at the bottom of
`.scratch/feature-engineering/issues/05-lagged-actuals-behind-the-cutoff.md` —
adding it moves `feature_hash` and takes `feature_row` to 112 attributes, so it
should land before or with this, not after.

**Status:** ready-for-agent

- [ ] `ordered_features.yaml` is gone and nothing reads it
- [ ] `driver_groups.py` validates totality against the dictionary, and the
      default test path needs no database
- [ ] A test proves the two cannot silently agree on a wrong list — a name
      present in the type and absent from the group map still fails
- [ ] The missing exceedance column is either added or recorded as a known
      difference with a test pinning it, not left as a silent agreement
