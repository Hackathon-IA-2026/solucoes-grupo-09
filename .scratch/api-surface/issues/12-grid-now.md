# 12 — The landing page has something honest to show with no model at all

**What to build:** the "right now" readout. Latest settled hour, the four
subsystems' observed constrained-off energy over the last 24 hours and in the
latest hour, each with its scalar technology split, and a national total.

It is **observed, not forecast**, which is exactly what makes it the honest thing
to put on a landing page when no artifact is promoted. It needs no model, so it
is one of the few endpoints that can ship before anything is trained.

The national total is a **field with its derivation named** — `sum_of_four` —
rather than a comment, because the domain model makes the national aggregate
structurally unrepresentable as a subsystem and this is the one place a national
number legitimately exists. **Observations add exactly**, which is why this
national total is legitimate where the forecast's is not.

It also carries the vintage fidelity, the as-of instant, the latest settled hour
and the lag in hours — the lag is the honest headline when ingestion is behind,
and a screen should never compute it from a clock.

**Blocked by:** 04. Also **data-platform 16** (in flight), which is where the
canonical reads this endpoint composes are becoming SQL views. This endpoint
reads those views and does not re-query base tables.

**Status:** done

- [ ] One request returns the latest settled hour, the lag, and the four subsystems' observed totals with their scalar splits
- [ ] The national total names its derivation on the payload
- [ ] The response carries its vintage fidelity and its as-of instant
- [ ] It returns a 200 with the modelling service unreachable and with no promoted artifact
- [ ] It reads the canonical views, not the base tables
- [ ] An absent hour is an absence, never a zero
