# 12 — Live-conformance suite

**What to build:** a test that tells WattSteer when the world changed underneath it.

Every other test in the platform runs against recorded fixtures and will keep
passing forever — including after the real sources change. This suite is the
opposite: it talks to the live sources and asserts they still look the way the
research found them.

It is expected to fail eventually, and that is the point. The sources demonstrably
rewrite history, add columns, backfill them retroactively, and change what a model
serves. A failure here is a notification that an assumption expired, so it must
report *which* assumption in prose a human can act on, rather than merely asserting
and dying.

It is gated and scheduled, and must never run in the default test path.

**Blocked by:** 02, 05, 07, 09

**Status:** ready-for-agent

- [ ] The suite is off by default and never runs without being explicitly enabled
- [ ] It runs on a schedule in CI rather than on every commit
- [ ] Expected columns are asserted present on each live source
- [ ] The load API subsystem-code hazard is asserted, in both the working and the empty case
- [ ] The registry identifier padding asymmetry is asserted still to hold
- [ ] The pinned weather model is asserted still to serve every required variable
- [ ] The daily registry resource is asserted fresher than the monthly one
- [ ] Each failure names the expired assumption in prose, not just a failed comparison
