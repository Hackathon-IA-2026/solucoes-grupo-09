# 29 — `crossing_rate` is published over two populations under one key

**What to build:** one meaning for one published field.

Found by forecaster 28 while building the caveats census, and it correctly
declined to declare a caveat for it — a caveat would have *documented* a bug
instead of fixing one. Verified at merge:

`MetricsRow.as_card_entry()` writes

```
"crossing_rate": self.crossing_rate,          # over every settled hour
...
entry.update(self.coverage.card_fields())     # ALSO emits "crossing_rate",
                                              # over the curtailed subset
```

so the published value is the **curtailed-hours** rate when a `CoverageReport`
exists and the **all-settled-hours** rate when it does not. Same key, two
populations, decided by whether an unrelated object is present.

`MetricsRow`'s own field comment is unambiguous that this must not happen:

> Over every settled hour. `CoverageReport.crossing_rate` is the same quantity
> over the curtailed subset; **the two are different populations and are not
> interchangeable.**

The code interchanges them.

**Scope, checked.** `crossing_rate` is `required` in `model-card.schema.json`,
read by `apps/api/src/api/model-card.ts` as `crossingRate`, and `schema.ts`
records that "`crossing_rate` over a fold is a hot-swap veto". The **veto is
safe** — the gate reads the `MetricsRow` attribute, not the card field — so this
is a published-figure defect, not a promotion defect. That is the good news and
the reason it is a ticket rather than an incident.

**The decision to make.** `crossing_rate` is required and its documented meaning
is the settled-hour rate, so that is what the key should carry. The curtailed
figure either gets an explicit key of its own or stops being published — decide
which, and if it gets a key, say what a reader is meant to do with two of them.
Do not resolve it by making the two interchangeable; the comment above is right.

**Blocked by:** None. Forecaster 28 is merged and recorded the finding.

**Status:** ready-for-agent

- [ ] `crossing_rate` means one thing regardless of whether coverage exists
- [ ] A test fails if a later `entry.update` ever shadows a key `as_card_entry`
      already set — the mechanism, not just this instance
- [ ] The curtailed figure is either explicitly named or explicitly dropped
- [ ] The hot-swap veto still reads the settled-hour attribute, asserted
- [ ] If a schema field is added or removed, generated types and the conformance
      fixture move with it
