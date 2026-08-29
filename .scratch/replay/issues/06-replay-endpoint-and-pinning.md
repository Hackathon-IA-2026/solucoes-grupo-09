# 06 — The replay endpoint: the optimizer's transport, and a link that still means what it meant

**What to build:** a replay answers inside one HTTP request over exactly the same
scenario transport as Mitigate, and a shared replay URL returns the same numbers next
month — after a retrain and a fresh backtest — because the forecast origin it pins is
part of the link.

**A replay is a `Scenario` with a past `target_date`**, so inventing a second transport
would be inventing a second scenario format. The blob is the optimizer's byte-for-byte:
the same canonical JCS encoding, the same `v: 1`, the same 4096-byte cap, the same
validation table, the same per-IP rate limit and the same failure posture. The fleet
controls on this screen are the same what-if controls as Mitigate's, and they behave
the same way — they re-plan and never re-forecast.

```
GET /v1/replay/days                    → replayable calendar + featured shortlist
GET /v1/replay?d=<date>&s=<blob>       → one replay
POST /v1/replay                        → same, scenario in the body
```

**Cache**, reusing the optimizer's discipline verbatim rather than inventing a second
one: Redis, TTL 24 h, key
`replay:v1:<sha256(canonical scenario)>:<target_date>:<forecast_origin>:<optimizer_build>`.
Evictable at any time with no user-visible loss. The forecast origin is in the key
because a later backtest run supersedes the `backfilled_holdout` rows;
`optimizer_build` is in it because a formulation change must not serve yesterday's plan
under today's code.

**Nothing about a replay is persisted as a result.** A `Replay` is a read mode and not
a table. What is persisted is the forecast rows, which were going to be persisted
anyway. Caching is therefore an optimisation and never a correctness requirement — the
whole computation is a pure function of (pinned forecast rows, observed rows, scenario).

A shared replay URL echoes back a **pinned** `forecast_origin`, which is what makes the
link honest: at that origin the numbers are reproducible forever, and at the unpinned
origin they may legitimately move and the response shows why.

**Blocked by:** 03; **Flex-optimizer 03** (canonical transport), **Flex-optimizer 04**
(the shared validation table), **Flex-optimizer 06** (rate limit, cache discipline,
failure posture).

**Status:** ready-for-agent

- [ ] All three routes answer inside one request, with no job id and no ML-service forecast call in the path
- [ ] Scenario validation parity with `/v1/optimize`: the same blob is accepted or rejected identically by both, asserted by a test that feeds one corpus to both endpoints
- [ ] One case per replay refusal code, each asserting rejection rather than a caveated answer
- [ ] A cache hit returns byte-identical output; a changed `forecast_origin` or `optimizer_build` misses
- [ ] The per-IP rate limit applies, because it is the same solver behind the same public surface
- [ ] Reproducibility across a retrain: compute a replay, run a full retrain and a fresh backtest, recompute at the **pinned** origin and assert byte-identical output
- [ ] At the unpinned origin the numbers may differ, and the response's `forecast_origin` shows why
