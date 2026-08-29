# 19 — Serve two artifacts: the morning view and the evening view

**What to build:** the operator keeps the eleven hours of notice *and* gets the
DESSEM-conditioned view — a morning artifact published around 09:00 BRT and an
evening artifact published around 19:00 BRT that supersedes it.

The eleven hours are only a cost if the late artifact *replaces* the early one,
and it does not have to. The bitemporal design already treats the D−1 12Z
weather run as a superseding vintage of the same valid hours, and every surface
already names its `ForecastOrigin` — so a later forecast for the same valid
hours is simply a newer vintage, needing no special case. This is the
recommendation, and it makes the DESSEM question a question about the evening
view alone, which is a much smaller decision and one the two decision folds can
actually carry.

It costs a second artifact lane, a second card, a doubled retrain of seconds and
a second row in the backtest matrix. It costs nothing in operator notice, and a
wrong DESSEM call becomes recoverable rather than a product regression, because
the early view exists either way.

**Blocked by:** 13, 14.

**Status:** ready-for-agent

- [ ] Two gate profiles are lanes in their own right, each with its own
      promotion history, incumbent and card
- [ ] Both are retrained and gated on the same schedule, and one lane's refusal
      does not block the other's promotion
- [ ] The evening forecast supersedes the morning one as a newer vintage of the
      same valid hours — no row is overwritten and both remain readable through
      `AsOf`
- [ ] Every served response names which lane produced it and when it was
      published, so a morning and an evening answer for the same day are never
      confusable
- [ ] Replay of a past day resolves to whichever vintage was current at the
      pinned instant
