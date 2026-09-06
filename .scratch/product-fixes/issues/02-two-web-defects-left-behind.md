# 02 — A difference of medians, and a screen that stopped working offline

**What to build:** two small web fixes each flagged by a ticket that could not
take them.

**1. `mitigate.tsx` prints a difference of two medians.** api-surface 09 built the
`no-summed-bands` guard and flagged this as deliberately out of its reach: the
guard forbids *summing* quantiles, and this subtracts them —
`previous.remaining.p50 - step.remaining.p50` — so it does not match. But the
arithmetic is the same error one operation over: **the median of a difference is
not the difference of the medians.** The figure is presented to a user as the
energy a step recovers. Decide whether the honest number exists in the contract
(the solver reports per-step absorption; a difference of medians is not it) and
either use it or stop printing a number the model does not support. If the guard
should also catch subtraction, extend it — but do not extend it so far that it
flags legitimate arithmetic, and check the full repo scan after.

**2. `/app/replay` no longer renders anything in a static export.** replay 10
correctly moved the Time Machine off fixtures and onto `/v1/replay`, because
filling its boxes from a fixture would have meant scoring a plan in the browser,
which `one-execution-rule` forbids. The cost, which that ticket named: in
`web:export` the screen shows the "Replaying" absence, as `/app/mitigate` already
does. Overview and Explain still work offline.

The trade was right; the *silence* is the problem. A reader opening the exported
build sees a dead screen with no explanation. Give the absence a reason — the same
courtesy `UnmeasuredLeadTime` and `band_unavailable_reason` extend on the data
side: say that this screen reads a live API and what is needed to see it. Do not
reintroduce a fixture-scored plan, and do not weaken `one-execution-rule`.

**Blocked by:** None — api-surface 09 and replay 10 are merged.

**Status:** ready-for-agent

- [ ] The mitigate figure is either the contract's own per-step number or gone
- [ ] If the guard is extended, the full-repo scan still yields only intended hits
- [ ] `/app/replay` in a static export explains its own absence in both locales
- [ ] No fixture-scored plan, and `one-execution-rule` still passes untouched
- [ ] `bun run web:export` green
