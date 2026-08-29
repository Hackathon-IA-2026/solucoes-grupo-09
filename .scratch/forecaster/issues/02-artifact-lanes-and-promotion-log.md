# 02 — Artifact lanes, the promotion log, and what "current" means

**What to build:** the volume can hold many artifacts, in many lanes, including
ones that were refused — and the service still knows exactly which one it is
allowed to serve, or that it is allowed to serve none.

An artifact's identity is the triple (feature set, gate profile, threshold), and
each triple gets its own lane directory so "newest" is well-defined within a
lane and meaningless across lanes. ISO-8601 UTC stems sort meaningfully, so
there is no symlink to go stale. Two changes to the existing artifact module are
required rather than assumed: inspection must walk one level of lane directories
instead of a flat listing, and **`current(lane)` must mean the newest artifact
named by a `promote` decision in the append-only promotion log, not the newest
file on disk** — because a candidate that fails the gate is still written, and a
newest-file rule would serve it.

Rollback is an append, never a delete: a line naming an earlier artifact
restores it, and the evidence of the bad promotion survives.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] Artifacts live in one directory per lane, and lanes are discovered rather
      than configured
- [ ] `current(lane)` resolves through the promotion log, so an unpromoted
      newer file on the volume is never served
- [ ] Every decision — promote and refuse alike — appends exactly one line
      carrying the artifact id, lane, decision, reason and instant
- [ ] A rollback is an append naming an earlier artifact; nothing is deleted and
      the earlier promotion's line survives
- [ ] `/v1/meta` distinguishes *no artifact*, *artifact present but none
      promoted* and *promoted and serving*, separately from what it already
      says about the mount
- [ ] A lane with a corrupt or truncated promotion log fails loudly rather than
      falling back to newest-file
- [ ] Tests cover a volume containing multiple lanes, a refused candidate newer
      than the promoted one, and a rollback line
