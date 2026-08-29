# 22 — The test that keeps the architecture

**What to build:** two tests that make re-adding a per-request inference
impossible to do by accident. Re-adding one is a two-line change and nothing else
in the repository would notice.

**The boundary, structurally.** A grep- or AST-level assertion that **no route
handler reaches the modelling service except the optimizer and the replay solve**.
Then, positively: the day-ahead forecast route and the diagnosis route resolve
from Postgres only, asserted by running them against a fixture database with the
modelling service's URL **unset** and expecting a 200.

**Degradation, as behaviour.** With the modelling service returning 503 for
everything, one table:

| Route | Expected |
|---|---|
| outlook, day-ahead, diagnosis, observed, replay days | 200 |
| optimize, replay | 502, upstream-unavailable |
| meta | 200, with the model block reporting unreachable |

One test, one table, and it is the whole product promise of the boundary
decision: **a modelling outage is a stale timestamp, not a product outage.**

These are deliberately the last tickets rather than the first, because they
assert a property of the finished surface — but the grep half can land as soon as
the forecast route is gone, and should.

**Blocked by:** 11, 15, 17.

**Status:** ready-for-agent

- [ ] A structural test names the only two handlers permitted to reach the modelling service, and fails when a third appears
- [ ] The forecast and diagnosis routes return 200 against a fixture database with the modelling service unconfigured
- [ ] The degradation table is one test, covering every row
- [ ] The meta endpoint reports the modelling service unreachable and stays otherwise correct
- [ ] The default test run needs no network, no database and no modelling service for the structural half
- [ ] The degradation half runs against real Postgres under the existing environment-variable gating
