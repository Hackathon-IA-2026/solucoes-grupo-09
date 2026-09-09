# 25 — One place that lists every figure this system will not state

**What to build:** a single surface answering "what does WattSteer decline to
tell me, and why" — assembled from the named reasons, never hand-written.

The discipline of refusing to publish a number rather than fabricating one has
held throughout, and it has produced a growing set of named absences:

* `ARCHIVE_FEATURES_HAVE_NO_SHAPE` — the lead-time A/B's control arm
* `CORRELATION_NOT_RUN_YET` — the aggregate train/serve correlation
* `MARGINAL_COVERAGE_NOT_RUN_YET` — whether the band's marginal coverage survives
  outside a fixture
* `NO_TFT_IMPLEMENTATION` — the transformer benchmark
* `NOT_RUN_YET` (dessem) — three arms not yet scored
* `band_unavailable_reason` — a national band with no joint ensemble behind it
* the `not_applicable` guardrail — a comparative rail with no incumbent
* an absent `TrainingCost` — a runtime nobody measured

Individually each is honest. Collectively they are **scattered across cards,
blocks and wire fields**, so nobody can answer the obvious question in one look —
and the value of refusing to fabricate is only realised if the refusals are
findable. A reviewer deciding whether to trust this system needs the list more
than any single figure on it.

**Assemble it, do not transcribe it.** A hand-maintained list would go stale the
first time a reason is added — which is the exact failure this repo has hit
repeatedly with counts and with "does not exist yet" comments. Derive it from the
constants and the card blocks, and make a new reason appear without anyone editing
a list. A test should fail if a named reason exists that the surface cannot show.

Whether this belongs on the model card, `/v1/meta`, its own read, or all three is
part of the work; decide it and argue it. Note `/v1/meta` is already `no-store`
and already the place a caller asks what the deployment is.

**Blocked by:** None — every reason above is merged.

**Status:** done

- [ ] The set is derived, and adding a new named reason requires editing no list
- [ ] A test fails if a reason exists that the surface cannot render
- [ ] Each entry carries its reason and whether it is unrunnable or merely unrun —
      that distinction is deliberate (forecaster 18 chose its constant precisely so
      it would not read like forecaster 16's) and must survive
- [ ] Nothing on the surface presents a fixture figure as a measurement
- [ ] Bilingual if it reaches the product surface; the copy guard takes no
      exemption
