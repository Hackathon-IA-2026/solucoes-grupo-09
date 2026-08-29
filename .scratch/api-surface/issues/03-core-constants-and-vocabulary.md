# 03 — One place both languages read the constants from

**What to build:** the numbers and the vocabulary the whole product agrees on
live once, in the shared package, where the gateway, the web app and — via the
fixture directory — the Python service can all read them.

Four constants move, and one of them is a live bug: the R$/MWh economic
assumption exists under **two names**, in a package Python cannot read, while
the optimizer spec calls it "the single place it is written down". It becomes
one published constant beside the subsystem enum with its ONS display names, the
reference battery fleet, the subsystem threshold (5 MW), the reporting-entity
threshold (1 MW) and the maximum gap hours (0).

Two of these are deliberately **not** endpoints, and the reasoning is worth
keeping: a subsystem list endpoint would invite a fifth member, and a reference
fleet endpoint would break the requirement that floor coverage and the
forecaster's recovered-floor delta are computed against the same battery. Both
ship as constants and the reference fleet is *echoed* in the meta endpoint for
diagnosability, never fetched in order to be used.

The frontend's domain vocabulary module is promoted into the shared package as
the single definition — it is already the one place the web app defines
`Subsystem`, `Band`, `ForecastOrigin`, `Technology`, `VintageFidelity` and the
reason codes, and it already carries the reasoning for each. Promoting it is
what lets the gateway stop having a second opinion.

Two vocabulary rules the promotion must preserve rather than lose: `SIN` is not
a subsystem value anywhere, and `lead_time` is derived and therefore never
stored and never returned.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The shared package exports the subsystem enum with ONS display names, the reference fleet, both thresholds, the gap default and the single R$/MWh assumption
- [ ] The duplicated economic-assumption name is gone, with one definition left and every reader pointed at it
- [ ] The frontend domain vocabulary lives in the shared package and the web app imports it from there
- [ ] The gateway imports the same definitions rather than restating them
- [ ] `SIN` is not representable as a subsystem in the shared types
- [ ] No exported type carries a stored lead time
- [ ] The web app still builds and its existing tests still pass against the promoted module
